import { genericTypeName, parseGenericType } from "./generic-types.ts";
import { parseReadonlyType } from "./readonly-types.ts";

const setPrefix = "__z_Set_";

export function setTypeName(elementType: string): string {
  return `${setPrefix}${elementType}`;
}

export function parseSetType(name: string): { readonly elementType: string; readonly readonly: boolean } | null {
  const qualifier = parseReadonlyType(name);
  const target = qualifier?.target ?? name;
  if (target.startsWith(setPrefix)) {
    const elementType = target.slice(setPrefix.length);
    return elementType.length > 0 ? { elementType, readonly: qualifier !== null } : null;
  }
  const generic = parseGenericType(target);
  return generic?.base === "Set" && generic.arguments.length === 1
    ? { elementType: generic.arguments[0], readonly: qualifier !== null }
    : null;
}

export function displaySetType(name: string): string {
  const set = parseSetType(name);
  return set
    ? `${set.readonly ? "readonly " : ""}${genericTypeName("Set", [set.elementType])}`
    : name;
}
