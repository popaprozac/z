import {
  NativeValueBinding,
  addValueBinding,
  valueBindingType,
} from "./semantic-flow-state.zs";
import {
  inferredTypeSymbolLocation,
  rebaseTypeName,
  typeSymbolLocation,
} from "./semantic-type-identities.zs";
import { genericTypeShape } from "./semantic-type-shapes.zs";
import { substituteGenericType } from "./semantic-type-ownership.zs";
import {
  ModuleFunctionSignature,
  ModuleSymbolKind,
  ModuleTypeParameterConstraint,
  ResolvedModule,
} from "./semantic-model.zs";
import {
  ExpressionKind,
  ExpressionTree,
  TypeParameter,
} from "./parser.zs";

export struct NativeMatchVariant {
  name: String;
  payloadType: String;
  payloadModuleIndex: usize;
  foreignMember: String = "";
  foreignValues: Array<String> = Array<String>();
  foreignFallback: boolean = false;
}

export struct NativeMatchShape {
  name: String;
  variants: Array<NativeMatchVariant>;
  foreignUnion: boolean = false;
  foreignDiscriminantMember: String = "";
  foreignDiscriminantType: String = "";
}

export struct NativeFieldShape {
  name: String;
  ownerName: String;
  ownerModuleIndex: usize;
  ownerSymbolIndex: usize;
  typeName: String;
  executorAffinity: String;
  visibility: String;
  readonlyField: boolean;
  optionalField: boolean;
  foreignUnion: boolean;
  viewLifetime: String;
}

export struct NativeAggregateConstructionShape {
  name: String;
  valueStruct: boolean;
  customDeinit: boolean;
  genericInstance: boolean;
  typeParameters: Array<String>;
  typeParameterConstraints: Array<ModuleTypeParameterConstraint>;
  fields: Array<String>;
  allFields: Array<String>;
}

export struct NativeMethodCallShape {
  name: String;
  ownerName: String;
  ownerModuleIndex: usize;
  ownerSymbolIndex: usize;
  staticMethod: boolean;
  visibility: String;
  receiverMode: String;
  ownerTypeParameters: Array<String>;
  ownerTypeArguments: Array<String>;
  ownerTypeParameterConstraints: Array<ModuleTypeParameterConstraint>;
  signature: ModuleFunctionSignature;
}

function matchVariant(
  in name: String,
  in payloadType: String,
  payloadModuleIndex: usize
): NativeMatchVariant {
  return NativeMatchVariant({
    name: name.copyBytes(0, name.byteLength),
    payloadType: payloadType.copyBytes(0, payloadType.byteLength),
    payloadModuleIndex,
  });
}

export function matchShape(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in subjectType: String
): Option<NativeMatchShape> {
  match (genericTypeShape(subjectType)) {
    some(generic) => {
      if (generic.base == "Option" && generic.arguments.length == 1) {
        let variants = Array<NativeMatchVariant>();
        variants.push(matchVariant("some", generic.arguments[0], moduleIndex));
        variants.push(matchVariant("none", "", moduleIndex));
        return Option.some(NativeMatchShape({
          name: subjectType.copyBytes(0, subjectType.byteLength),
          variants,
        }));
      }
      if (generic.base == "Result" && generic.arguments.length == 2) {
        let variants = Array<NativeMatchVariant>();
        let successType = "";
        if (generic.arguments[0] != "void") {
          successType = generic.arguments[0].copyBytes(0, generic.arguments[0].byteLength);
        }
        variants.push(matchVariant("success", successType, moduleIndex));
        variants.push(matchVariant("failure", generic.arguments[1], moduleIndex));
        return Option.some(NativeMatchShape({
          name: subjectType.copyBytes(0, subjectType.byteLength),
          variants,
        }));
      }
      if (generic.base == "GeneratorStep" && generic.arguments.length == 2) {
        let variants = Array<NativeMatchVariant>();
        variants.push(matchVariant("yielded", generic.arguments[0], moduleIndex));
        variants.push(matchVariant("complete", generic.arguments[1], moduleIndex));
        return Option.some(NativeMatchShape({
          name: subjectType.copyBytes(0, subjectType.byteLength),
          variants,
        }));
      }
    }
    none => {}
  }
  match (inferredTypeSymbolLocation(modules, moduleIndex, subjectType)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          if (signature.foreignDiscriminantMember.byteLength > 0) {
            let variants = Array<NativeMatchVariant>();
            for (const variant of signature.foreignUnionVariants) {
              let payloadType = "";
              if (variant.payloadType.byteLength > 0) {
                payloadType = rebaseTypeName(
                  modules,
                  location.moduleIndex,
                  moduleIndex,
                  variant.payloadType
                );
              }
              let values = Array<String>();
              for (const value of variant.values) {
                values.push(value.copyBytes(0, value.byteLength));
              }
              variants.push(NativeMatchVariant({
                name: variant.name.copyBytes(0, variant.name.byteLength),
                payloadType,
                payloadModuleIndex: moduleIndex,
                foreignMember: variant.member.copyBytes(0, variant.member.byteLength),
                foreignValues: values,
                foreignFallback: false,
              }));
            }
            variants.push(NativeMatchVariant({
              name: signature.foreignFallbackVariant.copyBytes(
                0,
                signature.foreignFallbackVariant.byteLength
              ),
              payloadType: rebaseTypeName(
                modules,
                location.moduleIndex,
                moduleIndex,
                signature.foreignDiscriminantType
              ),
              payloadModuleIndex: moduleIndex,
              foreignMember: "",
              foreignValues: Array<String>(),
              foreignFallback: true,
            }));
            return Option.some(NativeMatchShape({
              name: subjectType.copyBytes(0, subjectType.byteLength),
              variants,
              foreignUnion: true,
              foreignDiscriminantMember:
                signature.foreignDiscriminantMember.copyBytes(
                  0,
                  signature.foreignDiscriminantMember.byteLength
                ),
              foreignDiscriminantType: rebaseTypeName(
                modules,
                location.moduleIndex,
                moduleIndex,
                signature.foreignDiscriminantType
              ),
            }));
          }
        }
        none => {}
      }
      if (
        modules[location.moduleIndex].symbols[location.symbolIndex].kind
        != ModuleSymbolKind.enumSymbol
      ) {
        return Option<NativeMatchShape>.none;
      }
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          let variants = Array<NativeMatchVariant>();
          for (const variant of signature.variants) {
            let payloadType = "";
            if (variant.payloadType.byteLength > 0) {
              payloadType = rebaseTypeName(
                modules,
                location.moduleIndex,
                moduleIndex,
                variant.payloadType
              );
            }
            variants.push(matchVariant(
              variant.name,
              payloadType,
              moduleIndex
            ));
          }
          return Option.some(NativeMatchShape({
            name: subjectType.copyBytes(0, subjectType.byteLength),
            variants,
          }));
        }
        none => {}
      }
    }
    none => {}
  }
  return Option<NativeMatchShape>.none;
}

export function matchVariantIndex(
  in shape: NativeMatchShape,
  in name: String
): usize {
  let index: usize = 0;
  while (index < shape.variants.length) {
    if (shape.variants[index].name == name) return index;
    index = index + 1;
  }
  return shape.variants.length;
}

export function isKnownMatchVariant(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in subjectType: String,
  in variantName: String
): boolean {
  return match (matchShape(modules, moduleIndex, subjectType)) {
    some(shape) => matchVariantIndex(shape, variantName) < shape.variants.length;
    none => false;
  };
}

export function aggregateFieldShape(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in ownerType: String,
  in fieldName: String
): Option<NativeFieldShape> {
  let arguments = Array<String>();
  match (genericTypeShape(ownerType)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
      }
    }
    none => {}
  }
  match (inferredTypeSymbolLocation(modules, moduleIndex, ownerType)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          let substitutions = Array<NativeValueBinding>();
          let typeIndex: usize = 0;
          while (
            typeIndex < signature.typeParameters.length
            && typeIndex < arguments.length
          ) {
            addValueBinding(
              inout substitutions,
              signature.typeParameters[typeIndex],
              arguments[typeIndex]
            );
            typeIndex = typeIndex + 1;
          }
          for (const field of signature.fields) {
            if (field.name == fieldName) {
              const fieldType = rebaseTypeName(
                modules,
                location.moduleIndex,
                moduleIndex,
                field.typeName
              );
              return Option.some(NativeFieldShape({
                name: field.name.copyBytes(0, field.name.byteLength),
                ownerName: modules[location.moduleIndex].symbols[location.symbolIndex].name.copyBytes(
                  0,
                  modules[location.moduleIndex].symbols[location.symbolIndex].name.byteLength
                ),
                ownerModuleIndex: location.moduleIndex,
                ownerSymbolIndex: location.symbolIndex,
                typeName: substituteGenericType(fieldType, substitutions),
                executorAffinity: field.executorAffinity.copyBytes(
                  0,
                  field.executorAffinity.byteLength
                ),
                visibility: field.visibility.copyBytes(0, field.visibility.byteLength),
                readonlyField: field.readonlyField,
                optionalField: field.optionalField,
                foreignUnion: signature.foreignKind == "union"
                  || (
                    signature.foreignKind == "record"
                    && signature.foreignLayout == "union"
                  ),
                viewLifetime: field.viewLifetime.copyBytes(
                  0,
                  field.viewLifetime.byteLength
                ),
              }));
            }
          }
        }
        none => {}
      }
    }
    none => {}
  }
  return Option<NativeFieldShape>.none;
}

export function activeOwnerMatches(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in bindings: Array<NativeValueBinding>,
  in field: NativeFieldShape
): boolean {
  const ownerType = valueBindingType(bindings, "__z_native_owner_type");
  if (ownerType.byteLength == 0) return false;
  return match (inferredTypeSymbolLocation(modules, moduleIndex, ownerType)) {
    some(location) => location.moduleIndex == field.ownerModuleIndex
      && location.symbolIndex == field.ownerSymbolIndex;
    none => false;
  };
}

export function aggregateConstructionShape(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): Option<NativeAggregateConstructionShape> {
  match (inferredTypeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          let typeParameters = Array<String>();
          for (const parameter of signature.typeParameters) {
            typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
          }
          let genericInstance = false;
          match (genericTypeShape(typeName)) {
            some(generic) => genericInstance = true;
            none => {}
          }
          let typeParameterConstraints = Array<ModuleTypeParameterConstraint>();
          for (const constraint of signature.typeParameterConstraints) {
            typeParameterConstraints.push(ModuleTypeParameterConstraint({
              parameter: constraint.parameter.copyBytes(0, constraint.parameter.byteLength),
              traitName: rebaseTypeName(
                modules,
                location.moduleIndex,
                moduleIndex,
                constraint.traitName
              ),
            }));
          }
          let fields = Array<String>();
          let allFields = Array<String>();
          for (const field of signature.fields) {
            allFields.push(field.name.copyBytes(0, field.name.byteLength));
            if (!field.hasDefault) {
              fields.push(field.name.copyBytes(0, field.name.byteLength));
            }
          }
          return Option.some(NativeAggregateConstructionShape({
            name: modules[location.moduleIndex].symbols[location.symbolIndex].name.copyBytes(
              0,
              modules[location.moduleIndex].symbols[location.symbolIndex].name.byteLength
            ),
            valueStruct: modules[location.moduleIndex].symbols[
              location.symbolIndex
            ].kind == ModuleSymbolKind.structSymbol,
            customDeinit: signature.customDeinit,
            genericInstance,
            typeParameters,
            typeParameterConstraints,
            fields,
            allFields,
          }));
        }
        none => {}
      }
    }
    none => {}
  }
  return Option<NativeAggregateConstructionShape>.none;
}

export function rebaseModuleFunctionSignature(
  in modules: Array<ResolvedModule>,
  fromModuleIndex: usize,
  toModuleIndex: usize,
  in signature: ModuleFunctionSignature
): ModuleFunctionSignature {
  let typeParameters = Array<String>();
  for (const parameter of signature.typeParameters) {
    typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
  }
  let typeParameterConstraints = Array<ModuleTypeParameterConstraint>();
  for (const constraint of signature.typeParameterConstraints) {
    typeParameterConstraints.push(ModuleTypeParameterConstraint({
      parameter: constraint.parameter.copyBytes(0, constraint.parameter.byteLength),
      traitName: rebaseTypeName(
        modules,
        fromModuleIndex,
        toModuleIndex,
        constraint.traitName
      ),
    }));
  }
  let parameterModes = Array<String>();
  for (const mode of signature.parameterModes) {
    parameterModes.push(mode.copyBytes(0, mode.byteLength));
  }
  let parameterTypes = Array<String>();
  for (const typeName of signature.parameterTypes) {
    parameterTypes.push(rebaseTypeName(
      modules,
      fromModuleIndex,
      toModuleIndex,
      typeName
    ));
  }
  let errorType = "";
  if (signature.errorType.byteLength > 0) {
    errorType = rebaseTypeName(
      modules,
      fromModuleIndex,
      toModuleIndex,
      signature.errorType
    );
  }
  let invalidatesParameters = Array<usize>();
  for (const parameter of signature.invalidatesParameters) {
    invalidatesParameters.push(parameter);
  }
  let invalidatesLifetimes = Array<String>();
  for (const lifetime of signature.invalidatesLifetimes) {
    invalidatesLifetimes.push(lifetime.copyBytes(0, lifetime.byteLength));
  }
  return ModuleFunctionSignature({
    asynchronous: signature.asynchronous,
    executorAffinity: signature.executorAffinity.copyBytes(0, signature.executorAffinity.byteLength),
    threadContract: signature.threadContract.copyBytes(0, signature.threadContract.byteLength),
    typeParameters,
    typeParameterConstraints,
    parameterModes,
    parameterTypes,
    viewParameter: signature.viewParameter,
    invalidatesParameters,
    invalidatesLifetimes,
    returnType: rebaseTypeName(
      modules,
      fromModuleIndex,
      toModuleIndex,
      signature.returnType
    ),
    errorType,
  });
}

export function methodCallShape(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in ownerType: String,
  in methodName: String,
  staticMethod: boolean
): Option<NativeMethodCallShape> {
  let ownerArguments = Array<String>();
  match (genericTypeShape(ownerType)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        ownerArguments.push(argument.copyBytes(0, argument.byteLength));
      }
    }
    none => {}
  }
  match (inferredTypeSymbolLocation(modules, moduleIndex, ownerType)) {
    some(location) => {
      match (
        in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature
      ) {
        some(typeSignature) => {
          for (const method of typeSignature.methods) {
            if (method.name != methodName || method.staticMethod != staticMethod) continue;
            let ownerTypeParameters = Array<String>();
            for (const parameter of typeSignature.typeParameters) {
              ownerTypeParameters.push(parameter.copyBytes(0, parameter.byteLength));
            }
            let ownerTypeParameterConstraints = Array<ModuleTypeParameterConstraint>();
            for (const constraint of typeSignature.typeParameterConstraints) {
              ownerTypeParameterConstraints.push(ModuleTypeParameterConstraint({
                parameter: constraint.parameter.copyBytes(0, constraint.parameter.byteLength),
                traitName: rebaseTypeName(
                  modules,
                  location.moduleIndex,
                  moduleIndex,
                  constraint.traitName
                ),
              }));
            }
            return Option.some(NativeMethodCallShape({
              name: method.name.copyBytes(0, method.name.byteLength),
              ownerName: modules[location.moduleIndex].symbols[location.symbolIndex].name.copyBytes(
                0,
                modules[location.moduleIndex].symbols[location.symbolIndex].name.byteLength
              ),
              ownerModuleIndex: location.moduleIndex,
              ownerSymbolIndex: location.symbolIndex,
              staticMethod: method.staticMethod,
              visibility: method.visibility.copyBytes(0, method.visibility.byteLength),
              receiverMode: method.receiverMode.copyBytes(0, method.receiverMode.byteLength),
              ownerTypeParameters,
              ownerTypeArguments: ownerArguments,
              ownerTypeParameterConstraints,
              signature: rebaseModuleFunctionSignature(
                modules,
                location.moduleIndex,
                moduleIndex,
                method.signature
              ),
            }));
          }
        }
        none => {}
      }
    }
    none => {}
  }
  return Option<NativeMethodCallShape>.none;
}

function typeParameterMarkerName(in parameter: String): String {
  return `__z_native_type_parameter:${parameter}`;
}

function typeParameterConstraintName(in parameter: String): String {
  return `__z_native_type_parameter_constraint:${parameter}`;
}

export function addTypeParameterBindings(
  inout bindings: Array<NativeValueBinding>,
  in parameters: Array<TypeParameter>
): void {
  for (const parameter of parameters) {
    const markerName = typeParameterMarkerName(parameter.name);
    const constraintName = typeParameterConstraintName(parameter.name);
    addValueBinding(inout bindings, markerName, "");
    for (const constraint of parameter.constraints) {
      addValueBinding(
        inout bindings,
        constraintName,
        constraint.name
      );
    }
  }
}

function typeParameterConstraintTraits(
  in bindings: Array<NativeValueBinding>,
  in parameter: String
): Array<String> {
  let constraints = Array<String>();
  const markerName = typeParameterMarkerName(parameter);
  const constraintName = typeParameterConstraintName(parameter);
  let markerIndex = bindings.length;
  while (markerIndex > 0) {
    markerIndex = markerIndex - 1;
    if (bindings[markerIndex].name == markerName) break;
  }
  if (bindings.length == 0 || bindings[markerIndex].name != markerName) return constraints;
  let index = markerIndex + 1;
  while (index < bindings.length) {
    if (bindings[index].name == constraintName) {
      constraints.push(bindings[index].typeName.copyBytes(0, bindings[index].typeName.byteLength));
    }
    index = index + 1;
  }
  return constraints;
}

export function isActiveTypeParameter(
  in bindings: Array<NativeValueBinding>,
  in parameter: String
): boolean {
  const markerName = typeParameterMarkerName(parameter);
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == markerName) return true;
  }
  return false;
}

function constrainedMethodCallShape(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in bindings: Array<NativeValueBinding>,
  in ownerType: String,
  in methodName: String
): Option<NativeMethodCallShape> {
  const constraints = typeParameterConstraintTraits(bindings, ownerType);
  for (const traitName of constraints) {
    match (methodCallShape(modules, moduleIndex, traitName, methodName, false)) {
      some(method) => return Option.some(method);
      none => {}
    }
  }
  return Option<NativeMethodCallShape>.none;
}

export function callableMethodCallShape(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in bindings: Array<NativeValueBinding>,
  in ownerType: String,
  in methodName: String,
  staticMethod: boolean
): Option<NativeMethodCallShape> {
  match (methodCallShape(modules, moduleIndex, ownerType, methodName, staticMethod)) {
    some(method) => return Option.some(method);
    none => {}
  }
  if (!staticMethod) {
    return constrainedMethodCallShape(modules, moduleIndex, bindings, ownerType, methodName);
  }
  return Option<NativeMethodCallShape>.none;
}

export function activeOwnerMatchesMethod(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in bindings: Array<NativeValueBinding>,
  in method: NativeMethodCallShape
): boolean {
  const ownerType = valueBindingType(bindings, "__z_native_owner_type");
  if (ownerType.byteLength == 0) return false;
  return match (inferredTypeSymbolLocation(modules, moduleIndex, ownerType)) {
    some(location) => location.moduleIndex == method.ownerModuleIndex
      && location.symbolIndex == method.ownerSymbolIndex;
    none => false;
  };
}

export function typeExpressionName(
  in tree: ExpressionTree,
  index: usize
): String {
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
    return tree.nodes[index].value.copyBytes(0, tree.nodes[index].value.byteLength);
  }
  if (
    tree.nodes[index].kind == ExpressionKind.memberExpression
    && tree.nodes[index].children.length == 1
  ) {
    const receiverIndex = tree.nodes[index].children[0];
    const receiver = typeExpressionName(tree, receiverIndex);
    if (receiver.byteLength == 0) return "";
    return `${receiver}.${tree.nodes[index].value}`;
  }
  return "";
}

export function methodCallableSignature(
  in method: NativeMethodCallShape
): ModuleFunctionSignature {
  let typeParameters = Array<String>();
  let typeParameterConstraints = Array<ModuleTypeParameterConstraint>();
  for (const constraint of method.ownerTypeParameterConstraints) {
    typeParameterConstraints.push(ModuleTypeParameterConstraint({
      parameter: constraint.parameter.copyBytes(0, constraint.parameter.byteLength),
      traitName: constraint.traitName.copyBytes(0, constraint.traitName.byteLength),
    }));
  }
  if (method.staticMethod && method.ownerTypeArguments.length == 0) {
    for (const parameter of method.ownerTypeParameters) {
      typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
    }
  }
  for (const parameter of method.signature.typeParameters) {
    typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
  }
  for (const constraint of method.signature.typeParameterConstraints) {
    typeParameterConstraints.push(ModuleTypeParameterConstraint({
      parameter: constraint.parameter.copyBytes(0, constraint.parameter.byteLength),
      traitName: constraint.traitName.copyBytes(0, constraint.traitName.byteLength),
    }));
  }
  let parameterModes = Array<String>();
  for (const mode of method.signature.parameterModes) {
    parameterModes.push(mode.copyBytes(0, mode.byteLength));
  }
  let parameterTypes = Array<String>();
  for (const typeName of method.signature.parameterTypes) {
    parameterTypes.push(typeName.copyBytes(0, typeName.byteLength));
  }
  let invalidatesParameters = Array<usize>();
  for (const parameter of method.signature.invalidatesParameters) {
    invalidatesParameters.push(parameter);
  }
  let invalidatesLifetimes = Array<String>();
  for (const lifetime of method.signature.invalidatesLifetimes) {
    invalidatesLifetimes.push(lifetime.copyBytes(0, lifetime.byteLength));
  }
  return ModuleFunctionSignature({
    asynchronous: method.signature.asynchronous,
    executorAffinity: method.signature.executorAffinity.copyBytes(0, method.signature.executorAffinity.byteLength),
    threadContract: method.signature.threadContract.copyBytes(0, method.signature.threadContract.byteLength),
    typeParameters,
    typeParameterConstraints,
    parameterModes,
    parameterTypes,
    viewParameter: method.signature.viewParameter,
    invalidatesParameters,
    invalidatesLifetimes,
    returnType: method.signature.returnType.copyBytes(0, method.signature.returnType.byteLength),
    errorType: method.signature.errorType.copyBytes(0, method.signature.errorType.byteLength),
  });
}

export function hasKnownAggregate(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  match (inferredTypeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      const kind = modules[location.moduleIndex].symbols[location.symbolIndex].kind;
      return kind == ModuleSymbolKind.structSymbol || kind == ModuleSymbolKind.classSymbol;
    }
    none => {}
  }
  return false;
}

export function isForeignUnionType(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  match (inferredTypeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      match (
        in modules[location.moduleIndex].symbols[
          location.symbolIndex
        ].typeSignature
      ) {
        some(signature) => return signature.foreignKind == "union"
          || (
            signature.foreignKind == "record"
            && signature.foreignLayout == "union"
          );
        none => {}
      }
    }
    none => {}
  }
  return false;
}
