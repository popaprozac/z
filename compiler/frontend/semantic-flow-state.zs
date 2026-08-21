export enum NativeInitializationState {
  initialized,
  uninitialized,
  maybeUninitialized,
}

export enum NativeOwnershipState {
  available,
  moved,
  maybeMoved,
}

function bindingNameHasPrefix(in name: String, in prefix: String): boolean {
  if (name.byteLength < prefix.byteLength) return false;
  let index: usize = 0;
  while (index < prefix.byteLength) {
    if (name.byteAt(index) != prefix.byteAt(index)) return false;
    index = index + 1;
  }
  return true;
}

function bindingIsClosureCaptureMode(in name: String): boolean {
  return bindingNameHasPrefix(name, "__z_native_closure_capture_mode_");
}

export function ownerlessViewOwner(): String {
  return "__z_native_ownerless_view_owner";
}

export function viewOwnerIsOwnerless(in owner: String): boolean {
  return owner == "__z_native_ownerless_view_owner";
}

export function mergeViewOwners(in left: String, in right: String): String {
  if (left == right) return left.copyBytes(0, left.byteLength);
  if (viewOwnerIsOwnerless(left)) return right.copyBytes(0, right.byteLength);
  if (viewOwnerIsOwnerless(right)) return left.copyBytes(0, left.byteLength);
  return "__z_native_mixed_view_owner";
}

export function appendIndependentViewOwner(
  in existing: String,
  in owner: String
): String {
  if (existing.byteLength == 0) return owner.copyBytes(0, owner.byteLength);
  if (viewOwnerContains(existing, owner)) {
    return existing.copyBytes(0, existing.byteLength);
  }
  return `${existing}\n${owner}`;
}

export function viewOwnerContains(
  in owners: String,
  in owner: String
): boolean {
  let start: usize = 0;
  while (start <= owners.byteLength) {
    let end = start;
    while (end < owners.byteLength && owners.byteAt(end) != 10) {
      end = end + 1;
    }
    if (end - start == owner.byteLength) {
      let matches = true;
      let index: usize = 0;
      while (index < owner.byteLength) {
        if (owners.byteAt(start + index) != owner.byteAt(index)) matches = false;
        index = index + 1;
      }
      if (matches) return true;
    }
    if (end == owners.byteLength) return false;
    start = end + 1;
  }
  return false;
}

export struct NativeValueBinding {
  name: String;
  typeName: String;
  mutableBinding: boolean;
  borrowedBinding: boolean;
  matchBorrowedBinding: boolean;
  classAliasIdentity: usize = 0;
  viewOwner: String = "";
  viewPath: String = "";
  viewLive: boolean = false;
  suspensionBorrowRoot: String;
  initialization: NativeInitializationState;
  ownership: NativeOwnershipState;
  outputParameter: boolean;
}

export function copyValueBindings(
  in bindings: Array<NativeValueBinding>
): Array<NativeValueBinding> {
  let copied = Array<NativeValueBinding>();
  for (const binding of bindings) {
    copied.push(NativeValueBinding({
      name: binding.name.copyBytes(0, binding.name.byteLength),
      typeName: binding.typeName.copyBytes(0, binding.typeName.byteLength),
      mutableBinding: binding.mutableBinding,
      borrowedBinding: binding.borrowedBinding,
      matchBorrowedBinding: binding.matchBorrowedBinding,
      classAliasIdentity: binding.classAliasIdentity,
      viewOwner: binding.viewOwner.copyBytes(0, binding.viewOwner.byteLength),
      viewPath: binding.viewPath.copyBytes(0, binding.viewPath.byteLength),
      viewLive: binding.viewLive,
      suspensionBorrowRoot: binding.suspensionBorrowRoot.copyBytes(
        0,
        binding.suspensionBorrowRoot.byteLength
      ),
      initialization: binding.initialization,
      ownership: binding.ownership,
      outputParameter: binding.outputParameter,
    }));
  }
  return copied;
}

export function addValueBinding(
  inout bindings: Array<NativeValueBinding>,
  in name: String,
  in typeName: String
): void {
  bindings.push(NativeValueBinding({
    name: name.copyBytes(0, name.byteLength),
    typeName: typeName.copyBytes(0, typeName.byteLength),
    mutableBinding: false,
    borrowedBinding: false,
    matchBorrowedBinding: false,
    suspensionBorrowRoot: "",
    initialization: NativeInitializationState.initialized,
    ownership: NativeOwnershipState.available,
    outputParameter: false,
  }));
}

export function addMutableValueBinding(
  inout bindings: Array<NativeValueBinding>,
  in name: String,
  in typeName: String
): void {
  bindings.push(NativeValueBinding({
    name: name.copyBytes(0, name.byteLength),
    typeName: typeName.copyBytes(0, typeName.byteLength),
    mutableBinding: true,
    borrowedBinding: false,
    matchBorrowedBinding: false,
    suspensionBorrowRoot: "",
    initialization: NativeInitializationState.initialized,
    ownership: NativeOwnershipState.available,
    outputParameter: false,
  }));
}

export function addUninitializedMutableValueBinding(
  inout bindings: Array<NativeValueBinding>,
  in name: String,
  in typeName: String,
  outputParameter: boolean
): void {
  bindings.push(NativeValueBinding({
    name: name.copyBytes(0, name.byteLength),
    typeName: typeName.copyBytes(0, typeName.byteLength),
    mutableBinding: true,
    borrowedBinding: outputParameter,
    matchBorrowedBinding: false,
    suspensionBorrowRoot: "",
    initialization: NativeInitializationState.uninitialized,
    ownership: NativeOwnershipState.available,
    outputParameter,
  }));
}

export function addBorrowedValueBinding(
  inout bindings: Array<NativeValueBinding>,
  in name: String,
  in typeName: String,
  mutableBinding: boolean
): void {
  bindings.push(NativeValueBinding({
    name: name.copyBytes(0, name.byteLength),
    typeName: typeName.copyBytes(0, typeName.byteLength),
    mutableBinding,
    borrowedBinding: true,
    matchBorrowedBinding: false,
    suspensionBorrowRoot: "",
    initialization: NativeInitializationState.initialized,
    ownership: NativeOwnershipState.available,
    outputParameter: false,
  }));
}

export function addMatchBorrowedValueBinding(
  inout bindings: Array<NativeValueBinding>,
  in name: String,
  in typeName: String,
  in suspensionBorrowRoot: String
): void {
  bindings.push(NativeValueBinding({
    name: name.copyBytes(0, name.byteLength),
    typeName: typeName.copyBytes(0, typeName.byteLength),
    mutableBinding: false,
    borrowedBinding: true,
    matchBorrowedBinding: true,
    suspensionBorrowRoot: suspensionBorrowRoot.copyBytes(
      0,
      suspensionBorrowRoot.byteLength
    ),
    initialization: NativeInitializationState.initialized,
    ownership: NativeOwnershipState.available,
    outputParameter: false,
  }));
}

export function addViewValueBinding(
  inout bindings: Array<NativeValueBinding>,
  in name: String,
  in typeName: String,
  in owner: String,
  in path: String
): void {
  bindings.push(NativeValueBinding({
    name: name.copyBytes(0, name.byteLength),
    typeName: typeName.copyBytes(0, typeName.byteLength),
    mutableBinding: false,
    borrowedBinding: true,
    matchBorrowedBinding: false,
    viewOwner: owner.copyBytes(0, owner.byteLength),
    viewPath: path.copyBytes(0, path.byteLength),
    viewLive: true,
    suspensionBorrowRoot: "",
    initialization: NativeInitializationState.initialized,
    ownership: NativeOwnershipState.available,
    outputParameter: false,
  }));
}

function expressionViewOriginBindingName(offset: usize): String {
  return `__z_native_view_origin_${offset}`;
}

export function setExpressionViewOrigin(
  inout bindings: Array<NativeValueBinding>,
  offset: usize,
  in owner: String
): void {
  const bindingName = expressionViewOriginBindingName(offset);
  addValueBinding(
    inout bindings,
    bindingName,
    owner
  );
}

export function expressionViewOrigin(
  in bindings: Array<NativeValueBinding>,
  offset: usize
): String {
  const bindingName = expressionViewOriginBindingName(offset);
  return valueBindingType(bindings, bindingName);
}

function arenaBundleMoveBindingName(offset: usize): String {
  return `__z_native_arena_bundle_move_${offset}`;
}

export function allowArenaBundleMove(
  inout bindings: Array<NativeValueBinding>,
  offset: usize
): void {
  const name = arenaBundleMoveBindingName(offset);
  addValueBinding(
    inout bindings,
    name,
    "allowed"
  );
}

export function arenaBundleMoveIsAllowed(
  in bindings: Array<NativeValueBinding>,
  offset: usize
): boolean {
  const name = arenaBundleMoveBindingName(offset);
  return valueBindingType(
    bindings,
    name
  ) == "allowed";
}

export function closeArenaViewBindings(
  inout bindings: Array<NativeValueBinding>,
  in owner: String
): void {
  let index: usize = 0;
  while (index < bindings.length) {
    if (
      bindings[index].viewOwner == owner
      && bindings[index].ownership == NativeOwnershipState.available
    ) {
      bindings[index].viewLive = false;
      bindings[index].ownership = NativeOwnershipState.moved;
    }
    index = index + 1;
  }
}

function storagePathContains(in parent: String, in child: String): boolean {
  if (parent.byteLength >= child.byteLength) return false;
  let index: usize = 0;
  while (index < parent.byteLength) {
    if (parent.byteAt(index) != child.byteAt(index)) return false;
    index = index + 1;
  }
  return child.byteAt(parent.byteLength) == 46;
}

function storagePathsOverlap(in left: String, in right: String): boolean {
  if (left.byteLength == 0 || right.byteLength == 0) return true;
  if (left == right) return true;
  return storagePathContains(left, right)
    || storagePathContains(right, left);
}

export function liveViewBindingForStoragePath(
  in bindings: Array<NativeValueBinding>,
  in owner: String,
  in path: String
): String {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (
      viewOwnerContains(bindings[index].viewOwner, owner)
      && storagePathsOverlap(bindings[index].viewPath, path)
      && bindings[index].viewLive
      && bindings[index].ownership == NativeOwnershipState.available
    ) return bindings[index].name.copyBytes(0, bindings[index].name.byteLength);
  }
  return "";
}

export function liveViewBindingForOwner(
  in bindings: Array<NativeValueBinding>,
  in owner: String
): String {
  return liveViewBindingForStoragePath(bindings, owner, "");
}

export function valueBindingType(
  in bindings: Array<NativeValueBinding>,
  in name: String
): String {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) {
      return bindings[index].typeName.copyBytes(0, bindings[index].typeName.byteLength);
    }
  }
  return "";
}

export function valueBindingClassAlias(
  in bindings: Array<NativeValueBinding>,
  in name: String
): usize {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) {
      return bindings[index].classAliasIdentity;
    }
  }
  return 0;
}

export function setValueBindingClassAlias(
  inout bindings: Array<NativeValueBinding>,
  in name: String,
  identity: usize
): void {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name != name) continue;
    bindings[index] = NativeValueBinding({
      name: bindings[index].name.copyBytes(0, bindings[index].name.byteLength),
      typeName: bindings[index].typeName.copyBytes(0, bindings[index].typeName.byteLength),
      mutableBinding: bindings[index].mutableBinding,
      borrowedBinding: bindings[index].borrowedBinding,
      matchBorrowedBinding: bindings[index].matchBorrowedBinding,
      classAliasIdentity: identity,
      viewOwner: bindings[index].viewOwner.copyBytes(
        0,
        bindings[index].viewOwner.byteLength
      ),
      viewPath: bindings[index].viewPath.copyBytes(
        0,
        bindings[index].viewPath.byteLength
      ),
      viewLive: bindings[index].viewLive,
      suspensionBorrowRoot: bindings[index].suspensionBorrowRoot.copyBytes(
        0,
        bindings[index].suspensionBorrowRoot.byteLength
      ),
      initialization: bindings[index].initialization,
      ownership: bindings[index].ownership,
      outputParameter: bindings[index].outputParameter,
    });
    return;
  }
}

export function valueBindingIsMutable(
  in bindings: Array<NativeValueBinding>,
  in name: String
): boolean {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) return bindings[index].mutableBinding;
  }
  return false;
}

export function valueBindingIsBorrowed(
  in bindings: Array<NativeValueBinding>,
  in name: String
): boolean {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) return bindings[index].borrowedBinding;
  }
  return false;
}

export function valueBindingViewOwner(
  in bindings: Array<NativeValueBinding>,
  in name: String
): String {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) {
      return bindings[index].viewOwner.copyBytes(
        0,
        bindings[index].viewOwner.byteLength
      );
    }
  }
  return "";
}

export function valueBindingViewPath(
  in bindings: Array<NativeValueBinding>,
  in name: String
): String {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) {
      return bindings[index].viewPath.copyBytes(
        0,
        bindings[index].viewPath.byteLength
      );
    }
  }
  return "";
}

export function valueBindingIsMatchBorrowed(
  in bindings: Array<NativeValueBinding>,
  in name: String
): boolean {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) return bindings[index].matchBorrowedBinding;
  }
  return false;
}

export function activeSuspensionBorrowRoot(
  in bindings: Array<NativeValueBinding>
): String {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].suspensionBorrowRoot.byteLength > 0) {
      return bindings[index].suspensionBorrowRoot.copyBytes(
        0,
        bindings[index].suspensionBorrowRoot.byteLength
      );
    }
  }
  return "";
}

export function valueBindingInitialization(
  in bindings: Array<NativeValueBinding>,
  in name: String
): NativeInitializationState {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) return bindings[index].initialization;
  }
  return NativeInitializationState.initialized;
}

function replaceBindingInitialization(
  inout bindings: Array<NativeValueBinding>,
  index: usize,
  initialization: NativeInitializationState
): void {
  bindings[index] = NativeValueBinding({
    name: bindings[index].name.copyBytes(0, bindings[index].name.byteLength),
    typeName: bindings[index].typeName.copyBytes(0, bindings[index].typeName.byteLength),
    mutableBinding: bindings[index].mutableBinding,
    borrowedBinding: bindings[index].borrowedBinding,
    matchBorrowedBinding: bindings[index].matchBorrowedBinding,
    classAliasIdentity: bindings[index].classAliasIdentity,
    viewOwner: bindings[index].viewOwner.copyBytes(
      0,
      bindings[index].viewOwner.byteLength
    ),
    viewPath: bindings[index].viewPath.copyBytes(
      0,
      bindings[index].viewPath.byteLength
    ),
    viewLive: bindings[index].viewLive,
    suspensionBorrowRoot: bindings[index].suspensionBorrowRoot.copyBytes(
      0,
      bindings[index].suspensionBorrowRoot.byteLength
    ),
    initialization,
    ownership: bindings[index].ownership,
    outputParameter: bindings[index].outputParameter,
  });
}

function replaceBindingType(
  inout bindings: Array<NativeValueBinding>,
  index: usize,
  in typeName: String
): void {
  bindings[index] = NativeValueBinding({
    name: bindings[index].name.copyBytes(0, bindings[index].name.byteLength),
    typeName: typeName.copyBytes(0, typeName.byteLength),
    mutableBinding: bindings[index].mutableBinding,
    borrowedBinding: bindings[index].borrowedBinding,
    matchBorrowedBinding: bindings[index].matchBorrowedBinding,
    classAliasIdentity: bindings[index].classAliasIdentity,
    viewOwner: bindings[index].viewOwner.copyBytes(
      0,
      bindings[index].viewOwner.byteLength
    ),
    viewPath: bindings[index].viewPath.copyBytes(
      0,
      bindings[index].viewPath.byteLength
    ),
    viewLive: bindings[index].viewLive,
    suspensionBorrowRoot: bindings[index].suspensionBorrowRoot.copyBytes(
      0,
      bindings[index].suspensionBorrowRoot.byteLength
    ),
    initialization: bindings[index].initialization,
    ownership: bindings[index].ownership,
    outputParameter: bindings[index].outputParameter,
  });
}

function replaceBindingViewOwner(
  inout bindings: Array<NativeValueBinding>,
  index: usize,
  in viewOwner: String
): void {
  bindings[index] = NativeValueBinding({
    name: bindings[index].name.copyBytes(0, bindings[index].name.byteLength),
    typeName: bindings[index].typeName.copyBytes(0, bindings[index].typeName.byteLength),
    mutableBinding: bindings[index].mutableBinding,
    borrowedBinding: bindings[index].borrowedBinding,
    matchBorrowedBinding: bindings[index].matchBorrowedBinding,
    classAliasIdentity: bindings[index].classAliasIdentity,
    viewOwner: viewOwner.copyBytes(0, viewOwner.byteLength),
    viewPath: bindings[index].viewPath.copyBytes(
      0,
      bindings[index].viewPath.byteLength
    ),
    viewLive: bindings[index].viewLive,
    suspensionBorrowRoot: bindings[index].suspensionBorrowRoot.copyBytes(
      0,
      bindings[index].suspensionBorrowRoot.byteLength
    ),
    initialization: bindings[index].initialization,
    ownership: bindings[index].ownership,
    outputParameter: bindings[index].outputParameter,
  });
}

function replaceBindingViewPath(
  inout bindings: Array<NativeValueBinding>,
  index: usize,
  in viewPath: String
): void {
  bindings[index] = NativeValueBinding({
    name: bindings[index].name.copyBytes(0, bindings[index].name.byteLength),
    typeName: bindings[index].typeName.copyBytes(0, bindings[index].typeName.byteLength),
    mutableBinding: bindings[index].mutableBinding,
    borrowedBinding: bindings[index].borrowedBinding,
    matchBorrowedBinding: bindings[index].matchBorrowedBinding,
    classAliasIdentity: bindings[index].classAliasIdentity,
    viewOwner: bindings[index].viewOwner.copyBytes(
      0,
      bindings[index].viewOwner.byteLength
    ),
    viewPath: viewPath.copyBytes(0, viewPath.byteLength),
    viewLive: bindings[index].viewLive,
    suspensionBorrowRoot: bindings[index].suspensionBorrowRoot.copyBytes(
      0,
      bindings[index].suspensionBorrowRoot.byteLength
    ),
    initialization: bindings[index].initialization,
    ownership: bindings[index].ownership,
    outputParameter: bindings[index].outputParameter,
  });
}

function replaceBindingViewLive(
  inout bindings: Array<NativeValueBinding>,
  index: usize,
  viewLive: boolean
): void {
  bindings[index] = NativeValueBinding({
    name: bindings[index].name.copyBytes(0, bindings[index].name.byteLength),
    typeName: bindings[index].typeName.copyBytes(0, bindings[index].typeName.byteLength),
    mutableBinding: bindings[index].mutableBinding,
    borrowedBinding: bindings[index].borrowedBinding,
    matchBorrowedBinding: bindings[index].matchBorrowedBinding,
    classAliasIdentity: bindings[index].classAliasIdentity,
    viewOwner: bindings[index].viewOwner.copyBytes(
      0,
      bindings[index].viewOwner.byteLength
    ),
    viewPath: bindings[index].viewPath.copyBytes(
      0,
      bindings[index].viewPath.byteLength
    ),
    viewLive,
    suspensionBorrowRoot: bindings[index].suspensionBorrowRoot.copyBytes(
      0,
      bindings[index].suspensionBorrowRoot.byteLength
    ),
    initialization: bindings[index].initialization,
    ownership: bindings[index].ownership,
    outputParameter: bindings[index].outputParameter,
  });
}

export function setValueBindingInitialization(
  inout bindings: Array<NativeValueBinding>,
  in name: String,
  initialization: NativeInitializationState
): void {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) {
      replaceBindingInitialization(inout bindings, index, initialization);
      return;
    }
  }
}

export function setValueBindingType(
  inout bindings: Array<NativeValueBinding>,
  in name: String,
  in typeName: String
): void {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name != name) continue;
    replaceBindingType(inout bindings, index, typeName);
    return;
  }
}

export function setValueBindingViewOwner(
  inout bindings: Array<NativeValueBinding>,
  in name: String,
  in viewOwner: String
): void {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name != name) continue;
    replaceBindingViewOwner(inout bindings, index, viewOwner);
    return;
  }
}

export function valueBindingOwnership(
  in bindings: Array<NativeValueBinding>,
  in name: String
): NativeOwnershipState {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) return bindings[index].ownership;
  }
  return NativeOwnershipState.available;
}

function replaceBindingOwnership(
  inout bindings: Array<NativeValueBinding>,
  index: usize,
  ownership: NativeOwnershipState
): void {
  bindings[index] = NativeValueBinding({
    name: bindings[index].name.copyBytes(0, bindings[index].name.byteLength),
    typeName: bindings[index].typeName.copyBytes(0, bindings[index].typeName.byteLength),
    mutableBinding: bindings[index].mutableBinding,
    borrowedBinding: bindings[index].borrowedBinding,
    matchBorrowedBinding: bindings[index].matchBorrowedBinding,
    classAliasIdentity: bindings[index].classAliasIdentity,
    viewOwner: bindings[index].viewOwner.copyBytes(
      0,
      bindings[index].viewOwner.byteLength
    ),
    viewPath: bindings[index].viewPath.copyBytes(
      0,
      bindings[index].viewPath.byteLength
    ),
    viewLive: bindings[index].viewLive,
    suspensionBorrowRoot: bindings[index].suspensionBorrowRoot.copyBytes(
      0,
      bindings[index].suspensionBorrowRoot.byteLength
    ),
    initialization: bindings[index].initialization,
    ownership,
    outputParameter: bindings[index].outputParameter,
  });
}

export function setValueBindingOwnership(
  inout bindings: Array<NativeValueBinding>,
  in name: String,
  ownership: NativeOwnershipState
): void {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) {
      replaceBindingOwnership(inout bindings, index, ownership);
      return;
    }
  }
}

export function borrowValueBindingInPlace(
  inout bindings: Array<NativeValueBinding>,
  in name: String
): void {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) {
      bindings[index] = NativeValueBinding({
        name: bindings[index].name.copyBytes(0, bindings[index].name.byteLength),
        typeName: bindings[index].typeName.copyBytes(0, bindings[index].typeName.byteLength),
        mutableBinding: false,
        borrowedBinding: true,
        matchBorrowedBinding: bindings[index].matchBorrowedBinding,
        classAliasIdentity: bindings[index].classAliasIdentity,
        viewOwner: bindings[index].viewOwner.copyBytes(
          0,
          bindings[index].viewOwner.byteLength
        ),
        viewPath: bindings[index].viewPath.copyBytes(
          0,
          bindings[index].viewPath.byteLength
        ),
        viewLive: bindings[index].viewLive,
        suspensionBorrowRoot: bindings[index].suspensionBorrowRoot.copyBytes(
          0,
          bindings[index].suspensionBorrowRoot.byteLength
        ),
        initialization: bindings[index].initialization,
        ownership: bindings[index].ownership,
        outputParameter: bindings[index].outputParameter,
      });
      return;
    }
  }
}

export function borrowMatchValueBindingInPlace(
  inout bindings: Array<NativeValueBinding>,
  in name: String
): void {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) {
      bindings[index] = NativeValueBinding({
        name: bindings[index].name.copyBytes(0, bindings[index].name.byteLength),
        typeName: bindings[index].typeName.copyBytes(0, bindings[index].typeName.byteLength),
        mutableBinding: false,
        borrowedBinding: true,
        matchBorrowedBinding: bindings[index].matchBorrowedBinding,
        classAliasIdentity: bindings[index].classAliasIdentity,
        viewOwner: bindings[index].viewOwner.copyBytes(
          0,
          bindings[index].viewOwner.byteLength
        ),
        viewPath: bindings[index].viewPath.copyBytes(
          0,
          bindings[index].viewPath.byteLength
        ),
        viewLive: bindings[index].viewLive,
        suspensionBorrowRoot: name.copyBytes(0, name.byteLength),
        initialization: bindings[index].initialization,
        ownership: bindings[index].ownership,
        outputParameter: bindings[index].outputParameter,
      });
      return;
    }
  }
}

export function borrowClosureBindingInPlace(
  inout bindings: Array<NativeValueBinding>,
  in name: String
): void {
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == name) {
      bindings[index] = NativeValueBinding({
        name: bindings[index].name.copyBytes(0, bindings[index].name.byteLength),
        typeName: bindings[index].typeName.copyBytes(0, bindings[index].typeName.byteLength),
        mutableBinding: bindings[index].mutableBinding,
        borrowedBinding: true,
        matchBorrowedBinding: bindings[index].matchBorrowedBinding,
        classAliasIdentity: bindings[index].classAliasIdentity,
        viewOwner: bindings[index].viewOwner.copyBytes(
          0,
          bindings[index].viewOwner.byteLength
        ),
        viewPath: bindings[index].viewPath.copyBytes(
          0,
          bindings[index].viewPath.byteLength
        ),
        viewLive: bindings[index].viewLive,
        suspensionBorrowRoot: bindings[index].suspensionBorrowRoot.copyBytes(
          0,
          bindings[index].suspensionBorrowRoot.byteLength
        ),
        initialization: bindings[index].initialization,
        ownership: bindings[index].ownership,
        outputParameter: bindings[index].outputParameter,
      });
      return;
    }
  }
}

function mergedInitialization(
  left: NativeInitializationState,
  right: NativeInitializationState
): NativeInitializationState {
  if (left == right) return left;
  return NativeInitializationState.maybeUninitialized;
}

function mergedOwnership(
  left: NativeOwnershipState,
  right: NativeOwnershipState
): NativeOwnershipState {
  if (left == right) return left;
  return NativeOwnershipState.maybeMoved;
}

export function copyBindingFlowStates(
  inout target: Array<NativeValueBinding>,
  in source: Array<NativeValueBinding>
): void {
  let index: usize = 0;
  while (index < target.length && index < source.length) {
    // This binding records the resolver's current lexical context. It is not
    // flow evidence produced by the nested branch or scope.
    if (target[index].name == "__z_native_region_control_flow") {
      index = index + 1;
      continue;
    }
    const bindingName = target[index].name.copyBytes(
      0,
      target[index].name.byteLength
    );
    replaceBindingType(inout target, index, source[index].typeName);
    setValueBindingClassAlias(
      inout target,
      bindingName,
      source[index].classAliasIdentity
    );
    replaceBindingViewOwner(inout target, index, source[index].viewOwner);
    replaceBindingViewPath(inout target, index, source[index].viewPath);
    replaceBindingViewLive(inout target, index, source[index].viewLive);
    replaceBindingInitialization(inout target, index, source[index].initialization);
    replaceBindingOwnership(inout target, index, source[index].ownership);
    index = index + 1;
  }
}

export function mergeBindingFlowStates(
  inout target: Array<NativeValueBinding>,
  in left: Array<NativeValueBinding>,
  in right: Array<NativeValueBinding>
): void {
  let index: usize = 0;
  while (index < target.length && index < left.length && index < right.length) {
    // Preserve the enclosing lexical context instead of leaking a branch's
    // contextual marker into statements that follow the merge.
    if (target[index].name == "__z_native_region_control_flow") {
      index = index + 1;
      continue;
    }
    if (bindingIsClosureCaptureMode(target[index].name)) {
      const mergedCaptureMode = left[index].typeName == "inout"
        || right[index].typeName == "inout"
        ? "inout"
        : "in";
      replaceBindingType(inout target, index, mergedCaptureMode);
    } else if (left[index].typeName == right[index].typeName) {
      replaceBindingType(inout target, index, left[index].typeName);
    }
    const mergedAlias: usize = left[index].classAliasIdentity
      == right[index].classAliasIdentity
      ? left[index].classAliasIdentity
      : usize(0);
    const bindingName = target[index].name.copyBytes(
      0,
      target[index].name.byteLength
    );
    setValueBindingClassAlias(
      inout target,
      bindingName,
      mergedAlias
    );
    const mergedOwner = mergeViewOwners(
      left[index].viewOwner,
      right[index].viewOwner
    );
    replaceBindingViewOwner(inout target, index, mergedOwner);
    let mergedPath = "";
    if (
      mergedOwner == left[index].viewOwner
      && mergedOwner == right[index].viewOwner
      && left[index].viewPath == right[index].viewPath
    ) mergedPath = left[index].viewPath.copyBytes(
      0,
      left[index].viewPath.byteLength
    );
    replaceBindingViewPath(inout target, index, mergedPath);
    replaceBindingViewLive(
      inout target,
      index,
      left[index].viewLive || right[index].viewLive
    );
    replaceBindingInitialization(
      inout target,
      index,
      mergedInitialization(left[index].initialization, right[index].initialization)
    );
    replaceBindingOwnership(
      inout target,
      index,
      mergedOwnership(left[index].ownership, right[index].ownership)
    );
    index = index + 1;
  }
}
