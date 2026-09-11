import fs from "std/fs";
import process from "std/process";
import console from "std/console";
import { decodeRawForeignDeclarations } from "../../compiler/frontend/foreign-declaration-protocol.zs";
import { normalizeForeignContracts, parseForeignContracts } from "../../compiler/frontend/foreign-contracts.zs";
import { parseModule } from "../../compiler/frontend/module-graph.zs";
import { ParsedModule } from "../../compiler/frontend/module-symbols.zs";
import { ModuleSource } from "../../compiler/frontend/semantic-model.zs";
import { NativeForeignModuleContract } from "../../compiler/frontend/semantic-foreign.zs";
import { resolveParsedModulesWithForeignContracts } from "../../compiler/frontend/module-resolver.zs";
import { emitModulesC } from "../../compiler/frontend/c-emitter.zs";

// Independent checker/emitter: real imported Clang streams, no Stage 0 semantic
// evidence. The test supplies raw streams and contracts per imported header.
function emit(in directory: String, in sourcePath: String): String throws String {
  const source = try fs.readText(sourcePath);
  const input = ModuleSource({ path: copy sourcePath, source, packageSpecifiers: Array<String>(), targetPlatform: "macos", targetMinimumVersion: "14.0" });
  const parsed = match (attempt parseModule(input)) {
    success(value) => value;
    failure(error) => throw copy error.message;
  };
  let foreign = Array<NativeForeignModuleContract>();
  for (const declaration of parsed.program.imports) {
    if (declaration.header != "./objc-forward.h" && declaration.header != "./objc-subclass.h"
      && declaration.header != "./objc-registration.h" && declaration.header != "./reference-identity.h") continue;
    const wire = try fs.readText(`${directory}/${declaration.header}.zfdcl`);
    const raw = try decodeRawForeignDeclarations(wire);
    const declarationSource = try fs.readText(`${directory}/${declaration.header}.zd`);
    const declarations = try parseForeignContracts(declarationSource, declaration.header);
    const contracts = try normalizeForeignContracts(declarations, raw, declaration.header);
    foreign.push(NativeForeignModuleContract({ modulePath: copy sourcePath, cacheKey: copy declaration.header, dependencyPath: "", contracts }));
  }
  const modules = Array<ParsedModule>(parsed);
  const graph = match (attempt resolveParsedModulesWithForeignContracts(modules, sourcePath, foreign)) {
    success(value) => value;
    failure(error) => throw `${error.code}: ${error.message}`;
  };
  return try emitModulesC(modules, graph);
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length != 2) return 2;
  return match (attempt emit(arguments[0], arguments[1])) {
    success(source) => { console.write(source); select 0; }
    failure(error) => { console.error(error); select 1; }
  };
}
