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

function emit(in directory: String): String throws String {
  const entry = `${directory}/main.zs`;
  let modules = Array<ParsedModule>();
  let foreign = Array<NativeForeignModuleContract>();
  const files = Array<String>("main.zs", "contract.zs");
  for (const file of files) {
    const path = `${directory}/${file}`;
    const source = try fs.readText(path);
    const parsed = match (attempt parseModule(ModuleSource({ path: copy path, source,
      packageSpecifiers: Array<String>(), targetPlatform: "macos", targetMinimumVersion: "14.0" }))) {
      success(value) => value;
      failure(error) => throw copy error.message;
    };
    const wire = try fs.readText(`${directory}/foundation.zfdcl`);
    const raw = try decodeRawForeignDeclarations(wire);
    const declarations = try parseForeignContracts("declare module \"Foundation/Foundation.h\" {}", "Foundation/Foundation.h");
    const contracts = try normalizeForeignContracts(declarations, raw, "Foundation/Foundation.h");
    foreign.push(NativeForeignModuleContract({ modulePath: copy path, cacheKey: "Foundation/Foundation.h", dependencyPath: "", contracts }));
    modules.push(move parsed);
  }
  const graph = match (attempt resolveParsedModulesWithForeignContracts(modules, entry, foreign)) {
    success(value) => value;
    failure(error) => throw `${error.code}: ${error.message}`;
  };
  return try emitModulesC(modules, graph);
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length != 1) return 2;
  return match (attempt emit(arguments[0])) {
    success(source) => { console.write(source); select 0; }
    failure(error) => { console.error(error); select 1; }
  };
}
