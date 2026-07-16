import type { FunctionDeclaration, Program, StructDeclaration } from "./ast.ts";
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
      const callee = generic
        ? { ...value.callee, name: instantiateFunction(generic.base, generic.arguments.map((arg) => substituteName(arg, substitutions))) }
        : transform(value.callee, substitutions);
      return { ...value, callee, arguments: transform(value.arguments, substitutions) };
    }
    if (value.kind === "structExpression") {
      return { ...transformObject(value, substitutions), typeName: substituteName(value.typeName, substitutions) };
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
  return {
    ...program,
    structs,
    functions,
    enums: transform(program.enums, new Map()),
    traits: transform(program.traits, new Map()),
  };
}
