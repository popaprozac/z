import fs from "std/fs";
import process from "std/process";
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
import {
  emitModulesC,
} from "../../compiler/frontend/c-emitter.zs";
import {
  ModuleSource,
} from "../../compiler/frontend/semantic-model.zs";
import {
  ParsedModule,
} from "../../compiler/frontend/module-symbols.zs";

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
  if (normalized.functions.length != 2) return 11;
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

  const source = try fs.readText(sourcePath);
  const moduleSource = ModuleSource({
    path: sourcePath.copyBytes(0, sourcePath.byteLength),
    source,
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
  if (graph.modules[0].semanticEvidence.callResolutions.length != 3) return 30;
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
  const emitted = try emitModulesC(modules, graph);
  try fs.writeText(outputPath, emitted);
  return 0;
}

function main(): i32 {
  const arguments = process.args();
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
