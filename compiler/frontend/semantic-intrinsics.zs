import { parameterizedTypeName } from "./semantic-generic-inference.zs";
import { aggregateFieldShape } from "./semantic-member-lookups.zs";
import {
  arrayElementType,
  genericTypeShape,
  isIntegerTypeName,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import {
  ModuleFunctionSignature,
  ModuleTypeParameterConstraint,
  ResolvedModule,
} from "./semantic-model.zs";

export function numberLiteralType(in value: String): String {
  let index: usize = 0;
  while (index < value.byteLength) {
    const byte = value.byteAt(index);
    if (byte == 46 || byte == 69 || byte == 101) return "f64";
    index = index + 1;
  }
  return "i32";
}

export function iterationElementType(in name: String): String {
  if (stringStartsWith(name, "view ") && name.byteLength > 5) {
    const target = name.copyBytes(5, name.byteLength);
    return iterationElementType(target);
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      if (
        (
          generic.base == "Array"
          || generic.base == "Slice"
          || generic.base == "Set"
          || generic.base == "Iterator"
          || generic.base == "Generator"
          || generic.base == "AsyncGenerator"
        )
        && generic.arguments.length == 1
      ) return generic.arguments[0].copyBytes(
        0,
        generic.arguments[0].byteLength
      );
      if (generic.base == "Map" && generic.arguments.length == 2) {
        return `Map.Entry<${generic.arguments[0]}, ${generic.arguments[1]}>`;
      }
    }
    none => {}
  }
  return arrayElementType(name);
}

export function iterationObjectFieldType(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in iterableType: String,
  in fieldName: String
): String {
  if (
    stringStartsWith(iterableType, "view ")
    && iterableType.byteLength > 5
  ) {
    const target = iterableType.copyBytes(5, iterableType.byteLength);
    return iterationObjectFieldType(
      modules,
      moduleIndex,
      target,
      fieldName
    );
  }
  match (genericTypeShape(iterableType)) {
    some(generic) => {
      if (generic.base == "Map" && generic.arguments.length == 2) {
        if (fieldName == "key") {
          return generic.arguments[0].copyBytes(
            0,
            generic.arguments[0].byteLength
          );
        }
        if (fieldName == "value") {
          return generic.arguments[1].copyBytes(
            0,
            generic.arguments[1].byteLength
          );
        }
        return "";
      }
    }
    none => {}
  }
  const elementType = iterationElementType(iterableType);
  return match (
    aggregateFieldShape(modules, moduleIndex, elementType, fieldName)
  ) {
    some(field) => field.typeName.copyBytes(0, field.typeName.byteLength);
    none => "";
  };
}

export function throwingGeneratorHandleType(
  in returnType: String,
  in errorType: String
): Option<String> {
  return match (genericTypeShape(returnType)) {
    some(generator) => {
      if (
        generator.base != "Generator"
        && generator.base != "AsyncGenerator"
      ) return Option<String>.none;
      let arguments = Array<String>();
      for (const argument of generator.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
      }
      if (arguments.length == 1) arguments.push("void");
      if (arguments.length == 2) {
        arguments.push(errorType.copyBytes(0, errorType.byteLength));
      }
      return Option.some(parameterizedTypeName(generator.base, arguments));
    }
    none => Option<String>.none;
  };
}

export function collectionMethodSignature(
  in ownerType: String,
  in methodName: String
): Option<ModuleFunctionSignature> {
  if (
    stringStartsWith(ownerType, "view ")
    && ownerType.byteLength > 5
  ) {
    const target = ownerType.copyBytes(5, ownerType.byteLength);
    return collectionMethodSignature(target, methodName);
  }
  if (ownerType == "fs.Lock" && methodName == "unlock") {
    return Option.some(ModuleFunctionSignature({
      asynchronous: false,
      executorAffinity: "",
      typeParameters: Array<String>(),
      typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
      parameterModes: Array<String>(),
      parameterTypes: Array<String>(),
      viewParameter: Option<usize>.none,
      invalidatesParameters: Array<usize>(),
      invalidatesLifetimes: Array<String>(),
      returnType: "void",
      errorType: "",
    }));
  }
  if (
    isIntegerTypeName(ownerType)
    && (
      methodName == "wrappingAdd"
      || methodName == "wrappingSubtract"
      || methodName == "wrappingMultiply"
    )
  ) {
    let parameterModes = Array<String>();
    parameterModes.push("value");
    let parameterTypes = Array<String>();
    parameterTypes.push(ownerType.copyBytes(0, ownerType.byteLength));
    return Option.some(ModuleFunctionSignature({
      asynchronous: false,
      executorAffinity: "",
      typeParameters: Array<String>(),
      typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
      parameterModes,
      parameterTypes,
      viewParameter: Option<usize>.none,
      invalidatesParameters: Array<usize>(),
      invalidatesLifetimes: Array<String>(),
      returnType: ownerType.copyBytes(0, ownerType.byteLength),
      errorType: "",
    }));
  }
  if (ownerType == "String" || ownerType == "TextBuffer") {
    let parameterModes = Array<String>();
    let parameterTypes = Array<String>();
    let returnType = "";
    if (ownerType == "String" && methodName == "byteAt") {
      parameterModes.push("value");
      parameterTypes.push("usize");
      returnType = "u8";
    } else if (ownerType == "String" && methodName == "copyBytes") {
      parameterModes.push("value");
      parameterTypes.push("usize");
      parameterModes.push("value");
      parameterTypes.push("usize");
      returnType = "String";
    } else if (ownerType == "TextBuffer" && methodName == "append") {
      parameterModes.push("in");
      parameterTypes.push("String");
      returnType = "void";
    } else if (ownerType == "TextBuffer" && methodName == "appendBytes") {
      parameterModes.push("in");
      parameterTypes.push("String");
      parameterModes.push("value");
      parameterTypes.push("usize");
      parameterModes.push("value");
      parameterTypes.push("usize");
      returnType = "void";
    } else if (ownerType == "TextBuffer" && methodName == "appendAscii") {
      parameterModes.push("value");
      parameterTypes.push("u8");
      returnType = "void";
    } else if (ownerType == "TextBuffer" && methodName == "finish") {
      returnType = "String";
    }
    if (returnType.byteLength == 0) {
      return Option<ModuleFunctionSignature>.none;
    }
    return Option.some(ModuleFunctionSignature({
      asynchronous: false,
      executorAffinity: "",
      typeParameters: Array<String>(),
      typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
      parameterModes,
      parameterTypes,
      viewParameter: Option<usize>.none,
      invalidatesParameters: Array<usize>(),
      invalidatesLifetimes: Array<String>(),
      returnType,
      errorType: "",
    }));
  }
  if (ownerType == "Arena") {
    let parameterModes = Array<String>();
    let parameterTypes = Array<String>();
    if (methodName == "reset") {
      return Option.some(ModuleFunctionSignature({
        asynchronous: false,
        executorAffinity: "",
        typeParameters: Array<String>(),
        typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
        parameterModes,
        parameterTypes,
        viewParameter: Option<usize>.none,
        invalidatesParameters: Array<usize>(),
        invalidatesLifetimes: Array<String>(),
        returnType: "void",
        errorType: "",
      }));
    }
  }
  const generic = match (genericTypeShape(ownerType)) {
    some(generic) => generic;
    none => return Option<ModuleFunctionSignature>.none;
  };
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  let returnType = "";
  let errorType = "";
  if (generic.base == "Once" && generic.arguments.length == 1) {
    const valueType = generic.arguments[0].copyBytes(
      0,
      generic.arguments[0].byteLength
    );
    let executorAffinity = "";
    if (methodName == "initialize") {
      parameterModes.push("move");
      parameterTypes.push(valueType.copyBytes(0, valueType.byteLength));
      returnType = `OnceLifetime<${valueType}>`;
      executorAffinity = "thread.main";
    } else if (methodName == "get") {
      returnType = valueType;
    }
    if (returnType.byteLength > 0) {
      return Option.some(ModuleFunctionSignature({
        asynchronous: false,
        executorAffinity,
        typeParameters: Array<String>(),
        typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
        parameterModes,
        parameterTypes,
        viewParameter: Option<usize>.none,
        invalidatesParameters: Array<usize>(),
        invalidatesLifetimes: Array<String>(),
        returnType,
        errorType: "",
      }));
    }
  } else if (generic.base == "Array" && generic.arguments.length == 1) {
    const elementType = generic.arguments[0].copyBytes(
      0,
      generic.arguments[0].byteLength
    );
    if (methodName == "push") {
      parameterModes.push("value");
      parameterTypes.push(elementType);
      returnType = "void";
    }
  } else if (generic.base == "Map" && generic.arguments.length == 2) {
    const keyType = generic.arguments[0].copyBytes(
      0,
      generic.arguments[0].byteLength
    );
    const valueType = generic.arguments[1].copyBytes(
      0,
      generic.arguments[1].byteLength
    );
    if (methodName == "has") {
      parameterModes.push("in");
      parameterTypes.push(keyType.copyBytes(0, keyType.byteLength));
      returnType = "boolean";
    } else if (methodName == "get") {
      parameterModes.push("in");
      parameterTypes.push(keyType.copyBytes(0, keyType.byteLength));
      returnType = `Option<view ${valueType}>`;
    } else if (methodName == "set") {
      parameterModes.push("value");
      parameterTypes.push(keyType.copyBytes(0, keyType.byteLength));
      parameterModes.push("value");
      parameterTypes.push(valueType.copyBytes(0, valueType.byteLength));
      returnType = "void";
    } else if (methodName == "remove") {
      parameterModes.push("in");
      parameterTypes.push(keyType.copyBytes(0, keyType.byteLength));
      returnType = `Option<${valueType}>`;
    } else if (methodName == "delete") {
      parameterModes.push("in");
      parameterTypes.push(keyType.copyBytes(0, keyType.byteLength));
      returnType = "boolean";
    } else if (methodName == "clear") {
      returnType = "void";
    }
  } else if (generic.base == "Set" && generic.arguments.length == 1) {
    const elementType = generic.arguments[0].copyBytes(
      0,
      generic.arguments[0].byteLength
    );
    if (methodName == "has") {
      parameterModes.push("in");
      parameterTypes.push(elementType.copyBytes(0, elementType.byteLength));
      returnType = "boolean";
    } else if (methodName == "add") {
      parameterModes.push("value");
      parameterTypes.push(elementType.copyBytes(0, elementType.byteLength));
      returnType = "boolean";
    } else if (methodName == "remove") {
      parameterModes.push("in");
      parameterTypes.push(elementType.copyBytes(0, elementType.byteLength));
      returnType = `Option<${elementType}>`;
    } else if (methodName == "clear") {
      returnType = "void";
    }
  } else if (
    generic.base == "Weak"
    && generic.arguments.length == 1
    && methodName == "upgrade"
  ) {
    returnType = generic.arguments[0].copyBytes(
      0,
      generic.arguments[0].byteLength
    );
    errorType = "WeakExpired";
  } else if (
    (
      generic.base == "Generator"
      || generic.base == "AsyncGenerator"
    )
    && (
      generic.arguments.length == 1
      || generic.arguments.length == 2
      || generic.arguments.length == 3
    )
    && methodName == "next"
  ) {
    const elementType = generic.arguments[0].copyBytes(
      0,
      generic.arguments[0].byteLength
    );
    if (generic.arguments.length == 1 || generic.arguments[1] == "void") {
      returnType = `Option<${elementType}>`;
    } else {
      returnType = `GeneratorStep<${elementType}, ${generic.arguments[1]}>`;
    }
    if (generic.arguments.length == 3) {
      errorType = generic.arguments[2].copyBytes(
        0,
        generic.arguments[2].byteLength
      );
    }
    return Option.some(ModuleFunctionSignature({
      asynchronous: generic.base == "AsyncGenerator",
      executorAffinity: "",
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
  if (returnType.byteLength == 0) {
    return Option<ModuleFunctionSignature>.none;
  }
  return Option.some(ModuleFunctionSignature({
    asynchronous: false,
    executorAffinity: "",
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

export function collectionMethodMutates(
  in ownerType: String,
  in methodName: String
): boolean {
  if (ownerType == "TextBuffer") {
    return methodName == "append"
      || methodName == "appendBytes"
      || methodName == "appendAscii"
      || methodName == "finish";
  }
  return match (genericTypeShape(ownerType)) {
    some(generic) => generic.base == "Array"
      ? methodName == "push"
      : generic.base == "Map"
      ? methodName == "set"
        || methodName == "remove"
        || methodName == "clear"
      : generic.base == "Set"
        && (
          methodName == "add"
          || methodName == "remove"
          || methodName == "clear"
        );
    none => false;
  };
}
