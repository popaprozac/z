export type FixedArrayType = {
  readonly elementType: string;
  readonly length: number;
};

const prefix = "__z_array:";

export function fixedArrayTypeName(elementType: string, length: number): string {
  return `${prefix}${length}:${elementType}`;
}

export function parseFixedArrayType(name: string): FixedArrayType | null {
  if (!name.startsWith(prefix)) return null;
  const separator = name.indexOf(":", prefix.length);
  if (separator < 0) return null;
  const length = Number(name.slice(prefix.length, separator));
  if (!Number.isSafeInteger(length) || length < 0) return null;
  return { length, elementType: name.slice(separator + 1) };
}

export function displayArrayType(name: string): string {
  const array = parseFixedArrayType(name);
  return array ? `${displayArrayType(array.elementType)}[${array.length}]` : name;
}
