import { TextBuffer } from "std/text";
import {
  NativeValueBinding,
  addValueBinding,
  valueBindingType,
} from "./semantic-flow-state.zs";
import {
  equivalentTypes,
  typeSatisfiesTrait,
} from "./semantic-type-identities.zs";
import { substituteGenericType } from "./semantic-type-ownership.zs";
import {
  arrayElementType,
  fixedArrayShape,
  genericTypeShape,
  nativeFunctionSignature,
  nullableTargetType,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import {
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleTypeParameterConstraint,
  ResolvedModule,
  moduleResolutionError,
} from "./semantic-model.zs";
import { ParsedModule } from "./module-symbols.zs";
import { ExpressionTree } from "./parser.zs";

function typeMentionsParameter(in name: String, in parameter: String): boolean {
  if (name == parameter) return true;
  const nullableTarget = nullableTargetType(name);
  if (nullableTarget.byteLength > 0) {
    return typeMentionsParameter(nullableTarget, parameter);
  }
  if (stringStartsWith(name, "view ")) {
    const target = name.copyBytes(5, name.byteLength);
    return typeMentionsParameter(target, parameter);
  }
  match (fixedArrayShape(name)) {
    some(array) => return typeMentionsParameter(array.elementType, parameter);
    none => {}
  }
  match (nativeFunctionSignature(name)) {
    some(signature) => {
      for (const parameterType of signature.parameterTypes) {
        if (typeMentionsParameter(parameterType, parameter)) return true;
      }
      return typeMentionsParameter(signature.returnType, parameter);
    }
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        if (typeMentionsParameter(argument, parameter)) return true;
      }
    }
    none => {}
  }
  return false;
}

export function settledContextualType(
  in pattern: String,
  in typeParameters: Array<String>,
  in substitutions: Array<NativeValueBinding>
): String {
  for (const parameter of typeParameters) {
    const substitution = valueBindingType(substitutions, parameter);
    if (
      substitution.byteLength == 0
      && typeMentionsParameter(pattern, parameter)
    ) return "";
  }
  return substituteGenericType(pattern, substitutions);
}

export function parameterizedTypeName(
  in base: String,
  in parameters: Array<String>
): String {
  if (parameters.length == 0) return base.copyBytes(0, base.byteLength);
  let output = TextBuffer();
  output.append(base);
  output.append("<");
  let index: usize = 0;
  while (index < parameters.length) {
    if (index > 0) output.append(", ");
    output.append(parameters[index]);
    index = index + 1;
  }
  output.append(">");
  return output.finish();
}

export function genericCallError(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in message: String
): ModuleResolveError {
  return moduleResolutionError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    message,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
}

export function bindGenericType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  argumentIndex: usize,
  in functionName: String,
  in pattern: String,
  in actual: String,
  in typeParameters: Array<String>,
  inout substitutions: Array<NativeValueBinding>
): void throws ModuleResolveError {
  if (actual.byteLength == 0 || actual == "null") return;
  for (const typeParameter of typeParameters) {
    if (pattern != typeParameter) continue;
    const previous = valueBindingType(substitutions, typeParameter);
    if (
      previous.byteLength > 0
      && !equivalentTypes(modules, moduleIndex, previous, actual)
    ) {
      throw genericCallError(
        module,
        tree,
        argumentIndex,
        `conflicting inferred types for ${typeParameter} in ${functionName}: ${previous} and ${actual}`
      );
    }
    if (previous.byteLength == 0) {
      addValueBinding(inout substitutions, typeParameter, actual);
    }
    return;
  }
  const patternNullable = nullableTargetType(pattern);
  const actualNullable = nullableTargetType(actual);
  if (patternNullable.byteLength > 0 && actualNullable.byteLength > 0) {
    try bindGenericType(
      module,
      modules,
      moduleIndex,
      tree,
      argumentIndex,
      functionName,
      patternNullable,
      actualNullable,
      typeParameters,
      inout substitutions
    );
    return;
  }
  if (stringStartsWith(pattern, "view ") && stringStartsWith(actual, "view ")) {
    const patternTarget = pattern.copyBytes(5, pattern.byteLength);
    const actualTarget = actual.copyBytes(5, actual.byteLength);
    try bindGenericType(
      module,
      modules,
      moduleIndex,
      tree,
      argumentIndex,
      functionName,
      patternTarget,
      actualTarget,
      typeParameters,
      inout substitutions
    );
    return;
  }
  match (fixedArrayShape(pattern)) {
    some(patternArray) => {
      match (fixedArrayShape(actual)) {
        some(actualArray) => {
          if (patternArray.length == actualArray.length) {
            try bindGenericType(
              module,
              modules,
              moduleIndex,
              tree,
              argumentIndex,
              functionName,
              patternArray.elementType,
              actualArray.elementType,
              typeParameters,
              inout substitutions
            );
          }
        }
        none => {}
      }
      return;
    }
    none => {}
  }
  match (genericTypeShape(pattern)) {
    some(patternGeneric) => {
      match (genericTypeShape(actual)) {
        some(actualGeneric) => {
          if (
            patternGeneric.base == actualGeneric.base
            && patternGeneric.arguments.length == actualGeneric.arguments.length
          ) {
            let index: usize = 0;
            while (index < patternGeneric.arguments.length) {
              try bindGenericType(
                module,
                modules,
                moduleIndex,
                tree,
                argumentIndex,
                functionName,
                patternGeneric.arguments[index],
                actualGeneric.arguments[index],
                typeParameters,
                inout substitutions
              );
              index = index + 1;
            }
          }
        }
        none => {
          if (patternGeneric.base == "Slice") {
            const actualElement = arrayElementType(actual);
            if (
              patternGeneric.arguments.length == 1
              && actualElement.byteLength > 0
            ) {
              try bindGenericType(
                module,
                modules,
                moduleIndex,
                tree,
                argumentIndex,
                functionName,
                patternGeneric.arguments[0],
                actualElement,
                typeParameters,
                inout substitutions
              );
            }
          }
        }
      }
    }
    none => {}
  }
}

export function requireGenericConstraints(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in functionName: String,
  in constraints: Array<ModuleTypeParameterConstraint>,
  in substitutions: Array<NativeValueBinding>,
  in activeBindings: Array<NativeValueBinding>
): void throws ModuleResolveError {
  for (const constraint of constraints) {
    const argument = valueBindingType(substitutions, constraint.parameter);
    if (argument.byteLength == 0) continue;
    if (
      typeSatisfiesTrait(
        modules,
        moduleIndex,
        argument,
        constraint.traitName
      )
      || activeTypeParameterSatisfiesTrait(
        modules,
        moduleIndex,
        activeBindings,
        argument,
        constraint.traitName
      )
    ) continue;
    throw genericCallError(
      module,
      tree,
      index,
      `${argument} does not satisfy ${constraint.traitName} for ${constraint.parameter} in "${functionName}"`
    );
  }
}

function activeTypeParameterSatisfiesTrait(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in bindings: Array<NativeValueBinding>,
  in parameter: String,
  in requiredTrait: String
): boolean {
  const markerName = `__z_native_type_parameter:${parameter}`;
  const constraintName =
    `__z_native_type_parameter_constraint:${parameter}`;
  let markerIndex = bindings.length;
  while (markerIndex > 0) {
    markerIndex = markerIndex - 1;
    if (bindings[markerIndex].name == markerName) break;
  }
  if (
    bindings.length == 0
    || bindings[markerIndex].name != markerName
  ) return false;
  let index = markerIndex + 1;
  while (index < bindings.length) {
    if (bindings[index].name == constraintName) {
      if (
        bindings[index].typeName == requiredTrait
        || equivalentTypes(
          modules,
          moduleIndex,
          bindings[index].typeName,
          requiredTrait
        )
      ) return true;
    }
    index = index + 1;
  }
  return false;
}
