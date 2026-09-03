import { genericTypeName, parseGenericType } from "./generic-types.ts";

// Canonical compiler identity for the payload-free public std/sync enum.
export const onceStateTypeName = "__z_std_sync_OnceState";

export const onceStateVariants = ["empty", "initialized", "closed"] as const;

export type OnceType = {
  readonly valueType: string;
};

export function onceTypeName(valueType: string): string {
  return genericTypeName("Once", [valueType]);
}

export function onceLifetimeTypeName(valueType: string): string {
  return genericTypeName("OnceLifetime", [valueType]);
}

export function parseOnceType(name: string): OnceType | null {
  const generic = parseGenericType(name);
  return generic?.base === "Once" && generic.arguments.length === 1
    ? { valueType: generic.arguments[0] }
    : null;
}

export function parseOnceLifetimeType(name: string): OnceType | null {
  const generic = parseGenericType(name);
  return generic?.base === "OnceLifetime" && generic.arguments.length === 1
    ? { valueType: generic.arguments[0] }
    : null;
}
