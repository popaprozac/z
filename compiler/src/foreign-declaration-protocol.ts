import type {
  ForeignAvailability,
  ForeignModuleDeclarations,
} from "./foreign-ir.ts";

const protocolVersion = 3;

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
 * declarations. Version 3 additionally carries nominal enum evidence so the
 * Z-owned contract normalizer can verify enum-backed status facts without
 * flattening their identity into an integer. It still fails closed on richer
 * native types and Objective-C declarations that this stream tier cannot
 * represent.
 */
export function encodeForeignFunctionDeclarationStream(
  module: ForeignModuleDeclarations,
): string {
  const namedTypes = [...module.namedTypes.values()];
  if (
    namedTypes.some((type) => type.kind !== "enum")
    || module.objectTypes.size !== 0
    || module.interfaces.size !== 0
    || module.protocols.size !== 0
  ) {
    throw new Error(
      "foreign declaration stream tier 3 supports function modules with typed constants and nominal enums",
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
  for (let typeIndex = 0; typeIndex < namedTypes.length; typeIndex += 1) {
    const type = namedTypes[typeIndex];
    if (type.kind !== "enum") throw new Error("unreachable non-enum foreign type");
    const source = type.metadata.source;
    records.push([
      "T",
      hexNumber(typeIndex),
      text(type.kind),
      text(type.exportName),
      text(type.qualifiedName),
      text(type.typeName),
      text(type.cName),
      text(type.underlying),
      optionalText(source?.fileName),
      hexNumber(source?.line ?? 0),
      hexNumber(source?.column ?? 0),
      hexNumber(source?.length ?? 0),
    ].join(""));
  }
  const constants = [...module.constants.values()];
  for (let constantIndex = 0; constantIndex < constants.length; constantIndex += 1) {
    const constant = constants[constantIndex];
    const source = constant.metadata.source;
    records.push([
      "C",
      hexNumber(constantIndex),
      text(constant.name),
      text(constant.cName),
      text(constant.typeName),
      text(constant.sourceKind),
      optionalText(source?.fileName),
      hexNumber(source?.line ?? 0),
      hexNumber(source?.column ?? 0),
      hexNumber(source?.length ?? 0),
    ].join(""));
  }
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
