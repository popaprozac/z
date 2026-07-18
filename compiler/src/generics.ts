import type { EnumDeclaration, FunctionDeclaration, Program, StructDeclaration } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import {
  dynamicArrayTypeName,
  fixedArrayTypeName,
  parseDynamicArrayType,
  parseFixedArrayType,
  parseSliceType,
  sliceTypeName,
} from "./array-types.ts";
import { monomorphizedName, parseGenericType } from "./generic-types.ts";
import { functionTypeName, parseFunctionType } from "./function-types.ts";
import { weakTypeName } from "./weak-types.ts";
import { optionTypeName } from "./option-types.ts";
import { parseViewType, viewTypeName } from "./view-types.ts";

export function materializeGenerics(
  program: Program,
  fileName: string,
  typeDisplayNames: Map<string, string> = new Map(),
): Program {
  const structTemplates = new Map(program.structs.filter((item) => item.typeParameters?.length).map((item) => [item.name, item]));
  const functionTemplates = new Map(program.functions.filter((item) => item.typeParameters?.length).map((item) => [item.name, item]));
  const traits = new Map(program.traits.map((item) => [item.name, item]));
  const structs: StructDeclaration[] = [];
  const functions: FunctionDeclaration[] = [];
  const structInstances = new Map<string, string>();
  const functionInstances = new Map<string, string>();
  const optionInstances = new Map<string, EnumDeclaration>();

  if (program.structs.some((item) => item.name === "Option") || program.enums.some((item) => item.name === "Option")) {
    const declaration = program.structs.find((item) => item.name === "Option")
      ?? program.enums.find((item) => item.name === "Option")!;
    throw new DiagnosticError(fileName, declaration.location, "Option is a compiler-provided type and cannot be redeclared");
  }

  for (const template of [...structTemplates.values(), ...functionTemplates.values()]) {
    for (const constraint of template.typeParameterConstraints ?? []) {
      for (const reference of constraint.traits) {
        if (!traits.has(reference.name)) {
          throw new DiagnosticError(fileName, reference.location, `unknown trait constraint ${JSON.stringify(reference.name)}`);
        }
      }
    }
  }

  const displayName = (name: string): string => {
    const known = typeDisplayNames.get(name);
    if (known) return known;
    const view = parseViewType(name);
    if (view) return `view ${displayName(view.target)}`;
    const array = parseFixedArrayType(name);
    if (array) return `${displayName(array.elementType)}[${array.length}]`;
    const slice = parseSliceType(name);
    if (slice) return `Slice<${displayName(slice.elementType)}>`;
    const dynamic = parseDynamicArrayType(name);
    if (dynamic) return `Array<${displayName(dynamic.elementType)}>`;
    const generic = parseGenericType(name);
    return generic ? `${generic.base}<${generic.arguments.map(displayName).join(", ")}>` : name;
  };

  const substituteName = (name: string, substitutions: Map<string, string>): string => {
    if (substitutions.has(name)) return substitutions.get(name)!;
    const view = parseViewType(name);
    if (view) return viewTypeName(substituteName(view.target, substitutions));
    const functionType = parseFunctionType(name);
    if (functionType) {
      return functionTypeName(
        functionType.parameters.map((parameter) => ({
          ...parameter,
          type: substituteName(parameter.type, substitutions),
        })),
        substituteName(functionType.returnType, substitutions),
      );
    }
    const array = parseFixedArrayType(name);
    if (array) return fixedArrayTypeName(substituteName(array.elementType, substitutions), array.length);
    const slice = parseSliceType(name);
    if (slice) return sliceTypeName(substituteName(slice.elementType, substitutions));
    const dynamic = parseDynamicArrayType(name);
    if (dynamic) return dynamicArrayTypeName(substituteName(dynamic.elementType, substitutions));
    const generic = parseGenericType(name);
    if (!generic) return name;
    const args = generic.arguments.map((argument) => substituteName(argument, substitutions));
    return instantiateStruct(generic.base, args);
  };

  const transform = (value: any, substitutions: Map<string, string>): any => {
    if (Array.isArray(value)) return value.map((item) => transform(item, substitutions));
    if (!value || typeof value !== "object") return value;
    if (value.kind === "call" && value.callee?.kind === "identifier") {
      const generic = parseGenericType(value.callee.name);
      if (generic?.base === "Array") {
        if (generic.arguments.length !== 1 || value.arguments.length !== 0) {
          throw new DiagnosticError(fileName, value.location, "Array<T>() expects one type argument and no values");
        }
        return {
          kind: "dynamicArrayExpression",
          elementType: substituteName(generic.arguments[0], substitutions),
          location: value.location,
        };
      }
      if (generic && structTemplates.has(generic.base)) {
        const name = instantiateStruct(generic.base, generic.arguments.map((argument) => substituteName(argument, substitutions)));
        return {
          ...value,
          callee: { ...value.callee, name },
          arguments: transform(value.arguments, substitutions),
        };
      }
      const callee = generic
        ? { ...value.callee, name: instantiateFunction(generic.base, generic.arguments.map((arg) => substituteName(arg, substitutions))) }
        : transform(value.callee, substitutions);
      return { ...value, callee, arguments: transform(value.arguments, substitutions) };
    }
    if (value.kind === "member" && value.object?.kind === "identifier") {
      const generic = parseGenericType(value.object.name);
      if (generic?.base === "Option") {
        return {
          ...transformObject(value, substitutions),
          object: {
            ...value.object,
            name: instantiateStruct("Option", generic.arguments.map((argument) => substituteName(argument, substitutions))),
          },
        };
      }
      if (generic && structTemplates.has(generic.base)) {
        return {
          ...transformObject(value, substitutions),
          object: {
            ...value.object,
            name: instantiateStruct(generic.base, generic.arguments.map((argument) => substituteName(argument, substitutions))),
          },
        };
      }
    }
    if (value.kind === "structExpression") {
      return { ...transformObject(value, substitutions), typeName: substituteName(value.typeName, substitutions) };
    }
    if (value.kind === "new") {
      return {
        ...transformObject(value, substitutions),
        typeName: substituteName(value.typeName, substitutions),
      };
    }
    const keys = Object.keys(value);
    if (!value.kind && keys.length === 2 && keys.includes("name") && keys.includes("location")) {
      return { ...value, name: substituteName(value.name, substitutions) };
    }
    return transformObject(value, substitutions);
  };
  const transformObject = (value: any, substitutions: Map<string, string>): any => Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, transform(child, substitutions)]),
  );

  function instantiateStruct(base: string, args: string[]): string {
    if (base === "Option") {
      if (args.length !== 1) {
        throw new DiagnosticError(fileName, { offset: 0, line: 1, column: 1 }, `Option expects 1 type argument, received ${args.length}`);
      }
      const target = args[0];
      if (target === "void") {
        throw new DiagnosticError(fileName, { offset: 0, line: 1, column: 1 }, "Option<void> is invalid; use a payloadless enum variant instead");
      }
      const name = optionTypeName(target);
      typeDisplayNames.set(name, `Option<${displayName(target)}>`);
      if (!optionInstances.has(name)) {
        const location = program.functions[0]?.location ?? program.structs[0]?.location ?? program.enums[0]?.location
          ?? { offset: 0, line: 1, column: 1 };
        optionInstances.set(name, {
          kind: "enum",
          name,
          location,
          variants: [
            { name: "some", payload: { name: target, location }, location },
            { name: "none", payload: null, location },
          ],
        });
      }
      return name;
    }
    if (base === "Weak") {
      if (args.length !== 1) {
        throw new DiagnosticError(fileName, { offset: 0, line: 1, column: 1 }, `Weak expects 1 type argument, received ${args.length}`);
      }
      const target = args[0];
      typeDisplayNames.set(weakTypeName(target), `Weak<${displayName(target)}>`);
      return weakTypeName(target);
    }
    const template = structTemplates.get(base);
    if (!template) return monomorphizedName(base, args);
    if (args.length !== template.typeParameters!.length) {
      throw new DiagnosticError(fileName, template.location, `${base} expects ${template.typeParameters!.length} type argument(s), received ${args.length}`);
    }
    validateConstraints(template, args);
    const key = `${base}\0${args.join("\0")}`;
    const existing = structInstances.get(key);
    if (existing) return existing;
    const name = monomorphizedName(base, args);
    structInstances.set(key, name);
    typeDisplayNames.set(name, `${base}<${args.map(displayName).join(", ")}>`);
    const substitutions = new Map(template.typeParameters!.map((parameter, index) => [parameter, args[index]]));
    const concrete = transform({ ...template, name, typeParameters: [], typeParameterConstraints: [] }, substitutions) as StructDeclaration;
    structs.push(concrete);
    return name;
  }

  function instantiateFunction(base: string, args: string[]): string {
    const template = functionTemplates.get(base);
    if (!template) return monomorphizedName(base, args);
    if (args.length !== template.typeParameters!.length) {
      throw new DiagnosticError(fileName, template.location, `${base} expects ${template.typeParameters!.length} type argument(s), received ${args.length}`);
    }
    validateConstraints(template, args);
    const key = `${base}\0${args.join("\0")}`;
    const existing = functionInstances.get(key);
    if (existing) return existing;
    const name = monomorphizedName(base, args);
    functionInstances.set(key, name);
    const substitutions = new Map(template.typeParameters!.map((parameter, index) => [parameter, args[index]]));
    const concrete = transform({ ...template, name, typeParameters: [], typeParameterConstraints: [] }, substitutions) as FunctionDeclaration;
    functions.push(concrete);
    return name;
  }

  function validateConstraints(template: StructDeclaration | FunctionDeclaration, args: string[]): void {
    const argumentsByParameter = new Map(template.typeParameters!.map((parameter, index) => [parameter, args[index]]));
    for (const constraint of template.typeParameterConstraints ?? []) {
      const argument = argumentsByParameter.get(constraint.parameter)!;
      const declaration = [...structs, ...program.structs].find((item) => item.name === argument);
      for (const trait of constraint.traits) {
        if (!declaration?.implements.some((reference) => reference.name === trait.name)) {
          throw new DiagnosticError(
            fileName,
            trait.location,
            `${displayName(argument)} does not satisfy ${trait.name} for ${constraint.parameter} in ${JSON.stringify(template.name)}`,
          );
        }
      }
    }
  }

  for (const declaration of program.structs.filter((item) => !item.typeParameters?.length)) {
    structs.push(transform(declaration, new Map()));
  }
  for (const declaration of program.functions.filter((item) => !item.typeParameters?.length)) {
    functions.push(transform(declaration, new Map()));
  }
  const enums = transform(program.enums, new Map()) as EnumDeclaration[];
  return {
    ...program,
    structs,
    functions,
    enums: [...enums, ...optionInstances.values()],
    traits: transform(program.traits, new Map()),
  };
}
