import type { Program, TypeAliasDeclaration } from "./ast.ts";
import {
  dynamicArrayTypeName,
  fixedArrayTypeName,
  parseDynamicArrayType,
  parseFixedArrayType,
  parseSliceType,
  sliceTypeName,
} from "./array-types.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { functionTypeName, parseFunctionType } from "./function-types.ts";
import { genericTypeName, parseGenericType } from "./generic-types.ts";
import { isNullableObjCTypeName, nullableObjCTypeName, publicObjCTypeName } from "./objc-types.ts";
import { parseReadonlyType, readonlyTypeName } from "./readonly-types.ts";
import { transformProgramTypeNames } from "./foreign-handle-types.ts";
import { parseViewType, viewTypeName } from "./view-types.ts";

export type ResolvedTypeAliases = {
  readonly program: Program;
  readonly targets: ReadonlyMap<string, string>;
};

export function resolveTypeAliases(
  program: Program,
  fileName: string,
  displayNames: ReadonlyMap<string, string> = new Map(),
): ResolvedTypeAliases {
  if (program.typeAliases.length === 0) return { program, targets: new Map() };
  const declarations = new Map(program.typeAliases.map((declaration) => [declaration.name, declaration] as const));
  const targets = new Map<string, string>();

  const resolveAlias = (declaration: TypeAliasDeclaration, stack: readonly TypeAliasDeclaration[]): string => {
    const cached = targets.get(declaration.name);
    if (cached) return cached;
    const cycleIndex = stack.findIndex((candidate) => candidate.name === declaration.name);
    if (cycleIndex >= 0) {
      const cycle = [...stack.slice(cycleIndex), declaration]
        .map((candidate) => displayNames.get(candidate.name) ?? candidate.name)
        .join(" -> ");
      throw new DiagnosticError(
        declaration.location.fileName ?? fileName,
        declaration.location,
        `circular type alias: ${cycle}`,
        { helps: ["make at least one link a concrete struct, class, enum, or other non-alias type"] },
      );
    }
    const resolved = resolveName(declaration.target.name, [...stack, declaration]);
    targets.set(declaration.name, resolved);
    return resolved;
  };

  const resolveName = (name: string, stack: readonly TypeAliasDeclaration[] = []): string => {
    const direct = declarations.get(name);
    if (direct) return resolveAlias(direct, stack);
    if (isNullableObjCTypeName(name)) {
      return nullableObjCTypeName(resolveName(publicObjCTypeName(name), stack));
    }
    const readonly = parseReadonlyType(name);
    if (readonly) return readonlyTypeName(resolveName(readonly.target, stack));
    const functionType = parseFunctionType(name);
    if (functionType) {
      return functionTypeName(
        functionType.parameters.map((parameter) => ({
          ...parameter,
          type: resolveName(parameter.type, stack),
        })),
        resolveName(functionType.returnType, stack),
        functionType.errorType ? resolveName(functionType.errorType, stack) : null,
        functionType.thread,
      );
    }
    const view = parseViewType(name);
    if (view) return viewTypeName(resolveName(view.target, stack));
    const array = parseFixedArrayType(name);
    if (array) return fixedArrayTypeName(resolveName(array.elementType, stack), array.length);
    const slice = parseSliceType(name);
    if (slice) return sliceTypeName(resolveName(slice.elementType, stack));
    const dynamic = parseDynamicArrayType(name);
    if (dynamic) {
      const resolved = dynamicArrayTypeName(resolveName(dynamic.elementType, stack));
      return dynamic.readonly ? readonlyTypeName(resolved) : resolved;
    }
    const generic = parseGenericType(name);
    if (generic) {
      return genericTypeName(
        resolveName(generic.base, stack),
        generic.arguments.map((argument) => resolveName(argument, stack)),
      );
    }
    return name;
  };

  for (const declaration of program.typeAliases) resolveAlias(declaration, []);
  return {
    targets,
    program: transformProgramTypeNames(program, (name) => resolveName(name)),
  };
}
