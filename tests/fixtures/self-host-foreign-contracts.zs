import fs from "std/fs";
import process from "std/process";
import console from "std/console";
import {
  decodeRawForeignDeclarations,
} from "../../compiler/frontend/foreign-declaration-protocol.zs";
import {
  normalizeForeignContracts,
  parseForeignContracts,
} from "../../compiler/frontend/foreign-contracts.zs";
import {
  parseModule,
} from "../../compiler/frontend/module-graph.zs";
import {
  resolveParsedModulesWithForeignContracts,
} from "../../compiler/frontend/module-resolver.zs";
import {
  NativeForeignModuleContract,
} from "../../compiler/frontend/semantic-foreign.zs";
import { nativeObjCObjectTypeName } from "../../compiler/frontend/semantic-type-shapes.zs";
import {
  emitModulesC,
} from "../../compiler/frontend/c-emitter.zs";
import {
  ModuleSource,
} from "../../compiler/frontend/semantic-model.zs";
import {
  ParsedModule,
  moduleSymbolIndex,
} from "../../compiler/frontend/module-symbols.zs";

function inspectObjC(
  in declarationPath: String,
  in contractPath: String,
  in sourcePath: String,
  in expectedError: String,
  in emittedPath: String
): i32 throws String {
  const declarationSource = try fs.readText(declarationPath);
  const declarations = try decodeRawForeignDeclarations(declarationSource);
  const contractSource = try fs.readText(contractPath);
  const contracts = try parseForeignContracts(contractSource, contractPath);
  const normalized = try normalizeForeignContracts(
    contracts,
    declarations,
    "objc-registration-wire.h"
  );
  if (normalized.objectiveCProtocols.length != 2) return 80;
  if (normalized.objectiveCInterfaces.length != 3) return 81;
  const protocol = view normalized.objectiveCProtocols[1];
  if (protocol.name != "ZRegistrationHandler") return 82;
  if (protocol.inherited.length != 1) return 83;
  if (protocol.inherited[0] != "ZBaseHandler") return 84;
  if (protocol.methods.length != 1) return 85;
  if (
    protocol.methods[0].selector
      != "registrationOwner:didReceiveValue:"
  ) return 86;
  if (protocol.methods[0].returnType != "void") return 87;
  if (protocol.methods[0].parameters[1].typeName != "i32") return 88;
  const interface_ = view normalized.objectiveCInterfaces[1];
  if (interface_.name != "ZRegistrationOwner") return 89;
  const affinityInterface = view normalized.objectiveCInterfaces[2];
  if (affinityInterface.name != "ZPropertyOwner") return 134;
  if (affinityInterface.executorAffinity != "thread.main") return 135;
  if (interface_.methods.length != 8) return 90;
  if (interface_.methods[0].selector != "addHandler:name:") return 91;
  if (interface_.methods[0].parameters[0].typeName != nativeObjCObjectTypeName) return 92;
  if (interface_.methods[0].parameters[0].protocols.length != 1) return 93;
  if (
    interface_.methods[0].parameters[0].protocols[0]
      != "ZRegistrationHandler"
  ) return 94;
  if (interface_.methods[0].parameters[1].typeName != "cstring") return 95;
  const infallibleAsync = view interface_.methods[5];
  if (infallibleAsync.name != "fetchValue") return 136;
  match (in infallibleAsync.asyncCallbackParameter) {
    some(index) => if (index != 0) return 137;
    none => return 138;
  }
  match (in infallibleAsync.asyncResultParameter) {
    some(index) => if (index != 0) return 139;
    none => return 140;
  }
  match (in infallibleAsync.asyncErrorParameter) {
    some(_) => return 141;
    none => {}
  }
  const throwingAsync = view interface_.methods[6];
  if (throwingAsync.name != "fetchValueOrError") return 142;
  match (in throwingAsync.asyncCallbackParameter) {
    some(index) => if (index != 0) return 143;
    none => return 144;
  }
  match (in throwingAsync.asyncResultParameter) {
    some(index) => if (index != 0) return 145;
    none => return 146;
  }
  match (in throwingAsync.asyncErrorParameter) {
    some(index) => if (index != 1) return 147;
    none => return 148;
  }
  const objectAsync = view interface_.methods[7];
  if (objectAsync.name != "fetchOwner") return 149;
  match (in objectAsync.asyncResultParameter) {
    some(index) => if (index != 0) return 150;
    none => return 151;
  }

  const source = try fs.readText(sourcePath);
  const moduleSource = ModuleSource({
    path: sourcePath.copyBytes(0, sourcePath.byteLength),
    source,
    packageSpecifiers: Array<String>(),
  });
  const parsedOutcome = attempt parseModule(moduleSource);
  const parsed = match (parsedOutcome) {
    success(value) => value;
    failure(error) => throw error.message.copyBytes(
      0,
      error.message.byteLength
    );
  };
  let modules = Array<ParsedModule>();
  modules.push(parsed);
  let foreignModules = Array<NativeForeignModuleContract>();
  foreignModules.push(NativeForeignModuleContract({
    modulePath: sourcePath.copyBytes(0, sourcePath.byteLength),
    cacheKey: "objc-fixture",
    dependencyPath: "",
    contracts: normalized,
  }));
  const graphOutcome = attempt resolveParsedModulesWithForeignContracts(
    modules,
    sourcePath,
    foreignModules
  );
  if (expectedError.byteLength > 0) {
    return match (graphOutcome) {
      success(_) => 108;
      failure(error) => {
        if (error.code != "Z0812") return 109;
        if (error.message != expectedError) return 110;
        return 0;
      }
    };
  }
  const graph = match (graphOutcome) {
    success(value) => value;
    failure(error) => throw error.message.copyBytes(
      0,
      error.message.byteLength
    );
  };
  if (
    emittedPath.byteLength > 0
    && graph.modules[0].semanticEvidence.objectiveCRegistrations.length == 1
  ) {
    const registration = view graph.modules[0]
      .semanticEvidence.objectiveCRegistrations[0];
    if (registration.receiverNativeType != "ZRegistrationOwner") return 120;
    if (registration.ownerType != "Handler") return 121;
    if (registration.protocolNativeNames.length != 1) return 122;
    if (registration.protocolNativeNames[0] != "ZRegistrationHandler") {
      return 123;
    }
    if (registration.protocolMethods.length != 1) return 124;
    if (
      registration.protocolMethods[0].selector
        != "registrationOwner:didReceiveValue:"
    ) return 125;
    if (registration.protocolMethods[0].targetName != "receive") return 126;
    if (registration.addSelector != "addHandler:name:") return 127;
    if (registration.handlerParameter != 0) return 128;
    if (registration.removeArgumentSources.length != 1) return 129;
    if (registration.removeArgumentSources[0] != 1) return 130;
    const emitted = try emitModulesC(modules, graph);
    try fs.writeText(emittedPath, emitted);
    return 0;
  }
  if (emittedPath.byteLength > 0) {
    if (
      graph.modules[0].semanticEvidence.callResolutions.length == 3
      && graph.modules[0].semanticEvidence.callResolutions[0]
        .objectiveCSelector == "maybeOwner"
    ) {
      const firstMaybe = view graph.modules[0]
        .semanticEvidence.callResolutions[0];
      const secondMaybe = view graph.modules[0]
        .semanticEvidence.callResolutions[1];
      const comparison = view graph.modules[0]
        .semanticEvidence.callResolutions[2];
      if (firstMaybe.objectiveCSelector != "maybeOwner") return 131;
      if (secondMaybe.objectiveCSelector != "maybeOwner") return 132;
      if (comparison.objectiveCSelector != "compareOwner:") return 133;
      const emitted = try emitModulesC(modules, graph);
      try fs.writeText(emittedPath, emitted);
      return 0;
    }
    let foundSharedOwner = false;
    let foundFetchOwner = false;
    let foundCompareOwner = false;
    for (
      const resolution
      of graph.modules[0].semanticEvidence.callResolutions
    ) {
      if (resolution.objectiveCSelector == "sharedOwner") {
        foundSharedOwner = true;
      } else if (resolution.objectiveCSelector == "fetchOwner:") {
        foundFetchOwner = true;
      } else if (resolution.objectiveCSelector == "compareOwner:") {
        foundCompareOwner = true;
      }
    }
    if (foundSharedOwner && foundFetchOwner && foundCompareOwner) {
      const emitted = try emitModulesC(modules, graph);
      try fs.writeText(emittedPath, emitted);
      return 0;
    }
    if (graph.modules[0].semanticEvidence.callResolutions.length != 2) {
      return 111;
    }
    const classCall = view graph.modules[0]
      .semanticEvidence.callResolutions[0];
    if (classCall.kind != "staticMethod") return 112;
    if (classCall.objectiveCSelector != "sharedOwner") return 113;
    if (classCall.objectiveCReceiverNativeType != "ZRegistrationOwner") {
      return 114;
    }
    if (classCall.objectiveCNativeReturnType != "ZRegistrationOwner *") {
      return 115;
    }
    const instanceCall = view graph.modules[0]
      .semanticEvidence.callResolutions[1];
    if (instanceCall.kind != "method") return 116;
    if (
      instanceCall.objectiveCSelector != "removeHandlerForName:"
    ) return 117;
    if (instanceCall.objectiveCParameterNativeTypes.length != 1) {
      return 118;
    }
    if (
      instanceCall.objectiveCParameterNativeTypes[0] != "const char *"
    ) return 119;
    const emitted = try emitModulesC(modules, graph);
    try fs.writeText(emittedPath, emitted);
    return 0;
  }
  const ownerIndex = moduleSymbolIndex(
    graph.modules[0],
    "native.ZRegistrationOwner"
  );
  if (ownerIndex >= graph.modules[0].symbols.length) return 96;
  const protocolIndex = moduleSymbolIndex(
    graph.modules[0],
    "native.ZRegistrationHandler"
  );
  if (protocolIndex >= graph.modules[0].symbols.length) return 97;
  match (in graph.modules[0].symbols[ownerIndex].typeSignature) {
    some(ownerType) => {
      if (ownerType.foreignKind != "objcInterface") return 99;
      if (ownerType.methods.length != 5) return 100;
      if (ownerType.methods[0].objectiveCSelector != "addHandler:name:") {
        return 101;
      }
      if (ownerType.methods[0].objectiveCParameterProtocols.length != 1) {
        return 102;
      }
      if (
        ownerType.methods[0].objectiveCParameterProtocols[0].protocolName
          != "native.ZRegistrationHandler"
      ) return 103;
    }
    none => return 98;
  }
  if (graph.modules[0].semanticEvidence.callResolutions.length != 2) {
    return 104;
  }
  if (graph.modules[0].semanticEvidence.callResolutions[0].kind != "method") {
    return 105;
  }
  if (
    graph.modules[0].semanticEvidence.callResolutions[0].targetName
      != "native.ZRegistrationOwner.addHandler"
  ) return 106;
  if (
    graph.modules[0].semanticEvidence.callResolutions[1].targetName
      != "native.ZRegistrationOwner.removeHandlerForName"
  ) return 107;
  return 0;
}

function inspect(
  in declarationPath: String,
  in contractPath: String,
  in sourcePath: String,
  in outputPath: String
): i32 throws String {
  const declarationSource = try fs.readText(declarationPath);
  const declarations = try decodeRawForeignDeclarations(declarationSource);
  const contractSource = try fs.readText(contractPath);
  const contracts = try parseForeignContracts(contractSource, contractPath);
  const normalized = try normalizeForeignContracts(
    contracts,
    declarations,
    "foreign-functions-only.h"
  );
  if (normalized.moduleSpecifier != "foreign-functions-only.h") return 10;
  if (normalized.types.length != 1) return 45;
  if (normalized.types[0].name != "ZForeignStatus") return 46;
  if (normalized.types[0].nativeName != "ZForeignStatus") return 47;
  if (normalized.types[0].underlyingType != "i32") return 48;
  if (normalized.constants.length != 5) return 52;
  if (normalized.constants[0].name != "Z_FOREIGN_ENUM_OK") return 53;
  if (normalized.constants[0].typeName != "ZForeignStatus") return 54;
  if (normalized.constants[2].typeName != "i32") return 55;
  if (normalized.constants[4].typeName != "u32") return 56;
  if (normalized.functions.length != 5) return 11;
  if (normalized.functions[0].name != "z_foreign_add") return 12;
  if (normalized.functions[0].nativeName != "z_foreign_add") return 13;
  if (normalized.functions[0].returnType != "i32") return 14;
  if (normalized.functions[0].parameters.length != 2) return 15;
  if (normalized.functions[0].parameters[0].name != "left") return 16;
  if (normalized.functions[0].parameters[0].typeName != "i32") return 17;
  if (normalized.functions[0].parameters[1].name != "right") return 18;
  if (normalized.functions[0].parameters[1].typeName != "i32") return 19;
  match (in normalized.functions[0].errorType) {
    some(_) => return 20;
    none => {}
  }
  if (normalized.functions[0].successValues.length != 0) return 21;
  if (normalized.functions[1].name != "z_foreign_status") return 22;
  if (normalized.functions[1].returnType != "void") return 23;
  match (in normalized.functions[1].errorType) {
    some(typeName) => {
      if (typeName != "i32") return 24;
    }
    none => return 25;
  }
  if (normalized.functions[1].successValues.length != 2) return 26;
  if (normalized.functions[1].successValues[0] != "Z_FOREIGN_OK") return 27;
  if (normalized.functions[1].successValues[1] != "Z_FOREIGN_RETRY") return 28;
  if (normalized.functions[2].name != "z_foreign_enum_status") return 29;
  if (normalized.functions[2].returnType != "void") return 30;
  match (in normalized.functions[2].errorType) {
    some(typeName) => {
      if (typeName != "ZForeignStatus") return 31;
    }
    none => return 32;
  }
  if (normalized.functions[2].successValues.length != 1) return 33;
  if (
    normalized.functions[2].successValues[0]
      != "Z_FOREIGN_ENUM_OK"
  ) return 34;
  if (normalized.functions[3].name != "z_foreign_status_code") return 57;
  if (
    normalized.functions[3].parameters[0].typeName
      != "ZForeignStatus"
  ) return 58;
  if (normalized.functions[4].name != "z_foreign_text_length") return 66;
  if (normalized.functions[4].parameters.length != 1) return 67;
  if (normalized.functions[4].parameters[0].typeName != "cstring") return 68;

  const source = try fs.readText(sourcePath);
  const moduleSource = ModuleSource({
    path: sourcePath.copyBytes(0, sourcePath.byteLength),
    source,
    packageSpecifiers: Array<String>(),
  });
  const parsedOutcome = attempt parseModule(moduleSource);
  const parsed = match (parsedOutcome) {
    success(parsed) => parsed;
    failure(error) => throw error.message.copyBytes(
      0,
      error.message.byteLength
    );
  };
  let modules = Array<ParsedModule>();
  modules.push(parsed);
  let foreignModules = Array<NativeForeignModuleContract>();
  foreignModules.push(NativeForeignModuleContract({
    modulePath: sourcePath.copyBytes(0, sourcePath.byteLength),
    cacheKey: "fixture",
    dependencyPath: "",
    contracts: normalized,
  }));
  const graphOutcome = attempt resolveParsedModulesWithForeignContracts(
    modules,
    sourcePath,
    foreignModules
  );
  const graph = match (graphOutcome) {
    success(graph) => graph;
    failure(error) => throw error.message.copyBytes(
      0,
      error.message.byteLength
    );
  };
  if (graph.modules.length != 1) return 29;
  if (graph.modules[0].semanticEvidence.callResolutions.length != 8) return 30;
  if (graph.modules[0].semanticEvidence.callResolutions[0].kind != "foreign") {
    return 31;
  }
  if (
    graph.modules[0].semanticEvidence.callResolutions[0].targetName
      != "z_foreign_add"
  ) return 32;
  if (graph.modules[0].semanticEvidence.callResolutions[0].returnType != "i32") {
    return 33;
  }
  if (graph.modules[0].semanticEvidence.callResolutions[0].errorType != "") {
    return 34;
  }
  if (graph.modules[0].semanticEvidence.callResolutions[1].kind != "foreign") {
    return 35;
  }
  if (
    graph.modules[0].semanticEvidence.callResolutions[1].targetName
      != "z_foreign_add"
  ) return 36;
  if (graph.modules[0].semanticEvidence.callResolutions[2].kind != "foreign") {
    return 37;
  }
  if (
    graph.modules[0].semanticEvidence.callResolutions[2].targetName
      != "z_foreign_status"
  ) return 38;
  if (graph.modules[0].semanticEvidence.callResolutions[2].returnType != "void") {
    return 39;
  }
  if (graph.modules[0].semanticEvidence.callResolutions[2].errorType != "i32") {
    return 40;
  }
  if (graph.modules[0].semanticEvidence.callResolutions[3].kind != "foreign") {
    return 41;
  }
  if (
    graph.modules[0].semanticEvidence.callResolutions[3].targetName
      != "z_foreign_enum_status"
  ) return 42;
  if (graph.modules[0].semanticEvidence.callResolutions[3].returnType != "void") {
    return 43;
  }
  if (
    graph.modules[0].semanticEvidence.callResolutions[3].errorType
      != "__z_selective_import_0.ZForeignStatus"
  ) {
    return 44;
  }
  if (graph.modules[0].semanticEvidence.callResolutions[4].kind != "foreign") {
    return 49;
  }
  if (
    graph.modules[0].semanticEvidence.callResolutions[4].targetName
      != "z_foreign_enum_status"
  ) return 50;
  if (
    graph.modules[0].semanticEvidence.callResolutions[4].errorType
      != "native.ZForeignStatus"
  ) return 51;
  if (
    graph.modules[0].semanticEvidence.callResolutions[5].targetName
      != "z_foreign_status_code"
  ) return 59;
  if (
    graph.modules[0].semanticEvidence.callResolutions[5].parameterTypes[0]
      != "native.ZForeignStatus"
  ) return 60;
  if (
    graph.modules[0].semanticEvidence.callResolutions[6].targetName
      != "z_foreign_status_code"
  ) return 61;
  if (
    graph.modules[0].semanticEvidence.callResolutions[6].parameterTypes[0]
      != "__z_selective_import_0.ZForeignStatus"
  ) return 62;
  if (
    graph.modules[0].semanticEvidence.callResolutions[7].targetName
      != "z_foreign_text_length"
  ) return 69;
  if (
    graph.modules[0].semanticEvidence.callResolutions[7].parameterTypes[0]
      != "cstring"
  ) return 70;
  if (
    graph.modules[0].semanticEvidence.callResolutions[7].parameterModes[0]
      != "in"
  ) return 71;
  let constantEvidence: usize = 0;
  for (
    const resolution
    of graph.modules[0].semanticEvidence.expressionResolutions
  ) {
    if (resolution.targetName == "Z_FOREIGN_ENUM_OK") {
      if (resolution.typeName != "native.ZForeignStatus") return 63;
      constantEvidence = constantEvidence + 1;
    }
    if (resolution.targetName == "Z_FOREIGN_ENUM_FAILED") {
      if (
        resolution.typeName
          != "__z_selective_import_1.ZForeignStatus"
      ) return 64;
      constantEvidence = constantEvidence + 1;
    }
  }
  if (constantEvidence != 2) return 65;
  const emitted = try emitModulesC(modules, graph);
  try fs.writeText(outputPath, emitted);
  return 0;
}

function main(): i32 {
  const arguments = process.args();
  if (
    (arguments.length == 4 || arguments.length == 5)
    && (
      arguments[3] == "objc"
      || arguments[3] == "objc-protocol-negative"
      || arguments[3] == "objc-teardown-negative"
      || arguments[3] == "objc-direct"
    )
  ) {
    let expectedError = "";
    if (arguments[3] == "objc-protocol-negative") {
      expectedError = "Handler does not implement Objective-C protocol native.ZRegistrationHandler";
    } else if (arguments[3] == "objc-teardown-negative") {
      expectedError = "objc.register remove arguments must reuse exactly one add-time named or literal value with the same native ABI type";
    }
    let emittedPath = "";
    if (arguments.length == 5) emittedPath = copy arguments[4];
    const outcome = attempt inspectObjC(
      arguments[0],
      arguments[1],
      arguments[2],
      expectedError,
      emittedPath
    );
    return match (outcome) {
      success(code) => code;
      failure(error) => {
        console.error(error);
        return 3;
      }
    };
  }
  if (arguments.length != 4) return 2;
  const outcome = attempt inspect(
    arguments[0],
    arguments[1],
    arguments[2],
    arguments[3]
  );
  return match (outcome) {
    success(code) => code;
    failure(_) => 3;
  };
}
