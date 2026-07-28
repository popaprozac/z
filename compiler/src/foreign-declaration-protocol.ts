import type {
  ForeignAvailability,
  ForeignModuleDeclarations,
} from "./foreign-ir.ts";

const protocolVersion = 1;

function hexNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`foreign declaration protocol cannot encode integer ${value}`);
  }
  return value.toString(16).padStart(16, "0");
}

function text(value: string): string {
  return `${hexNumber(Buffer.byteLength(value, "utf8"))}${value}`;
}

function optionalText(value: string | null | undefined): string {
  return value === null || value === undefined ? "0" : `1${text(value)}`;
}

function boolean(value: boolean): string {
  return value ? "1" : "0";
}

function availabilityRecord(
  functionIndex: number,
  overloadIndex: number,
  availabilityIndex: number,
  availability: ForeignAvailability,
): string {
  return [
    "A",
    hexNumber(functionIndex),
    hexNumber(overloadIndex),
    hexNumber(availabilityIndex),
    optionalText(availability.platform),
    optionalText(availability.introduced),
    boolean(availability.deprecated),
    optionalText(availability.deprecatedVersion),
    optionalText(availability.obsoleted),
    boolean(availability.unavailable),
    optionalText(availability.message),
  ].join("");
}

/**
 * Versioned bootstrap wire format for producer-facing foreign function
 * declarations. It deliberately fails closed when the module contains native
 * types, constants, or Objective-C declarations that this first stream tier
 * cannot yet represent.
 */
export function encodeForeignFunctionDeclarationStream(
  module: ForeignModuleDeclarations,
): string {
  const unsupportedCounts = [
    module.nativeTypes.size,
    module.namedTypes.size,
    module.constants.size,
    module.objectTypes.size,
    module.interfaces.size,
    module.protocols.size,
  ];
  if (unsupportedCounts.some((count) => count !== 0)) {
    throw new Error(
      "foreign declaration stream tier 1 supports function-only modules",
    );
  }

  const records = [
    `ZFDCL${hexNumber(protocolVersion)}`,
    [
      "M",
      text(module.producer),
      optionalText(module.framework),
      boolean(module.objectiveC),
      boolean(module.cPlusPlus),
    ].join(""),
  ];
  const functions = [...module.functions.values()];
  for (let functionIndex = 0; functionIndex < functions.length; functionIndex += 1) {
    const declaration = functions[functionIndex];
    records.push([
      "F",
      hexNumber(functionIndex),
      text(declaration.name),
      hexNumber(declaration.namespacePath.length),
      ...declaration.namespacePath.map(text),
      text(declaration.qualifiedName),
      hexNumber(declaration.overloads.length),
    ].join(""));
    for (let overloadIndex = 0; overloadIndex < declaration.overloads.length; overloadIndex += 1) {
      const overload = declaration.overloads[overloadIndex];
      const source = overload.metadata.source;
      records.push([
        "O",
        hexNumber(functionIndex),
        hexNumber(overloadIndex),
        text(overload.name),
        text(overload.nativeName),
        text(overload.returnType.nativeName),
        optionalText(overload.returnType.canonicalNativeName),
        boolean(overload.variadic),
        text(overload.nativeSignature),
        optionalText(source?.fileName),
        hexNumber(source?.line ?? 0),
        hexNumber(source?.column ?? 0),
        hexNumber(source?.length ?? 0),
        optionalText(overload.metadata.executorAffinity),
        hexNumber(overload.parameters.length),
        hexNumber(overload.metadata.availability.length),
      ].join(""));
      for (let parameterIndex = 0; parameterIndex < overload.parameters.length; parameterIndex += 1) {
        const parameter = overload.parameters[parameterIndex];
        records.push([
          "P",
          hexNumber(functionIndex),
          hexNumber(overloadIndex),
          hexNumber(parameterIndex),
          optionalText(parameter.name),
          text(parameter.type.nativeName),
          optionalText(parameter.type.canonicalNativeName),
        ].join(""));
      }
      for (let availabilityIndex = 0; availabilityIndex < overload.metadata.availability.length; availabilityIndex += 1) {
        records.push(availabilityRecord(
          functionIndex,
          overloadIndex,
          availabilityIndex,
          overload.metadata.availability[availabilityIndex],
        ));
      }
    }
  }
  records.push("E");
  return `${records.join("\n")}\n`;
}
