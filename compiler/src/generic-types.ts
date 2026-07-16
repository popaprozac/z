const prefix = "__z_generic:";

export function genericTypeName(base: string, arguments_: string[]): string {
  return `${prefix}${JSON.stringify([base, ...arguments_])}`;
}

export function parseGenericType(name: string): { readonly base: string; readonly arguments: string[] } | null {
  if (!name.startsWith(prefix)) return null;
  const [base, ...arguments_] = JSON.parse(name.slice(prefix.length)) as string[];
  return { base, arguments: arguments_ };
}

export function monomorphizedName(base: string, arguments_: string[]): string {
  const encode = (value: string) => [...value].map((character) => (
    /[A-Za-z0-9_]/.test(character) ? character : `_${character.codePointAt(0)!.toString(16)}_`
  )).join("");
  return `__z_mono_${encode(base)}_${arguments_.map(encode).join("_")}`;
}
