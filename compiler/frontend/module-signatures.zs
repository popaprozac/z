import {
  Declaration,
  DeclarationKind,
  ConstructorDeclaration,
  FunctionDeclaration,
  ParameterMode,
  Program,
  ReceiverMode,
  Visibility,
} from "./parser.zs";
import {
  ModuleFieldSignature,
  ModuleFunctionSignature,
  ModuleMethodSignature,
  ModuleSymbolKind,
  ModuleTypeParameterConstraint,
  ModuleTypeSignature,
  ModuleVariantSignature,
} from "./semantic-model.zs";

function parameterModeName(mode: ParameterMode): String {
  return match (mode) {
    value => "value";
    input => "in";
    inputOutput => "inout";
    output => "out";
  };
}

export function declarationSymbolKind(kind: DeclarationKind): ModuleSymbolKind {
  if (kind == DeclarationKind.constantDeclaration) return ModuleSymbolKind.constantSymbol;
  if (kind == DeclarationKind.functionDeclaration) return ModuleSymbolKind.functionSymbol;
  if (kind == DeclarationKind.structDeclaration) return ModuleSymbolKind.structSymbol;
  if (kind == DeclarationKind.classDeclaration) return ModuleSymbolKind.classSymbol;
  if (kind == DeclarationKind.traitDeclaration) return ModuleSymbolKind.traitSymbol;
  if (kind == DeclarationKind.typeAliasDeclaration) return ModuleSymbolKind.typeAliasSymbol;
  return ModuleSymbolKind.enumSymbol;
}

export function programFunctionSignature(
  in program: Program,
  in declaration: Declaration
): Option<ModuleFunctionSignature> {
  if (declaration.kind != DeclarationKind.functionDeclaration) {
    return Option<ModuleFunctionSignature>.none;
  }
  for (const functionDeclaration of program.functions) {
    if (functionDeclaration.name != declaration.name) continue;
    return Option.some(functionDeclarationSignature(functionDeclaration));
  }
  return Option<ModuleFunctionSignature>.none;
}

function functionDeclarationSignature(
  in declaration: FunctionDeclaration
): ModuleFunctionSignature {
  let typeParameters = Array<String>();
  let typeParameterConstraints = Array<ModuleTypeParameterConstraint>();
  for (const parameter of declaration.typeParameters) {
    typeParameters.push(parameter.name.copyBytes(0, parameter.name.byteLength));
    for (const constraint of parameter.constraints) {
      typeParameterConstraints.push(ModuleTypeParameterConstraint({
        parameter: parameter.name.copyBytes(0, parameter.name.byteLength),
        traitName: constraint.name.copyBytes(0, constraint.name.byteLength),
      }));
    }
  }
  let parameterTypes = Array<String>();
  let parameterModes = Array<String>();
  for (const parameter of declaration.parameters) {
    parameterModes.push(parameterModeName(parameter.mode));
    parameterTypes.push(parameter.type.name.copyBytes(0, parameter.type.name.byteLength));
  }
  let errorType = "";
  match (in declaration.errorType) {
    some(error) => errorType = error.name.copyBytes(0, error.name.byteLength);
    none => {}
  }
  return ModuleFunctionSignature({
    asynchronous: declaration.asynchronous,
    executorAffinity: declaration.executorAffinity.copyBytes(0, declaration.executorAffinity.byteLength),
    typeParameters,
    typeParameterConstraints,
    parameterModes,
    parameterTypes,
    viewParameter: Option<usize>.none,
    invalidatesParameters: Array<usize>(),
    invalidatesLifetimes: Array<String>(),
    returnType: declaration.returnType.name.copyBytes(
      0,
      declaration.returnType.name.byteLength
    ),
    errorType,
  });
}

function constructorDeclarationSignature(
  in ownerName: String,
  in declaration: ConstructorDeclaration
): ModuleFunctionSignature {
  let parameterTypes = Array<String>();
  let parameterModes = Array<String>();
  for (const parameter of declaration.parameters) {
    parameterModes.push(parameterModeName(parameter.mode));
    parameterTypes.push(parameter.type.name.copyBytes(0, parameter.type.name.byteLength));
  }
  let errorType = "";
  match (in declaration.errorType) {
    some(error) => errorType = error.name.copyBytes(0, error.name.byteLength);
    none => {}
  }
  return ModuleFunctionSignature({
    asynchronous: false,
    executorAffinity: "",
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    parameterModes,
    parameterTypes,
    viewParameter: Option<usize>.none,
    invalidatesParameters: Array<usize>(),
    invalidatesLifetimes: Array<String>(),
    returnType: ownerName.copyBytes(0, ownerName.byteLength),
    errorType,
  });
}

function receiverModeName(mode: ReceiverMode): String {
  if (mode == ReceiverMode.inputOutput) return "inout";
  if (mode == ReceiverMode.move) return "move";
  return "in";
}

function visibilityName(visibility: Visibility): String {
  if (visibility == Visibility.privateVisibility) return "private";
  return "public";
}

export function programTypeSignature(
  in program: Program,
  in declaration: Declaration
): Option<ModuleTypeSignature> {
  if (
    declaration.kind == DeclarationKind.structDeclaration
    || declaration.kind == DeclarationKind.classDeclaration
  ) {
    for (const aggregate of program.aggregates) {
      if (aggregate.name != declaration.name) continue;
      let typeParameters = Array<String>();
      let typeParameterConstraints = Array<ModuleTypeParameterConstraint>();
      for (const parameter of aggregate.typeParameters) {
        typeParameters.push(parameter.name.copyBytes(0, parameter.name.byteLength));
        for (const constraint of parameter.constraints) {
          typeParameterConstraints.push(ModuleTypeParameterConstraint({
            parameter: parameter.name.copyBytes(0, parameter.name.byteLength),
            traitName: constraint.name.copyBytes(0, constraint.name.byteLength),
          }));
        }
      }
      let implementedTraits = Array<String>();
      for (const implemented of aggregate.implementedTraits) {
        implementedTraits.push(implemented.name.copyBytes(0, implemented.name.byteLength));
      }
      let fields = Array<ModuleFieldSignature>();
      for (const field of aggregate.fields) {
        let hasDefault = field.optionalField;
        match (in field.defaultValue) {
          some(_) => hasDefault = true;
          none => {}
        }
        fields.push(ModuleFieldSignature({
          name: field.name.copyBytes(0, field.name.byteLength),
          typeName: field.type.name.copyBytes(0, field.type.name.byteLength),
          executorAffinity: field.executorAffinity.copyBytes(
            0,
            field.executorAffinity.byteLength
          ),
          visibility: visibilityName(field.visibility),
          readonlyField: field.readonlyField,
          hasDefault,
          optionalField: field.optionalField,
          viewLifetime: "",
        }));
      }
      let methods = Array<ModuleMethodSignature>();
      for (const method of aggregate.methods) {
        methods.push(ModuleMethodSignature({
          name: method.name.copyBytes(0, method.name.byteLength),
          staticMethod: method.staticMethod,
          visibility: visibilityName(method.visibility),
          receiverMode: receiverModeName(method.receiverMode),
          signature: functionDeclarationSignature(method),
        }));
      }
      let customDeinit = false;
      match (in aggregate.deinitializer) {
        some(deinitializer) => customDeinit = true;
        none => {}
      }
      let customConstructor = false;
      let constructorSignature = Option<ModuleFunctionSignature>.none;
      match (in aggregate.constructorDeclaration) {
        some(initializer) => {
          customConstructor = true;
          constructorSignature = Option.some(constructorDeclarationSignature(
            aggregate.name,
            initializer
          ));
        }
        none => {}
      }
      return Option.some(ModuleTypeSignature({
        nativeCName: aggregate.nativeCLayout
          ? aggregate.name.copyBytes(0, aggregate.name.byteLength)
          : "",
        nativeCUnderlyingType: "",
        typeParameters,
        typeParameterConstraints,
        executorAffinity: aggregate.executorAffinity.copyBytes(0, aggregate.executorAffinity.byteLength),
        implementedTraits,
        fields,
        methods,
        variants: Array<ModuleVariantSignature>(),
        customDeinit,
        customConstructor,
        constructorSignature,
        foreignKind: "",
        foreignLayout: "",
        foreignNativeName: "",
        foreignUnderlyingType: "",
        foreignResourceRelease: "",
      }));
    }
  }
  if (declaration.kind == DeclarationKind.traitDeclaration) {
    for (const traitDeclaration of program.traits) {
      if (traitDeclaration.name != declaration.name) continue;
      let methods = Array<ModuleMethodSignature>();
      for (const method of traitDeclaration.methods) {
        methods.push(ModuleMethodSignature({
          name: method.name.copyBytes(0, method.name.byteLength),
          staticMethod: false,
          visibility: "public",
          receiverMode: receiverModeName(method.receiverMode),
          signature: functionDeclarationSignature(method),
        }));
      }
      return Option.some(ModuleTypeSignature({
        nativeCName: "",
        nativeCUnderlyingType: "",
        typeParameters: Array<String>(),
        typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
        executorAffinity: "",
        implementedTraits: Array<String>(),
        fields: Array<ModuleFieldSignature>(),
        methods,
        variants: Array<ModuleVariantSignature>(),
        customDeinit: false,
        customConstructor: false,
        constructorSignature: Option<ModuleFunctionSignature>.none,
        foreignKind: "",
        foreignLayout: "",
        foreignNativeName: "",
        foreignUnderlyingType: "",
        foreignResourceRelease: "",
      }));
    }
  }
  if (declaration.kind == DeclarationKind.enumDeclaration) {
    for (const enumDeclaration of program.enums) {
      if (enumDeclaration.name != declaration.name) continue;
      let variants = Array<ModuleVariantSignature>();
      for (const variant of enumDeclaration.variants) {
        let payloadType = "";
        match (in variant.payload) {
          some(payload) => payloadType = payload.name.copyBytes(0, payload.name.byteLength);
          none => {}
        }
        variants.push(ModuleVariantSignature({
          name: variant.name.copyBytes(0, variant.name.byteLength),
          payloadType,
        }));
      }
      let nativeCUnderlyingType = "";
      if (enumDeclaration.nativeCLayout) {
        match (in enumDeclaration.underlyingType) {
          some(type) => {
            nativeCUnderlyingType = type.name.copyBytes(0, type.name.byteLength);
          }
          none => {}
        }
      }
      return Option.some(ModuleTypeSignature({
        nativeCName: enumDeclaration.nativeCLayout
          ? enumDeclaration.name.copyBytes(0, enumDeclaration.name.byteLength)
          : "",
        nativeCUnderlyingType,
        typeParameters: Array<String>(),
        typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
        executorAffinity: "",
        implementedTraits: Array<String>(),
        fields: Array<ModuleFieldSignature>(),
        methods: Array<ModuleMethodSignature>(),
        variants,
        customDeinit: false,
        customConstructor: false,
        constructorSignature: Option<ModuleFunctionSignature>.none,
        foreignKind: "",
        foreignLayout: "",
        foreignNativeName: "",
        foreignUnderlyingType: "",
        foreignResourceRelease: "",
      }));
    }
  }
  return Option<ModuleTypeSignature>.none;
}
