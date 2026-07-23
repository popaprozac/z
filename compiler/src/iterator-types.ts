import type { SourceLocation, TraitDeclaration } from "./ast.ts";
import { genericTypeName } from "./generic-types.ts";

export function iteratorTraitDeclaration(name: string, location: SourceLocation): TraitDeclaration {
  return {
    kind: "trait",
    name,
    typeParameters: ["T"],
    typeParameterConstraints: [],
    intrinsic: "iterator",
    methods: [
      {
        kind: "function",
        name: "next",
        receiverMode: "inout",
        parameters: [],
        returnType: { name: genericTypeName("Option", ["T"]), location },
        errorType: null,
        body: [],
        location,
      },
    ],
    location,
  };
}
