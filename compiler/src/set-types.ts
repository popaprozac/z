import { genericTypeName, parseGenericType } from "./generic-types.ts";

const setPrefix = "__z_Set_";

export function setTypeName(elementType: string): string {
  return `${setPrefix}${elementType}`;
}

export function parseSetType(name: string): { readonly elementType: string } | null {
  if (name.startsWith(setPrefix)) {
    const elementType = name.slice(setPrefix.length);
    return elementType.length > 0 ? { elementType } : null;
  }
  const generic = parseGenericType(name);
  return generic?.base === "Set" && generic.arguments.length === 1
    ? { elementType: generic.arguments[0] }
    : null;
}

export function displaySetType(name: string): string {
  const set = parseSetType(name);
  return set ? genericTypeName("Set", [set.elementType]) : name;
}
