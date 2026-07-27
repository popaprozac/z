import {
  equivalentTypes,
  typeSymbolLocation,
} from "./semantic-type-identities.zs";
import {
  isIntegerTypeName,
  isNullableTypeName,
  isNumericTypeName,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import {
  typeHasCleanup,
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
  return moduleResolutionError(
    ModuleResolveErrorKind.invalidOperator,
    module.path,
    message,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
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

export function unaryOperatorType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in operator: String,
  in operand: String
): String throws ModuleResolveError {
  if (operand.byteLength == 0) return "";
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
    if (!typeHasCleanup(modules, moduleIndex, operand, visiting)) {
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
  if (operator == "~" && isIntegerTypeName(operand)) {
    return operand.copyBytes(0, operand.byteLength);
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
  in left: String,
  in right: String
): String throws ModuleResolveError {
  if (left.byteLength == 0 || right.byteLength == 0) return "";
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
