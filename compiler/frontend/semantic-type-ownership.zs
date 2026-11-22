import { TextBuffer } from "std/text";
import { moduleSymbolIndex } from "./module-symbols.zs";
import {
  NativeValueBinding,
  addValueBinding,
  valueBindingType,
} from "./semantic-flow-state.zs";
import {
  ModuleSymbolLocation,
  inferredTypeSymbolLocation,
  rebaseTypeName,
  semanticTypeIdentity,
  transparentTypeName,
  typeSymbolLocation,
} from "./semantic-type-identities.zs";
import {
  fixedArrayShape,
  genericTypeShape,
  isNumericTypeName,
  nativeFunctionSignature,
  nativeObjCObjectTypeName,
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

function containsSymbolLocation(
  in values: Array<ModuleSymbolLocation>,
  in value: ModuleSymbolLocation
): boolean {
  for (const candidate of values) {
    if (
      candidate.moduleIndex == value.moduleIndex
      && candidate.symbolIndex == value.symbolIndex
    ) return true;
  }
  return false;
}

function copySymbolLocations(
  in values: Array<ModuleSymbolLocation>
): Array<ModuleSymbolLocation> {
  let copied = Array<ModuleSymbolLocation>();
  for (const value of values) {
    copied.push(ModuleSymbolLocation({
      moduleIndex: value.moduleIndex,
      symbolIndex: value.symbolIndex,
    }));
  }
  return copied;
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
    || typeName == "__z_std_text_Utf8Error"
    || typeName == "TaskControl"
    || typeName == "TaskScope"
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
        return typeIsThreadTransferableInner(
          modules, moduleIndex, generic.arguments[0], inout visiting
        );
      }
      if (
        (generic.base == "Sender" || generic.base == "SyncSender")
        && generic.arguments.length == 1
      ) {
        // Sender identity is shared, while each message is transferred into
        // the channel. Channel construction separately proves the broader
        // transferable-message contract; requiring the payload itself to be
        // shareable would incorrectly reject owned String and value messages.
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
            || (signature.customDeinit && !signature.deinitThreadAny)
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

function typeIsThreadTransferableInner(
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
    || typeName == "__z_std_text_Utf8Error"
    || typeName == "TextBuffer"
    || typeName == "TaskControl"
    || typeName == "TaskScope"
  ) return true;
  if (
    stringStartsWith(typeName, "view ")
    || stringStartsWith(typeName, "Slice<")
    || stringStartsWith(typeName, "Task<")
    || stringStartsWith(typeName, "Weak<")
  ) return false;
  match (nativeFunctionSignature(typeName)) {
    some(signature) => return signature.threadContract == "thread.any";
    none => {}
  }
  const actual = transparentTypeName(modules, moduleIndex, typeName);
  if (actual != typeName) return typeIsThreadTransferableInner(
    modules,
    moduleIndex,
    actual,
    inout visiting
  );
  match (fixedArrayShape(actual)) {
    some(array) => return typeIsThreadTransferableInner(
      modules,
      moduleIndex,
      array.elementType,
      inout visiting
    );
    none => {}
  }
  let arguments = Array<String>();
  match (genericTypeShape(actual)) {
    some(generic) => {
      if (generic.base == "OnceLifetime" && generic.arguments.length == 1) {
        return typeIsThreadShareable(modules, moduleIndex, generic.arguments[0]);
      }
      if (
        (generic.base == "Sender" || generic.base == "SyncSender")
        && generic.arguments.length == 1
      ) return typeIsThreadTransferableInner(
        modules,
        moduleIndex,
        generic.arguments[0],
        inout visiting
      );
      if (
        (generic.base == "Receiver" || generic.base == "SyncReceiver")
        && generic.arguments.length == 1
      ) return typeIsThreadTransferableInner(
        modules,
        moduleIndex,
        generic.arguments[0],
        inout visiting
      );
      if (
        (
          generic.base == "Array"
          || generic.base == "Set"
          || generic.base == "Option"
          || generic.base == "Mutex"
          || generic.base == "ChannelClosed"
        )
        && generic.arguments.length == 1
      ) return typeIsThreadTransferableInner(
        modules,
        moduleIndex,
        generic.arguments[0],
        inout visiting
      );
      if (
        (generic.base == "Map" || generic.base == "Result")
        && generic.arguments.length == 2
      ) {
        for (const argument of generic.arguments) {
          if (!typeIsThreadTransferableInner(
            modules,
            moduleIndex,
            argument,
            inout visiting
          )) return false;
        }
        return true;
      }
      for (const argument of generic.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
      }
    }
    none => {}
  }
  if (containsString(visiting, actual)) return true;
  match (inferredTypeSymbolLocation(modules, moduleIndex, actual)) {
    some(location) => {
      const symbol = view modules[location.moduleIndex].symbols[
        location.symbolIndex
      ];
      if (symbol.kind == ModuleSymbolKind.classSymbol) {
        return typeIsThreadShareable(modules, moduleIndex, actual);
      }
      match (in symbol.typeSignature) {
        some(signature) => {
          if (
            signature.foreignNativeName.byteLength > 0
            || signature.executorAffinity.byteLength > 0
            || (signature.customDeinit && !signature.deinitThreadAny)
          ) return false;
          let nextVisiting = copyStrings(visiting);
          nextVisiting.push(actual.copyBytes(0, actual.byteLength));
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
            if (
              field.executorAffinity.byteLength > 0
              || !typeIsThreadTransferableInner(
                modules,
                location.moduleIndex,
                fieldType,
                inout nextVisiting
              )
            ) return false;
          }
          for (const variant of signature.variants) {
            const payloadType = substituteGenericType(
              variant.payloadType,
              substitutions
            );
            if (
              variant.payloadType.byteLength > 0
              && !typeIsThreadTransferableInner(
                modules,
                location.moduleIndex,
                payloadType,
                inout nextVisiting
              )
            ) return false;
          }
          return true;
        }
        none => return false;
      }
    }
    none => return false;
  }
}

export function typeIsThreadTransferable(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  let visiting = Array<String>();
  return typeIsThreadTransferableInner(
    modules,
    moduleIndex,
    typeName,
    inout visiting
  );
}

// Whether a value of this type certainly cannot move to another thread: its
// storage holds a custom deinit of unknown thread affinity, or a class that
// is not shareable for a reason this can name (such a deinit, a mutable
// field, an `inout` method). Types this cannot classify (foreign types,
// standard handles under any import name) answer false: other checks and
// native lowering decide them.
export function typeHoldsThreadBoundStorage(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>
): boolean {
  const actual = transparentTypeName(modules, moduleIndex, typeName);
  const nullableTarget = nullableTargetType(actual);
  if (nullableTarget.byteLength > 0) {
    return typeHoldsThreadBoundStorage(modules, moduleIndex, nullableTarget, visiting);
  }
  if (stringStartsWith(actual, "readonly ")) {
    const target = actual.copyBytes(9, actual.byteLength);
    return typeHoldsThreadBoundStorage(modules, moduleIndex, target, visiting);
  }
  match (fixedArrayShape(actual)) {
    some(array) => return typeHoldsThreadBoundStorage(modules, moduleIndex, array.elementType, visiting);
    none => {}
  }
  let arguments = Array<String>();
  match (genericTypeShape(actual)) {
    some(generic) => {
      // Array, Option, and Result hold their arguments by value.
      if (generic.base == "Array" || generic.base == "Option" || generic.base == "Result") {
        for (const argument of generic.arguments) {
          if (typeHoldsThreadBoundStorage(modules, moduleIndex, argument, visiting)) return true;
        }
        return false;
      }
      for (const argument of generic.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
      }
    }
    none => {}
  }
  const location = match (typeSymbolLocation(modules, moduleIndex, actual)) {
    some(found) => found;
    none => return false;
  };
  const symbol = view modules[location.moduleIndex].symbols[location.symbolIndex];
  if (symbol.foreignHeader.byteLength > 0) return false;
  const identity = semanticTypeIdentity(modules, moduleIndex, actual);
  if (containsString(visiting, identity)) return false;
  match (in symbol.typeSignature) {
    some(signature) => {
      if (signature.foreignNativeName.byteLength > 0) return false;
      if (signature.customDeinit && !signature.deinitThreadAny) return true;
      if (symbol.kind == ModuleSymbolKind.classSymbol) {
        if (typeIsThreadShareable(modules, moduleIndex, actual)) return false;
        for (const method of signature.methods) {
          if (!method.staticMethod && method.receiverMode == "inout") return true;
        }
        for (const field of signature.fields) {
          if (!field.readonlyField) return true;
        }
        return false;
      }
      let nextVisiting = copyStrings(visiting);
      nextVisiting.push(identity);
      let substitutions = Array<NativeValueBinding>();
      let typeIndex: usize = 0;
      while (typeIndex < signature.typeParameters.length && typeIndex < arguments.length) {
        const argument = rebaseTypeName(modules, moduleIndex, location.moduleIndex, arguments[typeIndex]);
        addValueBinding(inout substitutions, signature.typeParameters[typeIndex], argument);
        typeIndex = typeIndex + 1;
      }
      for (const field of signature.fields) {
        const fieldType = substituteGenericType(field.typeName, substitutions);
        if (typeHoldsThreadBoundStorage(modules, location.moduleIndex, fieldType, nextVisiting)) return true;
      }
      for (const variant of signature.variants) {
        if (variant.payloadType.byteLength == 0) continue;
        const payloadType = substituteGenericType(variant.payloadType, substitutions);
        if (typeHoldsThreadBoundStorage(modules, location.moduleIndex, payloadType, nextVisiting)) return true;
      }
      return false;
    }
    none => return false;
  }
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

// Stage 0's hasMoveOnlyForeignType: a move-only C++ value or C value
// resource, directly or through arrays, value-struct fields, or enum payloads.
// A class field is behind ARC, so it does not make its owner move-only here.
export function typeContainsMoveOnlyNative(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  depth: usize
): boolean {
  if (depth > 16 || typeName.byteLength == 0) return false;
  if (stringStartsWith(typeName, "readonly ")) {
    const target = typeName.copyBytes(9, typeName.byteLength);
    return typeContainsMoveOnlyNative(modules, moduleIndex, target, depth + 1);
  }
  const transparent = transparentTypeName(modules, moduleIndex, typeName);
  if (transparent != typeName) {
    return typeContainsMoveOnlyNative(modules, moduleIndex, transparent, depth + 1);
  }
  match (fixedArrayShape(typeName)) {
    some(array) => return typeContainsMoveOnlyNative(modules, moduleIndex, array.elementType, depth + 1);
    none => {}
  }
  match (genericTypeShape(typeName)) {
    some(generic) => {
      if (generic.base == "Array" && generic.arguments.length == 1) {
        return typeContainsMoveOnlyNative(modules, moduleIndex, generic.arguments[0], depth + 1);
      }
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      const symbol = view modules[location.moduleIndex].symbols[location.symbolIndex];
      if (symbol.kind == ModuleSymbolKind.classSymbol) return false;
      match (in symbol.typeSignature) {
        some(signature) => {
          if (signature.foreignKind == "moveValue") return true;
          if (signature.foreignKind == "record" && signature.foreignResourceRelease.byteLength > 0) return true;
          if (signature.foreignNativeName.byteLength > 0) return false;
          for (const field of signature.fields) {
            if (typeContainsMoveOnlyNative(modules, location.moduleIndex, field.typeName, depth + 1)) return true;
          }
          for (const variant of signature.variants) {
            if (typeContainsMoveOnlyNative(modules, location.moduleIndex, variant.payloadType, depth + 1)) return true;
          }
        }
        none => {}
      }
    }
    none => {}
  }
  return false;
}

export function typeHasCleanup(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>
): boolean {
  return typeHasCleanupInner(modules, moduleIndex, typeName, visiting, false);
}

// Imported Objective-C references are cleaned up by ARC even when an ordinary
// expression result is ignored. Z-owned storage must have an explicit owner.
export function typeRequiresOwnedBinding(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>
): boolean {
  return typeHasCleanupInner(modules, moduleIndex, typeName, visiting, true);
}

function typeHasCleanupInner(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>,
  requiresOwnedBinding: boolean
): boolean {
  const nullableTarget = nullableTargetType(typeName);
  if (nullableTarget.byteLength > 0) {
    return typeHasCleanupInner(modules, moduleIndex, nullableTarget, visiting, requiresOwnedBinding);
  }
  if (stringStartsWith(typeName, "view ") || stringStartsWith(typeName, "Slice<")) {
    return false;
  }
  // readonly restricts mutation; it does not turn owned collection storage
  // into a borrowed or reference-counted value. Preserve cleanup recursively
  // through aliases, aggregate fields, and Option/Result payloads.
  if (stringStartsWith(typeName, "readonly ")) {
    const target = typeName.copyBytes(9, typeName.byteLength);
    return typeHasCleanupInner(modules, moduleIndex, target, visiting, requiresOwnedBinding);
  }
  const transparent = transparentTypeName(modules, moduleIndex, typeName);
  if (transparent != typeName) {
    return typeHasCleanupInner(modules, moduleIndex, transparent, visiting, requiresOwnedBinding);
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
    some(array) => return typeHasCleanupInner(
      modules,
      moduleIndex,
      array.elementType,
      visiting,
      requiresOwnedBinding
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
        || generic.base == "OnceLifetime"
        || generic.base == "Weak"
        || generic.base == "Mutex"
        || generic.base == "Sender"
        || generic.base == "Receiver"
        || generic.base == "SyncSender"
        || generic.base == "SyncReceiver"
        || generic.base == "Channel.Endpoints"
      ) {
        return true;
      }
      if (
        generic.base == "ChannelClosed"
        && generic.arguments.length == 1
      ) {
        return typeHasCleanupInner(
          modules,
          moduleIndex,
          generic.arguments[0],
          visiting,
          requiresOwnedBinding
        );
      }
      if (generic.base == "Option" || generic.base == "Result") {
        for (const argument of generic.arguments) {
          if (typeHasCleanupInner(modules, moduleIndex, argument, visiting, requiresOwnedBinding)) return true;
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
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          // A protocol-qualified id is an ARC reference. Its getter fields
          // describe messages, not embedded storage whose cleanup we recurse.
          if (signature.foreignKind == "objcProtocol") return !requiresOwnedBinding;
        }
        none => {}
      }
      const kind = modules[location.moduleIndex].symbols[location.symbolIndex].kind;
      if (kind == ModuleSymbolKind.classSymbol) {
        if (requiresOwnedBinding) {
          match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
            some(signature) => {
              if (signature.foreignKind == "objcInterface") return false;
            }
            none => {}
          }
        }
        return true;
      }
      const identity = semanticTypeIdentity(modules, moduleIndex, typeName);
      if (containsString(visiting, identity)) return false;
      let nextVisiting = copyStrings(visiting);
      nextVisiting.push(identity);
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          if (signature.customDeinit) return true;
          // A move-only C++ value is owned: Z moves it (C++ destroys it).
          if (signature.foreignKind == "moveValue") return true;
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
            if (typeHasCleanupInner(
              modules,
              location.moduleIndex,
              fieldType,
              nextVisiting,
              requiresOwnedBinding
            )) return true;
          }
          for (const variant of signature.variants) {
            if (variant.payloadType.byteLength == 0) continue;
            const payloadType = substituteGenericType(
              variant.payloadType,
              substitutions
            );
            if (typeHasCleanupInner(
              modules,
              location.moduleIndex,
              payloadType,
              nextVisiting,
              requiresOwnedBinding
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

// Partial extraction cannot zero transferred fields and then run an opaque
// destructor on their former container. Ordinary owned storage (String, etc.)
// is different: its compiler-generated cleanup understands moved-out fields.
export function typeContainsOpaqueCleanupStorage(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>
): boolean {
  if (stringStartsWith(typeName, "view ") || stringStartsWith(typeName, "Slice<")) {
    return false;
  }
  if (stringStartsWith(typeName, "readonly ")) {
    const target = typeName.copyBytes(9, typeName.byteLength);
    return typeContainsOpaqueCleanupStorage(modules, moduleIndex, target, visiting);
  }
  const nullable = nullableTargetType(typeName);
  if (nullable.byteLength > 0) {
    return typeContainsOpaqueCleanupStorage(modules, moduleIndex, nullable, visiting);
  }
  const actual = transparentTypeName(modules, moduleIndex, typeName);
  if (actual != typeName) {
    return typeContainsOpaqueCleanupStorage(modules, moduleIndex, actual, visiting);
  }
  match (fixedArrayShape(actual)) {
    some(array) => return typeContainsOpaqueCleanupStorage(
      modules, moduleIndex, array.elementType, visiting
    );
    none => {}
  }
  let arguments = Array<String>();
  match (genericTypeShape(actual)) {
    some(generic) => {
      if (
        generic.base == "Array"
        || generic.base == "Map"
        || generic.base == "Set"
        || generic.base == "Option"
        || generic.base == "Result"
      ) {
        for (const argument of generic.arguments) {
          if (typeContainsOpaqueCleanupStorage(
            modules, moduleIndex, argument, visiting
          )) return true;
        }
        return false;
      }
      for (const argument of generic.arguments) {
        arguments.push(copy argument);
      }
    }
    none => {}
  }
  match (inferredTypeSymbolLocation(modules, moduleIndex, actual)) {
    some(location) => {
      const symbol = view modules[location.moduleIndex].symbols[location.symbolIndex];
      // ARC identity is not inline storage. Transferring an alias neither
      // partially moves the referenced object nor invokes its deinitializer.
      if (symbol.kind == ModuleSymbolKind.classSymbol) return false;
      const identity = semanticTypeIdentity(modules, moduleIndex, actual);
      if (containsString(visiting, identity)) return false;
      let nextVisiting = copyStrings(visiting);
      nextVisiting.push(identity);
      match (in symbol.typeSignature) {
        some(signature) => {
          if (signature.foreignLayout == "reference") return false;
          if (signature.customDeinit || signature.foreignResourceRelease.byteLength > 0) return true;
          let substitutions = Array<NativeValueBinding>();
          let parameter: usize = 0;
          while (
            parameter < signature.typeParameters.length
            && parameter < arguments.length
          ) {
            const argument = rebaseTypeName(
              modules, moduleIndex, location.moduleIndex, arguments[parameter]
            );
            addValueBinding(inout substitutions, signature.typeParameters[parameter], argument);
            parameter = parameter + 1;
          }
          for (const field of signature.fields) {
            const fieldType = substituteGenericType(field.typeName, substitutions);
            if (typeContainsOpaqueCleanupStorage(
              modules, location.moduleIndex, fieldType, nextVisiting
            )) return true;
          }
          for (const variant of signature.variants) {
            if (variant.payloadType.byteLength == 0) continue;
            const payloadType = substituteGenericType(variant.payloadType, substitutions);
            if (typeContainsOpaqueCleanupStorage(
              modules, location.moduleIndex, payloadType, nextVisiting
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

// Inline native identity cannot bypass thread checks by entering a value
// aggregate or container. Z ARC class boundaries have a separate proof.
export function typeContainsNativeObjCStorage(
  in modules: Array<ResolvedModule>, moduleIndex: usize, in typeName: String,
  in visiting: Array<String>
): boolean {
  const actual = transparentTypeName(modules, moduleIndex, typeName);
  if (typeIsNativeObjCReference(modules, moduleIndex, actual)) return true;
  const nullable = nullableTargetType(actual);
  if (nullable.byteLength > 0) return typeContainsNativeObjCStorage(modules, moduleIndex, nullable, visiting);
  if (stringStartsWith(actual, "readonly ")) {
    const target = actual.copyBytes(9, actual.byteLength);
    return typeContainsNativeObjCStorage(modules, moduleIndex, target, visiting);
  }
  match (fixedArrayShape(actual)) {
    some(array) => return typeContainsNativeObjCStorage(modules, moduleIndex, array.elementType, visiting);
    none => {}
  }
  let arguments = Array<String>();
  match (genericTypeShape(actual)) {
    some(generic) => {
      if (generic.base == "Array" || generic.base == "Map" || generic.base == "Set"
        || generic.base == "Option" || generic.base == "Result") {
        for (const argument of generic.arguments) {
          if (typeContainsNativeObjCStorage(modules, moduleIndex, argument, visiting)) return true;
        }
        return false;
      }
      for (const argument of generic.arguments) {
        arguments.push(copy argument);
      }
    }
    none => {}
  }
  const location = match (inferredTypeSymbolLocation(modules, moduleIndex, actual)) {
    some(value) => value;
    none => return false;
  };
  const symbol = view modules[location.moduleIndex].symbols[location.symbolIndex];
  // Z ARC classes have their own shareability/isolation proof. This walk is
  // about native references copied as inline value/container storage.
  if (symbol.kind == ModuleSymbolKind.classSymbol) return false;
  const identity = semanticTypeIdentity(modules, moduleIndex, actual);
  if (containsString(visiting, identity)) return false;
  let nextVisiting = copyStrings(visiting);
  nextVisiting.push(identity);
  match (in symbol.typeSignature) {
    some(signature) => {
      let substitutions = Array<NativeValueBinding>();
      let parameter: usize = 0;
      while (parameter < signature.typeParameters.length && parameter < arguments.length) {
        const argument = rebaseTypeName(modules, moduleIndex, location.moduleIndex, arguments[parameter]);
        addValueBinding(inout substitutions, signature.typeParameters[parameter], argument);
        parameter = parameter + 1;
      }
      for (const field of signature.fields) {
        const fieldType = substituteGenericType(field.typeName, substitutions);
        if (typeContainsNativeObjCStorage(modules, location.moduleIndex, fieldType, nextVisiting)) return true;
      }
      for (const variant of signature.variants) {
        const payload = substituteGenericType(variant.payloadType, substitutions);
        if (payload.byteLength > 0 && typeContainsNativeObjCStorage(modules, location.moduleIndex, payload, nextVisiting)) return true;
      }
    }
    none => {}
  }
  return false;
}

// Whether a value of the type holds a channel endpoint, inline or in a
// collection, aggregate field, or enum payload, whose message type cannot
// cross threads: taking it to another thread would carry those messages.
export function typeHoldsUntransferableEndpoint(
  in modules: Array<ResolvedModule>, moduleIndex: usize, in typeName: String,
  in visiting: Array<String>
): boolean {
  const actual = transparentTypeName(modules, moduleIndex, typeName);
  const nullable = nullableTargetType(actual);
  if (nullable.byteLength > 0) return typeHoldsUntransferableEndpoint(modules, moduleIndex, nullable, visiting);
  if (stringStartsWith(actual, "readonly ")) {
    const target = actual.copyBytes(9, actual.byteLength);
    return typeHoldsUntransferableEndpoint(modules, moduleIndex, target, visiting);
  }
  match (fixedArrayShape(actual)) {
    some(array) => return typeHoldsUntransferableEndpoint(modules, moduleIndex, array.elementType, visiting);
    none => {}
  }
  let arguments = Array<String>();
  match (genericTypeShape(actual)) {
    some(generic) => {
      if (generic.base == "Sender" || generic.base == "SyncSender"
        || generic.base == "Receiver" || generic.base == "SyncReceiver") {
        return !typeIsThreadTransferable(modules, moduleIndex, actual);
      }
      if (generic.base == "Array" || generic.base == "Map" || generic.base == "Set"
        || generic.base == "Option" || generic.base == "Result") {
        for (const argument of generic.arguments) {
          if (typeHoldsUntransferableEndpoint(modules, moduleIndex, argument, visiting)) return true;
        }
        return false;
      }
      for (const argument of generic.arguments) {
        arguments.push(copy argument);
      }
    }
    none => {}
  }
  const location = match (inferredTypeSymbolLocation(modules, moduleIndex, actual)) {
    some(value) => value;
    none => return false;
  };
  const symbol = view modules[location.moduleIndex].symbols[location.symbolIndex];
  // A Z ARC class crosses threads by its own shareability proof.
  if (symbol.kind == ModuleSymbolKind.classSymbol) return false;
  const identity = semanticTypeIdentity(modules, moduleIndex, actual);
  if (containsString(visiting, identity)) return false;
  let nextVisiting = copyStrings(visiting);
  nextVisiting.push(identity);
  match (in symbol.typeSignature) {
    some(signature) => {
      let substitutions = Array<NativeValueBinding>();
      let parameter: usize = 0;
      while (parameter < signature.typeParameters.length && parameter < arguments.length) {
        const argument = rebaseTypeName(modules, moduleIndex, location.moduleIndex, arguments[parameter]);
        addValueBinding(inout substitutions, signature.typeParameters[parameter], argument);
        parameter = parameter + 1;
      }
      for (const field of signature.fields) {
        const fieldType = substituteGenericType(field.typeName, substitutions);
        if (typeHoldsUntransferableEndpoint(modules, location.moduleIndex, fieldType, nextVisiting)) return true;
      }
      for (const variant of signature.variants) {
        const payload = substituteGenericType(variant.payloadType, substitutions);
        if (payload.byteLength > 0 && typeHoldsUntransferableEndpoint(modules, location.moduleIndex, payload, nextVisiting)) return true;
      }
    }
    none => {}
  }
  return false;
}

// Native Objective-C references retain shared identity on ordinary value use.
// That cleanup obligation is not unique ownership that `move value` can take.
export function typeIsNativeObjCReference(
  in modules: Array<ResolvedModule>, moduleIndex: usize, in typeName: String
): boolean {
  let actual = transparentTypeName(modules, moduleIndex, typeName);
  const nullableTarget = nullableTargetType(actual);
  if (nullableTarget.byteLength > 0) actual = nullableTarget;
  return match (inferredTypeSymbolLocation(modules, moduleIndex, actual)) {
    some(location) => match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
      some(signature) => signature.foreignKind == "objcInterface"
        || signature.foreignKind == "objcSubclass"
        || signature.foreignKind == "objcProtocol";
      none => false;
    }
    none => actual == nativeObjCObjectTypeName;
  };
}

export function typeMovesOnOwnedUse(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  if (typeIsNativeObjCReference(modules, moduleIndex, typeName)) return false;
  let managedType = typeName.copyBytes(0, typeName.byteLength);
  const nullableTarget = nullableTargetType(typeName);
  if (nullableTarget.byteLength > 0) {
    managedType = nullableTarget.copyBytes(0, nullableTarget.byteLength);
  }
  let transparentManagedType = transparentTypeName(
    modules,
    moduleIndex,
    managedType
  );
  const transparentNullableTarget = nullableTargetType(transparentManagedType);
  if (transparentNullableTarget.byteLength > 0) {
    transparentManagedType = transparentNullableTarget.copyBytes(
      0,
      transparentNullableTarget.byteLength
    );
  }
  if (
    stringStartsWith(managedType, "Weak<")
    || stringStartsWith(transparentManagedType, "Sender<")
    || stringStartsWith(transparentManagedType, "SyncSender<")
    || stringStartsWith(transparentManagedType, "__z_native_function:")
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

export function typeContainsSlice(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  const canonical = transparentTypeName(modules, moduleIndex, typeName);
  if (stringStartsWith(canonical, "Slice<")) return true;
  match (fixedArrayShape(canonical)) {
    some(array) => return typeContainsSlice(modules, moduleIndex, array.elementType);
    none => {}
  }
  return match (genericTypeShape(canonical)) {
    some(generic) => generic.base == "Array"
      && generic.arguments.length == 1
      && typeContainsSlice(modules, moduleIndex, generic.arguments[0]);
    none => false;
  };
}

function typeContainsStoredViewInner(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>,
  in visitingLocations: Array<ModuleSymbolLocation>
): boolean {
  if (stringStartsWith(typeName, "view ")) return true;
  const nullableTarget = nullableTargetType(typeName);
  if (nullableTarget.byteLength > 0) {
    return typeContainsStoredViewInner(
      modules,
      moduleIndex,
      nullableTarget,
      visiting,
      visitingLocations
    );
  }
  match (fixedArrayShape(typeName)) {
    some(array) => return typeContainsStoredViewInner(
      modules,
      moduleIndex,
      array.elementType,
      visiting,
      visitingLocations
    );
    none => {}
  }
  let arguments = Array<String>();
  match (genericTypeShape(typeName)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
        if (typeContainsStoredViewInner(
          modules,
          moduleIndex,
          argument,
          visiting,
          visitingLocations
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
      let nextVisiting = copyStrings(visiting);
      let nextVisitingLocations = copySymbolLocations(visitingLocations);
      if (arguments.length > 0) {
        const identity = semanticTypeIdentity(modules, moduleIndex, typeName);
        if (containsString(visiting, identity)) return false;
        nextVisiting.push(identity);
      } else {
        if (containsSymbolLocation(visitingLocations, location)) return false;
        nextVisitingLocations.push(ModuleSymbolLocation({
          moduleIndex: location.moduleIndex,
          symbolIndex: location.symbolIndex,
        }));
      }
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
            if (substitutions.length == 0) {
              if (typeContainsStoredViewInner(
                modules,
                location.moduleIndex,
                field.typeName,
                nextVisiting,
                nextVisitingLocations
              )) return true;
              continue;
            }
            const fieldType = substituteGenericType(
              field.typeName,
              substitutions
            );
            if (typeContainsStoredViewInner(
              modules,
              location.moduleIndex,
              fieldType,
              nextVisiting,
              nextVisitingLocations
            )) return true;
          }
          for (const variant of signature.variants) {
            if (variant.payloadType.byteLength == 0) continue;
            if (substitutions.length == 0) {
              if (typeContainsStoredViewInner(
                modules,
                location.moduleIndex,
                variant.payloadType,
                nextVisiting,
                nextVisitingLocations
              )) return true;
              continue;
            }
            const payloadType = substituteGenericType(
              variant.payloadType,
              substitutions
            );
            if (typeContainsStoredViewInner(
              modules,
              location.moduleIndex,
              payloadType,
              nextVisiting,
              nextVisitingLocations
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

export function typeContainsStoredView(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>
): boolean {
  let visitingLocations = Array<ModuleSymbolLocation>();
  return typeContainsStoredViewInner(
    modules,
    moduleIndex,
    typeName,
    visiting,
    visitingLocations
  );
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
  if (stringStartsWith(actual, "readonly ")) {
    const target = actual.copyBytes(9, actual.byteLength);
    return typeSupportsExplicitCopy(modules, moduleIndex, target, visiting);
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
    || stringStartsWith(actual, "OnceLifetime<")
    || stringStartsWith(actual, "Channel<")
    || stringStartsWith(actual, "Sender<")
    || stringStartsWith(actual, "Receiver<")
    || stringStartsWith(actual, "SyncSender<")
    || stringStartsWith(actual, "SyncReceiver<")
    || stringStartsWith(actual, "ChannelClosed<")
    || stringStartsWith(actual, "Channel.Endpoints<")
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

// Whether an undeclared executor capture of this type is a private snapshot,
// as in Stage 0: a String, or a cleanup-free value made of scalars (fixed
// arrays, structs without a deinit, enums). Anything else crosses only under
// an explicit `using (...)` capability.
export function typeIsImplicitPlacementCopy(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>
): boolean {
  const actual = transparentTypeName(modules, moduleIndex, typeName);
  if (actual == "String" || actual == "void" || actual == "boolean" || isNumericTypeName(actual)) return true;
  match (fixedArrayShape(actual)) {
    some(array) => return typeIsImplicitPlacementCopy(modules, moduleIndex, array.elementType, visiting);
    none => {}
  }
  let arguments = Array<String>();
  match (genericTypeShape(actual)) {
    some(generic) => {
      // The built-in enums are snapshots when their payloads are.
      if ((generic.base == "Option" && generic.arguments.length == 1)
        || (generic.base == "Result" && generic.arguments.length == 2)) {
        for (const argument of generic.arguments) {
          if (!typeIsImplicitPlacementCopy(modules, moduleIndex, argument, visiting)) return false;
        }
        return true;
      }
      for (const argument of generic.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
      }
    }
    none => {}
  }
  const location = match (typeSymbolLocation(modules, moduleIndex, actual)) {
    some(found) => found;
    none => return false;
  };
  const symbol = view modules[location.moduleIndex].symbols[location.symbolIndex];
  if (symbol.kind == ModuleSymbolKind.classSymbol) return false;
  const identity = semanticTypeIdentity(modules, moduleIndex, actual);
  if (containsString(visiting, identity)) return true;
  let nextVisiting = copyStrings(visiting);
  nextVisiting.push(identity);
  match (in symbol.typeSignature) {
    some(signature) => {
      if (signature.foreignNativeName.byteLength > 0 || signature.customDeinit) return false;
      let substitutions = Array<NativeValueBinding>();
      let typeIndex: usize = 0;
      while (typeIndex < signature.typeParameters.length && typeIndex < arguments.length) {
        const argument = rebaseTypeName(modules, moduleIndex, location.moduleIndex, arguments[typeIndex]);
        addValueBinding(inout substitutions, signature.typeParameters[typeIndex], argument);
        typeIndex = typeIndex + 1;
      }
      for (const field of signature.fields) {
        const fieldType = substituteGenericType(field.typeName, substitutions);
        if (!typeIsImplicitPlacementCopy(modules, location.moduleIndex, fieldType, nextVisiting)) return false;
      }
      for (const variant of signature.variants) {
        if (variant.payloadType.byteLength == 0) continue;
        const payloadType = substituteGenericType(variant.payloadType, substitutions);
        if (!typeIsImplicitPlacementCopy(modules, location.moduleIndex, payloadType, nextVisiting)) return false;
      }
      return true;
    }
    none => return false;
  }
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
