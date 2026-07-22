import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImportDeclaration } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { foreignDeclarationApiNotes, parseForeignDeclarationContracts } from "./foreign-declarations.ts";
import type { ForeignFunctionDeclaration } from "./foreign-ir.ts";

export type PointerNote = {
  readonly ownership?: "owned" | "borrowed" | "consuming";
  readonly access?: "in" | "out" | "inout";
  readonly nullable?: boolean;
  readonly release?: string;
  readonly nullOnly?: boolean;
  readonly semanticType?: "view-cstring";
  readonly fixed?: string;
  readonly thread?: {
    readonly transfer?: boolean;
    readonly share?: boolean;
    readonly deinit?: boolean;
  };
  readonly callback?: {
    readonly lifetime?: "call" | "escape";
    readonly thread?: "caller";
    readonly context?: {
      readonly parameter?: number;
      readonly callbackParameter?: number;
    };
    readonly release?: {
      readonly parameter?: number;
      readonly callbackParameter?: number;
    };
  };
};

export type ApiNotes = {
  readonly functions?: Readonly<Record<string, {
    readonly return?: PointerNote;
    readonly parameters?: Readonly<Record<string, PointerNote>>;
  }>>;
};

export class ApiNoteConflictError extends Error {
  constructor(readonly path: string, readonly firstSource: string, readonly secondSource: string) {
    super(`conflicting API notes for ${path} from ${JSON.stringify(firstSource)} and ${JSON.stringify(secondSource)}`);
  }
}

export function mergeApiNotes(
  sources: readonly { readonly name: string; readonly notes: ApiNotes }[],
): ApiNotes {
  const merged: Record<string, { return?: PointerNote; parameters?: Record<string, PointerNote> }> = {};
  const owners = new Map<string, string>();
  for (const source of sources) {
    for (const [functionName, note] of Object.entries(source.notes.functions ?? {})) {
      const target = merged[functionName] ??= {};
      if (note.return) target.return = mergePointerNote(target.return, note.return, `functions.${functionName}.return`, source.name, owners);
      for (const [index, parameter] of Object.entries(note.parameters ?? {})) {
        const parameters = target.parameters ??= {};
        parameters[index] = mergePointerNote(
          parameters[index],
          parameter,
          `functions.${functionName}.parameters.${index}`,
          source.name,
          owners,
        );
      }
    }
  }
  return Object.keys(merged).length > 0 ? { functions: merged } : {};
}

export function readApiNotes(
  declaration: ImportDeclaration,
  fileName: string,
  includeDirectory: string,
  declarations: ReadonlyMap<string, ForeignFunctionDeclaration>,
): ApiNotes {
  const sources = apiNoteSources(declaration, includeDirectory);
  try {
    return mergeApiNotes(sources.map((source) => ({
      name: source.path,
      notes: source.kind === "declaration"
        ? foreignDeclarationApiNotes(
          parseForeignDeclarationContracts(readFileSync(source.path, "utf8"), source.path),
          declarations,
          declaration.header,
          includeDirectory,
          source.path,
        )
        : parseApiNotes(JSON.parse(readFileSync(source.path, "utf8")), source.path),
    })));
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new DiagnosticError(fileName, declaration.location, `could not merge API notes for ${JSON.stringify(declaration.header)}: ${detail}`, {
      code: "Z0801",
    });
  }
}

export function apiNotesFreshness(declaration: ImportDeclaration, includeDirectory: string): string {
  return apiNoteSources(declaration, includeDirectory)
    .map((source) => {
      const stat = statSync(source.path);
      return `${source.path}:${stat.mtimeMs}:${stat.size}`;
    })
    .join("\0");
}

function apiNoteSources(
  declaration: ImportDeclaration,
  includeDirectory: string,
): { readonly path: string; readonly kind: "json" | "declaration" }[] {
  const localDeclarationPath = resolve(includeDirectory, `${declaration.header}.zd`);
  const localHeader = resolve(includeDirectory, declaration.header);
  const builtInPath = resolve(dirname(fileURLToPath(import.meta.url)), "../api-notes", `${basename(declaration.header)}.json`);
  const canUseBuiltIn = declaration.header === basename(declaration.header) && !existsSync(localHeader);
  return [
    ...(canUseBuiltIn && existsSync(builtInPath) ? [{ path: builtInPath, kind: "json" as const }] : []),
    ...(existsSync(localDeclarationPath) ? [{ path: localDeclarationPath, kind: "declaration" as const }] : []),
  ];
}

function mergePointerNote(
  first: PointerNote | undefined,
  second: PointerNote,
  path: string,
  source: string,
  owners: Map<string, string>,
): PointerNote {
  const result = mergeObject(first as Record<string, unknown> | undefined, second as Record<string, unknown>, path, source, owners);
  return result as PointerNote;
}

function mergeObject(
  first: Record<string, unknown> | undefined,
  second: Record<string, unknown>,
  path: string,
  source: string,
  owners: Map<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(first ?? {}) };
  for (const [key, value] of Object.entries(second)) {
    const fieldPath = `${path}.${key}`;
    const existing = result[key];
    if (existing === undefined) {
      if (isRecord(value)) result[key] = mergeObject(undefined, value, fieldPath, source, owners);
      else {
        result[key] = value;
        owners.set(fieldPath, source);
      }
      continue;
    }
    if (isRecord(existing) && isRecord(value)) {
      result[key] = mergeObject(existing, value, fieldPath, source, owners);
      continue;
    }
    if (existing !== value) {
      throw new ApiNoteConflictError(fieldPath, owners.get(fieldPath) ?? "an earlier source", source);
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseApiNotes(value: unknown, source: string): ApiNotes {
  const root = requireRecord(value, source, "root");
  requireKeys(root, ["functions"], source, "root");
  if (root.functions === undefined) return {};
  const functions = requireRecord(root.functions, source, "functions");
  for (const [name, rawFunction] of Object.entries(functions)) {
    const functionNote = requireRecord(rawFunction, source, `functions.${name}`);
    requireKeys(functionNote, ["return", "parameters"], source, `functions.${name}`);
    if (functionNote.return !== undefined) validatePointerNote(functionNote.return, source, `functions.${name}.return`);
    if (functionNote.parameters !== undefined) {
      const parameters = requireRecord(functionNote.parameters, source, `functions.${name}.parameters`);
      for (const [index, parameter] of Object.entries(parameters)) {
        validatePointerNote(parameter, source, `functions.${name}.parameters.${index}`);
      }
    }
  }
  return root as ApiNotes;
}

function validatePointerNote(value: unknown, source: string, path: string): void {
  const note = requireRecord(value, source, path);
  requireKeys(note, ["ownership", "access", "nullable", "release", "nullOnly", "semanticType", "fixed", "thread", "callback"], source, path);
  requireEnum(note.ownership, ["owned", "borrowed", "consuming"], source, `${path}.ownership`);
  requireEnum(note.access, ["in", "out", "inout"], source, `${path}.access`);
  requireOptionalType(note.nullable, "boolean", source, `${path}.nullable`);
  requireOptionalType(note.release, "string", source, `${path}.release`);
  requireOptionalType(note.nullOnly, "boolean", source, `${path}.nullOnly`);
  requireEnum(note.semanticType, ["view-cstring"], source, `${path}.semanticType`);
  requireOptionalType(note.fixed, "string", source, `${path}.fixed`);
  if (note.thread !== undefined) {
    const thread = requireRecord(note.thread, source, `${path}.thread`);
    requireKeys(thread, ["transfer", "share", "deinit"], source, `${path}.thread`);
    requireOptionalType(thread.transfer, "boolean", source, `${path}.thread.transfer`);
    requireOptionalType(thread.share, "boolean", source, `${path}.thread.share`);
    requireOptionalType(thread.deinit, "boolean", source, `${path}.thread.deinit`);
    if (thread.transfer === true && thread.share === true) {
      throw new Error(`invalid API notes ${JSON.stringify(source)}: ${path}.thread cannot declare both transfer and share`);
    }
    if (thread.transfer !== true && thread.share !== true) {
      throw new Error(`invalid API notes ${JSON.stringify(source)}: ${path}.thread requires transfer or share`);
    }
  }
  if (note.callback === undefined) return;
  const callback = requireRecord(note.callback, source, `${path}.callback`);
  requireKeys(callback, ["lifetime", "thread", "context", "release"], source, `${path}.callback`);
  requireEnum(callback.lifetime, ["call", "escape"], source, `${path}.callback.lifetime`);
  requireEnum(callback.thread, ["caller"], source, `${path}.callback.thread`);
  if (callback.context !== undefined) validatePair(callback.context, source, `${path}.callback.context`);
  if (callback.release !== undefined) validatePair(callback.release, source, `${path}.callback.release`);
}

function validatePair(value: unknown, source: string, path: string): void {
  const pair = requireRecord(value, source, path);
  requireKeys(pair, ["parameter", "callbackParameter"], source, path);
  requireOptionalInteger(pair.parameter, source, `${path}.parameter`);
  requireOptionalInteger(pair.callbackParameter, source, `${path}.callbackParameter`);
}

function requireRecord(value: unknown, source: string, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid API notes ${JSON.stringify(source)}: ${path} must be an object`);
  return value;
}

function requireKeys(value: Record<string, unknown>, allowed: readonly string[], source: string, path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`invalid API notes ${JSON.stringify(source)}: unknown field ${path}.${unknown}`);
}

function requireEnum(value: unknown, allowed: readonly string[], source: string, path: string): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
    throw new Error(`invalid API notes ${JSON.stringify(source)}: ${path} must be one of ${allowed.join(", ")}`);
  }
}

function requireOptionalType(value: unknown, expected: "boolean" | "string", source: string, path: string): void {
  if (value !== undefined && typeof value !== expected) {
    throw new Error(`invalid API notes ${JSON.stringify(source)}: ${path} must be ${expected}`);
  }
}

function requireOptionalInteger(value: unknown, source: string, path: string): void {
  if (value !== undefined && !Number.isInteger(value)) {
    throw new Error(`invalid API notes ${JSON.stringify(source)}: ${path} must be an integer`);
  }
}
