import { TextBuffer } from "std/text";
import {
  NativeValueBinding,
  addValueBinding,
  valueBindingType,
} from "./semantic-flow-state.zs";
import {
  rebaseTypeName,
  semanticTypeIdentity,
  typeSymbolLocation,
} from "./semantic-type-identities.zs";
import {
  fixedArrayShape,
  genericTypeShape,
  nativeFunctionSignature,
  nullableTargetType,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import {
  ModuleSymbolKind,
  ResolvedModule,
} from "./semantic-model.zs";

function copyStrings(in values: Array<String>): Array<String> {
  let copied = Array<String>();
  for (const value of values) {
    copied.push(value.copyBytes(0, value.byteLength));
  }
  return copied;
}

function containsString(in values: Array<String>, in value: String): boolean {
  for (const candidate of values) {
    if (candidate == value) return true;
  }
  return false;
}

export function substituteGenericType(
  in name: String,
  in substitutions: Array<NativeValueBinding>
): String {
  const direct = valueBindingType(substitutions, name);
  if (direct.byteLength > 0) return direct;
  match (nativeFunctionSignature(name)) {
    some(signature) => {
      let output = TextBuffer();
      output.append("(");
      let index: usize = 0;
      while (index < signature.parameterTypes.length) {
        if (index > 0) output.append(", ");
        if (signature.parameterModes[index] != "value") {
          output.append(signature.parameterModes[index]);
          output.append(" ");
        }
        output.append(`value${index}: `);
        output.append(substituteGenericType(signature.parameterTypes[index], substitutions));
        index = index + 1;
      }
      output.append(") => ");
      output.append(substituteGenericType(signature.returnType, substitutions));
      return output.finish();
    }
    none => {}
  }
  const nullableTarget = nullableTargetType(name);
  if (nullableTarget.byteLength > 0) {
    const substituted = substituteGenericType(nullableTarget, substitutions);
    return `${substituted} | null`;
  }
  if (stringStartsWith(name, "view ")) {
    const target = name.copyBytes(5, name.byteLength);
    const substituted = substituteGenericType(target, substitutions);
    return `view ${substituted}`;
  }
  match (fixedArrayShape(name)) {
    some(array) => {
      const substituted = substituteGenericType(array.elementType, substitutions);
      return `${substituted}[${array.length}]`;
    }
    none => {}
  }
  return match (genericTypeShape(name)) {
    some(generic) => {
      let output = TextBuffer();
      output.append(generic.base);
      output.append("<");
      let index: usize = 0;
      while (index < generic.arguments.length) {
        if (index > 0) output.append(", ");
        const argument = substituteGenericType(generic.arguments[index], substitutions);
        output.append(argument);
        index = index + 1;
      }
      output.append(">");
      select output.finish();
    }
    none => name.copyBytes(0, name.byteLength);
  };
}

export function typeHasCleanup(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>
): boolean {
  const nullableTarget = nullableTargetType(typeName);
  if (nullableTarget.byteLength > 0) {
    return typeHasCleanup(modules, moduleIndex, nullableTarget, visiting);
  }
  if (stringStartsWith(typeName, "view ") || stringStartsWith(typeName, "Slice<")) {
    return false;
  }
  if (
    typeName == "String"
    || typeName == "TextBuffer"
    || typeName == "Arena"
    || stringStartsWith(typeName, "__z_native_function:")
  ) return true;
  match (fixedArrayShape(typeName)) {
    some(array) => return typeHasCleanup(
      modules,
      moduleIndex,
      array.elementType,
      visiting
    );
    none => {}
  }
  let arguments = Array<String>();
  match (genericTypeShape(typeName)) {
    some(generic) => {
      if (
        generic.base == "Array"
        || generic.base == "Map"
        || generic.base == "Set"
        || generic.base == "Task"
        || generic.base == "Weak"
      ) {
        return true;
      }
      if (generic.base == "Option" || generic.base == "Result") {
        for (const argument of generic.arguments) {
          if (typeHasCleanup(modules, moduleIndex, argument, visiting)) return true;
        }
        return false;
      }
      for (const argument of generic.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
      }
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      const kind = modules[location.moduleIndex].symbols[location.symbolIndex].kind;
      if (kind == ModuleSymbolKind.classSymbol) return true;
      const identity = semanticTypeIdentity(modules, moduleIndex, typeName);
      if (containsString(visiting, identity)) return false;
      let nextVisiting = copyStrings(visiting);
      nextVisiting.push(identity);
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          if (signature.customDeinit) return true;
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
            const localType = rebaseTypeName(
              modules,
              location.moduleIndex,
              moduleIndex,
              field.typeName
            );
            const fieldType = substituteGenericType(localType, substitutions);
            if (typeHasCleanup(
              modules,
              moduleIndex,
              fieldType,
              nextVisiting
            )) return true;
          }
          for (const variant of signature.variants) {
            if (variant.payloadType.byteLength == 0) continue;
            const localType = rebaseTypeName(
              modules,
              location.moduleIndex,
              moduleIndex,
              variant.payloadType
            );
            const payloadType = substituteGenericType(localType, substitutions);
            if (typeHasCleanup(
              modules,
              moduleIndex,
              payloadType,
              nextVisiting
            )) return true;
          }
          return false;
        }
        none => {}
      }
    }
    none => {}
  }
  return false;
}

export function typeMovesOnOwnedUse(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  let managedType = typeName.copyBytes(0, typeName.byteLength);
  const nullableTarget = nullableTargetType(typeName);
  if (nullableTarget.byteLength > 0) {
    managedType = nullableTarget.copyBytes(0, nullableTarget.byteLength);
  }
  if (
    stringStartsWith(managedType, "Weak<")
    || stringStartsWith(managedType, "__z_native_function:")
  ) return false;
  match (typeSymbolLocation(modules, moduleIndex, managedType)) {
    some(location) => {
      if (
        modules[location.moduleIndex].symbols[location.symbolIndex].kind
        == ModuleSymbolKind.classSymbol
      ) return false;
    }
    none => {}
  }
  let visiting = Array<String>();
  return typeHasCleanup(modules, moduleIndex, typeName, visiting);
}

export function typeSupportsExplicitCopy(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>
): boolean {
  let actual = typeName.copyBytes(0, typeName.byteLength);
  if (stringStartsWith(actual, "view ")) {
    actual = actual.copyBytes(5, actual.byteLength);
  }
  if (actual == "String") return true;
  if (
    actual == "TextBuffer"
    || actual == "Arena"
    || stringStartsWith(actual, "Weak<")
    || stringStartsWith(actual, "__z_native_function:")
  ) return false;
  match (fixedArrayShape(actual)) {
    some(array) => return typeSupportsExplicitCopy(
      modules,
      moduleIndex,
      array.elementType,
      visiting
    );
    none => {}
  }
  let arguments = Array<String>();
  match (genericTypeShape(actual)) {
    some(generic) => {
      if (generic.base == "Array" || generic.base == "Map" || generic.base == "Set") {
        for (const argument of generic.arguments) {
          if (!typeSupportsExplicitCopy(modules, moduleIndex, argument, visiting)) return false;
        }
        return true;
      }
      if (generic.base == "Option" || generic.base == "Result") {
        for (const argument of generic.arguments) {
          if (!typeSupportsExplicitCopy(modules, moduleIndex, argument, visiting)) return false;
        }
        return true;
      }
      for (const argument of generic.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
      }
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, actual)) {
    some(location) => {
      if (
        modules[location.moduleIndex].symbols[location.symbolIndex].kind
        == ModuleSymbolKind.classSymbol
      ) return false;
      const identity = semanticTypeIdentity(modules, moduleIndex, actual);
      if (containsString(visiting, identity)) return false;
      let nextVisiting = copyStrings(visiting);
      nextVisiting.push(identity);
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          if (signature.customDeinit) return false;
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
            const localType = rebaseTypeName(
              modules,
              location.moduleIndex,
              moduleIndex,
              field.typeName
            );
            const fieldType = substituteGenericType(localType, substitutions);
            if (!typeSupportsExplicitCopy(
              modules,
              moduleIndex,
              fieldType,
              nextVisiting
            )) return false;
          }
          for (const variant of signature.variants) {
            if (variant.payloadType.byteLength == 0) continue;
            const localType = rebaseTypeName(
              modules,
              location.moduleIndex,
              moduleIndex,
              variant.payloadType
            );
            const payloadType = substituteGenericType(localType, substitutions);
            if (!typeSupportsExplicitCopy(
              modules,
              moduleIndex,
              payloadType,
              nextVisiting
            )) return false;
          }
          return true;
        }
        none => {}
      }
    }
    none => {}
  }
  let cleanupVisiting = Array<String>();
  return !typeHasCleanup(modules, moduleIndex, actual, cleanupVisiting);
}

export function typeHasCustomConstructor(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => return signature.customConstructor;
        none => {}
      }
    }
    none => {}
  }
  return false;
}
