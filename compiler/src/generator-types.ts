import { genericTypeName, parseGenericType } from "./generic-types.ts";
import type { FunctionDeclaration } from "./ast.ts";

export function generatorTypeName(
  elementType: string,
  returnType: string | null = null,
  errorType: string | null = null,
): string {
  if (errorType) return genericTypeName("Generator", [elementType, returnType ?? "void", errorType]);
  return genericTypeName("Generator", returnType ? [elementType, returnType] : [elementType]);
}

export function generatorStepTypeName(elementType: string, returnType: string): string {
  return genericTypeName("GeneratorStep", [elementType, returnType]);
}

export function parseGeneratorType(
  name: string,
): {
  readonly elementType: string;
  readonly returnType: string | null;
  readonly errorType: string | null;
} | null {
  const generic = parseGenericType(name);
  if (
    !generic
    || generic.base !== "Generator"
    || generic.arguments.length < 1
    || generic.arguments.length > 3
  ) return null;
  return {
    elementType: generic.arguments[0],
    returnType: generic.arguments[1] && generic.arguments[1] !== "void" ? generic.arguments[1] : null,
    errorType: generic.arguments[2] ?? null,
  };
}

export function isGeneratorFunction(declaration: FunctionDeclaration): boolean {
  if (!parseGeneratorType(declaration.returnType.name)) return false;
  const containsYield = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    const kind = (value as { readonly kind?: string }).kind;
    if (kind === "yield") return true;
    if (kind === "closure") return false;
    if (Array.isArray(value)) return value.some(containsYield);
    return Object.entries(value as Record<string, unknown>)
      .some(([key, child]) => key !== "location" && containsYield(child));
  };
  return declaration.body.some(containsYield);
}
