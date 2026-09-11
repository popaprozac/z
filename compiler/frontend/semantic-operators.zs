import {
  equivalentTypes,
  inferredTypeSymbolLocation,
  isUnresolvedExternalType,
  typeSymbolLocation,
  transparentTypeName,
} from "./semantic-type-identities.zs";
import { nativeObjectiveCReferenceAssignable } from "./semantic-expression-types.zs";
import {
  isIntegerTypeName,
  isNullableTypeName,
  isNumericTypeName,
  nullableTargetType,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import {
  typeHasCleanup,
  typeIsNativeObjCReference,
  typeSupportsExplicitCopy,
} from "./semantic-type-ownership.zs";
import {
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSymbolKind,
  ResolvedModule,
  moduleResolutionError,
} from "./semantic-model.zs";
import { ExpressionTree } from "./parser.zs";
import { ParsedModule } from "./module-symbols.zs";

function invalidOperator(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in message: String
): ModuleResolveError {
  const node = view tree.nodes[index];
  return moduleResolutionError(
    ModuleResolveErrorKind.invalidOperator,
    module.path,
    message,
    node.line,
    node.column
  );
}

function unresolvedOperatorType(
  in modules: Array<ResolvedModule>, moduleIndex: usize, in name: String
): boolean {
  if (!isUnresolvedExternalType(modules, moduleIndex, name)) return false;
  const nullable = nullableTargetType(name);
  const target = nullable.byteLength > 0 ? copy nullable : copy name;
  // A header namespace has no Z targetModule even when Clang metadata is
  // present. Known object references must use the checked identity rules;
  // preserve existing deferral for the other foreign operator tiers.
  return match (typeSymbolLocation(modules, moduleIndex, target)) {
    some(location) => match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
      some(signature) => signature.foreignKind != "objcInterface"
        && signature.foreignKind != "objcSubclass" && signature.foreignKind != "objcProtocol";
      none => true;
    }
    none => true;
  };
}

function isKnownEnumType(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  return match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => modules[location.moduleIndex]
      .symbols[location.symbolIndex]
      .kind == ModuleSymbolKind.enumSymbol;
    none => false;
  };
}

function flagEnumUnderlyingType(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): String {
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      match (
        in modules[location.moduleIndex]
          .symbols[location.symbolIndex]
          .typeSignature
      ) {
        some(signature) => {
          if (
            signature.foreignKind == "enum"
            && signature.foreignFlags
            && isIntegerTypeName(signature.foreignUnderlyingType)
          ) return signature.foreignUnderlyingType.copyBytes(
            0,
            signature.foreignUnderlyingType.byteLength
          );
          return "";
        }
        none => return "";
      }
    }
    none => return "";
  }
}

function identityClassReference(
  in modules: Array<ResolvedModule>, moduleIndex: usize, in source: String
): boolean {
  if (!typeIsNativeObjCReference(modules, moduleIndex, source)) return false;
  const target = nullableTargetType(source);
  const actual = target.byteLength > 0 ? copy target : copy source;
  match (inferredTypeSymbolLocation(modules, moduleIndex, actual)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          // Protocol existentials have separate conformance/erasure rules;
          // this tier agrees with Stage 0's class-reference boundary.
          if (signature.foreignKind == "objcProtocol") return false;
        }
        none => {}
      }
    }
    none => {}
  }
  return true;
}

function referenceIdentityComparable(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in left: String,
  in right: String
): boolean {
  const leftNative = identityClassReference(modules, moduleIndex, left);
  const rightNative = identityClassReference(modules, moduleIndex, right);
  if (leftNative || rightNative) {
    if (!leftNative || !rightNative) return false;
    let leftObject = copy left;
    let rightObject = copy right;
    const leftTarget = nullableTargetType(left);
    const rightTarget = nullableTargetType(right);
    if (leftTarget.byteLength > 0) leftObject = copy leftTarget;
    if (rightTarget.byteLength > 0) rightObject = copy rightTarget;
    return equivalentTypes(modules, moduleIndex, leftObject, rightObject)
      || nativeObjectiveCReferenceAssignable(modules, moduleIndex, leftObject, rightObject)
      || nativeObjectiveCReferenceAssignable(modules, moduleIndex, rightObject, leftObject);
  }
  if (!equivalentTypes(modules, moduleIndex, left, right)) return false;
  return match (inferredTypeSymbolLocation(modules, moduleIndex, left)) {
    some(location) => modules[location.moduleIndex].symbols[location.symbolIndex].kind == ModuleSymbolKind.classSymbol;
    none => false;
  };
}

export function unaryOperatorType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in operator: String,
  in operand: String,
  genericOwnedParameter: boolean
): String throws ModuleResolveError {
  if (operand.byteLength == 0) return "";
  if (operator == "view") {
    if (stringStartsWith(operand, "view ")) {
      throw invalidOperator(
        module,
        tree,
        index,
        "nested view values are not valid"
      );
    }
    return `view ${operand}`;
  }
  if (operator == "copy") {
    let copiedType = operand.copyBytes(0, operand.byteLength);
    if (stringStartsWith(copiedType, "view ")) {
      copiedType = copiedType.copyBytes(5, copiedType.byteLength);
    }
    let visiting = Array<String>();
    if (!typeSupportsExplicitCopy(modules, moduleIndex, copiedType, visiting)) {
      throw invalidOperator(
        module,
        tree,
        index,
        `type ${copiedType} cannot be explicitly copied`
      );
    }
    return copiedType;
  }
  if (operator == "move") {
    if (stringStartsWith(operand, "view ")) {
      throw invalidOperator(
        module,
        tree,
        index,
        "cannot move a view because it does not own the referenced value"
      );
    }
    let visiting = Array<String>();
    if (
      typeIsNativeObjCReference(modules, moduleIndex, operand)
      || (!genericOwnedParameter
        && !typeHasCleanup(modules, moduleIndex, operand, visiting)
        && !isUnresolvedExternalType(modules, moduleIndex, operand))
    ) {
      throw invalidOperator(
        module,
        tree,
        index,
        `type ${operand} has no unique ownership to move`
      );
    }
    return operand.copyBytes(0, operand.byteLength);
  }
  if (operator == "!" && operand == "boolean") return "boolean";
  if (
    (operator == "+" || operator == "-")
    && isNumericTypeName(operand)
  ) return operand.copyBytes(0, operand.byteLength);
  if (operator == "~") {
    const flagUnderlying = flagEnumUnderlyingType(
      modules,
      moduleIndex,
      operand
    );
    if (
      isIntegerTypeName(operand)
      || flagUnderlying.byteLength > 0
    ) return operand.copyBytes(0, operand.byteLength);
  }
  const requirement = operator == "!"
    ? "a boolean operand"
    : operator == "~" ? "an integer operand" : "a numeric operand";
  throw invalidOperator(
    module,
    tree,
    index,
    `operator ${operator} requires ${requirement}`
  );
}

export function binaryOperatorType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in operator: String,
  in leftSource: String,
  in rightSource: String
): String throws ModuleResolveError {
  // Aliases do not create new arithmetic or comparison types. Preserve
  // nominal enums/native identities while expanding transparent Z aliases.
  const left = transparentTypeName(modules, moduleIndex, leftSource);
  const right = transparentTypeName(modules, moduleIndex, rightSource);
  if (left.byteLength == 0 || right.byteLength == 0) return "";
  if (
    operator == "&"
    || operator == "|"
    || operator == "^"
    || operator == "<<"
    || operator == ">>"
  ) {
    const leftFlag = flagEnumUnderlyingType(modules, moduleIndex, left);
    const rightFlag = flagEnumUnderlyingType(modules, moduleIndex, right);
    if (
      leftFlag.byteLength > 0
      && rightFlag == leftFlag
      && equivalentTypes(modules, moduleIndex, left, right)
    ) return left.copyBytes(0, left.byteLength);
  }
  if (
    unresolvedOperatorType(modules, moduleIndex, left)
    || unresolvedOperatorType(modules, moduleIndex, right)
  ) return "";
  if (operator == "&&" || operator == "||") {
    if (left == "boolean" && right == "boolean") return "boolean";
    throw invalidOperator(
      module,
      tree,
      index,
      `operator ${operator} requires boolean operands`
    );
  }
  if (
    operator == "+"
    || operator == "-"
    || operator == "*"
    || operator == "/"
    || operator == "%"
  ) {
    if (left == right && isNumericTypeName(left)) {
      return left.copyBytes(0, left.byteLength);
    }
    throw invalidOperator(
      module,
      tree,
      index,
      `operator ${operator} requires matching numeric operands`
    );
  }
  if (
    operator == "&"
    || operator == "|"
    || operator == "^"
    || operator == "<<"
    || operator == ">>"
  ) {
    if (left == right && isIntegerTypeName(left)) {
      return left.copyBytes(0, left.byteLength);
    }
    throw invalidOperator(
      module,
      tree,
      index,
      `operator ${operator} requires matching integer operands`
    );
  }
  if (
    operator == "<"
    || operator == "<="
    || operator == ">"
    || operator == ">="
  ) {
    if (left == right && isNumericTypeName(left)) return "boolean";
    throw invalidOperator(
      module,
      tree,
      index,
      `operator ${operator} requires matching numeric operands`
    );
  }
  if (operator == "==" || operator == "!=") {
    if (referenceIdentityComparable(modules, moduleIndex, left, right)) return "boolean";
    const leftString = left == "String" || left == "view String";
    const rightString = right == "String" || right == "view String";
    if (leftString && rightString) {
      return "boolean";
    }
    if (
      equivalentTypes(modules, moduleIndex, left, right)
      && (
        isNumericTypeName(left)
        || left == "boolean"
        || left == "String"
        || isKnownEnumType(modules, moduleIndex, left)
      )
    ) return "boolean";
    if (
      (left == "null" && isNullableTypeName(right))
      || (right == "null" && isNullableTypeName(left))
    ) return "boolean";
    throw invalidOperator(
      module,
      tree,
      index,
      `operator ${operator} requires matching comparable operands`
    );
  }
  return "";
}
