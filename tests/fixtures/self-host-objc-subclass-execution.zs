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

// The host supplies raw Clang declarations, never Stage 0 semantic/lowering
// evidence. Resolve, own, lower, and emit the real subclass entirely in Z.
function emit(in wirePath: String, in sourcePath: String, in companionPath: String): String throws String {
  const wire = try fs.readText(wirePath);
  const raw = try decodeRawForeignDeclarations(wire);
  const declarations = try parseForeignContracts(`declare module "./objc-subclass.h" {}`, "empty.zd");
  const contracts = try normalizeForeignContracts(declarations, raw, "./objc-subclass.h");
  const source = try fs.readText(sourcePath);
  const input = ModuleSource({ path: copy sourcePath, source, packageSpecifiers: Array<String>(), targetPlatform: "macos", targetMinimumVersion: "14.0" });
  const parsed = match (attempt parseModule(input)) {
    success(value) => value;
    failure(error) => throw copy error.message;
  };
  let modules = Array<ParsedModule>(parsed);
  if (companionPath.byteLength > 0) {
    const companionSource = try fs.readText(companionPath);
    const companionInput = ModuleSource({ path: copy companionPath, source: companionSource, packageSpecifiers: Array<String>(), targetPlatform: "macos", targetMinimumVersion: "14.0" });
    const companion = match (attempt parseModule(companionInput)) {
      success(value) => value;
      failure(error) => throw copy error.message;
    };
    modules.push(companion);
  }
  const foreign = Array<NativeForeignModuleContract>(NativeForeignModuleContract({
    modulePath: companionPath.byteLength > 0 ? copy companionPath : copy sourcePath, cacheKey: "subclass-execution", dependencyPath: "", contracts,
  }));
  const graph = match (attempt resolveParsedModulesWithForeignContracts(modules, sourcePath, foreign)) {
    success(value) => value;
    failure(error) => throw `${error.code}: ${error.message}`;
  };
  return try emitModulesC(modules, graph);
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length != 2 && arguments.length != 3) return 2;
  const companion = arguments.length == 3 ? copy arguments[2] : "";
  return match (attempt emit(arguments[0], arguments[1], companion)) {
    success(source) => { console.write(source); select 0; }
    failure(error) => { console.error(error); select 1; }
  };
}
