import fs from "std/fs";
import process from "std/process";
import console from "std/console";
import { decodeRawForeignDeclarations } from "../../compiler/frontend/foreign-declaration-protocol.zs";
import { normalizeForeignContracts, parseForeignContracts } from "../../compiler/frontend/foreign-contracts.zs";
import { parseModule, buildResolvedModules } from "../../compiler/frontend/module-graph.zs";
import { ParsedModule, moduleSymbolIndex } from "../../compiler/frontend/module-symbols.zs";
import { ModuleSource, ModuleTypeSignature, ResolvedModule, moduleTypeSignatureWithMethods } from "../../compiler/frontend/semantic-model.zs";
import { NativeForeignModuleContract, attachForeignContracts } from "../../compiler/frontend/semantic-foreign.zs";

function signature(in modules: Array<ResolvedModule>, index: usize, in name: String): ModuleTypeSignature throws String {
  const symbol = moduleSymbolIndex(modules[index], name);
  if (symbol >= modules[index].symbols.length) throw `missing ${name}`;
  return match (in modules[index].symbols[symbol].typeSignature) {
    some(value) => value;
    none => throw `missing signature ${name}`;
  };
}

function inspect(in wirePath: String): void throws String {
  const wire = try fs.readText(wirePath);
  const raw = try decodeRawForeignDeclarations(wire);
  const plain = try parseForeignContracts(`declare module "foreign-signature-sharing.h" {}`, "plain.zd");
  const isolated = try parseForeignContracts(`declare module "foreign-signature-sharing.h" {
    export type ZSharedObject on thread.main;
  }`, "isolated.zd");
  const shared = try normalizeForeignContracts(plain, raw, "foreign-signature-sharing.h");
  const different = try normalizeForeignContracts(isolated, raw, "foreign-signature-sharing.h");
  let parsed = Array<ParsedModule>();
  let foreign = Array<NativeForeignModuleContract>();
  let index: usize = 0;
  while (index < 4) {
    const namespace = index == 2 ? "other" : "native";
    const path = `/sharing-${index}.zs`;
    const source = `import ${namespace} from "foreign-signature-sharing.h";`;
    const input = ModuleSource({ path: copy path, source, packageSpecifiers: Array<String>() });
    const module = match (attempt parseModule(input)) {
      success(value) => value;
      failure(error) => throw copy error.message;
    };
    parsed.push(module);
    foreign.push(NativeForeignModuleContract({
      modulePath: path, cacheKey: "deliberately-identical", dependencyPath: "",
      contracts: index == 3 ? different : shared,
    }));
    index = index + 1;
  }
  let modules = match (attempt buildResolvedModules(parsed)) {
    success(value) => value;
    failure(error) => throw copy error.message;
  };
  match (attempt attachForeignContracts(parsed, foreign, inout modules)) {
    success => {}
    failure(error) => throw copy error.message;
  }
  const first = try signature(modules, 0, "native.ZSharedObject");
  const second = try signature(modules, 1, "native.ZSharedObject");
  const renamed = try signature(modules, 2, "other.ZSharedObject");
  const isolatedType = try signature(modules, 3, "native.ZSharedObject");
  if (first != second) throw "identical contract and namespace did not share";
  if (first == renamed || first == isolatedType) throw "distinct namespace or contract merged";
  if (first.executorAffinity != "" || isolatedType.executorAffinity != "thread.main") throw "affinity leaked between contracts";
  let checkedReturn = false;
  for (const method of renamed.methods) {
    if (method.name == "next") {
      if (method.signature.returnType != "other.ZSharedObject") throw "alias was not localized";
      checkedReturn = true;
    }
  }
  if (!checkedReturn) throw "missing object return";
  if (try signature(modules, 0, "native.ZSharedRecord") != try signature(modules, 1, "native.ZSharedRecord")) throw "record not shared";
  if (try signature(modules, 0, "native.ZSharedProtocol") != try signature(modules, 1, "native.ZSharedProtocol")) throw "protocol not shared";
  let methods = copy first.methods;
  methods[0].signature.nonEscapingParameters.push(0);
  const refined = moduleTypeSignatureWithMethods(first, move methods);
  if (refined == first || refined.methods[0].signature.nonEscapingParameters.length != 1) throw "refinement did not replace";
  if (second.methods[0].signature.nonEscapingParameters.length != 0) throw "refinement mutated a shared signature";
  if (refined.fields.length != first.fields.length || refined.foreignNativeName != first.foreignNativeName) throw "refinement lost metadata";
  if (modules[0].path == modules[1].path) throw "module identity merged";
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length != 1) return 2;
  return match (attempt inspect(arguments[0])) {
    success => { console.log("signature sharing passed"); select 0; }
    failure(error) => { console.error(error); select 1; }
  };
}
