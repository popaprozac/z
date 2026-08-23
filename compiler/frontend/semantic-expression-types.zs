import { requireSettledExpressionType } from "./semantic-call-contracts.zs";
import { expressionStorageRootName } from "./semantic-expression-ownership.zs";
import {
  equivalentTypes,
  isUnresolvedExternalType,
  rebaseTypeName,
  typeSymbolLocation,
  transparentTypeName,
} from "./semantic-type-identities.zs";
import {
  typeHasCleanup,
  typeIsBorrowedForeignResource,
} from "./semantic-type-ownership.zs";
import {
  arrayElementType,
  genericTypeShape,
  isNullableTypeName,
  isNumericTypeName,
  nativeFunctionSignature,
  nullableTargetType,
  qualifiedTypeMember,
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

function isVerifiedForeignNominalType(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      match (
        in modules[location.moduleIndex].symbols[
          location.symbolIndex
        ].typeSignature
      ) {
        some(signature) => return signature.foreignNativeName.byteLength > 0;
        none => {}
      }
    }
    none => {}
  }
  return false;
}

function nativeFunctionSignaturesCompatible(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in expected: String,
  in actual: String
): boolean {
  const expandedExpected = transparentTypeName(modules, moduleIndex, expected);
  const expandedActual = transparentTypeName(modules, moduleIndex, actual);
  match (nativeFunctionSignature(expandedExpected)) {
    some(expectedSignature) => {
      match (nativeFunctionSignature(expandedActual)) {
        some(actualSignature) => {
          if (
            expectedSignature.parameterTypes.length
              != actualSignature.parameterTypes.length
            || expectedSignature.returnType.byteLength == 0
            || actualSignature.returnType.byteLength == 0
            || (
              expectedSignature.errorType.byteLength == 0
              && actualSignature.errorType.byteLength > 0
            )
            || (
              expectedSignature.errorType.byteLength > 0
              && actualSignature.errorType.byteLength == 0
            )
            || (
              expectedSignature.threadContract == "thread.any"
              && actualSignature.threadContract != "thread.any"
            )
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
          if (!equivalentTypes(
            modules,
            moduleIndex,
            expectedSignature.returnType,
            actualSignature.returnType
          )) return false;
          if (expectedSignature.errorType.byteLength == 0) return true;
          return equivalentTypes(
            modules,
            moduleIndex,
            expectedSignature.errorType,
            actualSignature.errorType
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

function isNativeObjectiveCStringType(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      const symbol = view modules[location.moduleIndex]
        .symbols[location.symbolIndex];
      match (in symbol.typeSignature) {
        some(signature) => return signature.foreignKind == "objcInterface"
          && signature.foreignNativeName == "NSString";
        none => return false;
      }
    }
    // Foreign namespace members are not always materialized as ordinary graph
    // symbols. Preserve their imported native spelling without treating a
    // local nominal NSString declaration as Foundation's NSString.
    none => return qualifiedTypeMember(typeName) == "NSString";
  }
}

function nativeObjectiveCReferenceAssignable(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in expectedType: String,
  in actualType: String
): boolean {
  const expectedNullable = isNullableTypeName(expectedType);
  const actualNullable = isNullableTypeName(actualType);
  if (actualNullable && !expectedNullable) return false;
  let expected = expectedType.copyBytes(0, expectedType.byteLength);
  let actual = actualType.copyBytes(0, actualType.byteLength);
  const expectedTarget = nullableTargetType(expectedType);
  if (expectedTarget.byteLength > 0) expected = move expectedTarget;
  const actualTarget = nullableTargetType(actualType);
  if (actualTarget.byteLength > 0) actual = move actualTarget;

  match (typeSymbolLocation(modules, moduleIndex, expected)) {
    some(location) => match (
      in modules[location.moduleIndex].symbols[
        location.symbolIndex
      ].typeSignature
    ) {
      some(signature) => {
        if (signature.foreignKind != "objcInterface") return false;
      }
      none => return false;
    }
    none => return false;
  }

  let current = actual.copyBytes(0, actual.byteLength);
  let visiting = Array<String>();
  while (current.byteLength > 0) {
    if (equivalentTypes(modules, moduleIndex, expected, current)) return true;
    match (typeSymbolLocation(modules, moduleIndex, current)) {
      some(location) => {
        const identity = `${location.moduleIndex}:${location.symbolIndex}`;
        for (const visited of visiting) {
          if (visited == identity) return false;
        }
        visiting.push(identity);
        match (
          in modules[location.moduleIndex].symbols[
            location.symbolIndex
          ].typeSignature
        ) {
          some(signature) => {
            if (
              signature.foreignKind != "objcInterface"
              || signature.foreignObjCSuperName.byteLength == 0
            ) return false;
            current = rebaseTypeName(
              modules,
              location.moduleIndex,
              moduleIndex,
              signature.foreignObjCSuperName
            );
          }
          none => return false;
        }
      }
      none => return false;
    }
  }
  return false;
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
  if (nativeObjectiveCReferenceAssignable(
    modules,
    moduleIndex,
    expected,
    actual
  )) return;
  if (
    expected == "String"
    && isNativeObjectiveCStringType(modules, moduleIndex, actual)
  ) return;
  if (
    actual == "String"
    && isNativeObjectiveCStringType(modules, moduleIndex, expected)
  ) return;
  if (
    isNumericTypeName(expected)
    && isNumericTypeName(actual)
    && isContextualNumericLiteral(tree, index)
  ) return;
  if (
    isUnresolvedExternalType(modules, moduleIndex, expected)
    && !isVerifiedForeignNominalType(modules, moduleIndex, expected)
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
    if (equivalentTypes(modules, moduleIndex, target, actual)) {
      throw moduleResolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "a view requires proven borrowed storage",
        tree.nodes[index].line,
        tree.nodes[index].column
      );
    }
  }
  if (stringStartsWith(actual, "view ")) {
    const target = actual.copyBytes(5, actual.byteLength);
    if (
      typeIsBorrowedForeignResource(modules, moduleIndex, actual)
      && equivalentTypes(modules, moduleIndex, expected, target)
    ) {
      throw moduleResolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "a borrowed native resource cannot escape into owned storage or an owned value result",
        tree.nodes[index].line,
        tree.nodes[index].column
      );
    }
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
