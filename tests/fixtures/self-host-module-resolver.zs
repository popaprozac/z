import {
  ModuleGraph,
  ModuleResolveErrorKind,
  ModuleSource,
  resolveModules,
} from "../../compiler/frontend/module-resolver.zs";

function module(in path: String, in source: String): ModuleSource {
  return ModuleSource({
    path: path.copyBytes(0, path.byteLength),
    source: source.copyBytes(0, source.byteLength),
  });
}

function successfulGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/app/main.zs", `
import { value as selected } from "./model.zs";
import helper from "./nested/helper.zs";

function main(): i32 {
  return selected() + helper.adjust();
}
`));
  sources.push(module("/workspace/app/model.zs", `
export function value(): i32 {
  return 40;
}
`));
  sources.push(module("/workspace/app/nested/helper.zs", `
import model from "../model.zs";

export function adjust(): i32 {
  return model.value() + 2;
}
`));
  return sources;
}

function missingModuleGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import missing from "./missing.zs";
function main(): i32 { return 0; }
`));
  return sources;
}

function missingExportGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import { hidden } from "./model.zs";
function main(): i32 { return hidden(); }
`));
  sources.push(module("/workspace/model.zs", `
function hidden(): i32 { return 1; }
`));
  return sources;
}

function circularGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import next from "./next.zs";
function main(): i32 { return next.value(); }
`));
  sources.push(module("/workspace/next.zs", `
import main from "./main.zs";
export function value(): i32 { return main.main(); }
`));
  return sources;
}

function duplicateBindingGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import value from "native.h";
function value(): i32 { return 1; }
function main(): i32 { return value(); }
`));
  return sources;
}

function resolvesTo(
  sources: Array<ModuleSource>,
  kind: ModuleResolveErrorKind
): boolean {
  const outcome = attempt resolveModules(sources, "/workspace/main.zs");
  return match (outcome) {
    success(graph) => false;
    failure(error) => error.kind == kind;
  };
}

function validOrder(in graph: ModuleGraph): boolean {
  return graph.entry == 0
    && graph.modules.length == 3
    && graph.modules[0].dependencies.length == 2
    && graph.modules[0].dependencies[0] == 1
    && graph.modules[0].dependencies[1] == 2
    && graph.modules[2].dependencies.length == 1
    && graph.modules[2].dependencies[0] == 1
    && graph.dependencyOrder.length == 3
    && graph.dependencyOrder[0] == 1
    && graph.dependencyOrder[1] == 2
    && graph.dependencyOrder[2] == 0;
}

function main(): i32 {
  const successSources = successfulGraph();
  const success = attempt resolveModules(successSources, "/workspace/app/main.zs");
  const graphIsValid = match (success) {
    success(graph) => validOrder(graph);
    failure(error) => false;
  };
  if (!graphIsValid) return 1;
  if (!resolvesTo(missingModuleGraph(), ModuleResolveErrorKind.missingModule)) return 2;
  if (!resolvesTo(missingExportGraph(), ModuleResolveErrorKind.missingExport)) return 3;
  if (!resolvesTo(circularGraph(), ModuleResolveErrorKind.circularImport)) return 4;
  if (!resolvesTo(duplicateBindingGraph(), ModuleResolveErrorKind.duplicateBinding)) return 5;
  return 0;
}
