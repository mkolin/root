/*****************************************************************************
 * Project: RooFit                                                           *
 * Package: RooFitCore                                                       *
 *    File: $Id$
 * Authors:                                                                  *
 *   WV, Wouter Verkerke, UC Santa Barbara, verkerke@slac.stanford.edu       *
 *   DK, David Kirkby,    UC Irvine,         dkirkby@uci.edu                 *
 *                                                                           *
 * Copyright (c) 2000-2005, Regents of the University of California          *
 *                          and Stanford University. All rights reserved.    *
 *                                                                           *
 * Redistribution and use in source and binary forms,                        *
 * with or without modification, are permitted according to the terms        *
 * listed in LICENSE (http://roofit.sourceforge.net/license.txt)             *
 *****************************************************************************/
#ifndef ROO_ABS_NUM_GENERATOR
#define ROO_ABS_NUM_GENERATOR

#include "TNamed.h"
#include "RooPrintable.h"
#include "RooArgSet.h"
#include "RooArgList.h"

class RooAbsReal;
class RooRealVar;
class RooDataSet;
class RooRealBinding;
class RooNumGenConfig ;

class RooAbsNumGenerator : public TNamed, public RooPrintable {
public:
  RooAbsNumGenerator() : _cloneSet(nullptr), _funcClone(nullptr), _funcMaxVal(nullptr), _verbose(false), _isValid(false), _funcValStore(nullptr), _funcValPtr(nullptr), _cache(nullptr) {}
  RooAbsNumGenerator(const RooAbsReal &func, const RooArgSet &genVars, bool verbose=false, const RooAbsReal* maxFuncVal=nullptr);
  virtual RooAbsNumGenerator* clone(const RooAbsReal&, const RooArgSet& genVars, const RooArgSet& condVars,
                const RooNumGenConfig& config, bool verbose=false, const RooAbsReal* maxFuncVal=nullptr) const = 0 ;

  bool isValid() const {
    // If true, generator is in a valid state
    return _isValid;
  }
  ~RooAbsNumGenerator() override;

  inline void setVerbose(bool verbose= true) {
    // If flag is true, verbose messaging will be active during generation
    _verbose= verbose;
  }
  inline bool isVerbose() const {
    // Return status of verbose messaging flag
    return _verbose;
  }

  virtual const RooArgSet *generateEvent(UInt_t remaining, double& resampleRatio) = 0;
  virtual double getFuncMax() { return 0 ; }

   inline void Print(Option_t *options= nullptr) const override {
     // ascii printing interface
    printStream(defaultPrintStream(),defaultPrintContents(options),defaultPrintStyle(options));
  }

  void printName(std::ostream& os) const override ;
  void printTitle(std::ostream& os) const override ;
  void printClassName(std::ostream& os) const override ;
  void printArgs(std::ostream& os) const override ;

  void attachParameters(const RooArgSet& vars) ;

  // Advertisement of capabilities
  virtual bool canSampleCategories() const { return false ; }
  virtual bool canSampleConditional() const { return false ; } // Must implement getFuncMax()

protected:

  RooArgSet *_cloneSet;                ///< Set owning clone of input function
  RooAbsReal *_funcClone;              ///< Pointer to top level node of cloned function
  const RooAbsReal *_funcMaxVal ;      ///< Container for maximum function value
  RooArgSet _catVars,_realVars ;       ///< Sets of discrete and real valued observabeles
  bool _verbose, _isValid;           ///< Verbose and valid flag
  RooRealVar *_funcValStore,*_funcValPtr; ///< RRVs storing function value in context and in output dataset

  RooDataSet *_cache;                  ///< Dataset holding generared values of observables

  ClassDefOverride(RooAbsNumGenerator,0) // Abstract base class for numeric event generator algorithms
};

#endif
