const readonlyPrefix = "__z_readonly:";

export function readonlyTypeName(target: string): string {
  return `${readonlyPrefix}${target}`;
}

export function parseReadonlyType(name: string): { readonly target: string } | null {
  if (!name.startsWith(readonlyPrefix)) return null;
  const target = name.slice(readonlyPrefix.length);
  return target.length > 0 ? { target } : null;
}

export function writableTypeName(name: string): string {
  return parseReadonlyType(name)?.target ?? name;
}
