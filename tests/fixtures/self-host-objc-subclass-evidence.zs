import fs from "std/fs";
import process from "std/process";
import console from "std/console";
import { decodeRawForeignDeclarations } from "../../compiler/frontend/foreign-declaration-protocol.zs";
import { normalizeForeignContracts, parseForeignContracts } from "../../compiler/frontend/foreign-contracts.zs";
import { buildResolvedModules, parseModule } from "../../compiler/frontend/module-graph.zs";
import { ParsedModule } from "../../compiler/frontend/module-symbols.zs";
import { ModuleSource } from "../../compiler/frontend/semantic-model.zs";
import { attachForeignContracts, NativeForeignModuleContract } from "../../compiler/frontend/semantic-foreign.zs";
import {
  prepareNativeObjCSubclassTypes, validateNativeObjCSubclassDeclarations,
} from "../../compiler/frontend/semantic-objc-subclasses.zs";
import { resolveParsedModulesWithForeignContracts, validateNativeObjCSubclassBodyTypes } from "../../compiler/frontend/module-resolver.zs";
import { compareNativeVersions } from "../../compiler/frontend/semantic-native-availability.zs";
import { planNativeObjCSubclasses } from "../../compiler/frontend/semantic-objc-subclass-plans.zs";
import { emitNativeObjCSubclassInterfaces } from "../../compiler/frontend/c-emitter.zs";
import { lowerProgram } from "../../compiler/frontend/lowering-ir.zs";
import { emptySemanticEvidence } from "../../compiler/frontend/semantic-evidence.zs";

function inspect(in path: String, in sourcePath: String, in mode: String, in platform: String, in minimumVersion: String, in header: String): i32 throws String {
  if (compareNativeVersions("14", "014.0.0") != 0
    || compareNativeVersions("13.10", "13.2") != 1
    || compareNativeVersions("13.0.9", "13.1") != -1
    || compareNativeVersions("0", "0.0.0") != 0
    || compareNativeVersions("999999999999999999999999", "1000000000000000000000000") != -1) {
    throw "incorrect native availability version comparison";
  }
  const source = try fs.readText(path);
  const module = try decodeRawForeignDeclarations(source);
  if (module.version != 15) throw "wrong foreign protocol version";
  let foundBase = false;
  let foundFinal = false;
  let observed: usize = 0;
  for (const interface_ of module.objectiveCInterfaces) {
    if (interface_.className == "ZWireFinal") {
      foundFinal = true;
      if (!interface_.subclassingRestricted) throw "lost subclass restriction";
      match (in interface_.superName) {
        some(name) => { if (name != "ZWireBase") throw "wrong native superclass"; }
        none => throw "lost native superclass";
      }
    }
    if (interface_.className != "ZWireBase") continue;
    foundBase = true;
    if (interface_.subclassingRestricted) throw "invented subclass restriction";
    match (in interface_.executorAffinity) {
      some(executor) => { if (executor != "main") throw "wrong native affinity"; }
      none => throw "lost native affinity";
    }
    let index: usize = 0;
    while (index < interface_.methodCount) {
      const method = view module.objectiveCMethods[interface_.methodStart + index];
      const initializer = method.selector == "initWithValue:";
      if (method.designatedInitializer != initializer) throw "wrong designated initializer evidence";
      if (method.returnsInstanceType != initializer) throw "wrong instancetype evidence";
      if (method.requiresSuper != (method.selector == "requiredValue")) throw "wrong required-super evidence";
      if (method.direct != (method.selector == "directValue" || method.selector == "extendedValue")) throw "wrong direct-dispatch evidence";
      // Clang also supplies consuming-self ownership for an ARC init-family method.
      if (method.consumesSelf != (initializer || method.selector == "consume")) throw "wrong consuming receiver evidence";
      if (method.variadic != (method.selector == "log:")) throw "wrong variadic evidence";
      let parameterIndex: usize = 0;
      while (parameterIndex < method.parameterCount) {
        const parameter = view module.objectiveCParameters[method.parameterStart + parameterIndex];
        const expected = method.selector == "takeIndex:object:" && parameterIndex == 1;
        if (parameter.consumed != expected) throw "wrong consuming parameter position";
        parameterIndex = parameterIndex + 1;
      }
      observed = observed + 1;
      index = index + 1;
    }
  }
  if (!foundBase || !foundFinal || observed != 13) throw `missing native subclass evidence: ${observed}`;
  const contracts = try parseForeignContracts(
    `declare module "${header}" {}`, "wire.zd"
  );
  const normalized = try normalizeForeignContracts(contracts, module, header);
  if (normalized.objectiveCInterfaces.length != module.objectiveCInterfaces.length) throw "lost normalized interfaces";
  let normalizedCount: usize = 0;
  for (const interface_ of normalized.objectiveCInterfaces) {
    if (interface_.subclassingRestricted != (interface_.nativeName == "ZWireFinal")) throw "wrong normalized restriction";
    if (interface_.nativeName != "ZWireBase") continue;
    if (interface_.executorAffinity != "thread.main") throw "lost normalized affinity";
    for (const method of interface_.methods) {
      const initializer = method.selector == "initWithValue:";
      if (method.designatedInitializer != initializer) throw "lost normalized initializer fact";
      if (method.requiresSuper != (method.selector == "requiredValue")) throw "lost normalized required-super fact";
      if (method.direct != (method.selector == "directValue" || method.selector == "extendedValue")) throw "lost normalized direct fact";
      if (method.consumesSelf != (initializer || method.selector == "consume")) throw "lost normalized consumes-self fact";
      if (method.variadic != (method.selector == "log:")) throw "lost normalized variadic fact";
      let parameterIndex: usize = 0;
      for (const parameter of method.parameters) {
        if (parameter.consumed != (method.selector == "takeIndex:object:" && parameterIndex == 1)) throw "lost normalized consumed parameter index";
        parameterIndex = parameterIndex + 1;
      }
      normalizedCount = normalizedCount + 1;
    }
  }
  if (normalizedCount != 13) throw "dropped normalized native methods";
  let programSource = `import native from "${header}"; function main(): i32 { return 0; }`;
  if (sourcePath.byteLength > 0) programSource = try fs.readText(sourcePath);
  const moduleSource = ModuleSource({
    path: "probe.zs", source: programSource, packageSpecifiers: Array<String>(),
    targetPlatform: copy platform, targetMinimumVersion: copy minimumVersion,
  });
  const parsed = match (attempt parseModule(moduleSource)) {
    success(value) => value;
    failure(error) => throw copy error.message;
  };
  let parsedModules = Array<ParsedModule>();
  parsedModules.push(parsed);
  let resolved = match (attempt buildResolvedModules(parsedModules)) {
    success(value) => value;
    failure(error) => throw copy error.message;
  };
  let foreignModules = Array<NativeForeignModuleContract>();
  foreignModules.push(NativeForeignModuleContract({
    modulePath: "probe.zs", cacheKey: "subclass-wire", dependencyPath: "", contracts: normalized,
  }));
  match (attempt attachForeignContracts(parsedModules, foreignModules, inout resolved)) {
    success => {}
    failure(error) => throw copy error.message;
  }
  let attachedCount: usize = 0;
  let excludedCount: usize = 0;
  let attachedFinal = false;
  let attachedNullable = false;
  for (const symbol of resolved[0].symbols) {
    match (in symbol.typeSignature) {
      some(signature) => {
        if (signature.foreignNativeName == "ZWireFinal") {
          attachedFinal = signature.foreignObjCSubclassingRestricted;
        }
        if (signature.foreignNativeName == "ZWireNullable") {
          if (signature.methods.length != 1) throw "missing nullable initializer";
          attachedNullable = signature.methods[0].objectiveCNativeResultType == "native.ZWireNullable | null";
        }
        if (signature.foreignNativeName != "ZWireBase") continue;
        for (const method of signature.methods) {
          const initializer = method.objectiveCSelector == "initWithValue:";
          if (method.objectiveCSelector == "extendedValue") throw "unsupported ABI became callable";
          if (method.objectiveCDesignatedInitializer != initializer) throw "lost attached initializer fact";
          if (method.objectiveCRequiresSuper != (method.objectiveCSelector == "requiredValue")) throw "lost attached required-super fact";
          if (method.objectiveCDirect != (method.objectiveCSelector == "directValue")) throw "lost attached direct fact";
          if (method.objectiveCConsumesSelf != (initializer || method.objectiveCSelector == "consume")) throw "lost attached consumes-self fact";
          if (method.objectiveCVariadic != (method.objectiveCSelector == "log:")) throw "lost attached variadic fact";
          if (method.objectiveCSelector == "takeIndex:object:") {
            if (method.objectiveCConsumedParameters.length != 1 || method.objectiveCConsumedParameters[0] != 1) throw "lost attached consumed parameter index";
          } else if (method.objectiveCConsumedParameters.length != 0) throw "invented consumed parameter";
          attachedCount = attachedCount + 1;
        }
        for (const method of signature.foreignObjCUnrepresentableMethods) {
          if (method.objectiveCSelector != "extendedValue" || !method.objectiveCDirect) throw "lost excluded ABI safety facts";
          excludedCount = excludedCount + 1;
        }
      }
      none => {}
    }
  }
  if (attachedCount != 12 || excludedCount != 1 || !attachedFinal || !attachedNullable) throw "missing attached subclass evidence";
  match (attempt validateNativeObjCSubclassDeclarations(parsedModules, resolved)) {
    success => {}
    failure(error) => throw `${error.code}: ${error.message}`;
  }
  if (mode == "types" || mode == "plans" || mode == "interfaces"
    || mode == "missing-super" || mode == "wrong-dispatch" || mode == "wrong-abi"
    || mode == "missing-access" || mode == "wrong-access") {
    match (attempt prepareNativeObjCSubclassTypes(parsedModules, inout resolved)) {
      success => {}
      failure(error) => throw `${error.code}: ${error.message}`;
    }
    let evidence = match (attempt validateNativeObjCSubclassBodyTypes(parsedModules[0], resolved, 0)) {
      success(value) => value;
      failure(error) => throw `${error.code}: ${error.message}`;
    };
    if (mode == "types") {
      for (const call of evidence.callResolutions) {
        console.log(`${call.kind}:${call.objectiveCSelector}:${call.returnType}`);
      }
    } else {
      let index: usize = 0;
      while (index < evidence.callResolutions.length) {
        if (evidence.callResolutions[index].kind == "objcSuper") {
          if (mode == "missing-super") evidence.callResolutions[index].offset = 0;
          if (mode == "wrong-dispatch") evidence.callResolutions[index].kind = "method";
          if (mode == "wrong-abi") evidence.callResolutions[index].objectiveCNativeReturnType = "double";
        }
        index = index + 1;
      }
      if (mode == "missing-access" || mode == "wrong-access") {
        let symbol: usize = 0;
        while (symbol < resolved[0].symbols.length) {
          match (copy resolved[0].symbols[symbol].typeSignature) {
            some(signature) => {
              if (signature.foreignKind == "objcSubclass") {
                let changed = move signature;
                changed.methods[0].receiverMode = mode == "missing-access" ? "" : "inout";
                resolved[0].symbols[symbol].typeSignature = Option.some(move changed);
              }
            }
            none => {}
          }
          symbol = symbol + 1;
        }
      }
      const plans = match (attempt planNativeObjCSubclasses(parsedModules[0], resolved, 0, evidence)) {
        success(value) => value;
        failure(error) => throw `${error.code}: ${error.message}`;
      };
      // A caller assembling its own unchecked graph cannot accidentally get
      // an ordinary Z ARC class from a native subclass declaration either.
      const detachedSource = ModuleSource({ path: "unlinked.zs", source:
        "class Probe extends MissingBase on thread.main { constructor() { super.init(); } } function main(): i32 { return 0; }",
        packageSpecifiers: Array<String>(),
      });
      const detached = match (attempt parseModule(detachedSource)) {
        success(value) => value;
        failure(error) => throw copy error.message;
      };
      const empty = emptySemanticEvidence();
      match (attempt lowerProgram(detached.program, empty)) {
        success(_) => throw "native subclass incorrectly lowered as an ordinary Z ARC class";
        failure(message) => {
          if (message != "internal compiler error: native lowering: native Objective-C subclass bodies require dedicated native lowering and emission") throw message;
        }
      }
      if (mode == "interfaces") {
        const declarations = try emitNativeObjCSubclassInterfaces(plans);
        console.log(declarations);
      } else {
        for (const plan of plans) {
          console.log(`class ${plan.sourceName}:${plan.nativeName}:${plan.superclassNativeName}:${plan.foreignHeader}`);
          console.log(`initializer ${plan.initializer.selector}:${plan.initializer.nativeReturnType}`);
          for (const type of plan.initializer.nativeParameterTypes) { console.log(`argument ${type}`); }
          for (const method of plan.methods) {
            console.log(`entry ${method.sourceName}:${method.selector}:${method.nativeReturnType}`);
            for (const type of method.nativeParameterTypes) { console.log(`parameter ${type}`); }
          }
          for (const call of plan.superCalls) {
            console.log(`dispatch ${call.initializesReceiver}:${call.selector}:${call.nativeReturnType}`);
          }
        }
      }
    }
  }
  if (mode == "gate") {
    match (attempt resolveParsedModulesWithForeignContracts(parsedModules, "probe.zs", foreignModules)) {
      success(_) => {}
      failure(error) => throw `${error.code}: ${error.message}`;
    }
  }
  return 0;
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length < 1 || arguments.length > 6) return 2;
  const sourcePath = arguments.length > 1 ? copy arguments[1] : "";
  const mode = arguments.length >= 3 ? copy arguments[2] : "";
  const platform = arguments.length >= 4 ? copy arguments[3] : "macos";
  const minimumVersion = arguments.length >= 5 ? copy arguments[4] : "13.0";
  const header = arguments.length >= 6 ? copy arguments[5] : "objc-subclass-wire.h";
  return match (attempt inspect(arguments[0], sourcePath, mode, platform, minimumVersion, header)) {
    success(code) => code;
    failure(error) => { console.log(error); select 1; }
  };
}
