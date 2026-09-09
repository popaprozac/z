import type {
  ForeignAvailability,
  ForeignModuleDeclarations,
  ForeignObjCMethod,
  ForeignObjCProperty,
  ForeignType,
} from "./foreign-ir.ts";

export const foreignDeclarationProtocolVersion = 15;

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

function optionalNumber(value: number | null): string {
  return value === null ? "0" : `1${hexNumber(value)}`;
}

function semanticTypeName(type: ForeignType): string {
  if (type.kind === "z") return type.name;
  if (type.kind === "nullPointer") return "null";
  if (type.kind === "selector") return "objc.Selector";
  if (type.kind === "swiftString") return "Swift.String";
  if (type.kind === "named") return type.type.typeName;
  if (type.kind === "reference") return type.type.typeName;
  if (type.kind === "object") return type.typeName;
  if (type.kind === "pointer") return type.typeName;
  if (type.kind === "pointerOut") return type.pointer.typeName;
  if (type.kind === "scalarPointer") return type.typeName;
  if (type.kind === "block") {
    const parameters = type.parameters.map((parameter, index) => (
      `argument${index + 1}: ${semanticTypeName(parameter)}`
    ));
    if (parameters.some((parameter) => parameter.endsWith(": "))) return "";
    const returnType = semanticTypeName(type.returnType);
    if (!returnType) return "";
    const threadContract = type.thread === "any" ? " on thread.any" : "";
    return `(${parameters.join(", ")}) => ${returnType}${threadContract}`;
  }
  return "";
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
 * Versioned bootstrap wire format for producer-facing foreign declarations.
 * Version 15 retains Objective-C interface availability, including unavailable
 * and deployment-version restrictions on native superclasses.
 * Version 14 carries native subclass restrictions, designated-initializer,
 * required-super, direct-dispatch, consuming ownership, and variadic evidence.
 * Version 13 preserves Objective-C block parameter signatures so the native
 * frontend can type and lower completion-handler calls directly.
 * Version 11 preserves Clang's flag-enum classification so the native
 * frontend can retain nominal enum identity across bitwise expressions.
 * Version 10 adds Objective-C interface properties, including their getter,
 * setter, ownership, protocol qualifiers, type identity, executor affinity,
 * availability, and source location. Version 9 adds the producer's semantic Z type identity beside every
 * Objective-C method ABI spelling, preserving nullability and imported object
 * identity for native semantic normalization. Version 8 carries Objective-C interfaces, protocols, methods, method
 * parameters, protocol-qualified `id<...>` evidence, availability, and async
 * projection indices into the native frontend. Properties remain a later
 * protocol slice. Version 7 retained every field of an otherwise-supported C record using its
 * exact native type spelling. Safe normalization can therefore keep raw
 * pointer fields hidden while a `.zd` contract ABI-checks a reviewed field
 * projection. Version 6 added canonical C-record identity so lifecycle facts
 * on a canonical typedef govern aliases that preserve the same native representation. Richer
 * declarations remain outside this protocol tier,
 * but do not poison an otherwise representable header: their native spellings
 * remain visible on function records and normalization fails closed if a .zd
 * contract actually attempts to use one of those unsupported boundary types.
 */
export function encodeForeignFunctionDeclarationStream(
  module: ForeignModuleDeclarations,
): string {
  const namedTypes = [...module.namedTypes.values()].filter(
    (type) => (
      type.kind === "enum"
      || type.kind === "record"
      || type.kind === "scalar"
    ),
  );

  const records = [
    `ZFDCL${hexNumber(foreignDeclarationProtocolVersion)}`,
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
    const source = type.metadata.source;
    const fields = type.kind === "record"
      ? type.nativeFields.map((field) => ({
          name: field.name,
          typeName: field.cName,
          metadata: field.metadata,
        }))
      : [];
    records.push([
      "T",
      hexNumber(typeIndex),
      text(type.kind),
      text(type.exportName),
      text(type.qualifiedName),
      text(type.typeName),
      text(type.cName),
      optionalText(type.kind === "record" ? type.canonicalNativeName : null),
      text(
        type.kind === "enum" || type.kind === "scalar"
          ? type.underlying
          : "",
      ),
      boolean(type.kind === "enum" && type.flags),
      text(type.kind === "record" ? type.layout : ""),
      optionalText(source?.fileName),
      hexNumber(source?.line ?? 0),
      hexNumber(source?.column ?? 0),
      hexNumber(source?.length ?? 0),
      hexNumber(fields.length),
    ].join(""));
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      const field = fields[fieldIndex];
      const fieldSource = field.metadata.source;
      records.push([
        "D",
        hexNumber(typeIndex),
        hexNumber(fieldIndex),
        text(field.name),
        text(field.typeName),
        optionalText(fieldSource?.fileName),
        hexNumber(fieldSource?.line ?? 0),
        hexNumber(fieldSource?.column ?? 0),
        hexNumber(fieldSource?.length ?? 0),
      ].join(""));
    }
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
  const appendObjCMethods = (
    ownerKind: "interface" | "protocol",
    ownerIndex: number,
    methods: readonly ForeignObjCMethod[],
  ): void => {
    for (let methodIndex = 0; methodIndex < methods.length; methodIndex += 1) {
      const method = methods[methodIndex];
      const source = method.metadata.source;
      const required = "required" in method ? method.required === true : true;
      records.push([
        "J",
        text(ownerKind),
        hexNumber(ownerIndex),
        hexNumber(methodIndex),
        text(method.selector),
        text(method.baseName),
        boolean(method.instance),
        boolean(method.returnsInstanceType),
        boolean(method.designatedInitializer === true),
        boolean(method.requiresSuper === true),
        boolean(method.direct === true),
        boolean(method.consumesSelf === true),
        boolean(method.variadic === true),
        text(method.returnType.cName),
        text(semanticTypeName(method.returnType)),
        boolean(required),
        optionalText(source?.fileName),
        hexNumber(source?.line ?? 0),
        hexNumber(source?.column ?? 0),
        hexNumber(source?.length ?? 0),
        optionalText(method.metadata.executorAffinity),
        hexNumber(method.parameters.length),
        hexNumber(method.metadata.availability.length),
        optionalNumber(method.asyncCallbackParameter),
        optionalNumber(method.asyncResultParameter),
        optionalNumber(method.asyncErrorParameter),
      ].join(""));
      for (let parameterIndex = 0; parameterIndex < method.parameters.length; parameterIndex += 1) {
        const parameter = method.parameters[parameterIndex];
        records.push([
          "K",
          text(ownerKind),
          hexNumber(ownerIndex),
          hexNumber(methodIndex),
          hexNumber(parameterIndex),
          optionalText(parameter.name),
          text(parameter.type.cName),
          text(semanticTypeName(parameter.type)),
          boolean(method.consumedParameters?.includes(parameterIndex) === true),
          hexNumber(parameter.protocols?.length ?? 0),
          ...(parameter.protocols ?? []).map(text),
        ].join(""));
      }
      for (let availabilityIndex = 0; availabilityIndex < method.metadata.availability.length; availabilityIndex += 1) {
        const availability = method.metadata.availability[availabilityIndex];
        records.push([
          "V",
          text(ownerKind),
          hexNumber(ownerIndex),
          hexNumber(methodIndex),
          hexNumber(availabilityIndex),
          optionalText(availability.platform),
          optionalText(availability.introduced),
          boolean(availability.deprecated),
          optionalText(availability.deprecatedVersion),
          optionalText(availability.obsoleted),
          boolean(availability.unavailable),
          optionalText(availability.message),
        ].join(""));
      }
    }
  };
  const appendObjCProperties = (
    ownerIndex: number,
    properties: readonly ForeignObjCProperty[],
  ): void => {
    for (let propertyIndex = 0; propertyIndex < properties.length; propertyIndex += 1) {
      const property = properties[propertyIndex];
      const source = property.metadata.source;
      records.push([
        "R",
        hexNumber(ownerIndex),
        hexNumber(propertyIndex),
        text(property.name),
        text(property.getter),
        optionalText(property.setter),
        boolean(property.classProperty),
        boolean(property.readonly),
        text(property.ownership),
        text(property.type.cName),
        text(semanticTypeName(property.type)),
        hexNumber(property.protocols.length),
        ...property.protocols.map(text),
        optionalText(source?.fileName),
        hexNumber(source?.line ?? 0),
        hexNumber(source?.column ?? 0),
        hexNumber(source?.length ?? 0),
        optionalText(property.metadata.executorAffinity),
        hexNumber(property.metadata.availability.length),
      ].join(""));
      for (let availabilityIndex = 0; availabilityIndex < property.metadata.availability.length; availabilityIndex += 1) {
        const availability = property.metadata.availability[availabilityIndex];
        records.push([
          "W",
          hexNumber(ownerIndex),
          hexNumber(propertyIndex),
          hexNumber(availabilityIndex),
          optionalText(availability.platform),
          optionalText(availability.introduced),
          boolean(availability.deprecated),
          optionalText(availability.deprecatedVersion),
          optionalText(availability.obsoleted),
          boolean(availability.unavailable),
          optionalText(availability.message),
        ].join(""));
      }
    }
  };
  const protocols = [...module.protocols.values()];
  for (let protocolIndex = 0; protocolIndex < protocols.length; protocolIndex += 1) {
    const protocol = protocols[protocolIndex];
    const source = protocol.metadata.source;
    records.push([
      "Q",
      hexNumber(protocolIndex),
      text(protocol.exportName),
      text(protocol.typeName),
      text(protocol.protocolName),
      hexNumber(protocol.inherited.length),
      ...protocol.inherited.map(text),
      optionalText(source?.fileName),
      hexNumber(source?.line ?? 0),
      hexNumber(source?.column ?? 0),
      hexNumber(source?.length ?? 0),
      optionalText(protocol.metadata.executorAffinity),
      hexNumber(protocol.methods.length),
    ].join(""));
    appendObjCMethods("protocol", protocolIndex, protocol.methods);
  }
  const interfaces = [...module.interfaces.values()];
  for (let interfaceIndex = 0; interfaceIndex < interfaces.length; interfaceIndex += 1) {
    const interface_ = interfaces[interfaceIndex];
    const source = interface_.metadata.source;
    records.push([
      "I",
      hexNumber(interfaceIndex),
      text(interface_.exportName),
      text(interface_.typeName),
      text(interface_.className),
      optionalText(interface_.superName),
      boolean(interface_.subclassingRestricted === true),
      optionalText(source?.fileName),
      hexNumber(source?.line ?? 0),
      hexNumber(source?.column ?? 0),
      hexNumber(source?.length ?? 0),
      optionalText(interface_.metadata.executorAffinity),
      hexNumber(interface_.methods.length),
      hexNumber(interface_.properties.length),
      hexNumber(interface_.metadata.availability.length),
      ...interface_.metadata.availability.flatMap((availability) => [
        optionalText(availability.platform), optionalText(availability.introduced),
        boolean(availability.deprecated), optionalText(availability.deprecatedVersion),
        optionalText(availability.obsoleted), boolean(availability.unavailable),
        optionalText(availability.message),
      ]),
    ].join(""));
    appendObjCMethods("interface", interfaceIndex, interface_.methods);
    appendObjCProperties(interfaceIndex, interface_.properties);
  }
  records.push("E");
  return `${records.join("\n")}\n`;
}
