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
  path: String;
  aliasIdentity: usize;
  aliasUnknown: boolean;
  capability: String;
}

function callAccessPathsOverlap(in left: String, in right: String): boolean {
  if (left == right) return true;
  const rightPrefix = `${right}.`;
  const leftPrefix = `${left}.`;
  return stringStartsWith(left, rightPrefix)
    || stringStartsWith(right, leftPrefix);
}

function callAccessRelativeStart(in root: String, in path: String): usize {
  if (path == root) return path.byteLength;
  if (
    path.byteLength > root.byteLength
    && stringStartsWith(path, root)
    && path.byteAt(root.byteLength) == 46
  ) return root.byteLength + 1;
  return 0;
}

function callAccessRelativeContains(
  in parent: String,
  parentStart: usize,
  in child: String,
  childStart: usize
): boolean {
  const parentLength = parent.byteLength - parentStart;
  const childLength = child.byteLength - childStart;
  if (parentLength >= childLength) return false;
  let index: usize = 0;
  while (index < parentLength) {
    if (parent.byteAt(parentStart + index) != child.byteAt(childStart + index)) {
      return false;
    }
    index = index + 1;
  }
  return child.byteAt(childStart + parentLength) == 46;
}

function callAccessAliasPathsOverlap(
  in leftRoot: String,
  in left: String,
  in rightRoot: String,
  in right: String
): boolean {
  const leftStart = callAccessRelativeStart(leftRoot, left);
  const rightStart = callAccessRelativeStart(rightRoot, right);
  const leftLength = left.byteLength - leftStart;
  const rightLength = right.byteLength - rightStart;
  if (leftLength == 0 || rightLength == 0) return true;
  if (leftLength == rightLength) {
    let index: usize = 0;
    while (index < leftLength) {
      if (left.byteAt(leftStart + index) != right.byteAt(rightStart + index)) {
        return false;
      }
      index = index + 1;
    }
    return true;
  }
  return callAccessRelativeContains(left, leftStart, right, rightStart)
    || callAccessRelativeContains(right, rightStart, left, leftStart);
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
  in path: String,
  aliasIdentity: usize,
  aliasUnknown: boolean,
  in capability: String
): void throws ModuleResolveError {
  if (root.byteLength == 0) return;
  for (const access of accesses) {
    if (
      (
        (
          access.root == root
          && callAccessPathsOverlap(access.path, path)
        )
        || (
          (
            (
              access.aliasIdentity > 0
              && access.aliasIdentity == aliasIdentity
            )
            || (
              access.aliasUnknown
              && (aliasIdentity > 0 || aliasUnknown)
            )
            || (
              aliasUnknown
              && (access.aliasIdentity > 0 || access.aliasUnknown)
            )
          )
          && callAccessAliasPathsOverlap(
            access.root,
            access.path,
            root,
            path
          )
        )
      )
      && callCapabilitiesConflict(access.capability, capability)
    ) {
      const message = access.root == root
        ? access.path == path
          ? `overlapping ${access.capability} and ${capability} uses of "${path}" in one call are not allowed`
          : `overlapping ${access.capability} and ${capability} uses of "${access.path}" and "${path}" in one call are not allowed`
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
    path: path.copyBytes(0, path.byteLength),
    aliasIdentity,
    aliasUnknown,
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
