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
import { planNativeObjCSubclasses } from "../../compiler/frontend/semantic-objc-subclass-plans.zs";
import { emptySemanticEvidence } from "../../compiler/frontend/semantic-evidence.zs";

// The host supplies raw Clang declarations, never Stage 0 semantic/lowering
// evidence. Resolve, own, lower, and emit the real subclass entirely in Z.
function emit(in wirePath: String, in sourcePath: String, in companionPath: String, in contractPath: String, in corruption: String): String throws String {
  const wire = try fs.readText(wirePath);
  const raw = try decodeRawForeignDeclarations(wire);
  const contractSource = contractPath.byteLength > 0 ? try fs.readText(contractPath) : `declare module "./objc-subclass.h" {}`;
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
  let foreign = Array<NativeForeignModuleContract>();
  for (const module of modules) {
    for (const declaration of module.program.imports) {
      if (declaration.header != "./objc-subclass.h" && declaration.header != "./objc-object.h"
        && declaration.header != "./objc-instanceof.h"
        && declaration.header != "./objc-blocks.h"
        && declaration.header != "AppKit/AppKit.h") continue;
      const declarations = try parseForeignContracts(copy contractSource, "objc-subclass.h.zd");
      const contracts = try normalizeForeignContracts(declarations, raw, declaration.header);
      foreign.push(NativeForeignModuleContract({
        modulePath: copy module.path, cacheKey: "subclass-execution", dependencyPath: "", contracts,
      }));
    }
  }
  let graph = match (attempt resolveParsedModulesWithForeignContracts(modules, sourcePath, foreign)) {
    success(value) => value;
    failure(error) => throw `${error.code}: ${error.message}`;
  };
  if (corruption == "empty-call-header") {
    // Header provenance on a call is optional; the checked import still owns
    // the ABI dependency. Real SDK C calls can have this evidence shape.
    let call: usize = 0;
    while (call < graph.modules[0].semanticEvidence.callResolutions.length) {
      graph.modules[0].semanticEvidence.callResolutions[call].foreignHeader = "";
      call = call + 1;
    }
  } else if (corruption.byteLength > 0) {
    // The planner consumes call evidence only. Keep this a minimal corrupted
    // proof, not a deep copy of the resolver's ownership-bearing lookup Maps.
    let evidence = emptySemanticEvidence();
    evidence.callResolutions = copy graph.modules[0].semanticEvidence.callResolutions;
    let call: usize = 0;
    let changed = false;
    while (call < evidence.callResolutions.length) {
      if (evidence.callResolutions[call].objectiveCReceiverHandoff
        && evidence.callResolutions[call].objectiveCHandoffParameterObjects.length > 0
        && evidence.callResolutions[call].objectiveCHandoffParameterObjects[0]) {
        if (corruption == "missing-lifetime") {
          evidence.callResolutions[call].objectiveCHandoffParameterObjects = Array<boolean>();
        } else if (corruption == "wrong-lifetime") {
          evidence.callResolutions[call].objectiveCHandoffParameterObjects[0] = false;
        } else throw "unknown evidence corruption";
        changed = true;
        break;
      }
      call = call + 1;
    }
    if (!changed) throw "no object handoff available for corruption";
    match (attempt planNativeObjCSubclasses(modules[0], graph.modules, 0, evidence)) {
      success(plans) => throw "corrupt lifetime evidence was accepted";
      failure(error) => throw copy error.message;
    }
  }
  return try emitModulesC(modules, graph);
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length < 2 || arguments.length > 5) return 2;
  const companion = arguments.length >= 3 ? copy arguments[2] : "";
  const contract = arguments.length >= 4 ? copy arguments[3] : "";
  const corruption = arguments.length == 5 ? copy arguments[4] : "";
  return match (attempt emit(arguments[0], arguments[1], companion, contract, corruption)) {
    success(source) => { console.write(source); select 0; }
    failure(error) => { console.error(error); select 1; }
  };
}
