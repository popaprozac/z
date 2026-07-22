import type { SourceLocation, TraitDeclaration } from "./ast.ts";

export const hashableSelfTypeName = "__z_hashable_self";

export function hashableTraitDeclaration(location: SourceLocation): TraitDeclaration {
  return {
    kind: "trait",
    name: "Hashable",
    location,
    methods: [
      {
        kind: "function",
        name: "equals",
        receiverMode: null,
        parameters: [{ name: "other", mode: "in", type: { name: hashableSelfTypeName, location }, location }],
        returnType: { name: "boolean", location },
        errorType: null,
        body: [],
        location,
      },
      {
        kind: "function",
        name: "hash",
        receiverMode: null,
        parameters: [{ name: "hasher", mode: "inout", type: { name: "Hasher", location }, location }],
        returnType: { name: "void", location },
        errorType: null,
        body: [],
        location,
      },
    ],
  };
}
