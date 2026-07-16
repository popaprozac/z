export function isStandardModuleSpecifier(specifier: string): boolean {
  return specifier === "std" || specifier.startsWith("std/");
}
