//--------------------------------------------------------------------*- C++ -*-
// CLING - the C++ LLVM-based InterpreterG :)
// author:  Axel Naumann <axel@cern.ch>
//
// This file is dual-licensed: you can choose to license it under the University
// of Illinois Open Source License or the GNU Lesser General Public License. See
// LICENSE.TXT for details.
//------------------------------------------------------------------------------

#include "IncrementalExecutor.h"
#include "BackendPasses.h"
#include "IncrementalJIT.h"
#include "Threading.h"

#include "cling/Interpreter/DynamicLibraryManager.h"
#include "cling/Interpreter/Transaction.h"
#include "cling/Interpreter/Value.h"
#include "cling/Utils/AST.h"
#include "cling/Utils/Output.h"
#include "cling/Utils/Platform.h"

#include "clang/Basic/Diagnostic.h"
#include "clang/Basic/TargetOptions.h"
#include "clang/Frontend/CompilerInstance.h"

#include "llvm/ExecutionEngine/Orc/ExecutorProcessControl.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/IR/Module.h"
#include "llvm/ADT/SmallPtrSet.h"
#include "llvm/ADT/Triple.h"
#include "llvm/Support/Host.h"
#include "llvm/Support/TargetRegistry.h"
#include "llvm/Target/TargetMachine.h"

#include <iostream>

using namespace llvm;

namespace cling {

namespace {

static std::unique_ptr<TargetMachine>
CreateHostTargetMachine(const clang::CompilerInstance& CI) {
  const clang::TargetOptions& TargetOpts = CI.getTargetOpts();
  const clang::CodeGenOptions& CGOpt = CI.getCodeGenOpts();
  const std::string& Triple = TargetOpts.Triple;

  std::string Error;
  const Target *TheTarget = TargetRegistry::lookupTarget(Triple, Error);
  if (!TheTarget) {
    cling::errs() << "cling::IncrementalExecutor: unable to find target:\n"
                  << Error;
    return std::unique_ptr<TargetMachine>();
  }

  CodeGenOpt::Level OptLevel = CodeGenOpt::Default;
  switch (CGOpt.OptimizationLevel) {
    case 0: OptLevel = CodeGenOpt::None; break;
    case 1: OptLevel = CodeGenOpt::Less; break;
    case 2: OptLevel = CodeGenOpt::Default; break;
    case 3: OptLevel = CodeGenOpt::Aggressive; break;
    default: OptLevel = CodeGenOpt::Default;
  }
  using namespace llvm::orc;
  auto JTMB = JITTargetMachineBuilder::detectHost();
  if (!JTMB)
    logAllUnhandledErrors(JTMB.takeError(), llvm::errs(),
                          "Error detecting host");

  JTMB->setCodeGenOptLevel(OptLevel);
#ifdef _WIN32
  JTMB->getOptions().EmulatedTLS = false;
#endif // _WIN32

#if defined(__powerpc64__) || defined(__PPC64__)
  // We have to use large code model for PowerPC64 because TOC and text sections
  // can be more than 2GB apart.
  JTMB->setCodeModel(CodeModel::Large);
#endif

  std::unique_ptr<TargetMachine> TM = cantFail(JTMB->createTargetMachine());

  // Forcefully disable GlobalISel, it might be enabled on AArch64 without
  // optimizations. In tests on an Apple M1 after the upgrade to LLVM 9, this
  // new instruction selection framework emits branches / calls that expect all
  // code to be reachable in +/- 128 MB. This cannot be guaranteed during JIT,
  // which generates code into allocated pages on the heap and could span the
  // entire address space of the process.
  //
  // TODO:
  // 1. Try to reproduce the problem with vanilla lli of LLVM 9 to check that
  //    this is not related to the way Cling incrementally JITs and executes.
  // 2. Figure out exactly why GlobalISel emits different branch instructions,
  //    and whether this is a problem in the framework or of the generated IR.
  // 3. Verify if the same happens with LLVM 11/12 (whatever Cling will move to
  //    next), and possibly fix the underlying issue in LLVM upstream's `main`.
  //
  // FIXME: Lift this restriction and allow the target to enable GlobalISel,
  // if deemed ready by upstream developers.
  TM->setGlobalISel(false);

  return TM;
}

} // anonymous namespace

IncrementalExecutor::IncrementalExecutor(clang::DiagnosticsEngine& /*diags*/,
                                         const clang::CompilerInstance& CI):
  m_Callbacks(nullptr), m_externalIncrementalExecutor(nullptr)
#if 0
  : m_Diags(diags)
#endif
{
  m_DyLibManager.initializeDyld([](llvm::StringRef){/*ignore*/ return false;});

  // MSVC doesn't support m_AtExitFuncsSpinLock=ATOMIC_FLAG_INIT; in the class definition
  std::atomic_flag_clear( &m_AtExitFuncsSpinLock );

  std::unique_ptr<TargetMachine> TM(CreateHostTargetMachine(CI));
  auto &TMRef = *TM;
  llvm::Error Err = llvm::Error::success();
  auto EPC = llvm::cantFail(llvm::orc::SelfExecutorProcessControl::Create());
  m_JIT.reset(new IncrementalJIT(*this, std::move(TM), std::move(EPC), Err));
  if (Err) {
    llvm::logAllUnhandledErrors(std::move(Err), llvm::errs(), "Fatal: ");
    llvm_unreachable("Propagate this error and exit gracefully");
  }

  m_BackendPasses.reset(new BackendPasses(CI.getCodeGenOpts(),
                                          CI.getTargetOpts(),
                                          CI.getLangOpts(),
                                          TMRef,
                                          *m_JIT));
}

IncrementalExecutor::~IncrementalExecutor() {}

void IncrementalExecutor::runAtExitFuncs() {
  // It is legal to register an atexit handler from within another atexit
  // handler and furthor-more the standard says they need to run in reverse
  // order, so this function must be recursion safe.
  AtExitFunctions Local;
  {
    cling::internal::SpinLockGuard slg(m_AtExitFuncsSpinLock);
    // Check this case first, to avoid the swap all-together.
    if (m_AtExitFuncs.empty())
      return;
    Local.swap(m_AtExitFuncs);
  }
  for (auto&& Ordered : llvm::reverse(Local.ordered())) {
    for (auto&& AtExit : llvm::reverse(Ordered->second))
      AtExit();
    // The standard says that they need to run in reverse order, which means
    // anything added from 'AtExit()' must now be run!
    runAtExitFuncs();
  }
}

void IncrementalExecutor::AddAtExitFunc(void (*func)(void*), void* arg,
                                        const Transaction* T) {
  // Register a CXAAtExit function
  cling::internal::SpinLockGuard slg(m_AtExitFuncsSpinLock);
  m_AtExitFuncs[T].emplace_back(func, arg);
}

void unresolvedSymbol()
{
  // This might get called recursively, or a billion of times. Do not generate
  // useless output; unresolvedSymbol() is always handed out with an error
  // message - that's enough.
  //cling::errs() << "IncrementalExecutor: calling unresolved symbol, "
  //  "see previous error message!\n";

  // throw exception instead?
}

void*
IncrementalExecutor::HandleMissingFunction(const std::string& mangled_name) const {
  // Not found in the map, add the symbol in the list of unresolved symbols
  if (m_unresolvedSymbols.insert(mangled_name).second) {
    //cling::errs() << "IncrementalExecutor: use of undefined symbol '"
    //             << mangled_name << "'!\n";
  }

  return utils::FunctionToVoidPtr(&unresolvedSymbol);
}

void*
IncrementalExecutor::NotifyLazyFunctionCreators(const std::string& mangled_name) const {
  for (auto it = m_lazyFuncCreator.begin(), et = m_lazyFuncCreator.end();
       it != et; ++it) {
    void* ret = (void*)((LazyFunctionCreatorFunc_t)*it)(mangled_name);
    if (ret)
      return ret;
  }
  void *address = nullptr;
  if (m_externalIncrementalExecutor)
   address = m_externalIncrementalExecutor->getAddressOfGlobal(mangled_name);

  return (address ? address : HandleMissingFunction(mangled_name));
}

#if 0
// FIXME: employ to empty module dependencies *within* the *current* module.
static void
freeCallersOfUnresolvedSymbols(llvm::SmallVectorImpl<llvm::Function*>&
                               funcsToFree, llvm::ExecutionEngine* engine) {
  llvm::SmallPtrSet<llvm::Function*, 40> funcsToFreeUnique;
  for (size_t i = 0; i < funcsToFree.size(); ++i) {
    llvm::Function* func = funcsToFree[i];
    assert(func && "Cannot free NULL function");
    if (funcsToFreeUnique.insert(func).second) {
      for (llvm::Value::use_iterator IU = func->use_begin(),
             EU = func->use_end(); IU != EU; ++IU) {
        llvm::Instruction* instUser = llvm::dyn_cast<llvm::Instruction>(*IU);
        if (!instUser) continue;
        if (!instUser->getParent()) continue;
        if (llvm::Function* userFunc = instUser->getParent()->getParent())
          funcsToFree.push_back(userFunc);
      }
    }
  }
  for (llvm::SmallPtrSet<llvm::Function*, 40>::iterator
         I = funcsToFreeUnique.begin(), E = funcsToFreeUnique.end();
       I != E; ++I) {
    // This should force the JIT to recompile the function. But the stubs stay,
    // and the JIT reuses the stubs now pointing nowhere, i.e. without updating
    // the machine code address. Fix the JIT, or hope that MCJIT helps.
    //engine->freeMachineCodeForFunction(*I);
    engine->updateGlobalMapping(*I, 0);
  }
}
#endif

static bool isPracticallyEmptyModule(const llvm::Module* M) {
  return M->empty() && M->global_empty() && M->alias_empty();
}


IncrementalExecutor::ExecutionResult
IncrementalExecutor::runStaticInitializersOnce(Transaction& T) {
  llvm::Module* m = T.getModule();
  assert(m && "Module must not be null");

  if (isPracticallyEmptyModule(m))
    return kExeSuccess;

  emitModule(T);

  // We don't care whether something was unresolved before.
  m_unresolvedSymbols.clear();

  // check if there is any unresolved symbol in the list
  if (diagnoseUnresolvedSymbols("static initializers"))
    return kExeUnresolvedSymbols;

  if (llvm::Error Err = m_JIT->runCtors()) {
    llvm::logAllUnhandledErrors(std::move(Err), llvm::errs(),
                                "[runStaticInitializersOnce]: ");
  }
  return kExeSuccess;
}

void IncrementalExecutor::runAndRemoveStaticDestructors(Transaction* T) {
  assert(T && "Must be set");
  // Collect all the dtors bound to this transaction.
  AtExitFunctions::mapped_type Local;
  {
    cling::internal::SpinLockGuard slg(m_AtExitFuncsSpinLock);
    auto Itr = m_AtExitFuncs.find(T);
    if (Itr == m_AtExitFuncs.end()) return;
    m_AtExitFuncs.erase(Itr, &Local);
  } // end of spin lock lifetime block.

  // 'Unload' the cxa_atexit, atexit entities.
  for (auto&& AtExit : llvm::reverse(Local)) {
    AtExit();
    // Run anything that was just registered in 'AtExit()'
    runAndRemoveStaticDestructors(T);
  }
}

static void flushOutBuffers() {
  // Force-flush as we might be printing on screen with printf.
  std::cout.flush();
  fflush(stdout);
}

IncrementalExecutor::ExecutionResult
IncrementalExecutor::executeWrapper(llvm::StringRef function,
                                    Value* returnValue/* =0*/) const {
  // Set the value to cling::invalid.
  if (returnValue)
    *returnValue = Value();

  typedef void (*InitFun_t)(void*);
  InitFun_t fun;
  ExecutionResult res = jitInitOrWrapper(function, fun);
  if (res != kExeSuccess)
    return res;
  EnterUserCodeRAII euc(m_Callbacks);
  (*fun)(returnValue);

  flushOutBuffers();
  return kExeSuccess;
}

void IncrementalExecutor::setCallbacks(InterpreterCallbacks* callbacks) {
  m_Callbacks = callbacks;
  m_DyLibManager.setCallbacks(callbacks);
}

void
IncrementalExecutor::installLazyFunctionCreator(LazyFunctionCreatorFunc_t fp)
{
  m_lazyFuncCreator.push_back(fp);
}

void IncrementalExecutor::replaceSymbol(const char* Name, void* Addr) const {
  assert(Addr);
  // FIXME: Look at the registration of at_quick_exit and uncomment.
  // assert(m_JIT->getSymbolAddress(Name, /*IncludeHostSymbols*/true) &&
  //        "The symbol must exist");
  m_JIT->addOrReplaceDefinition(Name, llvm::pointerToJITTargetAddress(Addr));
}

void* IncrementalExecutor::getAddressOfGlobal(llvm::StringRef symbolName,
                                              bool* fromJIT /*=0*/) const {
  constexpr bool includeHostSymbols = true;

  void* address = m_JIT->getSymbolAddress(symbolName, includeHostSymbols);

  // FIXME: If we split the loaded libraries into a separate JITDylib we should
  // be able to delete this code and use something like:
  //   if (IncludeHostSymbols) {
  //   if (auto Sym = lookup(<HostSymbolsJD>, Name)) {
  //     fromJIT = false;
  //     return Sym;
  //   }
  // }
  // if (auto Sym = lookup(<REPLJD>, Name)) {
  //   fromJIT = true;
  //   return Sym;
  // }
  // fromJIT = false;
  // return nullptr;
  if (fromJIT) {
    // FIXME: See comments on DLSym below.
    // We use dlsym to just tell if somethings was from the jit or not.
#if !defined(_WIN32)
    void* Addr = llvm::sys::DynamicLibrary::SearchForAddressOfSymbol(symbolName.str());
#else
    void* Addr = const_cast<void*>(platform::DLSym(symbolName.str()));
#endif
    *fromJIT = !Addr;
  }

  return address;
}

void*
IncrementalExecutor::getPointerToGlobalFromJIT(llvm::StringRef name) const {
  // Get the function / variable pointer referenced by name.

  // We don't care whether something was unresolved before.
  m_unresolvedSymbols.clear();

  void* addr = m_JIT->getSymbolAddress(name, false /*no dlsym*/);

  if (diagnoseUnresolvedSymbols(name, "symbol"))
    return 0;
  return addr;
}

bool IncrementalExecutor::diagnoseUnresolvedSymbols(llvm::StringRef trigger,
                                                  llvm::StringRef title) const {
  if (m_unresolvedSymbols.empty())
    return false;
  if (m_unresolvedSymbols.size() == 1 && *m_unresolvedSymbols.begin() == trigger)
    return false;

  // Issue callback to TCling!!
  for (const std::string& sym : m_unresolvedSymbols) {
    // We emit callback to LibraryLoadingFailed when we get error with error message.
    if (InterpreterCallbacks* C = m_Callbacks)
      if (C->LibraryLoadingFailed(sym, "", false, false))
        return false;
  }

  llvm::SmallVector<llvm::Function*, 128> funcsToFree;
  for (const std::string& sym : m_unresolvedSymbols) {
#if 0
    // FIXME: This causes a lot of test failures, for some reason it causes
    // the call to HandleMissingFunction to be elided.
    unsigned diagID = m_Diags.getCustomDiagID(clang::DiagnosticsEngine::Error,
                                              "%0 unresolved while jitting %1");
    (void)diagID;
    //m_Diags.Report(diagID) << sym << funcname; // TODO: demangle the names.
#endif

    cling::errs() << "IncrementalExecutor::executeFunction: symbol '" << sym
                  << "' unresolved while linking ";
    if (trigger.find(utils::Synthesize::UniquePrefix) != llvm::StringRef::npos)
      cling::errs() << "[cling interface function]";
    else {
      if (!title.empty())
        cling::errs() << title << " '";
      cling::errs() << trigger;
      if (!title.empty())
        cling::errs() << "'";
    }
    cling::errs() << "!\n";

    // Be helpful, demangle!
    std::string demangledName = platform::Demangle(sym);
    if (!demangledName.empty()) {
       cling::errs()
          << "You are probably missing the definition of "
          << demangledName << "\n"
          << "Maybe you need to load the corresponding shared library?\n";
    }

    std::string libName = m_DyLibManager.searchLibrariesForSymbol(sym,
                                                        /*searchSystem=*/ true);
    if (!libName.empty())
      cling::errs() << "Symbol found in '" << libName << "';"
                    << " did you mean to load it with '.L "
                    << libName << "'?\n";

    //llvm::Function *ff = m_engine->FindFunctionNamed(i->c_str());
    // i could also reference a global variable, in which case ff == 0.
    //if (ff)
    //  funcsToFree.push_back(ff);
  }
  //freeCallersOfUnresolvedSymbols(funcsToFree, m_engine.get());
  m_unresolvedSymbols.clear();
  return true;
}

}// end namespace cling
