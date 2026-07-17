const prefix = "__z_Option_";

export function optionTypeName(target: string): string {
  return `${prefix}${target}`;
}

export function parseOptionType(name: string): { readonly target: string } | null {
  return name.startsWith(prefix) ? { target: name.slice(prefix.length) } : null;
}
