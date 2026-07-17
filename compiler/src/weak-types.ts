import type { EnumDeclaration, Program, StructDeclaration } from "./ast.ts";
import { resultTypeName } from "./results.ts";

const prefix = "__z_Weak:";
export const weakExpiredType = "WeakExpired";

export function weakTypeName(target: string): string {
  return `${prefix}${target}`;
}

export function parseWeakType(name: string): { readonly target: string } | null {
  return name.startsWith(prefix) ? { target: name.slice(prefix.length) } : null;
}

export function weakResultTypeName(target: string): string {
  return resultTypeName(target, weakExpiredType);
}

export function parseWeakResultType(name: string): { readonly target: string } | null {
  const resultPrefix = "__z_Result_";
  const suffix = `_${weakExpiredType}`;
  return name.startsWith(resultPrefix) && name.endsWith(suffix)
    ? { target: name.slice(resultPrefix.length, -suffix.length) }
    : null;
}

export function materializeWeakTypes(program: Program): Program {
  const classes = program.structs.filter((declaration) => declaration.kind === "class");
  if (classes.length === 0) return program;
  const location = classes[0].location;
  const expired: StructDeclaration = {
    kind: "struct",
    name: weakExpiredType,
    implements: [],
    fields: [],
    constructor: null,
    methods: [],
    deinitializer: null,
    location,
  };
  const results: EnumDeclaration[] = classes.map((declaration) => ({
    kind: "enum",
    name: weakResultTypeName(declaration.name),
    location: declaration.location,
    variants: [
      { name: "success", payload: { name: declaration.name, location: declaration.location }, location: declaration.location },
      { name: "failure", payload: { name: weakExpiredType, location: declaration.location }, location: declaration.location },
    ],
  }));
  return {
    ...program,
    structs: [...program.structs, expired],
    enums: [...program.enums, ...results.filter((result) => !program.enums.some((item) => item.name === result.name))],
  };
}
