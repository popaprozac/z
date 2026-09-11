import {
  NativeInitializationState,
  NativeOwnershipState,
  NativeValueBinding,
  arenaBundleMoveIsAllowed,
  expressionCopiesObjectiveCString,
  liveViewBindingForOwner,
  setValueBindingOwnership,
  valueBindingType,
  valueBindingInitialization,
  valueBindingIsBorrowed,
  valueBindingIsMatchBorrowed,
  valueBindingOwnership,
} from "./semantic-flow-state.zs";
import {
  isKnownMatchVariant,
  typeExpressionName,
} from "./semantic-member-lookups.zs";
import { typeMovesOnOwnedUse } from "./semantic-type-ownership.zs";
import { typeSymbolLocation, transparentTypeName } from "./semantic-type-identities.zs";
import { nativeFunctionSignature, stringStartsWith } from "./semantic-type-shapes.zs";
import {
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSymbolKind,
  ResolvedModule,
  codedModuleResolutionError,
  moduleResolutionError,
} from "./semantic-model.zs";
import { ParsedModule } from "./module-symbols.zs";
import {
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
} from "./parser.zs";

export function identifierLookupName(in name: String): String {
  let index: usize = 0;
  while (index < name.byteLength) {
    if (name.byteAt(index) == 60) return name.copyBytes(0, index);
    index = index + 1;
  }
  return name.copyBytes(0, name.byteLength);
}

export function requireInitializedBinding(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in bindings: Array<NativeValueBinding>,
  in name: String
): void throws ModuleResolveError {
  const initialization = valueBindingInitialization(bindings, name);
  if (initialization != NativeInitializationState.initialized) {
    const message = initialization == NativeInitializationState.uninitialized
      ? `use of uninitialized value "${name}"`
      : `value "${name}" may be uninitialized on another control-flow path`;
    throw moduleResolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      message,
      tree.nodes[index].line,
      tree.nodes[index].column
    );
  }
  const ownership = valueBindingOwnership(bindings, name);
  if (ownership == NativeOwnershipState.available) return;
  const message = ownership == NativeOwnershipState.moved
    ? `use of moved value "${name}"`
    : `value "${name}" may have moved on another control-flow path`;
  throw moduleResolutionError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    message,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
}

export function requireInitializedOutputParameters(
  in module: ParsedModule,
  line: usize,
  column: usize,
  in bindings: Array<NativeValueBinding>
): void throws ModuleResolveError {
  for (const binding of bindings) {
    if (
      binding.outputParameter
      && binding.initialization != NativeInitializationState.initialized
    ) {
      throw moduleResolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `out parameter "${binding.name}" may be uninitialized on a successful return path`,
        line,
        column
      );
    }
  }
}

export function expressionStorageRootName(
  in tree: ExpressionTree,
  index: usize
): String {
  const kind = tree.nodes[index].kind;
  if (
    kind == ExpressionKind.identifierExpression
    || kind == ExpressionKind.argumentBindingExpression
  ) return identifierLookupName(tree.nodes[index].value);
  if (
    kind == ExpressionKind.argumentReferenceExpression
    || kind == ExpressionKind.memberExpression
    || kind == ExpressionKind.indexExpression
  ) {
    if (tree.nodes[index].children.length > 0) {
      const child = tree.nodes[index].children[0];
      return expressionStorageRootName(tree, child);
    }
  }
  return "";
}

export function requireOwnedClosureEnvironment(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  // This qualifier is inferred, never declared through a source type alias.
  // Avoid resolving ordinary value types on this hot ownership path.
  if (!stringStartsWith(typeName, "__z_native_function:borrowed ")) return;
  const expanded = transparentTypeName(modules, moduleIndex, typeName);
  match (nativeFunctionSignature(expanded)) {
    some(signature) => {
      if (signature.borrowedEnvironment) throw codedModuleResolutionError(
        ModuleResolveErrorKind.typeMismatch,
        "Z0212",
        module.path,
        "a borrowed capturing closure cannot become a function value; use move to own its environment",
        line,
        column,
        1
      );
    }
    none => {}
  }
}

export function consumeOwnedExpressionNode(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in typeName: String,
  force: boolean,
  inout bindings: Array<NativeValueBinding>
): void throws ModuleResolveError {
  try requireOwnedClosureEnvironment(
    module, modules, moduleIndex, typeName,
    tree.nodes[index].line, tree.nodes[index].column
  );
  // Contextual NSString <-> String conversion creates fresh owned storage.
  // The source reference/string is observed, not moved out of its owner.
  if (expressionCopiesObjectiveCString(bindings, tree.nodes[index].offset)) return;
  if (!force && !typeMovesOnOwnedUse(modules, moduleIndex, typeName)) return;
  const kind = tree.nodes[index].kind;
  if (
    kind == ExpressionKind.memberExpression
    && tree.nodes[index].children.length == 1
  ) {
    const receiverIndex = tree.nodes[index].children[0];
    const enumType = typeExpressionName(tree, receiverIndex);
    const variantName = identifierLookupName(tree.nodes[index].value);
    if (
      isKnownMatchVariant(modules, moduleIndex, enumType, variantName)
      || isKnownMatchVariant(modules, moduleIndex, typeName, variantName)
    ) return;
  }
  let consumesWholeReceiver = false;
  if (
    kind == ExpressionKind.memberExpression
    && tree.nodes[index].children.length == 1
  ) {
    const receiverIndex = tree.nodes[index].children[0];
    if (
      tree.nodes[receiverIndex].kind == ExpressionKind.identifierExpression
      && identifierLookupName(tree.nodes[receiverIndex].value) == "this"
      && !valueBindingIsBorrowed(bindings, "this")
    ) {
      const receiverType = valueBindingType(bindings, "this");
      match (typeSymbolLocation(modules, moduleIndex, receiverType)) {
        some(location) => {
          const symbol = view modules[location.moduleIndex].symbols[
            location.symbolIndex
          ];
          if (symbol.kind == ModuleSymbolKind.structSymbol) {
            match (in symbol.typeSignature) {
              some(signature) => {
                if (!signature.customDeinit) {
                  let foundField = false;
                  let otherOwnedField = false;
                  for (const field of signature.fields) {
                    if (field.name == tree.nodes[index].value) {
                      foundField = typeMovesOnOwnedUse(
                        modules,
                        location.moduleIndex,
                        field.typeName
                      );
                    } else if (typeMovesOnOwnedUse(
                      modules,
                      location.moduleIndex,
                      field.typeName
                    )) {
                      otherOwnedField = true;
                    }
                  }
                  consumesWholeReceiver = foundField && !otherOwnedField;
                }
              }
              none => {}
            }
          }
        }
        none => {}
      }
    }
  }
  if (
    (kind == ExpressionKind.memberExpression && !consumesWholeReceiver)
    || kind == ExpressionKind.indexExpression
  ) {
    throw moduleResolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "cannot move an ownership-bearing field or element out of its owner",
      tree.nodes[index].line,
      tree.nodes[index].column
    );
  }
  const root = expressionStorageRootName(tree, index);
  if (root.byteLength == 0) return;
  const liveView = liveViewBindingForOwner(bindings, root);
  if (
    liveView.byteLength > 0
    && !arenaBundleMoveIsAllowed(bindings, tree.nodes[index].offset)
  ) {
    throw moduleResolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      `cannot move "${root}" while view "${liveView}" is live`,
      tree.nodes[index].line,
      tree.nodes[index].column
    );
  }
  if (
    valueBindingIsBorrowed(bindings, root)
    && !arenaBundleMoveIsAllowed(bindings, tree.nodes[index].offset)
  ) {
    const message = valueBindingIsMatchBorrowed(bindings, root)
      ? `cannot move borrowed match binding "${root}"`
      : `cannot move borrowed parameter "${root}"`;
    throw moduleResolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      message,
      tree.nodes[index].line,
      tree.nodes[index].column
    );
  }
  setValueBindingOwnership(inout bindings, root, NativeOwnershipState.moved);
}

export function consumeOwnedExpressionSyntax(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in expression: ExpressionSyntax,
  in typeName: String,
  inout bindings: Array<NativeValueBinding>
): void throws ModuleResolveError {
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      try consumeOwnedExpressionNode(
        module,
        modules,
        moduleIndex,
        tree,
        root,
        typeName,
        false,
        inout bindings
      );
    }
    none => {}
  }
}
