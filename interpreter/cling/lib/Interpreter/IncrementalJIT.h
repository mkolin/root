//--------------------------------------------------------------------*- C++ -*-
// CLING - the C++ LLVM-based InterpreterG :)
// author:  Stefan Gränitz <stefan.graenitz@gmail.com>
//
// This file is dual-licensed: you can choose to license it under the University
// of Illinois Open Source License or the GNU Lesser General Public License. See
// LICENSE.TXT for details.
//------------------------------------------------------------------------------

#ifndef CLING_INCREMENTAL_JIT_H
#define CLING_INCREMENTAL_JIT_H

#include "llvm/ADT/FunctionExtras.h"
#include "llvm/ADT/StringRef.h"
#include "llvm/IR/Module.h"
#include "llvm/ExecutionEngine/Orc/ExecutorProcessControl.h"
#include "llvm/ExecutionEngine/Orc/LLJIT.h"
#include "llvm/ExecutionEngine/Orc/ThreadSafeModule.h"
#include "llvm/Support/Error.h"
#include "llvm/Target/TargetMachine.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>

namespace cling {

class IncrementalExecutor;
class Transaction;

class SharedAtomicFlag {
public:
  SharedAtomicFlag(bool UnlockedState)
      : Lock(std::make_shared<std::atomic<bool>>(UnlockedState)),
        LockedState(!UnlockedState) {}

  // FIXME: We don't lock recursively. Can we assert it?
  void lock() { Lock->store(LockedState); }
  void unlock() { Lock->store(!LockedState); }

  operator bool() const { return Lock->load(); }

private:
  std::shared_ptr<std::atomic<bool>> Lock;
  const bool LockedState;
};

class IncrementalJIT {
public:
  IncrementalJIT(IncrementalExecutor& Executor,
                 std::unique_ptr<llvm::TargetMachine> TM,
                 std::unique_ptr<llvm::orc::ExecutorProcessControl> EPC,
                 llvm::Error &Err);

  // FIXME: Accept a LLVMContext as well, e.g. the one that was used for the
  // particular module in Interpreter, CIFactory or BackendPasses (would be
  // more efficient)
  void addModule(Transaction& T);

  llvm::Error removeModule(const Transaction& T);

  /// Get the address of a symbol based on its IR name (as coming from clang's
  /// mangler). The ExcludeHostSymbols parameter controls whether the lookup
  /// should include symbols from the host process or not.
  void* getSymbolAddress(llvm::StringRef Name, bool ExcludeHostSymbols);

  /// Inject a symbol with a known address. Collisions will cause an error
  /// unless AcceptExisting = true.
  llvm::JITTargetAddress addDefinition(llvm::StringRef LinkerMangledName,
                                       llvm::JITTargetAddress KnownAddr,
                                       bool AcceptExisting = false);

  llvm::Error runCtors() const {
    return Jit->initialize(Jit->getMainJITDylib());
  }
private:
  std::unique_ptr<llvm::orc::LLJIT> Jit;
  llvm::orc::SymbolMap m_InjectedSymbols;
  SharedAtomicFlag SkipHostProcessLookup;

  /// FIXME: If the relation between modules and transactions is a bijection, the
  /// mapping via module pointers here is unnecessary. The transaction should
  /// store the resource tracker directly and pass it to `remove()` for
  /// unloading.
  std::map<const Transaction*, llvm::orc::ResourceTrackerSP> m_ResourceTrackers;
  std::map<const llvm::Module *, llvm::orc::ThreadSafeModule> m_CompiledModules;

  // FIXME: Move TargetMachine ownership to BackendPasses
  std::unique_ptr<llvm::TargetMachine> TM;

  // TODO: We only need the context for materialization. Instead of defining it
  // here we might want to pass one in on a per-module basis.
  //
  // FIXME: Using a single context for all modules prevents concurrent
  // compilation.
  //
  llvm::orc::ThreadSafeContext SingleThreadedContext;
};

} // namespace cling

#endif // CLING_INCREMENTAL_JIT_H
