import { genericTypeName, parseGenericType } from "./generic-types.ts";
import type { FunctionDeclaration } from "./ast.ts";

export function generatorTypeName(elementType: string): string {
  return genericTypeName("Generator", [elementType]);
}

export function parseGeneratorType(name: string): { readonly elementType: string } | null {
  const generic = parseGenericType(name);
  if (!generic || generic.base !== "Generator" || generic.arguments.length !== 1) return null;
  return { elementType: generic.arguments[0] };
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
