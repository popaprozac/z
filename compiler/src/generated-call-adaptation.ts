import { createHash } from "node:crypto";
import type { CallExpression, Expression, Program, SourceLocation } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { GeneratedCallAdapter } from "./generated-build.ts";
import type { SourceModuleBatch } from "./modules.ts";
import type { SemanticInfo } from "./sema.ts";

export type ValidatedGeneratedCallAdapter = GeneratedCallAdapter & {
  readonly replacementMethod: string;
  readonly replacementPackageId: string | null;
};

function diagnostic(
  fileName: string,
  location: SourceLocation,
  summary: string,
  notes: readonly string[] = [],
): never {
  throw new DiagnosticError(fileName, location, summary, {
    code: "Z0840",
    notes,
    helps: ["regenerate the build overlay against the current checked Z source"],
  });
}

function callsAtOffset(value: unknown, offset: number, calls: CallExpression[]): void {
  if (Array.isArray(value)) {
    for (const item of value) callsAtOffset(item, offset, calls);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    record.kind === "call"
    && typeof record.location === "object"
    && record.location !== null
    && (record.location as SourceLocation).offset === offset
  ) {
    calls.push(value as CallExpression);
  }
  for (const child of Object.values(record)) callsAtOffset(child, offset, calls);
}

function displayAggregateName(
  canonicalName: string,
  typeDisplayNames: ReadonlyMap<string, string>,
): string {
  return typeDisplayNames.get(canonicalName) ?? canonicalName;
}

export function validateGeneratedCallAdapters(
  adapters: readonly GeneratedCallAdapter[],
  overlayFileName: string,
  sourceBatch: SourceModuleBatch,
  semanticInfo: SemanticInfo,
  typeDisplayNames: ReadonlyMap<string, string>,
  generatedModulePackageIds: ReadonlyMap<string, string>,
): readonly ValidatedGeneratedCallAdapter[] {
  const seen = new Set<string>();
  return adapters.map((adapter) => {
    const module = sourceBatch.modules.find((candidate) => candidate.fileName === adapter.sourcePath);
    const fallbackLocation: SourceLocation = {
      offset: 0,
      line: 1,
      column: 1,
      fileName: adapter.sourcePath,
    };
    if (!module) {
      diagnostic(
        adapter.sourcePath,
        fallbackLocation,
        "generated call adaptation source is not part of the checked module graph",
        [`overlay: ${overlayFileName}`],
      );
    }
    const actualHash = createHash("sha256").update(module.source).digest("hex");
    if (actualHash !== adapter.sourceHash) {
      diagnostic(
        module.fileName,
        fallbackLocation,
        "generated call adaptation source hash is stale",
        [`expected ${adapter.sourceHash}`, `found ${actualHash}`, `overlay: ${overlayFileName}`],
      );
    }
    const key = `${module.fileName}:${adapter.offset}`;
    if (seen.has(key)) {
      diagnostic(module.fileName, fallbackLocation, "multiple generated call adaptations target the same call");
    }
    seen.add(key);

    const calls: CallExpression[] = [];
    callsAtOffset(module.program, adapter.offset, calls);
    if (calls.length !== 1) {
      diagnostic(
        module.fileName,
        fallbackLocation,
        calls.length === 0
          ? `generated call adaptation offset ${adapter.offset} does not identify a call`
          : `generated call adaptation offset ${adapter.offset} is ambiguous`,
      );
    }
    const call = calls[0]!;
    const callFileName = call.location.fileName ?? module.fileName;
    const resolution = semanticInfo.methodCallResolutions.find((candidate) => (
      (candidate.location.fileName ?? module.fileName) === callFileName
      && candidate.location.line === call.location.line
      && candidate.location.column === call.location.column
    ));
    if (!resolution) {
      diagnostic(
        module.fileName,
        call.location,
        "generated call adaptation target is not a checked instance or static method call",
      );
    }
    const aggregateName = displayAggregateName(resolution.aggregate.name, typeDisplayNames);
    const methodName = resolution.declaration.genericOriginName
      ?? resolution.declaration.name;
    const actualTarget = `${aggregateName}.${methodName}`;
    if (actualTarget !== adapter.target) {
      diagnostic(
        module.fileName,
        call.location,
        `generated call adaptation expected ${JSON.stringify(adapter.target)} but resolved ${JSON.stringify(actualTarget)}`,
      );
    }
    const targetAggregate = adapter.target.slice(0, adapter.target.lastIndexOf("."));
    const replacementAggregate = adapter.replacement.slice(0, adapter.replacement.lastIndexOf("."));
    if (replacementAggregate !== targetAggregate) {
      diagnostic(
        module.fileName,
        call.location,
        "generated call adaptation replacement must be a method on the original receiver type",
        [`target receiver: ${targetAggregate}`, `replacement receiver: ${replacementAggregate}`],
      );
    }
    if (adapter.argument >= call.arguments.length) {
      diagnostic(
        module.fileName,
        call.location,
        `generated call adaptation argument ${adapter.argument} is outside this ${call.arguments.length}-argument call`,
      );
    }
    return {
      ...adapter,
      replacementMethod: adapter.replacement.slice(adapter.replacement.lastIndexOf(".") + 1),
      replacementPackageId: generatedModulePackageIds.get(adapter.adapterModule) ?? null,
    };
  });
}

function collectNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNames(item, names);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["name", "bindingName", "localName", "moduleName"]) {
    if (typeof record[key] === "string") names.add(record[key]);
  }
  for (const child of Object.values(record)) collectNames(child, names);
}

function transformValue(
  value: unknown,
  adapters: ReadonlyMap<number, {
    readonly declaration: ValidatedGeneratedCallAdapter;
    readonly localName: string;
    readonly identifierOffset: number;
    readonly callOffset: number;
  }>,
): unknown {
  if (Array.isArray(value)) return value.map((item) => transformValue(item, adapters));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const transformed = Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, transformValue(child, adapters)]),
  ) as Record<string, unknown>;
  if (record.kind !== "call") return transformed;
  const call = transformed as CallExpression;
  const plan = adapters.get(call.location.offset);
  if (!plan) return call;
  if (call.callee.kind !== "member") {
    throw new Error("validated generated method call no longer has a member callee");
  }
  const argument = call.arguments[plan.declaration.argument]!;
  const adapterCall: Expression = {
    kind: "call",
    callee: {
      kind: "identifier",
      name: plan.localName,
      location: { ...argument.location, offset: plan.identifierOffset },
    },
    arguments: [argument],
    argumentLabels: [null],
    location: { ...argument.location, offset: plan.callOffset },
  };
  const arguments_ = [...call.arguments];
  arguments_[plan.declaration.argument] = adapterCall;
  return {
    ...call,
    callee: {
      ...call.callee,
      property: plan.declaration.replacementMethod,
      location: {
        ...call.callee.location,
        syntheticPackageId: plan.declaration.replacementPackageId ?? undefined,
      },
    },
    arguments: arguments_,
  } satisfies CallExpression;
}

export function applyGeneratedCallAdaptersToProgram(
  program: Program,
  sourceLength: number,
  adapters: readonly ValidatedGeneratedCallAdapter[],
): Program {
  if (adapters.length === 0) return program;
  const names = new Set<string>();
  collectNames(program, names);
  const plans = new Map<number, {
    readonly declaration: ValidatedGeneratedCallAdapter;
    readonly localName: string;
    readonly identifierOffset: number;
    readonly callOffset: number;
  }>();
  const imports = [...program.imports];
  for (const [index, declaration] of adapters.entries()) {
    let localName = `__z_generated_call_adapter_${index}`;
    while (names.has(localName)) localName += "_";
    names.add(localName);
    const syntheticOffset = sourceLength + index * 3 + 1;
    const location: SourceLocation = {
      offset: syntheticOffset,
      line: 1,
      column: 1,
      fileName: declaration.sourcePath,
    };
    imports.push({
      kind: "import",
      moduleName: `__z_generated_call_module_${index}`,
      bindings: [{
        importedName: declaration.adapterExport,
        localName,
        location,
      }],
      header: declaration.adapterModule,
      location,
    });
    plans.set(declaration.offset, {
      declaration,
      localName,
      identifierOffset: syntheticOffset + 1,
      callOffset: syntheticOffset + 2,
    });
  }
  const transformed = transformValue(program, plans) as Program;
  return { ...transformed, imports };
}
