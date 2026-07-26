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

export struct NativeValueBinding {
  name: String;
  typeName: String;
  mutableBinding: boolean;
  borrowedBinding: boolean;
  matchBorrowedBinding: boolean;
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
    initialization: NativeInitializationState.initialized,
    ownership: NativeOwnershipState.available,
    outputParameter: false,
  }));
}

export function addMatchBorrowedValueBinding(
  inout bindings: Array<NativeValueBinding>,
  in name: String,
  in typeName: String
): void {
  bindings.push(NativeValueBinding({
    name: name.copyBytes(0, name.byteLength),
    typeName: typeName.copyBytes(0, typeName.byteLength),
    mutableBinding: false,
    borrowedBinding: true,
    matchBorrowedBinding: true,
    initialization: NativeInitializationState.initialized,
    ownership: NativeOwnershipState.available,
    outputParameter: false,
  }));
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
    initialization,
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
