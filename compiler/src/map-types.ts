import { genericTypeName, parseGenericType } from "./generic-types.ts";

const mapPrefix = "__z_Map_";
const entryPrefix = "__z_MapEntry_";

function encodedPair(prefix: string, keyType: string, valueType: string): string {
  return `${prefix}${keyType.length}_${keyType}${valueType}`;
}

function parseEncodedPair(
  name: string,
  prefix: string,
): { readonly keyType: string; readonly valueType: string } | null {
  if (!name.startsWith(prefix)) return null;
  const encoded = name.slice(prefix.length);
  const separator = encoded.indexOf("_");
  if (separator < 1) return null;
  const keyLength = Number(encoded.slice(0, separator));
  if (!Number.isSafeInteger(keyLength) || keyLength < 1) return null;
  const keyStart = separator + 1;
  const keyType = encoded.slice(keyStart, keyStart + keyLength);
  const valueType = encoded.slice(keyStart + keyLength);
  return keyType.length === keyLength && valueType.length > 0 ? { keyType, valueType } : null;
}

export function mapTypeName(keyType: string, valueType: string): string {
  return encodedPair(mapPrefix, keyType, valueType);
}

export function mapEntryTypeName(keyType: string, valueType: string): string {
  return encodedPair(entryPrefix, keyType, valueType);
}

export function parseMapType(name: string): { readonly keyType: string; readonly valueType: string } | null {
  const encoded = parseEncodedPair(name, mapPrefix);
  if (encoded) return encoded;
  const generic = parseGenericType(name);
  return generic?.base === "Map" && generic.arguments.length === 2
    ? { keyType: generic.arguments[0], valueType: generic.arguments[1] }
    : null;
}

export function parseMapEntryType(name: string): { readonly keyType: string; readonly valueType: string } | null {
  return parseEncodedPair(name, entryPrefix);
}

export function displayMapType(name: string): string {
  const map = parseMapType(name);
  return map ? genericTypeName("Map", [map.keyType, map.valueType]) : name;
}
