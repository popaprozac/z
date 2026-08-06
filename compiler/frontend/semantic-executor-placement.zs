import {
  NativeInitializationState,
  NativeOwnershipState,
  NativeValueBinding,
  addBorrowedValueBinding,
  borrowValueBindingInPlace,
  setValueBindingOwnership,
  valueBindingInitialization,
  valueBindingIsMutable,
  valueBindingOwnership,
  valueBindingType,
} from "./semantic-flow-state.zs";
import {
  ModuleSymbolKind,
  ModuleResolveError,
  ModuleResolveErrorKind,
  ResolvedModule,
  moduleResolutionError,
} from "./semantic-model.zs";
import {
  transparentTypeName,
  typeSymbolLocation,
} from "./semantic-type-identities.zs";
import { ParsedModule } from "./module-symbols.zs";
import {
  ExpressionKind,
  ExpressionTree,
} from "./parser.zs";

export function taskEffectType(
  in successType: String,
  in errorType: String
): String {
  if (errorType.byteLength > 0) return `Task<${successType}, ${errorType}>`;
  return `Task<${successType}>`;
}

export function prepareExecutorCaptureBindings(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  in children: Array<usize>,
  in bindings: Array<NativeValueBinding>,
  inout blockBindings: Array<NativeValueBinding>,
  inout movedNames: Array<String>
): boolean throws ModuleResolveError {
  let captureIndex: usize = 2;
  while (captureIndex < children.length) {
    const capture = children[captureIndex];
    if (tree.nodes[capture].kind != ExpressionKind.executorCaptureExpression) {
      captureIndex = captureIndex + 1;
      continue;
    }
    const name = tree.nodes[capture].labels[0].copyBytes(
      0,
      tree.nodes[capture].labels[0].byteLength
    );
    const typeName = valueBindingType(bindings, name);
    // Foreign/thread-spawn results may be valid Stage-0 bindings while absent
    // from the native source graph. Defer the placement instead of inventing
    // an unknown-capture diagnostic without its upstream type fact.
    if (typeName.byteLength == 0) return false;
    if (
      valueBindingInitialization(bindings, name)
      != NativeInitializationState.initialized
    ) {
      throw moduleResolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `cannot capture uninitialized value "${name}"`,
        tree.nodes[capture].line,
        tree.nodes[capture].column
      );
    }
    if (
      valueBindingOwnership(bindings, name)
      != NativeOwnershipState.available
    ) {
      throw moduleResolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `cannot capture unavailable value "${name}"`,
        tree.nodes[capture].line,
        tree.nodes[capture].column
      );
    }
    const capability = tree.nodes[capture].value.copyBytes(
      0,
      tree.nodes[capture].value.byteLength
    );
    if (capability == "in") {
      borrowValueBindingInPlace(inout blockBindings, name);
    } else if (capability == "inout") {
      const expandedType = transparentTypeName(
        modules,
        moduleIndex,
        typeName
      );
      let mutatesThroughIdentity = false;
      match (typeSymbolLocation(modules, moduleIndex, expandedType)) {
        some(location) => {
          mutatesThroughIdentity = modules[location.moduleIndex].symbols[
            location.symbolIndex
          ].kind == ModuleSymbolKind.classSymbol;
        }
        none => {}
      }
      if (
        !valueBindingIsMutable(bindings, name)
        && !mutatesThroughIdentity
      ) {
        throw moduleResolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `inout executor capture "${name}" requires a mutable let binding`,
          tree.nodes[capture].line,
          tree.nodes[capture].column
        );
      }
      addBorrowedValueBinding(
        inout blockBindings,
        name,
        typeName,
        true
      );
    } else if (capability == "move") {
      movedNames.push(name.copyBytes(0, name.byteLength));
    }
    captureIndex = captureIndex + 1;
  }
  return true;
}

export function applyExecutorCaptureMoves(
  in movedNames: Array<String>,
  inout bindings: Array<NativeValueBinding>
): void {
  for (const name of movedNames) {
    setValueBindingOwnership(
      inout bindings,
      name,
      NativeOwnershipState.moved
    );
  }
}
