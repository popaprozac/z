import type { EnumDeclaration, FunctionDeclaration, Program } from "./ast.ts";

export function resultTypeName(successType: string, errorType: string): string {
  return `__z_Result_${successType}_${errorType}`;
}

export function materializeResultTypes(program: Program): Program {
  const generated = new Map<string, EnumDeclaration>();
  const existing = new Set(program.enums.map((declaration) => declaration.name));
  const functions: FunctionDeclaration[] = [
    ...program.functions,
    ...program.structs.flatMap((declaration) => declaration.methods),
  ];

  for (const declaration of functions) {
    if (!declaration.errorType) continue;
    const name = resultTypeName(declaration.returnType.name, declaration.errorType.name);
    if (existing.has(name) || generated.has(name)) continue;
    generated.set(name, {
      kind: "enum",
      name,
      location: declaration.location,
      variants: [
        {
          name: "success",
          payload: declaration.returnType.name === "void" ? null : declaration.returnType,
          location: declaration.location,
        },
        { name: "failure", payload: declaration.errorType, location: declaration.location },
      ],
    });
  }

  for (const aggregate of program.structs) {
    const constructor = aggregate.constructor;
    if (!constructor?.errorType) continue;
    const name = resultTypeName(aggregate.name, constructor.errorType.name);
    if (existing.has(name) || generated.has(name)) continue;
    generated.set(name, {
      kind: "enum",
      name,
      location: constructor.location,
      variants: [
        { name: "success", payload: { name: aggregate.name, location: constructor.location }, location: constructor.location },
        { name: "failure", payload: constructor.errorType, location: constructor.location },
      ],
    });
  }

  return { ...program, enums: [...program.enums, ...generated.values()] };
}
