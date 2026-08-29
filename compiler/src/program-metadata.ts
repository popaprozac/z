import type { CallExpression, Expression, Program } from "./ast.ts";
import type { SourceModuleBatch } from "./modules.ts";
import type {
  Stage1ModuleGraph,
  Stage1ModuleCallResolution,
  Stage1ModuleSymbol,
} from "./self-hosting.ts";

export const Z_PROGRAM_METADATA_SCHEMA_VERSION = 1 as const;

export type ZProgramArgumentMetadata = {
  readonly kind: "string" | "number" | "boolean" | "null" | "other";
  readonly type: string;
  readonly value?: string | boolean | null;
};

export type ZProgramCallMetadata = {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly target: {
    readonly module: string;
    readonly symbol: string;
    readonly kind: "function" | "method" | "staticMethod" | "constructor" | "standard";
    readonly name: string;
  };
  readonly asynchronous: boolean;
  readonly receiverMode: string;
  readonly callableTypeParameterCount: number;
  readonly typeParameters: readonly string[];
  readonly typeArguments: readonly string[];
  readonly parameterModes: readonly string[];
  readonly parameterTypes: readonly string[];
  readonly returnType: string;
  readonly errorType: string | null;
  readonly arguments: readonly ZProgramArgumentMetadata[];
};

export type ZProgramModuleMetadata = {
  readonly path: string;
  readonly dependencies: readonly number[];
  readonly symbols: readonly Stage1ModuleSymbol[];
  readonly calls: readonly ZProgramCallMetadata[];
};

export type ZProgramMetadata = {
  readonly schemaVersion: typeof Z_PROGRAM_METADATA_SCHEMA_VERSION;
  readonly entry: number;
  readonly modules: readonly ZProgramModuleMetadata[];
};

function callExpressionAt(program: Program, offset: number): CallExpression | null {
  const pending: unknown[] = [program];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (visited.has(value)) continue;
    visited.add(value);
    const record = value as Record<string, unknown>;
    if (
      record.kind === "call"
      && typeof record.location === "object"
      && record.location !== null
      && (record.location as { offset?: unknown }).offset === offset
      && Array.isArray(record.arguments)
    ) {
      return value as CallExpression;
    }
    pending.push(...Object.values(record));
  }
  return null;
}

function argumentMetadata(expression: Expression, type: string): ZProgramArgumentMetadata {
  if (expression.kind === "string") {
    return { kind: "string", type, value: expression.value };
  }
  if (expression.kind === "number") {
    return { kind: "number", type, value: expression.value };
  }
  if (expression.kind === "boolean") {
    return { kind: "boolean", type, value: expression.value };
  }
  if (expression.kind === "null") {
    return { kind: "null", type, value: null };
  }
  return { kind: "other", type };
}

function publicSymbolMetadata(symbol: Stage1ModuleSymbol): Stage1ModuleSymbol {
  const copy = structuredClone(symbol);
  if (!copy.typeSignature) return copy;
  return {
    ...copy,
    typeSignature: {
      ...copy.typeSignature,
      fields: copy.typeSignature.fields.filter((field) => field.visibility === "public"),
      methods: copy.typeSignature.methods.filter((method) => method.visibility === "public"),
      constructorSignature: copy.typeSignature.constructorVisibility === "public"
        ? copy.typeSignature.constructorSignature
        : null,
    },
  };
}

function resolutionIsPublicMember(
  symbol: Stage1ModuleSymbol,
  kind: Stage1ModuleCallResolution["kind"],
  targetName: string,
): boolean {
  if (kind === "constructor") {
    return symbol.typeSignature?.constructorVisibility === "public";
  }
  if (kind !== "method" && kind !== "staticMethod") return true;
  const methodName = targetName.split(".").at(-1) ?? targetName;
  const method = symbol.typeSignature?.methods.find((candidate) => candidate.name === methodName);
  return method?.visibility !== "internal" && method?.visibility !== "private";
}

export function createZProgramMetadata(
  graph: Stage1ModuleGraph,
  sourceBatch: SourceModuleBatch,
): ZProgramMetadata {
  const programs = new Map(
    sourceBatch.modules.map((module) => [module.fileName, module.program] as const),
  );
  return {
    schemaVersion: Z_PROGRAM_METADATA_SCHEMA_VERSION,
    entry: graph.entry,
    modules: graph.modules.map((module) => {
      const program = programs.get(module.path);
      if (!program) {
        throw new Error(`program metadata has no parsed source for ${JSON.stringify(module.path)}`);
      }
      return {
        path: module.path,
        dependencies: [...module.dependencies],
        symbols: module.symbols
          .filter((symbol) => symbol.exported)
          .map(publicSymbolMetadata),
        calls: module.callResolutions.flatMap((resolution) => {
          const targetModule = graph.modules[resolution.targetModule];
          const targetSymbol = targetModule?.symbols[resolution.targetSymbol];
          if (!targetModule || !targetSymbol?.exported) return [];
          if (!resolutionIsPublicMember(targetSymbol, resolution.kind, resolution.targetName)) return [];
          const call = callExpressionAt(program, resolution.offset);
          if (!call) {
            throw new Error(
              `program metadata could not find resolved call ${JSON.stringify(resolution.targetName)} `
              + `at ${module.path}:${resolution.line}:${resolution.column}`,
            );
          }
          return [{
            offset: resolution.offset,
            line: resolution.line,
            column: resolution.column,
            target: {
              module: targetModule.path,
              symbol: targetSymbol.name,
              kind: resolution.kind,
              name: resolution.targetName,
            },
            asynchronous: resolution.asynchronous,
            receiverMode: resolution.receiverMode,
            callableTypeParameterCount: resolution.callableTypeParameterCount,
            typeParameters: [...resolution.typeParameters],
            typeArguments: [...resolution.typeArguments],
            parameterModes: [...resolution.parameterModes],
            parameterTypes: [...resolution.parameterTypes],
            returnType: resolution.returnType,
            errorType: resolution.errorType,
            arguments: call.arguments.map((argument, index) => (
              argumentMetadata(argument, resolution.parameterTypes[index] ?? "")
            )),
          }];
        }),
      };
    }),
  };
}

export function renderZProgramMetadata(metadata: ZProgramMetadata): string {
  return `${JSON.stringify(metadata)}\n`;
}
