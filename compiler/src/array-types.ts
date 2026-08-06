export type FixedArrayType = {
  readonly elementType: string;
  readonly length: number;
};

const prefix = "__z_array:";
const slicePrefix = "__z_slice:";
const dynamicPrefix = "__z_dynamic_array:";

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

export function displayArrayType(
  name: string,
  displayElement: (name: string) => string = (element) => displayArrayType(element),
): string {
  const array = parseFixedArrayType(name);
  if (array) return `${displayElement(array.elementType)}[${array.length}]`;
  const slice = parseSliceType(name);
  if (slice) return `Slice<${displayElement(slice.elementType)}>`;
  const dynamic = parseDynamicArrayType(name);
  return dynamic ? `Array<${displayElement(dynamic.elementType)}>` : name;
}

export function sliceTypeName(elementType: string): string {
  return `${slicePrefix}${elementType}`;
}

export function parseSliceType(name: string): { readonly elementType: string } | null {
  return name.startsWith(slicePrefix) ? { elementType: name.slice(slicePrefix.length) } : null;
}

export function dynamicArrayTypeName(elementType: string): string {
  return `${dynamicPrefix}${elementType}`;
}

export function parseDynamicArrayType(name: string): { readonly elementType: string } | null {
  return name.startsWith(dynamicPrefix) ? { elementType: name.slice(dynamicPrefix.length) } : null;
}
