const unsafeNativePrefix = "__z_unsafe_native:";

export function unsafeNativeTypeName(cName: string): string {
  return `${unsafeNativePrefix}${normalizeUnsafeNativeSpelling(cName)}`;
}

export function parseUnsafeNativeType(typeName: string): string | null {
  return typeName.startsWith(unsafeNativePrefix)
    ? typeName.slice(unsafeNativePrefix.length)
    : null;
}

export function normalizeUnsafeNativeSpelling(cName: string): string {
  return cName.trim().replace(/\s+/g, " ").replace(/\s*\*\s*/g, " *");
}

export function isUnsafeNativePointerSpelling(cName: string): boolean {
  const normalized = normalizeUnsafeNativeSpelling(cName);
  return normalized.includes("*") && !/\(\s*\*/.test(normalized);
}

export function isUnsafeCStringSpelling(cName: string): boolean {
  const normalized = normalizeUnsafeNativeSpelling(cName)
    .replace(/\b(?:const|volatile|restrict|_Nonnull|_Nullable|_Null_unspecified)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:signed |unsigned )?char \*$/.test(normalized);
}

export function displayUnsafeNativeType(typeName: string): string | null {
  const cName = parseUnsafeNativeType(typeName);
  return cName ? `opaque native ${cName}` : null;
}
