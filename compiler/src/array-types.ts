export type FixedArrayType = {
  readonly elementType: string;
  readonly length: number;
};

const prefix = "__z_array:";
const slicePrefix = "__z_slice:";

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
  if (array) return `${displayArrayType(array.elementType)}[${array.length}]`;
  const slice = parseSliceType(name);
  return slice ? `Slice<${displayArrayType(slice.elementType)}>` : name;
}

export function sliceTypeName(elementType: string): string {
  return `${slicePrefix}${elementType}`;
}

export function parseSliceType(name: string): { readonly elementType: string } | null {
  return name.startsWith(slicePrefix) ? { elementType: name.slice(slicePrefix.length) } : null;
}
