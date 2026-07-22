import type { SourceModuleBatch } from "./modules.ts";
import type { Stage1ModuleGraph, Stage1ModuleSymbol } from "./self-hosting.ts";

export type NativeResolvedSymbol = {
  readonly modulePath: string;
  readonly binding: Stage1ModuleSymbol;
  readonly declaration: Stage1ModuleSymbol;
};

export class NativeSemanticIndex {
  readonly graph: Stage1ModuleGraph;
  readonly entryPath: string;

  readonly #moduleIndexByPath: ReadonlyMap<string, number>;
  readonly #symbolsByModule: readonly ReadonlyMap<string, Stage1ModuleSymbol>[];

  constructor(graph: Stage1ModuleGraph, sourceBatch: SourceModuleBatch) {
    validateGraphShape(graph, sourceBatch);
    this.graph = graph;
    this.entryPath = sourceBatch.entryFileName;
    this.#moduleIndexByPath = new Map(graph.modules.map((module, index) => [module.path, index] as const));
    this.#symbolsByModule = graph.modules.map((module) => {
      const symbols = new Map<string, Stage1ModuleSymbol>();
      for (const symbol of module.symbols) {
        if (symbols.has(symbol.name)) {
          throw new Error(`native frontend returned duplicate symbol ${JSON.stringify(symbol.name)} in ${module.path}`);
        }
        if (symbol.targetModule !== null && !graph.modules[symbol.targetModule]) {
          throw new Error(
            `native frontend symbol ${JSON.stringify(symbol.name)} in ${module.path} targets invalid module ${symbol.targetModule}`,
          );
        }
        symbols.set(symbol.name, symbol);
      }
      return symbols;
    });
  }

  symbol(modulePath: string, name: string): Stage1ModuleSymbol | null {
    const moduleIndex = this.#moduleIndexByPath.get(modulePath);
    return moduleIndex === undefined ? null : this.#symbolsByModule[moduleIndex].get(name) ?? null;
  }

  resolveSymbol(modulePath: string, name: string): NativeResolvedSymbol | null {
    const moduleIndex = this.#moduleIndexByPath.get(modulePath);
    if (moduleIndex === undefined) return null;
    const binding = this.#symbolsByModule[moduleIndex].get(name);
    if (!binding) return null;
    if (binding.kind !== "imported" || binding.targetModule === null) {
      return { modulePath, binding, declaration: binding };
    }
    const declaration = this.#symbolsByModule[binding.targetModule].get(binding.importedName);
    if (!declaration?.exported) return null;
    return {
      modulePath: this.graph.modules[binding.targetModule].path,
      binding,
      declaration,
    };
  }

  resolveNamespaceMember(modulePath: string, namespace: string, member: string): NativeResolvedSymbol | null {
    const moduleIndex = this.#moduleIndexByPath.get(modulePath);
    if (moduleIndex === undefined) return null;
    const binding = this.#symbolsByModule[moduleIndex].get(namespace);
    if (binding?.kind !== "namespace" || binding.targetModule === null) return null;
    const declaration = this.#symbolsByModule[binding.targetModule].get(member);
    if (!declaration?.exported) return null;
    return {
      modulePath: this.graph.modules[binding.targetModule].path,
      binding,
      declaration,
    };
  }
}

function validateGraphShape(graph: Stage1ModuleGraph, sourceBatch: SourceModuleBatch): void {
  if (graph.modules.length !== sourceBatch.modules.length) {
    throw new Error(
      `native frontend returned ${graph.modules.length} modules for a ${sourceBatch.modules.length}-module source batch`,
    );
  }
  if (graph.entry < 0 || graph.entry >= graph.modules.length) {
    throw new Error(`native frontend returned invalid entry module index ${graph.entry}`);
  }
  for (let index = 0; index < sourceBatch.modules.length; index += 1) {
    const expected = sourceBatch.modules[index].fileName;
    const actual = graph.modules[index]?.path;
    if (actual !== expected) {
      throw new Error(
        `native frontend module ${index} does not match its source batch: expected ${expected}, received ${actual ?? "no module"}`,
      );
    }
    for (const dependency of graph.modules[index].dependencies) {
      if (!graph.modules[dependency]) {
        throw new Error(`native frontend module ${index} has invalid dependency ${dependency}`);
      }
    }
  }
  if (graph.modules[graph.entry]?.path !== sourceBatch.entryFileName) {
    throw new Error(
      `native frontend entry does not match its source batch: expected ${sourceBatch.entryFileName}, received ${graph.modules[graph.entry]?.path ?? "no module"}`,
    );
  }
}
