const nullablePrefix = "__z_objc:nullable:";
const nonnullPrefix = "__z_objc:nonnull:";

export function nullableObjCTypeName(type: string): string {
  return `${nullablePrefix}${publicObjCTypeName(type)}`;
}

export function publicObjCTypeName(type: string): string {
  if (type.startsWith(nullablePrefix)) return type.slice(nullablePrefix.length);
  if (type.startsWith(nonnullPrefix)) return type.slice(nonnullPrefix.length);
  return type;
}

export function isNullableObjCTypeName(type: string): boolean {
  return type.startsWith(nullablePrefix);
}
