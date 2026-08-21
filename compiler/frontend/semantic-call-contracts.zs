import { stringStartsWith } from "./semantic-type-shapes.zs";
import {
  ModuleResolveError,
  ModuleResolveErrorKind,
  moduleResolutionError,
} from "./semantic-model.zs";
import { ParsedModule } from "./module-symbols.zs";
import {
  ExpressionKind,
  ExpressionTree,
} from "./parser.zs";

export struct NativeCallAccess {
  root: String;
  aliasIdentity: usize;
  capability: String;
}

export struct NativeThrowingCallShape {
  successType: String;
  errorType: String;
}

export struct NativeAsyncCallShape {
  successType: String;
  errorType: String;
}

function callCapabilitiesConflict(in left: String, in right: String): boolean {
  return !(
    (left == "in" && right == "in")
    || (left == "value" && right == "value")
  );
}

export function registerCallAccess(
  in module: ParsedModule,
  in tree: ExpressionTree,
  nodeIndex: usize,
  inout accesses: Array<NativeCallAccess>,
  in root: String,
  aliasIdentity: usize,
  in capability: String
): void throws ModuleResolveError {
  if (root.byteLength == 0) return;
  for (const access of accesses) {
    if (
      (
        access.root == root
        || (
          access.aliasIdentity > 0
          && access.aliasIdentity == aliasIdentity
        )
      )
      && callCapabilitiesConflict(access.capability, capability)
    ) {
      const message = access.root == root
        ? `overlapping ${access.capability} and ${capability} uses of "${root}" in one call are not allowed`
        : `overlapping ${access.capability} and ${capability} uses of ARC aliases "${access.root}" and "${root}" in one call are not allowed`;
      throw moduleResolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        message,
        tree.nodes[nodeIndex].line,
        tree.nodes[nodeIndex].column
      );
    }
  }
  accesses.push(NativeCallAccess({
    root: root.copyBytes(0, root.byteLength),
    aliasIdentity,
    capability: capability.copyBytes(0, capability.byteLength),
  }));
}

export function pendingThrowingCallType(
  in successType: String,
  in errorType: String
): String {
  return `__z_native_throwing_call:${successType}\t${errorType}`;
}

export function pendingThrowingCallShape(
  in typeName: String
): Option<NativeThrowingCallShape> {
  const prefix = "__z_native_throwing_call:";
  if (!stringStartsWith(typeName, prefix)) {
    return Option<NativeThrowingCallShape>.none;
  }
  let separator = prefix.byteLength;
  while (separator < typeName.byteLength && typeName.byteAt(separator) != 9) {
    separator = separator + 1;
  }
  if (separator == typeName.byteLength) {
    return Option<NativeThrowingCallShape>.none;
  }
  return Option.some(NativeThrowingCallShape({
    successType: typeName.copyBytes(prefix.byteLength, separator),
    errorType: typeName.copyBytes(separator + 1, typeName.byteLength),
  }));
}

export function pendingAsyncCallType(
  in successType: String,
  in errorType: String
): String {
  return `__z_native_async_call:${successType}\t${errorType}`;
}

export function pendingAsyncCallShape(
  in typeName: String
): Option<NativeAsyncCallShape> {
  const prefix = "__z_native_async_call:";
  if (!stringStartsWith(typeName, prefix)) {
    return Option<NativeAsyncCallShape>.none;
  }
  let separator = prefix.byteLength;
  while (separator < typeName.byteLength && typeName.byteAt(separator) != 9) {
    separator = separator + 1;
  }
  if (separator == typeName.byteLength) {
    return Option<NativeAsyncCallShape>.none;
  }
  return Option.some(NativeAsyncCallShape({
    successType: typeName.copyBytes(prefix.byteLength, separator),
    errorType: typeName.copyBytes(separator + 1, typeName.byteLength),
  }));
}

function unhandledThrowingCallError(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize
): ModuleResolveError {
  let message = "throwing call requires `attempt` or `try`";
  if (tree.nodes[index].kind == ExpressionKind.newExpression) {
    message = "throwing constructor requires `attempt` or `try`";
  }
  return moduleResolutionError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    message,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
}

export function requireSettledExpressionType(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in typeName: String
): void throws ModuleResolveError {
  match (pendingAsyncCallShape(typeName)) {
    some(shape) => throw moduleResolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "async call requires `await` or `task`",
      tree.nodes[index].line,
      tree.nodes[index].column
    );
    none => {}
  }
  match (pendingThrowingCallShape(typeName)) {
    some(shape) => throw unhandledThrowingCallError(module, tree, index);
    none => {}
  }
}
