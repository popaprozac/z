import {
  ModuleFunctionSignature,
  ModuleSymbolKind,
  ModuleTypeParameterConstraint,
} from "./semantic-model.zs";
import { TextBuffer } from "std/text";

export struct NativeGenericTypeShape {
  base: String;
  arguments: Array<String>;
}

export struct NativeFixedArrayShape {
  elementType: String;
  length: String;
}

export function nativeFunctionTypeName(
  in signature: ModuleFunctionSignature
): String {
  let output = TextBuffer();
  output.append("__z_native_function:");
  if (signature.asynchronous) output.append("async ");
  output.append("(");
  let index: usize = 0;
  while (index < signature.parameterTypes.length) {
    if (index > 0) output.append(", ");
    if (signature.parameterModes[index] != "value") {
      output.append(signature.parameterModes[index]);
      output.append(" ");
    }
    output.append(`value${index}: `);
    output.append(signature.parameterTypes[index]);
    index = index + 1;
  }
  output.append(") => ");
  output.append(signature.returnType);
  if (signature.errorType.byteLength > 0) {
    output.append(" throws ");
    output.append(signature.errorType);
  }
  if (signature.threadContract.byteLength > 0) {
    output.append(" on ");
    output.append(signature.threadContract);
  }
  return output.finish();
}

export function isTypeSymbolKind(kind: ModuleSymbolKind): boolean {
  return kind == ModuleSymbolKind.structSymbol
    || kind == ModuleSymbolKind.classSymbol
    || kind == ModuleSymbolKind.traitSymbol
    || kind == ModuleSymbolKind.typeAliasSymbol
    || kind == ModuleSymbolKind.enumSymbol;
}

export function isIntrinsicTypeName(in name: String): boolean {
  return name == "void"
    || name == "boolean"
    || name == "i8"
    || name == "i16"
    || name == "i32"
    || name == "i64"
    || name == "u8"
    || name == "u16"
    || name == "u32"
    || name == "u64"
    || name == "isize"
    || name == "usize"
    || name == "f32"
    || name == "f64"
    || name == "cstring"
    || name == "String"
    || name == "TextBuffer"
    || name == "Arena"
    || name == "Array"
    || name == "Slice"
    || name == "Option"
    || name == "Result"
    || name == "Task"
    || name == "Weak"
    || name == "WeakExpired"
    || name == "Once"
    || name == "OnceLifetime"
    || name == "Mutex";
}

export function qualifiedTypeBase(in name: String): String {
  let index: usize = 0;
  while (index < name.byteLength) {
    if (name.byteAt(index) == 46) return name.copyBytes(0, index);
    index = index + 1;
  }
  return name.copyBytes(0, name.byteLength);
}

export function qualifiedTypeMember(in name: String): String {
  let index: usize = 0;
  while (index < name.byteLength) {
    if (name.byteAt(index) == 46) return name.copyBytes(index + 1, name.byteLength);
    index = index + 1;
  }
  return "";
}

export function isIntegerTypeName(in name: String): boolean {
  return name == "i8"
    || name == "i16"
    || name == "i32"
    || name == "i64"
    || name == "u8"
    || name == "u16"
    || name == "u32"
    || name == "u64"
    || name == "isize"
    || name == "usize";
}

export function isFloatTypeName(in name: String): boolean {
  return name == "f32" || name == "f64";
}

export function isNumericTypeName(in name: String): boolean {
  return isIntegerTypeName(name) || isFloatTypeName(name);
}

export function stringStartsWith(in value: String, in prefix: String): boolean {
  if (prefix.byteLength > value.byteLength) return false;
  let index: usize = 0;
  while (index < prefix.byteLength) {
    if (value.byteAt(index) != prefix.byteAt(index)) return false;
    index = index + 1;
  }
  return true;
}

export function arrayElementType(in name: String): String {
  if (stringStartsWith(name, "view ") && name.byteLength > 5) {
    const target = name.copyBytes(5, name.byteLength);
    return arrayElementType(target);
  }
  if (stringStartsWith(name, "Array<") || stringStartsWith(name, "Slice<")) {
    if (name.byteLength > 7 && name.byteAt(name.byteLength - 1) == 62) {
      const start: usize = 6;
      return name.copyBytes(start, name.byteLength - 1);
    }
  }
  let index = name.byteLength;
  while (index > 0) {
    index = index - 1;
    if (name.byteAt(index) == 91) return name.copyBytes(0, index);
  }
  return "";
}

function trimmedTypeSlice(in name: String, start: usize, end: usize): String {
  let first = start;
  let last = end;
  while (first < last && name.byteAt(first) == 32) {
    first = first + 1;
  }
  while (last > first && name.byteAt(last - 1) == 32) {
    last = last - 1;
  }
  return name.copyBytes(first, last);
}

export function genericTypeShape(in name: String): Option<NativeGenericTypeShape> {
  let open = name.byteLength;
  let index: usize = 0;
  while (index < name.byteLength) {
    if (name.byteAt(index) == 60) {
      open = index;
      break;
    }
    index = index + 1;
  }
  if (open == name.byteLength || name.byteAt(name.byteLength - 1) != 62) {
    return Option<NativeGenericTypeShape>.none;
  }
  let arguments = Array<String>();
  let angleDepth: usize = 1;
  let parenthesisDepth: usize = 0;
  let bracketDepth: usize = 0;
  let argumentStart = open + 1;
  index = argumentStart;
  while (index < name.byteLength) {
    const byte = name.byteAt(index);
    if (byte == 40) parenthesisDepth = parenthesisDepth + 1;
    else if (byte == 41 && parenthesisDepth > 0) parenthesisDepth = parenthesisDepth - 1;
    else if (byte == 91) bracketDepth = bracketDepth + 1;
    else if (byte == 93 && bracketDepth > 0) bracketDepth = bracketDepth - 1;
    else if (byte == 60) angleDepth = angleDepth + 1;
    else if (byte == 62 && (index == 0 || name.byteAt(index - 1) != 61)) {
      angleDepth = angleDepth - 1;
      if (angleDepth == 0) {
        if (index != name.byteLength - 1 || index == argumentStart) {
          return Option<NativeGenericTypeShape>.none;
        }
        arguments.push(trimmedTypeSlice(name, argumentStart, index));
        return Option.some(NativeGenericTypeShape({
          base: trimmedTypeSlice(name, 0, open),
          arguments,
        }));
      }
    } else if (
      byte == 44
      && angleDepth == 1
      && parenthesisDepth == 0
      && bracketDepth == 0
    ) {
      if (index == argumentStart) return Option<NativeGenericTypeShape>.none;
      arguments.push(trimmedTypeSlice(name, argumentStart, index));
      argumentStart = index + 1;
    }
    index = index + 1;
  }
  return Option<NativeGenericTypeShape>.none;
}

export function fixedArrayShape(in name: String): Option<NativeFixedArrayShape> {
  if (name.byteLength < 4 || name.byteAt(name.byteLength - 1) != 93) {
    return Option<NativeFixedArrayShape>.none;
  }
  let index = name.byteLength - 1;
  while (index > 0) {
    index = index - 1;
    if (name.byteAt(index) == 91) {
      if (index == 0 || index + 1 == name.byteLength - 1) {
        return Option<NativeFixedArrayShape>.none;
      }
      let digit = index + 1;
      while (digit < name.byteLength - 1) {
        const byte = name.byteAt(digit);
        if (byte < 48 || byte > 57) {
          return Option<NativeFixedArrayShape>.none;
        }
        digit = digit + 1;
      }
      return Option.some(NativeFixedArrayShape({
        elementType: name.copyBytes(0, index),
        length: name.copyBytes(index + 1, name.byteLength - 1),
      }));
    }
  }
  return Option<NativeFixedArrayShape>.none;
}

export function isNullableTypeName(in name: String): boolean {
  if (name.byteLength < 7) return false;
  return name.copyBytes(name.byteLength - 7, name.byteLength) == " | null";
}

export function nullableTargetType(in name: String): String {
  if (!isNullableTypeName(name)) return "";
  return name.copyBytes(0, name.byteLength - 7);
}

export function nativeFunctionDisplayType(in typeName: String): String {
  const prefix = "__z_native_function:";
  if (!stringStartsWith(typeName, prefix)) return "";
  return typeName.copyBytes(prefix.byteLength, typeName.byteLength);
}

function appendNativeFunctionParameter(
  in functionType: String,
  start: usize,
  end: usize,
  inout parameterModes: Array<String>,
  inout parameterTypes: Array<String>
): boolean {
  const parameter = trimmedTypeSlice(functionType, start, end);
  if (parameter.byteLength == 0) return false;
  let mode = "value";
  let nameStart: usize = 0;
  if (stringStartsWith(parameter, "inout ")) {
    mode = "inout";
    nameStart = 6;
  } else if (stringStartsWith(parameter, "out ")) {
    mode = "out";
    nameStart = 4;
  } else if (stringStartsWith(parameter, "in ")) {
    mode = "in";
    nameStart = 3;
  }
  let colon = parameter.byteLength;
  let index = nameStart;
  while (index < parameter.byteLength) {
    if (parameter.byteAt(index) == 58) {
      colon = index;
      break;
    }
    index = index + 1;
  }
  if (colon == parameter.byteLength || colon + 1 >= parameter.byteLength) return false;
  const parameterLength = parameter.byteLength;
  const typeName = trimmedTypeSlice(parameter, colon + 1, parameterLength);
  if (typeName.byteLength == 0) return false;
  parameterModes.push(mode);
  parameterTypes.push(typeName);
  return true;
}

export function nativeFunctionSignature(
  in typeName: String
): Option<ModuleFunctionSignature> {
  let functionType = nativeFunctionDisplayType(typeName);
  if (
    functionType.byteLength == 0
    && (
      (typeName.byteLength > 0 && typeName.byteAt(0) == 40)
      || stringStartsWith(typeName, "async (")
    )
  ) functionType = typeName.copyBytes(0, typeName.byteLength);
  let asynchronous = false;
  if (stringStartsWith(functionType, "async ")) {
    asynchronous = true;
    functionType = functionType.copyBytes(6, functionType.byteLength);
  }
  if (functionType.byteLength < 6 || functionType.byteAt(0) != 40) {
    return Option<ModuleFunctionSignature>.none;
  }
  let close = functionType.byteLength;
  let depth: usize = 0;
  let index: usize = 0;
  while (index < functionType.byteLength) {
    const byte = functionType.byteAt(index);
    if (byte == 40) depth = depth + 1;
    else if (byte == 41) {
      if (depth == 0) return Option<ModuleFunctionSignature>.none;
      depth = depth - 1;
      if (depth == 0) {
        close = index;
        break;
      }
    }
    index = index + 1;
  }
  if (
    close == functionType.byteLength
    || close + 4 > functionType.byteLength
    || functionType.copyBytes(close, close + 4) != ") =>"
  ) return Option<ModuleFunctionSignature>.none;
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  let parameterStart: usize = 1;
  let parenthesisDepth: usize = 0;
  let angleDepth: usize = 0;
  let bracketDepth: usize = 0;
  index = 1;
  while (index <= close) {
    let separator = index == close;
    if (!separator) {
      const byte = functionType.byteAt(index);
      if (byte == 40) parenthesisDepth = parenthesisDepth + 1;
      else if (byte == 41 && parenthesisDepth > 0) parenthesisDepth = parenthesisDepth - 1;
      else if (byte == 60) angleDepth = angleDepth + 1;
      else if (byte == 62 && angleDepth > 0) angleDepth = angleDepth - 1;
      else if (byte == 91) bracketDepth = bracketDepth + 1;
      else if (byte == 93 && bracketDepth > 0) bracketDepth = bracketDepth - 1;
      else if (
        byte == 44
        && parenthesisDepth == 0
        && angleDepth == 0
        && bracketDepth == 0
      ) separator = true;
    }
    if (separator) {
      if (index > parameterStart) {
        if (!appendNativeFunctionParameter(
          functionType,
          parameterStart,
          index,
          inout parameterModes,
          inout parameterTypes
        )) return Option<ModuleFunctionSignature>.none;
      }
      parameterStart = index + 1;
    }
    index = index + 1;
  }
  let functionTypeLength = functionType.byteLength;
  let threadContract = "";
  const anyThreadSuffix = " on thread.any";
  const mainThreadSuffix = " on thread.main";
  if (
    functionTypeLength >= anyThreadSuffix.byteLength
    && functionType.copyBytes(
      functionTypeLength - anyThreadSuffix.byteLength,
      functionTypeLength
    ) == anyThreadSuffix
  ) {
    threadContract = "thread.any";
    functionTypeLength = functionTypeLength - anyThreadSuffix.byteLength;
  } else if (
    functionTypeLength >= mainThreadSuffix.byteLength
    && functionType.copyBytes(
      functionTypeLength - mainThreadSuffix.byteLength,
      functionTypeLength
    ) == mainThreadSuffix
  ) {
    threadContract = "thread.main";
    functionTypeLength = functionTypeLength - mainThreadSuffix.byteLength;
  }
  let throwsAt = functionTypeLength;
  let returnParenthesisDepth: usize = 0;
  let returnAngleDepth: usize = 0;
  let returnBracketDepth: usize = 0;
  index = close + 4;
  while (index + 8 <= functionTypeLength) {
    const byte = functionType.byteAt(index);
    if (byte == 40) returnParenthesisDepth = returnParenthesisDepth + 1;
    else if (byte == 41 && returnParenthesisDepth > 0) {
      returnParenthesisDepth = returnParenthesisDepth - 1;
    } else if (byte == 60) returnAngleDepth = returnAngleDepth + 1;
    else if (byte == 62 && returnAngleDepth > 0) {
      returnAngleDepth = returnAngleDepth - 1;
    } else if (byte == 91) returnBracketDepth = returnBracketDepth + 1;
    else if (byte == 93 && returnBracketDepth > 0) {
      returnBracketDepth = returnBracketDepth - 1;
    }
    if (
      returnParenthesisDepth == 0
      && returnAngleDepth == 0
      && returnBracketDepth == 0
      && functionType.copyBytes(index, index + 8) == " throws "
    ) {
      throwsAt = index;
      break;
    }
    index = index + 1;
  }
  const returnType = trimmedTypeSlice(functionType, close + 4, throwsAt);
  if (returnType.byteLength == 0) return Option<ModuleFunctionSignature>.none;
  let errorType = "";
  if (throwsAt < functionTypeLength) {
    errorType = trimmedTypeSlice(functionType, throwsAt + 8, functionTypeLength);
    if (errorType.byteLength == 0) {
      return Option<ModuleFunctionSignature>.none;
    }
  }
  return Option.some(ModuleFunctionSignature({
    asynchronous,
    executorAffinity: "",
    threadContract,
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    parameterModes,
    parameterTypes,
    viewParameter: Option<usize>.none,
    invalidatesParameters: Array<usize>(),
    invalidatesLifetimes: Array<String>(),
    returnType,
    errorType,
  }));
}
