import { requireSettledExpressionType } from "./semantic-call-contracts.zs";
import { expressionStorageRootName } from "./semantic-expression-ownership.zs";
import { equivalentTypes } from "./semantic-type-identities.zs";
import { typeHasCleanup } from "./semantic-type-ownership.zs";
import {
  arrayElementType,
  genericTypeShape,
  isNullableTypeName,
  isNumericTypeName,
  nativeFunctionSignature,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import {
  ModuleResolveError,
  ModuleResolveErrorKind,
  ResolvedModule,
  moduleResolutionError,
} from "./semantic-model.zs";
import { ParsedModule } from "./module-symbols.zs";
import {
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
} from "./parser.zs";

export function isContextualNumericLiteral(
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (tree.nodes[index].kind == ExpressionKind.numberExpression) return true;
  if (
    tree.nodes[index].kind == ExpressionKind.unaryExpression
    && (tree.nodes[index].value == "+" || tree.nodes[index].value == "-")
    && tree.nodes[index].children.length == 1
  ) {
    const child = tree.nodes[index].children[0];
    return tree.nodes[child].kind == ExpressionKind.numberExpression;
  }
  return false;
}

function nativeFunctionSignaturesCompatible(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in expected: String,
  in actual: String
): boolean {
  match (nativeFunctionSignature(expected)) {
    some(expectedSignature) => {
      match (nativeFunctionSignature(actual)) {
        some(actualSignature) => {
          if (
            expectedSignature.parameterTypes.length
              != actualSignature.parameterTypes.length
            || expectedSignature.returnType.byteLength == 0
            || actualSignature.returnType.byteLength == 0
          ) return false;
          let index: usize = 0;
          while (index < expectedSignature.parameterTypes.length) {
            if (
              expectedSignature.parameterModes[index]
                != actualSignature.parameterModes[index]
              || !equivalentTypes(
                modules,
                moduleIndex,
                expectedSignature.parameterTypes[index],
                actualSignature.parameterTypes[index]
              )
            ) return false;
            index = index + 1;
          }
          return equivalentTypes(
            modules,
            moduleIndex,
            expectedSignature.returnType,
            actualSignature.returnType
          );
        }
        none => return false;
      }
    }
    none => return false;
  }
}

function compatibleSliceTypes(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in expected: String,
  in actual: String
): boolean {
  const actualElement = arrayElementType(actual);
  return match (genericTypeShape(expected)) {
    some(generic) => generic.base == "Slice"
      && generic.arguments.length == 1
      && equivalentTypes(
        modules,
        moduleIndex,
        actualElement,
        generic.arguments[0]
      );
    none => false;
  };
}

export function requireExpressionType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in expected: String,
  in actual: String
): void throws ModuleResolveError {
  try requireSettledExpressionType(module, tree, index, actual);
  if (
    nativeFunctionSignaturesCompatible(
      modules,
      moduleIndex,
      expected,
      actual
    )
  ) return;
  if (
    actual.byteLength == 0
    || actual == "__z_never"
    || equivalentTypes(modules, moduleIndex, expected, actual)
  ) return;
  if (
    isNumericTypeName(expected)
    && isNumericTypeName(actual)
    && isContextualNumericLiteral(tree, index)
  ) return;
  if (
    expected == "cstring"
    && actual == "String"
    && tree.nodes[index].kind == ExpressionKind.stringExpression
  ) return;
  if (actual == "null" && isNullableTypeName(expected)) return;
  if (compatibleSliceTypes(modules, moduleIndex, expected, actual)) return;
  if (stringStartsWith(expected, "view ")) {
    const target = expected.copyBytes(5, expected.byteLength);
    const kind = tree.nodes[index].kind;
    if (
      equivalentTypes(modules, moduleIndex, target, actual)
      && (
        kind == ExpressionKind.memberExpression
        || kind == ExpressionKind.indexExpression
      )
      && expressionStorageRootName(tree, index) == "this"
    ) return;
  }
  if (stringStartsWith(actual, "view ")) {
    const target = actual.copyBytes(5, actual.byteLength);
    let visiting = Array<String>();
    if (
      equivalentTypes(modules, moduleIndex, expected, target)
      && !typeHasCleanup(modules, moduleIndex, target, visiting)
    ) return;
  }
  throw moduleResolutionError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    `expected ${expected}, found ${actual}`,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
}

export function requireExpressionSyntaxType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in expression: ExpressionSyntax,
  in expected: String,
  in actual: String
): void throws ModuleResolveError {
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      try requireExpressionType(
        module,
        modules,
        moduleIndex,
        tree,
        root,
        expected,
        actual
      );
    }
    none => {}
  }
}
