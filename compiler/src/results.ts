import type { EnumDeclaration, FunctionDeclaration, Program } from "./ast.ts";

export function resultTypeName(successType: string, errorType: string): string {
  return `__z_Result_${successType}_${errorType}`;
}

export function materializeResultTypes(program: Program): Program {
  const generated = new Map<string, EnumDeclaration>();
  const functions: FunctionDeclaration[] = [
    ...program.functions,
    ...program.structs.flatMap((declaration) => declaration.methods),
  ];

  for (const declaration of functions) {
    if (!declaration.errorType) continue;
    const name = resultTypeName(declaration.returnType.name, declaration.errorType.name);
    if (generated.has(name)) continue;
    generated.set(name, {
      kind: "enum",
      name,
      location: declaration.location,
      variants: [
        { name: "success", payload: declaration.returnType, location: declaration.location },
        { name: "failure", payload: declaration.errorType, location: declaration.location },
      ],
    });
  }

  return { ...program, enums: [...program.enums, ...generated.values()] };
}
