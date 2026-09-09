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
  requireNativeObjCSubclassBodySupport, validateNativeObjCSubclassDeclarations,
} from "../../compiler/frontend/semantic-objc-subclasses.zs";

function inspect(in path: String, in sourcePath: String, gate: boolean): i32 throws String {
  const source = try fs.readText(path);
  const module = try decodeRawForeignDeclarations(source);
  if (module.version != 14) throw "wrong foreign protocol version";
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
  if (!foundBase || !foundFinal || observed != 10) throw "missing native subclass evidence";
  const contracts = try parseForeignContracts(
    "declare module \"objc-subclass-wire.h\" {}", "wire.zd"
  );
  const normalized = try normalizeForeignContracts(contracts, module, "objc-subclass-wire.h");
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
  if (normalizedCount != 10) throw "dropped normalized native methods";
  let programSource = "import native from \"objc-subclass-wire.h\"; function main(): i32 { return 0; }";
  if (sourcePath.byteLength > 0) programSource = try fs.readText(sourcePath);
  const moduleSource = ModuleSource({
    path: "probe.zs", source: programSource, packageSpecifiers: Array<String>(),
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
  if (attachedCount != 9 || excludedCount != 1 || !attachedFinal || !attachedNullable) throw "missing attached subclass evidence";
  match (attempt validateNativeObjCSubclassDeclarations(parsedModules, resolved)) {
    success => {}
    failure(error) => throw `${error.code}: ${error.message}`;
  }
  if (gate) {
    match (attempt requireNativeObjCSubclassBodySupport(parsedModules)) {
      success => {}
      failure(error) => throw `${error.code}: ${error.message}`;
    }
  }
  return 0;
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length < 1 || arguments.length > 3) return 2;
  const sourcePath = arguments.length > 1 ? copy arguments[1] : "";
  return match (attempt inspect(arguments[0], sourcePath, arguments.length == 3)) {
    success(code) => code;
    failure(error) => { console.log(error); select 1; }
  };
}
