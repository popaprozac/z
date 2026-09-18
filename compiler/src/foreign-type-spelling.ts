import type { ForeignParameter } from "./foreign-ir.ts";

/** Preserve protocol-qualified receiver lookup in emitted native entries. */
export function objcParameterNativeSpelling(parameter: ForeignParameter): string {
  const protocols = parameter.protocols ?? [];
  return parameter.type.kind === "object" && parameter.type.className === null && protocols.length > 0
    ? `id<${protocols.join(", ")}>`
    : parameter.type.cName;
}

export function callbackParameterSpellings(signature: string): string[] | null {
  const normalized = signature
    .replace(/\b(restrict|_Nonnull|_Nullable|_Null_unspecified)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^(.+?)\s*\(\s*\*\s*\)\s*\((.*)\)$/.exec(normalized);
  return match ? splitCParameters(match[2]) : null;
}

export function callbackReturnSpelling(signature: string): string | null {
  const normalized = signature
    .replace(/\b(restrict|_Nonnull|_Nullable|_Null_unspecified)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^(.+?)\s*\(\s*\*\s*\)\s*\((.*)\)$/.exec(normalized);
  return match ? match[1].trim() : null;
}

export function normalizeCallbackContextType(cName: string): string {
  return cName
    .replace(/\b(restrict|_Nonnull|_Nullable|_Null_unspecified)\b/g, "")
    .replace(/\s*\*\s*/g, " *")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitCParameters(parameters: string): string[] {
  const trimmed = parameters.trim();
  if (!trimmed || trimmed === "void") return [];
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "(") depth += 1;
    else if (trimmed[index] === ")") depth -= 1;
    else if (trimmed[index] === "," && depth === 0) {
      result.push(trimmed.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(trimmed.slice(start).trim());
  return result;
}
