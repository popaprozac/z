import { TextBuffer } from "std/text";
import {
  NativeValueBinding,
  valueBindingType,
} from "./semantic-flow-state.zs";
import { identifierLookupName } from "./semantic-expression-ownership.zs";
import {
  equivalentTypes,
  transparentTypeName,
} from "./semantic-type-identities.zs";
import {
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
  ExpressionTree,
  StatementArena,
  StatementKind,
} from "./parser.zs";

export struct NativeClosureSignatureShape {
  asynchronous: boolean;
  parameterNames: Array<String>;
  parameterModes: Array<String>;
  parameterTypes: Array<String>;
  returnType: String;
  errorType: String;
  threadContract: String;
}

function copyBindings(in bindings: Array<String>): Array<String> {
  let copied = Array<String>();
  for (const binding of bindings) {
    copied.push(binding.copyBytes(0, binding.byteLength));
  }
  return copied;
}

function copyIndices(in indices: Array<usize>): Array<usize> {
  let copied = Array<usize>();
  for (const index of indices) {
    copied.push(index);
  }
  return copied;
}

function containsString(in values: Array<String>, in value: String): boolean {
  for (const candidate of values) {
    if (candidate == value) return true;
  }
  return false;
}

function addUniqueString(inout values: Array<String>, in value: String): void {
  if (!containsString(values, value)) {
    values.push(value.copyBytes(0, value.byteLength));
  }
}

function collectMatchBindingNames(
  in tree: ExpressionTree,
  index: usize,
  inout bindings: Array<String>
): void {
  const kind = tree.nodes[index].kind;
  const children = copyIndices(tree.nodes[index].children);
  if (kind == ExpressionKind.matchBindingExpression) {
    bindings.push(tree.nodes[index].value.copyBytes(
      0,
      tree.nodes[index].value.byteLength
    ));
    return;
  }
  for (const child of children) {
    collectMatchBindingNames(tree, child, inout bindings);
  }
}

export function resolveClosureSignature(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in contextualType: String,
  in declaredReturnType: String,
  in errorType: String
): NativeClosureSignatureShape throws ModuleResolveError {
  let contextualParameterModes = Array<String>();
  let contextualParameterTypes = Array<String>();
  let returnType = declaredReturnType.copyBytes(
    0,
    declaredReturnType.byteLength
  );
  let resolvedErrorType = errorType.copyBytes(0, errorType.byteLength);
  let threadContract = "";
  const expandedContextualType = transparentTypeName(
    modules,
    moduleIndex,
    contextualType
  );
  const closureAsynchronous = tree.nodes[index].labels.length > 3
    && tree.nodes[index].labels[3] == "async";
  match (nativeFunctionSignature(expandedContextualType)) {
    some(signature) => {
      if (signature.asynchronous != closureAsynchronous) {
        const expected = signature.asynchronous
          ? "an async callable"
          : "a synchronous callable";
        const actual = closureAsynchronous
          ? "an async closure"
          : "a synchronous closure";
        throw moduleResolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `expected ${expected}, found ${actual}`,
          tree.nodes[index].line,
          tree.nodes[index].column
        );
      }
      threadContract = signature.threadContract.copyBytes(
        0,
        signature.threadContract.byteLength
      );
      let closureParameterCount: usize = 0;
      for (const child of tree.nodes[index].children) {
        if (
          tree.nodes[child].kind
          == ExpressionKind.closureParameterExpression
        ) {
          closureParameterCount = closureParameterCount + 1;
        }
      }
      if (closureParameterCount != signature.parameterTypes.length) {
        throw moduleResolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `expected ${signature.parameterTypes.length} closure parameter(s), found ${closureParameterCount}`,
          tree.nodes[index].line,
          tree.nodes[index].column
        );
      }
      for (const mode of signature.parameterModes) {
        contextualParameterModes.push(mode.copyBytes(0, mode.byteLength));
      }
      for (const parameterType of signature.parameterTypes) {
        contextualParameterTypes.push(parameterType.copyBytes(
          0,
          parameterType.byteLength
        ));
      }
      if (
        returnType.byteLength == 0
        && signature.returnType != "__z_native_infer_return"
      ) {
        returnType = signature.returnType.copyBytes(
          0,
          signature.returnType.byteLength
        );
      } else if (
        signature.returnType != "__z_native_infer_return"
        &&
        !equivalentTypes(
          modules,
          moduleIndex,
          returnType,
          signature.returnType
        )
      ) {
        throw moduleResolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `closure return type expects ${signature.returnType}, found ${returnType}`,
          tree.nodes[index].line,
          tree.nodes[index].column
        );
      }
      if (resolvedErrorType.byteLength == 0) {
        resolvedErrorType = signature.errorType.copyBytes(
          0,
          signature.errorType.byteLength
        );
      } else if (
        signature.errorType.byteLength == 0
        || !equivalentTypes(
          modules,
          moduleIndex,
          resolvedErrorType,
          signature.errorType
        )
      ) {
        const expected = signature.errorType.byteLength == 0
          ? "a nonthrowing closure"
          : `throws ${signature.errorType}`;
        throw moduleResolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `closure error type expects ${expected}, found throws ${resolvedErrorType}`,
          tree.nodes[index].line,
          tree.nodes[index].column
        );
      }
    }
    none => {}
  }
  let parameterNames = Array<String>();
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  let parameterIndex: usize = 0;
  for (const child of tree.nodes[index].children) {
    if (
      tree.nodes[child].kind
      != ExpressionKind.closureParameterExpression
    ) continue;
    const parameterName = tree.nodes[child].value.copyBytes(
      0,
      tree.nodes[child].value.byteLength
    );
    if (containsString(parameterNames, parameterName)) {
      throw moduleResolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `duplicate closure parameter "${parameterName}"`,
        tree.nodes[child].line,
        tree.nodes[child].column
      );
    }
    parameterNames.push(parameterName.copyBytes(0, parameterName.byteLength));
    let mode = tree.nodes[child].labels[0].copyBytes(
      0,
      tree.nodes[child].labels[0].byteLength
    );
    let parameterType = tree.nodes[child].labels[1].copyBytes(
      0,
      tree.nodes[child].labels[1].byteLength
    );
    if (parameterIndex < contextualParameterModes.length) {
      const expectedMode = contextualParameterModes[parameterIndex].copyBytes(
        0,
        contextualParameterModes[parameterIndex].byteLength
      );
      if (mode != expectedMode) {
        let capability = `the "${expectedMode}" capability`;
        if (expectedMode == "value") capability = "no capability";
        throw moduleResolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `closure parameter "${parameterName}" requires ${capability} from its destination function type`,
          tree.nodes[child].line,
          tree.nodes[child].column
        );
      }
      const expectedParameterType = contextualParameterTypes[parameterIndex].copyBytes(
        0,
        contextualParameterTypes[parameterIndex].byteLength
      );
      if (parameterType.byteLength == 0) {
        parameterType = expectedParameterType;
      } else if (
        !equivalentTypes(
          modules,
          moduleIndex,
          parameterType,
          expectedParameterType
        )
      ) {
        throw moduleResolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `closure parameter "${parameterName}" expects ${expectedParameterType}, found ${parameterType}`,
          tree.nodes[child].line,
          tree.nodes[child].column
        );
      }
    }
    if (parameterType.byteLength == 0) {
      throw moduleResolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `cannot infer the type of closure parameter "${parameterName}"`,
        tree.nodes[child].line,
        tree.nodes[child].column
      );
    }
    parameterModes.push(mode);
    parameterTypes.push(parameterType);
    parameterIndex = parameterIndex + 1;
  }
  return NativeClosureSignatureShape({
    asynchronous: closureAsynchronous,
    parameterNames,
    parameterModes,
    parameterTypes,
    returnType,
    errorType: resolvedErrorType,
    threadContract,
  });
}

export function nativeClosureFunctionType(
  in tree: ExpressionTree,
  index: usize,
  in parameterModes: Array<String>,
  in parameterTypes: Array<String>,
  in returnType: String,
  in errorType: String,
  in threadContract: String,
  asynchronous: boolean
): String {
  let output = TextBuffer();
  output.append("__z_native_function:");
  if (asynchronous) output.append("async ");
  output.append("(");
  let first = true;
  let parameterIndex: usize = 0;
  for (const child of tree.nodes[index].children) {
    if (
      tree.nodes[child].kind
      != ExpressionKind.closureParameterExpression
    ) continue;
    if (!first) output.append(", ");
    first = false;
    const mode = parameterModes[parameterIndex].copyBytes(
      0,
      parameterModes[parameterIndex].byteLength
    );
    const typeName = parameterTypes[parameterIndex].copyBytes(
      0,
      parameterTypes[parameterIndex].byteLength
    );
    if (mode != "value") {
      output.append(mode);
      output.append(" ");
    }
    output.append(tree.nodes[child].value);
    output.append(": ");
    output.append(typeName);
    parameterIndex = parameterIndex + 1;
  }
  output.append(") => ");
  output.append(returnType);
  if (errorType.byteLength > 0) {
    output.append(" throws ");
    output.append(errorType);
  }
  if (threadContract.byteLength > 0) {
    output.append(" on ");
    output.append(threadContract);
  }
  return output.finish();
}

export function collectClosureExpressionCaptures(
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize,
  in outerBindings: Array<NativeValueBinding>,
  in localNames: Array<String>,
  inout captures: Array<String>
): void {
  const kind = tree.nodes[index].kind;
  if (kind == ExpressionKind.closureExpression) return;
  if (
    kind == ExpressionKind.identifierExpression
    || kind == ExpressionKind.argumentBindingExpression
  ) {
    const name = identifierLookupName(tree.nodes[index].value);
    const outerType = valueBindingType(outerBindings, name);
    if (
      !containsString(localNames, name)
      && outerType.byteLength > 0
      && !stringStartsWith(name, "__z_native_")
    ) addUniqueString(inout captures, name);
    return;
  }
  const children = copyIndices(tree.nodes[index].children);
  if (kind == ExpressionKind.matchExpression && children.length > 0) {
    collectClosureExpressionCaptures(
      arena,
      tree,
      children[0],
      outerBindings,
      localNames,
      inout captures
    );
    let childIndex: usize = 1;
    while (childIndex < children.length) {
      const arm = children[childIndex];
      let armNames = copyBindings(localNames);
      for (const pattern of tree.nodes[arm].children) {
        collectMatchBindingNames(tree, pattern, inout armNames);
      }
      let armStatements = copyIndices(tree.nodes[arm].statements);
      collectClosureStatementCaptures(
        arena,
        tree,
        armStatements,
        outerBindings,
        inout armNames,
        inout captures
      );
      childIndex = childIndex + 1;
    }
    return;
  }
  for (const child of children) {
    collectClosureExpressionCaptures(
      arena,
      tree,
      child,
      outerBindings,
      localNames,
      inout captures
    );
  }
  let statementNames = copyBindings(localNames);
  const statements = copyIndices(tree.nodes[index].statements);
  collectClosureStatementCaptures(
    arena,
    tree,
    statements,
    outerBindings,
    inout statementNames,
    inout captures
  );
}

export function collectClosureStatementCaptures(
  in arena: StatementArena,
  in tree: ExpressionTree,
  in indices: Array<usize>,
  in outerBindings: Array<NativeValueBinding>,
  inout localNames: Array<String>,
  inout captures: Array<String>
): void {
  for (const statementIndex of indices) {
    match (in arena.nodes[statementIndex].expression) {
      some(expression) => {
        match (in expression.tree) {
          some(expressionTree) => {
            const root = expressionTree.root;
            collectClosureExpressionCaptures(
              arena,
              expressionTree,
              root,
              outerBindings,
              localNames,
              inout captures
            );
          }
          none => {}
        }
      }
      none => {}
    }
    match (in arena.nodes[statementIndex].secondExpression) {
      some(expression) => {
        match (in expression.tree) {
          some(expressionTree) => {
            const root = expressionTree.root;
            collectClosureExpressionCaptures(
              arena,
              expressionTree,
              root,
              outerBindings,
              localNames,
              inout captures
            );
          }
          none => {}
        }
      }
      none => {}
    }
    if (arena.nodes[statementIndex].kind == StatementKind.variableStatement) {
      addUniqueString(inout localNames, arena.nodes[statementIndex].name);
      continue;
    }
    if (arena.nodes[statementIndex].kind == StatementKind.destructureStatement) {
      for (const binding of arena.nodes[statementIndex].objectBindings) {
        addUniqueString(inout localNames, binding.bindingName);
      }
      for (const binding of arena.nodes[statementIndex].arrayBindings) {
        if (binding.bindingName.byteLength > 0) {
          addUniqueString(inout localNames, binding.bindingName);
        }
      }
      continue;
    }
    let nestedNames = copyBindings(localNames);
    if (
      arena.nodes[statementIndex].kind == StatementKind.forStatement
      || arena.nodes[statementIndex].kind == StatementKind.forAwaitStatement
      || arena.nodes[statementIndex].kind == StatementKind.forTryAwaitStatement
    ) {
      if (arena.nodes[statementIndex].name.byteLength > 0) {
        addUniqueString(inout nestedNames, arena.nodes[statementIndex].name);
      }
      for (const binding of arena.nodes[statementIndex].objectBindings) {
        addUniqueString(inout nestedNames, binding.bindingName);
      }
    }
    if (
      arena.nodes[statementIndex].kind == StatementKind.asyncScopeStatement
      && arena.nodes[statementIndex].name.byteLength > 0
    ) {
      addUniqueString(inout nestedNames, arena.nodes[statementIndex].name);
    }
    const children = copyIndices(arena.nodes[statementIndex].children);
    collectClosureStatementCaptures(
      arena,
      tree,
      children,
      outerBindings,
      inout nestedNames,
      inout captures
    );
  }
}
