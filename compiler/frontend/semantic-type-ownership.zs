import { TextBuffer } from "std/text";
import { moduleSymbolIndex } from "./module-symbols.zs";
import {
  NativeValueBinding,
  addValueBinding,
  valueBindingType,
} from "./semantic-flow-state.zs";
import {
  inferredTypeSymbolLocation,
  rebaseTypeName,
  semanticTypeIdentity,
  transparentTypeName,
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

export function typeNameIsArena(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  if (typeName == "Arena") return true;
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], typeName);
  if (symbolIndex >= modules[moduleIndex].symbols.length) return false;
  const symbol = view modules[moduleIndex].symbols[symbolIndex];
  return symbol.kind == ModuleSymbolKind.importedSymbol
    && symbol.importedName == "Arena";
}

function containsString(in values: Array<String>, in value: String): boolean {
  for (const candidate of values) {
    if (candidate == value) return true;
  }
  return false;
}

function typeIsThreadShareableInner(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  inout visiting: Array<String>
): boolean {
  if (
    typeName == "void"
    || typeName == "boolean"
    || typeName == "i8"
    || typeName == "i16"
    || typeName == "i32"
    || typeName == "i64"
    || typeName == "u8"
    || typeName == "u16"
    || typeName == "u32"
    || typeName == "u64"
    || typeName == "isize"
    || typeName == "usize"
    || typeName == "f32"
    || typeName == "f64"
    || typeName == "String"
  ) return true;
  match (nativeFunctionSignature(typeName)) {
    some(signature) => return signature.threadContract == "thread.any";
    none => {}
  }
  if (stringStartsWith(typeName, "readonly ")) {
    const target = typeName.copyBytes(9, typeName.byteLength);
    match (genericTypeShape(target)) {
      some(generic) => {
        if (
          (generic.base == "Array" || generic.base == "Set")
          && generic.arguments.length == 1
        ) return typeIsThreadShareableInner(
          modules,
          moduleIndex,
          generic.arguments[0],
          inout visiting
        );
        if (generic.base == "Map" && generic.arguments.length == 2) {
          for (const argument of generic.arguments) {
            if (!typeIsThreadShareableInner(
              modules,
              moduleIndex,
              argument,
              inout visiting
            )) return false;
          }
          return true;
        }
      }
      none => {}
    }
    return false;
  }
  const actual = transparentTypeName(modules, moduleIndex, typeName);
  if (actual != typeName) {
    return typeIsThreadShareableInner(
      modules,
      moduleIndex,
      actual,
      inout visiting
    );
  }
  match (genericTypeShape(actual)) {
    some(generic) => {
      if (generic.base == "Mutex" && generic.arguments.length == 1) {
        // Stage 0 separately proves worker-safe destruction for the protected
        // payload. The native graph treats Mutex identity itself as shareable.
        return true;
      }
      if (
        (generic.base == "Option" && generic.arguments.length == 1)
        || (generic.base == "Result" && generic.arguments.length == 2)
      ) {
        for (const argument of generic.arguments) {
          if (!typeIsThreadShareableInner(
            modules,
            moduleIndex,
            argument,
            inout visiting
          )) return false;
        }
        return true;
      }
      return false;
    }
    none => {}
  }
  if (containsString(visiting, actual)) return true;
  match (typeSymbolLocation(modules, moduleIndex, actual)) {
    some(location) => {
      const symbol = view modules[location.moduleIndex].symbols[
        location.symbolIndex
      ];
      match (in symbol.typeSignature) {
        some(signature) => {
          if (
            signature.foreignNativeName.byteLength > 0
            || signature.executorAffinity.byteLength > 0
            || signature.customDeinit
          ) return false;
          for (const method of signature.methods) {
            if (method.receiverMode == "inout") return false;
          }
          let nextVisiting = copyStrings(visiting);
          nextVisiting.push(actual.copyBytes(0, actual.byteLength));
          if (symbol.kind == ModuleSymbolKind.enumSymbol) {
            for (const variant of signature.variants) {
              if (
                variant.payloadType.byteLength > 0
                && !typeIsThreadShareableInner(
                  modules,
                  location.moduleIndex,
                  variant.payloadType,
                  inout nextVisiting
                )
              ) {
                return false;
              }
            }
          } else {
            for (const field of signature.fields) {
              if (
                !field.readonlyField
                || field.executorAffinity.byteLength > 0
                || !typeIsThreadShareableInner(
                  modules,
                  location.moduleIndex,
                  field.typeName,
                  inout nextVisiting
                )
              ) {
                return false;
              }
            }
          }
          return true;
        }
        none => return false;
      }
    }
    none => return false;
  }
}

export function typeIsThreadShareable(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  let visiting = Array<String>();
  return typeIsThreadShareableInner(
    modules,
    moduleIndex,
    typeName,
    inout visiting
  );
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
      if (signature.errorType.byteLength > 0) {
        output.append(" throws ");
        output.append(substituteGenericType(signature.errorType, substitutions));
      }
      if (signature.threadContract.byteLength > 0) {
        output.append(" on ");
        output.append(signature.threadContract);
      }
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
  const transparent = transparentTypeName(modules, moduleIndex, typeName);
  if (transparent != typeName) {
    return typeHasCleanup(modules, moduleIndex, transparent, visiting);
  }
  if (
    typeName == "String"
    || typeName == "TextBuffer"
    || typeNameIsArena(modules, moduleIndex, typeName)
    || typeName == "fs.Lock"
    || typeName == "__z_std_fs_Lock"
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
        || generic.base == "Mutex"
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
  match (inferredTypeSymbolLocation(modules, moduleIndex, typeName)) {
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
            const argument = rebaseTypeName(
              modules,
              moduleIndex,
              location.moduleIndex,
              arguments[typeIndex]
            );
            addValueBinding(
              inout substitutions,
              signature.typeParameters[typeIndex],
              argument
            );
            typeIndex = typeIndex + 1;
          }
          for (const field of signature.fields) {
            const fieldType = substituteGenericType(
              field.typeName,
              substitutions
            );
            if (typeHasCleanup(
              modules,
              location.moduleIndex,
              fieldType,
              nextVisiting
            )) return true;
          }
          for (const variant of signature.variants) {
            if (variant.payloadType.byteLength == 0) continue;
            const payloadType = substituteGenericType(
              variant.payloadType,
              substitutions
            );
            if (typeHasCleanup(
              modules,
              location.moduleIndex,
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
  match (inferredTypeSymbolLocation(modules, moduleIndex, managedType)) {
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

export function typeContainsStoredView(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>
): boolean {
  if (stringStartsWith(typeName, "view ")) return true;
  const nullableTarget = nullableTargetType(typeName);
  if (nullableTarget.byteLength > 0) {
    return typeContainsStoredView(
      modules,
      moduleIndex,
      nullableTarget,
      visiting
    );
  }
  match (fixedArrayShape(typeName)) {
    some(array) => return typeContainsStoredView(
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
      for (const argument of generic.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
        if (typeContainsStoredView(
          modules,
          moduleIndex,
          argument,
          visiting
        )) return true;
      }
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      match (
        in modules[location.moduleIndex].symbols[
          location.symbolIndex
        ].typeSignature
      ) {
        some(signature) => {
          // A foreign reference stores one native object identity in Z. Its
          // imported properties describe messages, not recursively embedded
          // Z storage, so walking that SDK graph is both semantically wrong
          // and potentially exponential for mutually-referential frameworks.
          if (signature.foreignLayout == "reference") return false;
        }
        none => {}
      }
      const identity = semanticTypeIdentity(modules, moduleIndex, typeName);
      if (containsString(visiting, identity)) return false;
      let nextVisiting = copyStrings(visiting);
      nextVisiting.push(identity);
      match (
        in modules[location.moduleIndex].symbols[
          location.symbolIndex
        ].typeSignature
      ) {
        some(signature) => {
          let substitutions = Array<NativeValueBinding>();
          let typeIndex: usize = 0;
          while (
            typeIndex < signature.typeParameters.length
            && typeIndex < arguments.length
          ) {
            const argument = rebaseTypeName(
              modules,
              moduleIndex,
              location.moduleIndex,
              arguments[typeIndex]
            );
            addValueBinding(
              inout substitutions,
              signature.typeParameters[typeIndex],
              argument
            );
            typeIndex = typeIndex + 1;
          }
          for (const field of signature.fields) {
            const fieldType = substituteGenericType(
              field.typeName,
              substitutions
            );
            if (typeContainsStoredView(
              modules,
              location.moduleIndex,
              fieldType,
              nextVisiting
            )) return true;
          }
          for (const variant of signature.variants) {
            if (variant.payloadType.byteLength == 0) continue;
            const payloadType = substituteGenericType(
              variant.payloadType,
              substitutions
            );
            if (typeContainsStoredView(
              modules,
              location.moduleIndex,
              payloadType,
              nextVisiting
            )) return true;
          }
        }
        none => {}
      }
    }
    none => {}
  }
  return false;
}

export function typeIsRetainedParameterViewAggregate(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  match (genericTypeShape(typeName)) {
    some(_) => return false;
    none => {}
  }
  if (typeIsArenaOwnerBundle(modules, moduleIndex, typeName)) return false;
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      const symbol = view modules[location.moduleIndex].symbols[
        location.symbolIndex
      ];
      if (symbol.kind != ModuleSymbolKind.structSymbol) return false;
      match (in symbol.typeSignature) {
        some(signature) => {
          let hasDirectView = false;
          for (const field of signature.fields) {
            if (stringStartsWith(field.typeName, "view ")) {
              hasDirectView = true;
              continue;
            }
            let visiting = Array<String>();
            if (typeContainsStoredView(
              modules,
              location.moduleIndex,
              field.typeName,
              visiting
            )) return false;
          }
          return hasDirectView;
        }
        none => return false;
      }
    }
    none => return false;
  }
}

export function arenaOwnerBundleFieldName(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): String {
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      if (
        modules[location.moduleIndex].symbols[location.symbolIndex].kind
        != ModuleSymbolKind.structSymbol
      ) return "";
      match (
        in modules[location.moduleIndex].symbols[
          location.symbolIndex
        ].typeSignature
      ) {
        some(signature) => {
          let arenaField = "";
          let arenaCount: usize = 0;
          let carriesViews = false;
          for (const field of signature.fields) {
            if (!field.readonlyField) return "";
            if (typeNameIsArena(
              modules,
              location.moduleIndex,
              field.typeName
            )) {
              arenaCount = arenaCount + 1;
              arenaField = field.name.copyBytes(0, field.name.byteLength);
              continue;
            }
            let visiting = Array<String>();
            if (typeContainsStoredView(
              modules,
              location.moduleIndex,
              field.typeName,
              visiting
            )) carriesViews = true;
          }
          if (arenaCount == 1 && carriesViews) return arenaField;
        }
        none => {}
      }
    }
    none => {}
  }
  return "";
}

export function typeIsArenaOwnerBundle(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  const fieldName = arenaOwnerBundleFieldName(modules, moduleIndex, typeName);
  return fieldName.byteLength > 0;
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
  const transparent = transparentTypeName(modules, moduleIndex, actual);
  if (transparent != actual) {
    return typeSupportsExplicitCopy(
      modules,
      moduleIndex,
      transparent,
      visiting
    );
  }
  if (actual == "String") return true;
  if (
    actual == "TextBuffer"
    || actual == "Arena"
    || actual == "fs.Lock"
    || actual == "__z_std_fs_Lock"
    || stringStartsWith(actual, "Weak<")
    || stringStartsWith(actual, "Mutex<")
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
  match (inferredTypeSymbolLocation(modules, moduleIndex, actual)) {
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
            const argument = rebaseTypeName(
              modules,
              moduleIndex,
              location.moduleIndex,
              arguments[typeIndex]
            );
            addValueBinding(
              inout substitutions,
              signature.typeParameters[typeIndex],
              argument
            );
            typeIndex = typeIndex + 1;
          }
          for (const field of signature.fields) {
            const fieldType = substituteGenericType(
              field.typeName,
              substitutions
            );
            if (!typeSupportsExplicitCopy(
              modules,
              location.moduleIndex,
              fieldType,
              nextVisiting
            )) return false;
          }
          for (const variant of signature.variants) {
            if (variant.payloadType.byteLength == 0) continue;
            const payloadType = substituteGenericType(
              variant.payloadType,
              substitutions
            );
            if (!typeSupportsExplicitCopy(
              modules,
              location.moduleIndex,
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

export function typeContainsForeignValueStorage(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>
): boolean {
  if (stringStartsWith(typeName, "view ") || stringStartsWith(typeName, "Slice<")) {
    return false;
  }
  match (fixedArrayShape(typeName)) {
    some(array) => return typeContainsForeignValueStorage(
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
      for (const argument of generic.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
        if (typeContainsForeignValueStorage(
          modules,
          moduleIndex,
          argument,
          visiting
        )) return true;
      }
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      const identity = semanticTypeIdentity(modules, moduleIndex, typeName);
      if (containsString(visiting, identity)) return false;
      let nextVisiting = copyStrings(visiting);
      nextVisiting.push(identity);
      match (
        in modules[location.moduleIndex].symbols[
          location.symbolIndex
        ].typeSignature
      ) {
        some(signature) => {
          if (signature.foreignNativeName.byteLength > 0) return true;
          let substitutions = Array<NativeValueBinding>();
          let typeIndex: usize = 0;
          while (
            typeIndex < signature.typeParameters.length
            && typeIndex < arguments.length
          ) {
            const argument = rebaseTypeName(
              modules,
              moduleIndex,
              location.moduleIndex,
              arguments[typeIndex]
            );
            addValueBinding(
              inout substitutions,
              signature.typeParameters[typeIndex],
              argument
            );
            typeIndex = typeIndex + 1;
          }
          for (const field of signature.fields) {
            const fieldType = substituteGenericType(
              field.typeName,
              substitutions
            );
            if (typeContainsForeignValueStorage(
              modules,
              location.moduleIndex,
              fieldType,
              nextVisiting
            )) return true;
          }
          for (const variant of signature.variants) {
            if (variant.payloadType.byteLength == 0) continue;
            const payloadType = substituteGenericType(
              variant.payloadType,
              substitutions
            );
            if (typeContainsForeignValueStorage(
              modules,
              location.moduleIndex,
              payloadType,
              nextVisiting
            )) return true;
          }
        }
        none => {}
      }
    }
    none => {}
  }
  return false;
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

export function typeIsForeignResource(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  let actual = typeName.copyBytes(0, typeName.byteLength);
  if (stringStartsWith(actual, "view ")) {
    actual = actual.copyBytes(5, actual.byteLength);
  }
  match (typeSymbolLocation(modules, moduleIndex, actual)) {
    some(location) => {
      match (
        in modules[location.moduleIndex].symbols[
          location.symbolIndex
        ].typeSignature
      ) {
        some(signature) => return signature.foreignKind == "handle"
          || signature.foreignResourceRelease.byteLength > 0;
        none => {}
      }
    }
    none => {}
  }
  return false;
}

export function typeIsForeignViewOnlyRecord(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  let actual = typeName.copyBytes(0, typeName.byteLength);
  if (stringStartsWith(actual, "view ")) {
    actual = actual.copyBytes(5, actual.byteLength);
  }
  match (typeSymbolLocation(modules, moduleIndex, actual)) {
    some(location) => {
      match (
        in modules[location.moduleIndex].symbols[
          location.symbolIndex
        ].typeSignature
      ) {
        some(signature) => return signature.foreignKind == "viewRecord";
        none => {}
      }
    }
    none => {}
  }
  return false;
}

export function typeIsBorrowedForeignResource(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  if (!stringStartsWith(typeName, "view ")) return false;
  let target = typeName.copyBytes(5, typeName.byteLength);
  const nullableTarget = nullableTargetType(target);
  if (nullableTarget.byteLength > 0) target = move nullableTarget;
  return typeIsForeignResource(modules, moduleIndex, target);
}
