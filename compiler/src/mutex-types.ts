import { genericTypeName, parseGenericType } from "./generic-types.ts";

export type MutexType = {
  readonly valueType: string;
};

export function mutexTypeName(valueType: string): string {
  return genericTypeName("Mutex", [valueType]);
}

export function parseMutexType(name: string): MutexType | null {
  const generic = parseGenericType(name);
  return generic?.base === "Mutex" && generic.arguments.length === 1
    ? { valueType: generic.arguments[0] }
    : null;
}
