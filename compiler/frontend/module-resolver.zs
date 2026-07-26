import { TextBuffer } from "std/text";
import {
  buildResolvedModules,
  findEntryModule,
  parseModuleSources,
  resolveModuleOrder,
} from "./module-graph.zs";
import {
  ParsedModule,
  moduleBindingName as bindingName,
  moduleSymbolIndex,
} from "./module-symbols.zs";
import { validateModuleNames } from "./semantic-names.zs";
import {
  ModuleSymbolLocation,
  collectTypeIdentities,
  equivalentTypes,
  rebaseTypeName,
  semanticTypeIdentity,
  typeSatisfiesTrait,
  typeSymbolLocation,
} from "./semantic-type-identities.zs";
import {
  NativeFixedArrayShape,
  NativeGenericTypeShape,
  fixedArrayShape,
  genericTypeShape,
  isFloatTypeName,
  isIntegerTypeName,
  isIntrinsicTypeName,
  isNullableTypeName,
  isNumericTypeName,
  isTypeSymbolKind,
  nativeFunctionDisplayType,
  nativeFunctionSignature,
  nullableTargetType,
  qualifiedTypeBase,
  qualifiedTypeMember,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import { validateModuleTypes } from "./semantic-type-validation.zs";
import {
  ModuleBindingResolution,
  ModuleCallResolution,
  ModuleExpressionResolution,
  ModuleFunctionSignature,
  ModuleGraph,
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSemanticEvidence,
  ModuleSource,
  ModuleSymbol,
  ModuleSymbolKind,
  ModuleTypeIdentity,
  ModuleTypeParameterConstraint,
  ModuleTypeSignature,
  ResolvedModule,
  moduleResolutionError,
} from "./semantic-model.zs";
import {
  AggregateDeclaration,
  ConstructorDeclaration,
  Declaration,
  DeclarationKind,
  EnumDeclaration,
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  FunctionDeclaration,
  Parameter,
  ParameterMode,
  ReceiverMode,
  StatementArena,
  StatementKind,
  TraitDeclaration,
  TypeParameter,
  TypeReference,
} from "./parser.zs";

enum NativeInitializationState {
  initialized,
  uninitialized,
  maybeUninitialized,
}

enum NativeOwnershipState {
  available,
  moved,
  maybeMoved,
}

struct NativeValueBinding {
  name: String;
  typeName: String;
  mutableBinding: boolean;
  borrowedBinding: boolean;
  matchBorrowedBinding: boolean;
  initialization: NativeInitializationState;
  ownership: NativeOwnershipState;
  outputParameter: boolean;
}

struct NativeCallAccess {
  root: String;
  capability: String;
}

struct NativeThrowingCallShape {
  successType: String;
  errorType: String;
}

struct NativeMatchVariant {
  name: String;
  payloadType: String;
  payloadModuleIndex: usize;
}

struct NativeMatchShape {
  name: String;
  variants: Array<NativeMatchVariant>;
}

struct NativeFieldShape {
  name: String;
  ownerName: String;
  ownerModuleIndex: usize;
  ownerSymbolIndex: usize;
  typeName: String;
  visibility: String;
  readonlyField: boolean;
}

struct NativeMethodCallShape {
  name: String;
  ownerName: String;
  ownerModuleIndex: usize;
  ownerSymbolIndex: usize;
  staticMethod: boolean;
  visibility: String;
  receiverMode: String;
  ownerTypeParameters: Array<String>;
  ownerTypeArguments: Array<String>;
  ownerTypeParameterConstraints: Array<ModuleTypeParameterConstraint>;
  signature: ModuleFunctionSignature;
}

function resolutionError(
  kind: ModuleResolveErrorKind,
  in path: String,
  in message: String,
  line: usize,
  column: usize
): ModuleResolveError {
  return moduleResolutionError(kind, path, message, line, column);
}

function copyBindings(in bindings: Array<String>): Array<String> {
  let copied = Array<String>();
  for (const binding of bindings) {
    copied.push(binding.copyBytes(0, binding.byteLength));
  }
  return copied;
}

function copiedString(in value: String): String {
  const length = value.byteLength;
  return value.copyBytes(0, length);
}

function copyIndices(in indices: Array<usize>): Array<usize> {
  let copied = Array<usize>();
  for (const index of indices) {
    copied.push(index);
  }
  return copied;
}

function collectMatchBindingNames(
  in tree: ExpressionTree,
  index: usize,
  inout bindings: Array<String>
): void {
  const kind = tree.nodes[index].kind;
  const children = copyIndices(tree.nodes[index].children);
  if (kind == ExpressionKind.matchBindingExpression) {
    bindings.push(tree.nodes[index].value.copyBytes(0, tree.nodes[index].value.byteLength));
    return;
  }
  for (const child of children) {
    collectMatchBindingNames(tree, child, inout bindings);
  }
}

function identifierLookupName(in name: String): String {
  let index: usize = 0;
  while (index < name.byteLength) {
    if (name.byteAt(index) == 60) return name.copyBytes(0, index);
    index = index + 1;
  }
  return name.copyBytes(0, name.byteLength);
}

function copyValueBindings(in bindings: Array<NativeValueBinding>): Array<NativeValueBinding> {
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

function addValueBinding(
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

function contextualExpectedBindingName(offset: usize): String {
  return `__z_native_contextual_expected:${offset}`;
}

function loopSelectTypeBindingName(): String {
  return "__z_native_loop_select_type";
}

function contextualExpectedType(
  in bindings: Array<NativeValueBinding>,
  in tree: ExpressionTree,
  index: usize
): String {
  const bindingName = contextualExpectedBindingName(tree.nodes[index].offset);
  return valueBindingType(bindings, bindingName);
}

function addMutableValueBinding(
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

function addUninitializedMutableValueBinding(
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

function addBorrowedValueBinding(
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

function addMatchBorrowedValueBinding(
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

function valueBindingType(
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

function valueBindingIsMutable(
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

function valueBindingIsBorrowed(
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

function valueBindingIsMatchBorrowed(
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

function valueBindingInitialization(
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

function setValueBindingInitialization(
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

function valueBindingOwnership(
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

function setValueBindingOwnership(
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

function borrowValueBindingInPlace(
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

function borrowClosureBindingInPlace(
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

function copyBindingFlowStates(
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

function mergeBindingFlowStates(
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

function requireInitializedBinding(
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
    throw resolutionError(
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
  throw resolutionError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    message,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
}

function requireInitializedOutputParameters(
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
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `out parameter "${binding.name}" may be uninitialized on a successful return path`,
        line,
        column
      );
    }
  }
}

function expressionStorageRootName(
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

function consumeOwnedExpressionNode(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in typeName: String,
  force: boolean,
  inout bindings: Array<NativeValueBinding>
): void throws ModuleResolveError {
  if (!force && !typeMovesOnOwnedUse(modules, moduleIndex, typeName)) return;
  const kind = tree.nodes[index].kind;
  if (
    kind == ExpressionKind.memberExpression
    && tree.nodes[index].children.length == 1
  ) {
    const receiverIndex = tree.nodes[index].children[0];
    const enumType = typeExpressionName(tree, receiverIndex);
    const variantName = identifierLookupName(tree.nodes[index].value);
    if (isKnownMatchVariant(modules, moduleIndex, enumType, variantName)) return;
  }
  if (kind == ExpressionKind.memberExpression || kind == ExpressionKind.indexExpression) {
    throw resolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "cannot move an ownership-bearing field or element out of its owner",
      tree.nodes[index].line,
      tree.nodes[index].column
    );
  }
  const root = expressionStorageRootName(tree, index);
  if (root.byteLength == 0) return;
  if (valueBindingIsBorrowed(bindings, root)) {
    const message = valueBindingIsMatchBorrowed(bindings, root)
      ? `cannot move borrowed match binding "${root}"`
      : `cannot move borrowed parameter "${root}"`;
    throw resolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      message,
      tree.nodes[index].line,
      tree.nodes[index].column
    );
  }
  setValueBindingOwnership(inout bindings, root, NativeOwnershipState.moved);
}

function consumeOwnedExpressionSyntax(
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

function callCapabilitiesConflict(in left: String, in right: String): boolean {
  return !(
    (left == "in" && right == "in")
    || (left == "value" && right == "value")
  );
}

function registerCallAccess(
  in module: ParsedModule,
  in tree: ExpressionTree,
  nodeIndex: usize,
  inout accesses: Array<NativeCallAccess>,
  in root: String,
  in capability: String
): void throws ModuleResolveError {
  if (root.byteLength == 0) return;
  for (const access of accesses) {
    if (
      access.root == root
      && callCapabilitiesConflict(access.capability, capability)
    ) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `overlapping ${access.capability} and ${capability} uses of "${root}" in one call are not allowed`,
        tree.nodes[nodeIndex].line,
        tree.nodes[nodeIndex].column
      );
    }
  }
  accesses.push(NativeCallAccess({
    root: root.copyBytes(0, root.byteLength),
    capability: capability.copyBytes(0, capability.byteLength),
  }));
}

function numberLiteralType(in value: String): String {
  let index: usize = 0;
  while (index < value.byteLength) {
    const byte = value.byteAt(index);
    if (byte == 46 || byte == 69 || byte == 101) return "f64";
    index = index + 1;
  }
  return "i32";
}

function pendingThrowingCallType(
  in successType: String,
  in errorType: String
): String {
  return `__z_native_throwing_call:${successType}\t${errorType}`;
}

function pendingThrowingCallShape(
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

function unhandledThrowingCallError(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize
): ModuleResolveError {
  let message = "throwing call requires `attempt` or `try`";
  if (tree.nodes[index].kind == ExpressionKind.newExpression) {
    message = "throwing constructor requires `attempt` or `try`";
  }
  return resolutionError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    message,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
}

function requireSettledExpressionType(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in typeName: String
): void throws ModuleResolveError {
  match (pendingThrowingCallShape(typeName)) {
    some(shape) => throw unhandledThrowingCallError(module, tree, index);
    none => {}
  }
}

function isContextualNumericLiteral(in tree: ExpressionTree, index: usize): boolean {
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

function requireExpressionType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in expected: String,
  in actual: String
): void throws ModuleResolveError {
  try requireSettledExpressionType(module, tree, index, actual);
  const actualFunctionType = nativeFunctionDisplayType(actual);
  if (
    actualFunctionType.byteLength > 0
    && nativeFunctionSignaturesCompatible(modules, moduleIndex, expected, actual)
  ) return;
  if (
    actual.byteLength == 0
    || actual == "__z_never"
    || equivalentTypes(modules, moduleIndex, expected, actual)
  ) return;
  if (isNumericTypeName(expected) && isNumericTypeName(actual) && isContextualNumericLiteral(tree, index)) return;
  if (expected == "cstring" && actual == "String" && tree.nodes[index].kind == ExpressionKind.stringExpression) return;
  if (actual == "null" && isNullableTypeName(expected)) return;
  if (compatibleSliceTypes(modules, moduleIndex, expected, actual)) return;
  if (stringStartsWith(expected, "view ")) {
    const target = expected.copyBytes(5, expected.byteLength);
    const kind = tree.nodes[index].kind;
    if (
      equivalentTypes(modules, moduleIndex, target, actual)
      && (kind == ExpressionKind.memberExpression || kind == ExpressionKind.indexExpression)
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
  throw resolutionError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    `expected ${expected}, found ${actual}`,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
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
      && equivalentTypes(modules, moduleIndex, actualElement, generic.arguments[0]);
    none => false;
  };
}

function invalidOperator(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in message: String
): ModuleResolveError {
  return resolutionError(
    ModuleResolveErrorKind.invalidOperator,
    module.path,
    message,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
}

function arrayElementType(in name: String): String {
  if (stringStartsWith(name, "Array<") || stringStartsWith(name, "Slice<")) {
    if (name.byteLength > 7 && name.byteAt(name.byteLength - 1) == 62) {
      const start: usize = 6;
      return name.copyBytes(start, name.byteLength - 1);
    }
  }
  let index = name.byteLength;
  while (index > 0) {
    index = index - 1;
    if (name.byteAt(index) == 91) return name.copyBytes(0, index);
  }
  return "";
}

function iterationElementType(in name: String): String {
  match (genericTypeShape(name)) {
    some(generic) => {
      if (
        (
          generic.base == "Array"
          || generic.base == "Slice"
          || generic.base == "Set"
          || generic.base == "Iterator"
          || generic.base == "Generator"
          || generic.base == "AsyncGenerator"
        )
        && generic.arguments.length == 1
      ) return generic.arguments[0].copyBytes(0, generic.arguments[0].byteLength);
      if (generic.base == "Map" && generic.arguments.length == 2) {
        return `Map.Entry<${generic.arguments[0]}, ${generic.arguments[1]}>`;
      }
    }
    none => {}
  }
  return arrayElementType(name);
}

function iterationObjectFieldType(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in iterableType: String,
  in fieldName: String
): String {
  match (genericTypeShape(iterableType)) {
    some(generic) => {
      if (generic.base == "Map" && generic.arguments.length == 2) {
        if (fieldName == "key") return generic.arguments[0].copyBytes(0, generic.arguments[0].byteLength);
        if (fieldName == "value") return generic.arguments[1].copyBytes(0, generic.arguments[1].byteLength);
        return "";
      }
    }
    none => {}
  }
  const elementType = iterationElementType(iterableType);
  return match (aggregateFieldShape(modules, moduleIndex, elementType, fieldName)) {
    some(field) => field.typeName.copyBytes(0, field.typeName.byteLength);
    none => "";
  };
}

function substituteGenericType(
  in name: String,
  in substitutions: Array<NativeValueBinding>
): String {
  const direct = valueBindingType(substitutions, name);
  if (direct.byteLength > 0) return direct;
  match (nativeFunctionSignature(name)) {
    some(signature) => {
      let output = TextBuffer();
      output.append("(");
      let index: usize = 0;
      while (index < signature.parameterTypes.length) {
        if (index > 0) output.append(", ");
        if (signature.parameterModes[index] != "value") {
          output.append(signature.parameterModes[index]);
          output.append(" ");
        }
        output.append(`value${index}: `);
        output.append(substituteGenericType(signature.parameterTypes[index], substitutions));
        index = index + 1;
      }
      output.append(") => ");
      output.append(substituteGenericType(signature.returnType, substitutions));
      return output.finish();
    }
    none => {}
  }
  const nullableTarget = nullableTargetType(name);
  if (nullableTarget.byteLength > 0) {
    const substituted = substituteGenericType(nullableTarget, substitutions);
    return `${substituted} | null`;
  }
  if (stringStartsWith(name, "view ")) {
    const target = name.copyBytes(5, name.byteLength);
    const substituted = substituteGenericType(target, substitutions);
    return `view ${substituted}`;
  }
  match (fixedArrayShape(name)) {
    some(array) => {
      const substituted = substituteGenericType(array.elementType, substitutions);
      return `${substituted}[${array.length}]`;
    }
    none => {}
  }
  return match (genericTypeShape(name)) {
    some(generic) => {
      let output = TextBuffer();
      output.append(generic.base);
      output.append("<");
      let index: usize = 0;
      while (index < generic.arguments.length) {
        if (index > 0) output.append(", ");
        const argument = substituteGenericType(generic.arguments[index], substitutions);
        output.append(argument);
        index = index + 1;
      }
      output.append(">");
      select output.finish();
    }
    none => name.copyBytes(0, name.byteLength);
  };
}

function typeMentionsParameter(in name: String, in parameter: String): boolean {
  if (name == parameter) return true;
  const nullableTarget = nullableTargetType(name);
  if (nullableTarget.byteLength > 0) {
    return typeMentionsParameter(nullableTarget, parameter);
  }
  if (stringStartsWith(name, "view ")) {
    const target = name.copyBytes(5, name.byteLength);
    return typeMentionsParameter(target, parameter);
  }
  match (fixedArrayShape(name)) {
    some(array) => return typeMentionsParameter(array.elementType, parameter);
    none => {}
  }
  match (nativeFunctionSignature(name)) {
    some(signature) => {
      for (const parameterType of signature.parameterTypes) {
        if (typeMentionsParameter(parameterType, parameter)) return true;
      }
      return typeMentionsParameter(signature.returnType, parameter);
    }
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        if (typeMentionsParameter(argument, parameter)) return true;
      }
    }
    none => {}
  }
  return false;
}

function settledContextualType(
  in pattern: String,
  in typeParameters: Array<String>,
  in substitutions: Array<NativeValueBinding>
): String {
  for (const parameter of typeParameters) {
    const substitution = valueBindingType(substitutions, parameter);
    if (
      substitution.byteLength == 0
      && typeMentionsParameter(pattern, parameter)
    ) return "";
  }
  return substituteGenericType(pattern, substitutions);
}

function parameterizedTypeName(
  in base: String,
  in parameters: Array<String>
): String {
  if (parameters.length == 0) return base.copyBytes(0, base.byteLength);
  let output = TextBuffer();
  output.append(base);
  output.append("<");
  let index: usize = 0;
  while (index < parameters.length) {
    if (index > 0) output.append(", ");
    output.append(parameters[index]);
    index = index + 1;
  }
  output.append(">");
  return output.finish();
}

function throwingGeneratorHandleType(
  in returnType: String,
  in errorType: String
): Option<String> {
  return match (genericTypeShape(returnType)) {
    some(generator) => {
      if (
        generator.base != "Generator"
        && generator.base != "AsyncGenerator"
      ) return Option<String>.none;
      let arguments = Array<String>();
      for (const argument of generator.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
      }
      if (arguments.length == 1) arguments.push("void");
      if (arguments.length == 2) {
        arguments.push(errorType.copyBytes(0, errorType.byteLength));
      }
      return Option.some(parameterizedTypeName(generator.base, arguments));
    }
    none => Option<String>.none;
  };
}

function genericCallError(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in message: String
): ModuleResolveError {
  return resolutionError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    message,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
}

function bindGenericType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  argumentIndex: usize,
  in functionName: String,
  in pattern: String,
  in actual: String,
  in typeParameters: Array<String>,
  inout substitutions: Array<NativeValueBinding>
): void throws ModuleResolveError {
  if (actual.byteLength == 0 || actual == "null") return;
  for (const typeParameter of typeParameters) {
    if (pattern != typeParameter) continue;
    const previous = valueBindingType(substitutions, typeParameter);
    if (
      previous.byteLength > 0
      && !equivalentTypes(modules, moduleIndex, previous, actual)
    ) {
      throw genericCallError(
        module,
        tree,
        argumentIndex,
        `conflicting inferred types for ${typeParameter} in ${functionName}: ${previous} and ${actual}`
      );
    }
    if (previous.byteLength == 0) addValueBinding(inout substitutions, typeParameter, actual);
    return;
  }
  const patternNullable = nullableTargetType(pattern);
  const actualNullable = nullableTargetType(actual);
  if (patternNullable.byteLength > 0 && actualNullable.byteLength > 0) {
    try bindGenericType(
      module,
      modules,
      moduleIndex,
      tree,
      argumentIndex,
      functionName,
      patternNullable,
      actualNullable,
      typeParameters,
      inout substitutions
    );
    return;
  }
  if (stringStartsWith(pattern, "view ") && stringStartsWith(actual, "view ")) {
    const patternTarget = pattern.copyBytes(5, pattern.byteLength);
    const actualTarget = actual.copyBytes(5, actual.byteLength);
    try bindGenericType(
      module,
      modules,
      moduleIndex,
      tree,
      argumentIndex,
      functionName,
      patternTarget,
      actualTarget,
      typeParameters,
      inout substitutions
    );
    return;
  }
  match (fixedArrayShape(pattern)) {
    some(patternArray) => {
      match (fixedArrayShape(actual)) {
        some(actualArray) => {
          if (patternArray.length == actualArray.length) {
            try bindGenericType(
              module,
              modules,
              moduleIndex,
              tree,
              argumentIndex,
              functionName,
              patternArray.elementType,
              actualArray.elementType,
              typeParameters,
              inout substitutions
            );
          }
        }
        none => {}
      }
      return;
    }
    none => {}
  }
  match (genericTypeShape(pattern)) {
    some(patternGeneric) => {
      match (genericTypeShape(actual)) {
        some(actualGeneric) => {
          if (
            patternGeneric.base == actualGeneric.base
            && patternGeneric.arguments.length == actualGeneric.arguments.length
          ) {
            let index: usize = 0;
            while (index < patternGeneric.arguments.length) {
              try bindGenericType(
                module,
                modules,
                moduleIndex,
                tree,
                argumentIndex,
                functionName,
                patternGeneric.arguments[index],
                actualGeneric.arguments[index],
                typeParameters,
                inout substitutions
              );
              index = index + 1;
            }
          }
        }
        none => {
          if (patternGeneric.base == "Slice") {
            const actualElement = arrayElementType(actual);
            if (patternGeneric.arguments.length == 1 && actualElement.byteLength > 0) {
              try bindGenericType(
                module,
                modules,
                moduleIndex,
                tree,
                argumentIndex,
                functionName,
                patternGeneric.arguments[0],
                actualElement,
                typeParameters,
                inout substitutions
              );
            }
          }
        }
      }
    }
    none => {}
  }
}

function explicitCallTypeArguments(
  in tree: ExpressionTree,
  calleeIndex: usize
): Option<NativeGenericTypeShape> {
  if (
    tree.nodes[calleeIndex].kind != ExpressionKind.identifierExpression
    && tree.nodes[calleeIndex].kind != ExpressionKind.memberExpression
  ) return Option<NativeGenericTypeShape>.none;
  return genericTypeShape(tree.nodes[calleeIndex].value);
}

function matchVariant(
  in name: String,
  in payloadType: String,
  payloadModuleIndex: usize
): NativeMatchVariant {
  return NativeMatchVariant({
    name: name.copyBytes(0, name.byteLength),
    payloadType: payloadType.copyBytes(0, payloadType.byteLength),
    payloadModuleIndex,
  });
}

function typeHasCleanup(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>
): boolean {
  const nullableTarget = nullableTargetType(typeName);
  if (nullableTarget.byteLength > 0) {
    return typeHasCleanup(modules, moduleIndex, nullableTarget, visiting);
  }
  if (stringStartsWith(typeName, "view ") || stringStartsWith(typeName, "Slice<")) {
    return false;
  }
  if (
    typeName == "String"
    || typeName == "TextBuffer"
    || typeName == "Arena"
    || stringStartsWith(typeName, "__z_native_function:")
  ) return true;
  match (fixedArrayShape(typeName)) {
    some(array) => return typeHasCleanup(
      modules,
      moduleIndex,
      array.elementType,
      visiting
    );
    none => {}
  }
  let arguments = Array<String>();
  match (genericTypeShape(typeName)) {
    some(generic) => {
      if (
        generic.base == "Array"
        || generic.base == "Map"
        || generic.base == "Set"
        || generic.base == "Task"
        || generic.base == "Weak"
      ) {
        return true;
      }
      if (generic.base == "Option" || generic.base == "Result") {
        for (const argument of generic.arguments) {
          if (typeHasCleanup(modules, moduleIndex, argument, visiting)) return true;
        }
        return false;
      }
      for (const argument of generic.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
      }
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      const kind = modules[location.moduleIndex].symbols[location.symbolIndex].kind;
      if (kind == ModuleSymbolKind.classSymbol) return true;
      const identity = semanticTypeIdentity(modules, moduleIndex, typeName);
      if (containsString(visiting, identity)) return false;
      let nextVisiting = copyBindings(visiting);
      nextVisiting.push(identity);
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          if (signature.customDeinit) return true;
          let substitutions = Array<NativeValueBinding>();
          let typeIndex: usize = 0;
          while (
            typeIndex < signature.typeParameters.length
            && typeIndex < arguments.length
          ) {
            addValueBinding(
              inout substitutions,
              signature.typeParameters[typeIndex],
              arguments[typeIndex]
            );
            typeIndex = typeIndex + 1;
          }
          for (const field of signature.fields) {
            const localType = rebaseTypeName(
              modules,
              location.moduleIndex,
              moduleIndex,
              field.typeName
            );
            const fieldType = substituteGenericType(localType, substitutions);
            if (typeHasCleanup(
              modules,
              moduleIndex,
              fieldType,
              nextVisiting
            )) return true;
          }
          for (const variant of signature.variants) {
            if (variant.payloadType.byteLength == 0) continue;
            const localType = rebaseTypeName(
              modules,
              location.moduleIndex,
              moduleIndex,
              variant.payloadType
            );
            const payloadType = substituteGenericType(localType, substitutions);
            if (typeHasCleanup(
              modules,
              moduleIndex,
              payloadType,
              nextVisiting
            )) return true;
          }
          return false;
        }
        none => {}
      }
    }
    none => {}
  }
  return false;
}

function typeMovesOnOwnedUse(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  let managedType = typeName.copyBytes(0, typeName.byteLength);
  const nullableTarget = nullableTargetType(typeName);
  if (nullableTarget.byteLength > 0) {
    managedType = nullableTarget.copyBytes(0, nullableTarget.byteLength);
  }
  if (
    stringStartsWith(managedType, "Weak<")
    || stringStartsWith(managedType, "__z_native_function:")
  ) return false;
  match (typeSymbolLocation(modules, moduleIndex, managedType)) {
    some(location) => {
      if (
        modules[location.moduleIndex].symbols[location.symbolIndex].kind
        == ModuleSymbolKind.classSymbol
      ) return false;
    }
    none => {}
  }
  let visiting = Array<String>();
  return typeHasCleanup(modules, moduleIndex, typeName, visiting);
}

function typeSupportsExplicitCopy(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in visiting: Array<String>
): boolean {
  let actual = typeName.copyBytes(0, typeName.byteLength);
  if (stringStartsWith(actual, "view ")) {
    actual = actual.copyBytes(5, actual.byteLength);
  }
  if (actual == "String") return true;
  if (
    actual == "TextBuffer"
    || actual == "Arena"
    || stringStartsWith(actual, "Weak<")
    || stringStartsWith(actual, "__z_native_function:")
  ) return false;
  match (fixedArrayShape(actual)) {
    some(array) => return typeSupportsExplicitCopy(
      modules,
      moduleIndex,
      array.elementType,
      visiting
    );
    none => {}
  }
  let arguments = Array<String>();
  match (genericTypeShape(actual)) {
    some(generic) => {
      if (generic.base == "Array" || generic.base == "Map" || generic.base == "Set") {
        for (const argument of generic.arguments) {
          if (!typeSupportsExplicitCopy(modules, moduleIndex, argument, visiting)) return false;
        }
        return true;
      }
      if (generic.base == "Option" || generic.base == "Result") {
        for (const argument of generic.arguments) {
          if (!typeSupportsExplicitCopy(modules, moduleIndex, argument, visiting)) return false;
        }
        return true;
      }
      for (const argument of generic.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
      }
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, actual)) {
    some(location) => {
      if (
        modules[location.moduleIndex].symbols[location.symbolIndex].kind
        == ModuleSymbolKind.classSymbol
      ) return false;
      const identity = semanticTypeIdentity(modules, moduleIndex, actual);
      if (containsString(visiting, identity)) return false;
      let nextVisiting = copyBindings(visiting);
      nextVisiting.push(identity);
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          if (signature.customDeinit) return false;
          let substitutions = Array<NativeValueBinding>();
          let typeIndex: usize = 0;
          while (
            typeIndex < signature.typeParameters.length
            && typeIndex < arguments.length
          ) {
            addValueBinding(
              inout substitutions,
              signature.typeParameters[typeIndex],
              arguments[typeIndex]
            );
            typeIndex = typeIndex + 1;
          }
          for (const field of signature.fields) {
            const localType = rebaseTypeName(
              modules,
              location.moduleIndex,
              moduleIndex,
              field.typeName
            );
            const fieldType = substituteGenericType(localType, substitutions);
            if (!typeSupportsExplicitCopy(
              modules,
              moduleIndex,
              fieldType,
              nextVisiting
            )) return false;
          }
          for (const variant of signature.variants) {
            if (variant.payloadType.byteLength == 0) continue;
            const localType = rebaseTypeName(
              modules,
              location.moduleIndex,
              moduleIndex,
              variant.payloadType
            );
            const payloadType = substituteGenericType(localType, substitutions);
            if (!typeSupportsExplicitCopy(
              modules,
              moduleIndex,
              payloadType,
              nextVisiting
            )) return false;
          }
          return true;
        }
        none => {}
      }
    }
    none => {}
  }
  let cleanupVisiting = Array<String>();
  return !typeHasCleanup(modules, moduleIndex, actual, cleanupVisiting);
}

function typeHasCustomConstructor(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => return signature.customConstructor;
        none => {}
      }
    }
    none => {}
  }
  return false;
}

function matchShape(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in subjectType: String
): Option<NativeMatchShape> {
  match (genericTypeShape(subjectType)) {
    some(generic) => {
      if (generic.base == "Option" && generic.arguments.length == 1) {
        let variants = Array<NativeMatchVariant>();
        variants.push(matchVariant("some", generic.arguments[0], moduleIndex));
        variants.push(matchVariant("none", "", moduleIndex));
        return Option.some(NativeMatchShape({
          name: subjectType.copyBytes(0, subjectType.byteLength),
          variants,
        }));
      }
      if (generic.base == "Result" && generic.arguments.length == 2) {
        let variants = Array<NativeMatchVariant>();
        let successType = "";
        if (generic.arguments[0] != "void") {
          successType = generic.arguments[0].copyBytes(0, generic.arguments[0].byteLength);
        }
        variants.push(matchVariant("success", successType, moduleIndex));
        variants.push(matchVariant("failure", generic.arguments[1], moduleIndex));
        return Option.some(NativeMatchShape({
          name: subjectType.copyBytes(0, subjectType.byteLength),
          variants,
        }));
      }
      if (generic.base == "GeneratorStep" && generic.arguments.length == 2) {
        let variants = Array<NativeMatchVariant>();
        variants.push(matchVariant("yielded", generic.arguments[0], moduleIndex));
        variants.push(matchVariant("complete", generic.arguments[1], moduleIndex));
        return Option.some(NativeMatchShape({
          name: subjectType.copyBytes(0, subjectType.byteLength),
          variants,
        }));
      }
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, subjectType)) {
    some(location) => {
      if (
        modules[location.moduleIndex].symbols[location.symbolIndex].kind
        != ModuleSymbolKind.enumSymbol
      ) {
        return Option<NativeMatchShape>.none;
      }
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          let variants = Array<NativeMatchVariant>();
          for (const variant of signature.variants) {
            let payloadType = "";
            if (variant.payloadType.byteLength > 0) {
              payloadType = rebaseTypeName(
                modules,
                location.moduleIndex,
                moduleIndex,
                variant.payloadType
              );
            }
            variants.push(matchVariant(
              variant.name,
              payloadType,
              moduleIndex
            ));
          }
          return Option.some(NativeMatchShape({
            name: subjectType.copyBytes(0, subjectType.byteLength),
            variants,
          }));
        }
        none => {}
      }
    }
    none => {}
  }
  return Option<NativeMatchShape>.none;
}

function matchVariantIndex(
  in shape: NativeMatchShape,
  in name: String
): usize {
  let index: usize = 0;
  while (index < shape.variants.length) {
    if (shape.variants[index].name == name) return index;
    index = index + 1;
  }
  return shape.variants.length;
}

function isKnownMatchVariant(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in subjectType: String,
  in variantName: String
): boolean {
  return match (matchShape(modules, moduleIndex, subjectType)) {
    some(shape) => matchVariantIndex(shape, variantName) < shape.variants.length;
    none => false;
  };
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

function matchError(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in message: String
): ModuleResolveError {
  return resolutionError(
    ModuleResolveErrorKind.invalidMatch,
    module.path,
    message,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
}

function isDefinitelyNonMatchable(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in subjectType: String
): boolean {
  const elementType = arrayElementType(subjectType);
  if (
    isNumericTypeName(subjectType)
    || subjectType == "boolean"
    || subjectType == "String"
    || subjectType == "cstring"
    || subjectType == "null"
    || elementType.byteLength > 0
  ) return true;
  match (typeSymbolLocation(modules, moduleIndex, subjectType)) {
    some(location) => {
      const kind = modules[location.moduleIndex].symbols[location.symbolIndex].kind;
      if (
        kind == ModuleSymbolKind.structSymbol
        || kind == ModuleSymbolKind.classSymbol
        || kind == ModuleSymbolKind.traitSymbol
      ) return true;
    }
    none => {}
  }
  return false;
}

function aggregateFieldShape(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in ownerType: String,
  in fieldName: String
): Option<NativeFieldShape> {
  let arguments = Array<String>();
  match (genericTypeShape(ownerType)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        arguments.push(argument.copyBytes(0, argument.byteLength));
      }
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, ownerType)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          let substitutions = Array<NativeValueBinding>();
          let typeIndex: usize = 0;
          while (
            typeIndex < signature.typeParameters.length
            && typeIndex < arguments.length
          ) {
            addValueBinding(
              inout substitutions,
              signature.typeParameters[typeIndex],
              arguments[typeIndex]
            );
            typeIndex = typeIndex + 1;
          }
          for (const field of signature.fields) {
            if (field.name == fieldName) {
              const fieldType = rebaseTypeName(
                modules,
                location.moduleIndex,
                moduleIndex,
                field.typeName
              );
              return Option.some(NativeFieldShape({
                name: field.name.copyBytes(0, field.name.byteLength),
                ownerName: modules[location.moduleIndex].symbols[location.symbolIndex].name.copyBytes(
                  0,
                  modules[location.moduleIndex].symbols[location.symbolIndex].name.byteLength
                ),
                ownerModuleIndex: location.moduleIndex,
                ownerSymbolIndex: location.symbolIndex,
                typeName: substituteGenericType(fieldType, substitutions),
                visibility: field.visibility.copyBytes(0, field.visibility.byteLength),
                readonlyField: field.readonlyField,
              }));
            }
          }
        }
        none => {}
      }
    }
    none => {}
  }
  return Option<NativeFieldShape>.none;
}

function activeOwnerMatches(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in bindings: Array<NativeValueBinding>,
  in field: NativeFieldShape
): boolean {
  const ownerType = valueBindingType(bindings, "__z_native_owner_type");
  if (ownerType.byteLength == 0) return false;
  return match (typeSymbolLocation(modules, moduleIndex, ownerType)) {
    some(location) => location.moduleIndex == field.ownerModuleIndex
      && location.symbolIndex == field.ownerSymbolIndex;
    none => false;
  };
}

function copyModuleFunctionSignature(
  in signature: ModuleFunctionSignature
): ModuleFunctionSignature {
  let typeParameters = Array<String>();
  for (const parameter of signature.typeParameters) {
    typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
  }
  let typeParameterConstraints = Array<ModuleTypeParameterConstraint>();
  for (const constraint of signature.typeParameterConstraints) {
    typeParameterConstraints.push(ModuleTypeParameterConstraint({
      parameter: constraint.parameter.copyBytes(0, constraint.parameter.byteLength),
      traitName: constraint.traitName.copyBytes(0, constraint.traitName.byteLength),
    }));
  }
  let parameterModes = Array<String>();
  for (const mode of signature.parameterModes) {
    parameterModes.push(mode.copyBytes(0, mode.byteLength));
  }
  let parameterTypes = Array<String>();
  for (const typeName of signature.parameterTypes) {
    parameterTypes.push(typeName.copyBytes(0, typeName.byteLength));
  }
  return ModuleFunctionSignature({
    asynchronous: signature.asynchronous,
    executorAffinity: signature.executorAffinity.copyBytes(0, signature.executorAffinity.byteLength),
    typeParameters,
    typeParameterConstraints,
    parameterModes,
    parameterTypes,
    returnType: signature.returnType.copyBytes(0, signature.returnType.byteLength),
    errorType: signature.errorType.copyBytes(0, signature.errorType.byteLength),
  });
}

function rebaseModuleFunctionSignature(
  in modules: Array<ResolvedModule>,
  fromModuleIndex: usize,
  toModuleIndex: usize,
  in signature: ModuleFunctionSignature
): ModuleFunctionSignature {
  let typeParameters = Array<String>();
  for (const parameter of signature.typeParameters) {
    typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
  }
  let typeParameterConstraints = Array<ModuleTypeParameterConstraint>();
  for (const constraint of signature.typeParameterConstraints) {
    typeParameterConstraints.push(ModuleTypeParameterConstraint({
      parameter: constraint.parameter.copyBytes(0, constraint.parameter.byteLength),
      traitName: rebaseTypeName(
        modules,
        fromModuleIndex,
        toModuleIndex,
        constraint.traitName
      ),
    }));
  }
  let parameterModes = Array<String>();
  for (const mode of signature.parameterModes) {
    parameterModes.push(mode.copyBytes(0, mode.byteLength));
  }
  let parameterTypes = Array<String>();
  for (const typeName of signature.parameterTypes) {
    parameterTypes.push(rebaseTypeName(
      modules,
      fromModuleIndex,
      toModuleIndex,
      typeName
    ));
  }
  let errorType = "";
  if (signature.errorType.byteLength > 0) {
    errorType = rebaseTypeName(
      modules,
      fromModuleIndex,
      toModuleIndex,
      signature.errorType
    );
  }
  return ModuleFunctionSignature({
    asynchronous: signature.asynchronous,
    executorAffinity: signature.executorAffinity.copyBytes(0, signature.executorAffinity.byteLength),
    typeParameters,
    typeParameterConstraints,
    parameterModes,
    parameterTypes,
    returnType: rebaseTypeName(
      modules,
      fromModuleIndex,
      toModuleIndex,
      signature.returnType
    ),
    errorType,
  });
}

function methodCallShape(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in ownerType: String,
  in methodName: String,
  staticMethod: boolean
): Option<NativeMethodCallShape> {
  let ownerArguments = Array<String>();
  match (genericTypeShape(ownerType)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        ownerArguments.push(argument.copyBytes(0, argument.byteLength));
      }
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, ownerType)) {
    some(location) => {
      match (
        in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature
      ) {
        some(typeSignature) => {
          for (const method of typeSignature.methods) {
            if (method.name != methodName || method.staticMethod != staticMethod) continue;
            let ownerTypeParameters = Array<String>();
            for (const parameter of typeSignature.typeParameters) {
              ownerTypeParameters.push(parameter.copyBytes(0, parameter.byteLength));
            }
            let ownerTypeParameterConstraints = Array<ModuleTypeParameterConstraint>();
            for (const constraint of typeSignature.typeParameterConstraints) {
              ownerTypeParameterConstraints.push(ModuleTypeParameterConstraint({
                parameter: constraint.parameter.copyBytes(0, constraint.parameter.byteLength),
                traitName: rebaseTypeName(
                  modules,
                  location.moduleIndex,
                  moduleIndex,
                  constraint.traitName
                ),
              }));
            }
            return Option.some(NativeMethodCallShape({
              name: method.name.copyBytes(0, method.name.byteLength),
              ownerName: modules[location.moduleIndex].symbols[location.symbolIndex].name.copyBytes(
                0,
                modules[location.moduleIndex].symbols[location.symbolIndex].name.byteLength
              ),
              ownerModuleIndex: location.moduleIndex,
              ownerSymbolIndex: location.symbolIndex,
              staticMethod: method.staticMethod,
              visibility: method.visibility.copyBytes(0, method.visibility.byteLength),
              receiverMode: method.receiverMode.copyBytes(0, method.receiverMode.byteLength),
              ownerTypeParameters,
              ownerTypeArguments: ownerArguments,
              ownerTypeParameterConstraints,
              signature: rebaseModuleFunctionSignature(
                modules,
                location.moduleIndex,
                moduleIndex,
                method.signature
              ),
            }));
          }
        }
        none => {}
      }
    }
    none => {}
  }
  return Option<NativeMethodCallShape>.none;
}

function typeParameterMarkerName(in parameter: String): String {
  return `__z_native_type_parameter:${parameter}`;
}

function typeParameterConstraintName(in parameter: String): String {
  return `__z_native_type_parameter_constraint:${parameter}`;
}

function addTypeParameterBindings(
  inout bindings: Array<NativeValueBinding>,
  in parameters: Array<TypeParameter>
): void {
  for (const parameter of parameters) {
    const markerName = typeParameterMarkerName(parameter.name);
    const constraintName = typeParameterConstraintName(parameter.name);
    addValueBinding(inout bindings, markerName, "");
    for (const constraint of parameter.constraints) {
      addValueBinding(
        inout bindings,
        constraintName,
        constraint.name
      );
    }
  }
}

function typeParameterConstraintTraits(
  in bindings: Array<NativeValueBinding>,
  in parameter: String
): Array<String> {
  let constraints = Array<String>();
  const markerName = typeParameterMarkerName(parameter);
  const constraintName = typeParameterConstraintName(parameter);
  let markerIndex = bindings.length;
  while (markerIndex > 0) {
    markerIndex = markerIndex - 1;
    if (bindings[markerIndex].name == markerName) break;
  }
  if (bindings.length == 0 || bindings[markerIndex].name != markerName) return constraints;
  let index = markerIndex + 1;
  while (index < bindings.length) {
    if (bindings[index].name == constraintName) {
      constraints.push(bindings[index].typeName.copyBytes(0, bindings[index].typeName.byteLength));
    }
    index = index + 1;
  }
  return constraints;
}

function isActiveTypeParameter(
  in bindings: Array<NativeValueBinding>,
  in parameter: String
): boolean {
  const markerName = typeParameterMarkerName(parameter);
  let index = bindings.length;
  while (index > 0) {
    index = index - 1;
    if (bindings[index].name == markerName) return true;
  }
  return false;
}

function constrainedMethodCallShape(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in bindings: Array<NativeValueBinding>,
  in ownerType: String,
  in methodName: String
): Option<NativeMethodCallShape> {
  const constraints = typeParameterConstraintTraits(bindings, ownerType);
  for (const traitName of constraints) {
    match (methodCallShape(modules, moduleIndex, traitName, methodName, false)) {
      some(method) => return Option.some(method);
      none => {}
    }
  }
  return Option<NativeMethodCallShape>.none;
}

function callableMethodCallShape(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in bindings: Array<NativeValueBinding>,
  in ownerType: String,
  in methodName: String,
  staticMethod: boolean
): Option<NativeMethodCallShape> {
  match (methodCallShape(modules, moduleIndex, ownerType, methodName, staticMethod)) {
    some(method) => return Option.some(method);
    none => {}
  }
  if (!staticMethod) {
    return constrainedMethodCallShape(modules, moduleIndex, bindings, ownerType, methodName);
  }
  return Option<NativeMethodCallShape>.none;
}

function typeExpressionName(in tree: ExpressionTree, index: usize): String {
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
    return tree.nodes[index].value.copyBytes(0, tree.nodes[index].value.byteLength);
  }
  if (
    tree.nodes[index].kind == ExpressionKind.memberExpression
    && tree.nodes[index].children.length == 1
  ) {
    const receiverIndex = tree.nodes[index].children[0];
    const receiver = typeExpressionName(tree, receiverIndex);
    if (receiver.byteLength == 0) return "";
    return `${receiver}.${tree.nodes[index].value}`;
  }
  return "";
}

function activeOwnerMatchesMethod(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in bindings: Array<NativeValueBinding>,
  in method: NativeMethodCallShape
): boolean {
  const ownerType = valueBindingType(bindings, "__z_native_owner_type");
  if (ownerType.byteLength == 0) return false;
  return match (typeSymbolLocation(modules, moduleIndex, ownerType)) {
    some(location) => location.moduleIndex == method.ownerModuleIndex
      && location.symbolIndex == method.ownerSymbolIndex;
    none => false;
  };
}

function methodCallableSignature(
  in method: NativeMethodCallShape
): ModuleFunctionSignature {
  let typeParameters = Array<String>();
  let typeParameterConstraints = Array<ModuleTypeParameterConstraint>();
  for (const constraint of method.ownerTypeParameterConstraints) {
    typeParameterConstraints.push(ModuleTypeParameterConstraint({
      parameter: constraint.parameter.copyBytes(0, constraint.parameter.byteLength),
      traitName: constraint.traitName.copyBytes(0, constraint.traitName.byteLength),
    }));
  }
  if (method.staticMethod && method.ownerTypeArguments.length == 0) {
    for (const parameter of method.ownerTypeParameters) {
      typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
    }
  }
  for (const parameter of method.signature.typeParameters) {
    typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
  }
  for (const constraint of method.signature.typeParameterConstraints) {
    typeParameterConstraints.push(ModuleTypeParameterConstraint({
      parameter: constraint.parameter.copyBytes(0, constraint.parameter.byteLength),
      traitName: constraint.traitName.copyBytes(0, constraint.traitName.byteLength),
    }));
  }
  let parameterModes = Array<String>();
  for (const mode of method.signature.parameterModes) {
    parameterModes.push(mode.copyBytes(0, mode.byteLength));
  }
  let parameterTypes = Array<String>();
  for (const typeName of method.signature.parameterTypes) {
    parameterTypes.push(typeName.copyBytes(0, typeName.byteLength));
  }
  return ModuleFunctionSignature({
    asynchronous: method.signature.asynchronous,
    executorAffinity: method.signature.executorAffinity.copyBytes(0, method.signature.executorAffinity.byteLength),
    typeParameters,
    typeParameterConstraints,
    parameterModes,
    parameterTypes,
    returnType: method.signature.returnType.copyBytes(0, method.signature.returnType.byteLength),
    errorType: method.signature.errorType.copyBytes(0, method.signature.errorType.byteLength),
  });
}

function requireVisibleField(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in bindings: Array<NativeValueBinding>,
  in field: NativeFieldShape
): void throws ModuleResolveError {
  if (field.visibility != "private") return;
  if (activeOwnerMatches(modules, moduleIndex, bindings, field)) return;
  let ownerKind = "struct";
  if (
    modules[field.ownerModuleIndex].symbols[field.ownerSymbolIndex].kind
    == ModuleSymbolKind.classSymbol
  ) ownerKind = "class";
  throw resolutionError(
    ModuleResolveErrorKind.unknownMember,
    module.path,
    `field "${field.name}" is private to ${ownerKind} "${field.ownerName}"`,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
}

function hasKnownAggregate(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      const kind = modules[location.moduleIndex].symbols[location.symbolIndex].kind;
      return kind == ModuleSymbolKind.structSymbol || kind == ModuleSymbolKind.classSymbol;
    }
    none => {}
  }
  return false;
}

function requireGenericConstraints(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  calleeIndex: usize,
  in functionName: String,
  in constraints: Array<ModuleTypeParameterConstraint>,
  in substitutions: Array<NativeValueBinding>
): void throws ModuleResolveError {
  for (const constraint of constraints) {
    const argument = valueBindingType(substitutions, constraint.parameter);
    if (argument.byteLength == 0) continue;
    if (typeSatisfiesTrait(modules, moduleIndex, argument, constraint.traitName)) continue;
    throw genericCallError(
      module,
      tree,
      calleeIndex,
      `${argument} does not satisfy ${constraint.traitName} for ${constraint.parameter} in "${functionName}"`
    );
  }
}

function isKnownEnumType(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  return match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => modules[location.moduleIndex].symbols[location.symbolIndex].kind
      == ModuleSymbolKind.enumSymbol;
    none => false;
  };
}

function inferMatchArmStatementType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  statementIndex: usize,
  in expectedType: String,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): String throws ModuleResolveError {
  const kind = arena.nodes[statementIndex].kind;
  const expectedReturn = valueBindingType(bindings, "__z_native_return_type");
  if (
    kind == StatementKind.expressionStatement
    || kind == StatementKind.selectStatement
    || kind == StatementKind.matchStatement
  ) {
    return match (in arena.nodes[statementIndex].expression) {
      some(expression) => {
        const typeName = try inferExpressionTypeExpected(
          module,
          modules,
          moduleIndex,
          arena,
          expression,
          expectedType,
          inout bindings,
          inout evidence
        );
        let valueType = typeName.copyBytes(0, typeName.byteLength);
        if (expectedType.byteLength > 0) {
          try requireExpressionSyntaxType(
            module,
            modules,
            moduleIndex,
            expression,
            expectedType,
            typeName
          );
          valueType = expectedType.copyBytes(0, expectedType.byteLength);
        } else if (stringStartsWith(typeName, "view ")) {
          const target = typeName.copyBytes(5, typeName.byteLength);
          let visiting = Array<String>();
          if (!typeHasCleanup(modules, moduleIndex, target, visiting)) {
            valueType = target;
          }
        }
        try consumeOwnedExpressionSyntax(
          module,
          modules,
          moduleIndex,
          expression,
          valueType,
          inout bindings
        );
        return valueType;
      }
      none => "";
    };
  }
  if (kind == StatementKind.returnStatement || kind == StatementKind.throwStatement) {
    const continues = try inferStatement(
      module,
      modules,
      moduleIndex,
      arena,
      statementIndex,
      inout bindings,
      inout evidence,
      expectedReturn
    );
    if (!continues) return "__z_never";
    return "";
  }
  if (kind == StatementKind.blockStatement) {
    const children = copyIndices(arena.nodes[statementIndex].children);
    if (children.length == 0) return "";
    let index: usize = 0;
    while (index + 1 < children.length) {
      const continues = try inferStatement(
        module,
        modules,
        moduleIndex,
        arena,
        children[index],
        inout bindings,
        inout evidence,
        expectedReturn
      );
      if (!continues) return "__z_never";
      index = index + 1;
    }
    return try inferMatchArmStatementType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[children.length - 1],
      expectedType,
      inout bindings,
      inout evidence
    );
  }
  const continues = try inferStatement(
    module,
    modules,
    moduleIndex,
    arena,
    statementIndex,
    inout bindings,
    inout evidence,
    expectedReturn
  );
  if (!continues) return "__z_never";
  return "";
}

function addMatchArmValueBindings(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  armIndex: usize,
  in variant: NativeMatchVariant,
  borrowedMatch: boolean,
  inout bindings: Array<NativeValueBinding>
): void throws ModuleResolveError {
  let patternKind = "none";
  if (tree.nodes[armIndex].labels.length > 0) {
    patternKind = tree.nodes[armIndex].labels[0].copyBytes(
      0,
      tree.nodes[armIndex].labels[0].byteLength
    );
  }
  const hasPattern = patternKind != "none";
  const hasPayload = variant.payloadType.byteLength > 0;
  if (hasPayload != hasPattern) {
    const message = hasPayload
      ? "payload variant requires a binding"
      : "payloadless variant cannot bind a value";
    throw matchError(
      module,
      tree,
      armIndex,
      message
    );
  }
  if (!hasPattern) return;
  const patterns = copyIndices(tree.nodes[armIndex].children);
  if (patternKind == "binding" && patterns.length == 1) {
    let visiting = Array<String>();
    if (
      borrowedMatch
      && typeHasCleanup(modules, moduleIndex, variant.payloadType, visiting)
    ) {
      addMatchBorrowedValueBinding(
        inout bindings,
        tree.nodes[patterns[0]].value,
        variant.payloadType
      );
    } else {
      addValueBinding(
        inout bindings,
        tree.nodes[patterns[0]].value,
        variant.payloadType
      );
    }
    return;
  }
  if (patternKind != "object") return;
  const payloadModuleIndex = variant.payloadModuleIndex;
  const payloadType = variant.payloadType.copyBytes(0, variant.payloadType.byteLength);
  const knownAggregate = hasKnownAggregate(
    modules,
    payloadModuleIndex,
    payloadType
  );
  if (
    !knownAggregate
    && isDefinitelyNonMatchable(modules, payloadModuleIndex, payloadType)
  ) {
    throw matchError(module, tree, armIndex, "an object pattern requires a struct or class payload");
  }
  let coveredFields = Array<String>();
  for (const pattern of patterns) {
    const fieldName = tree.nodes[pattern].value.copyBytes(
      0,
      tree.nodes[pattern].value.byteLength
    );
    if (containsString(coveredFields, fieldName)) {
      throw matchError(module, tree, pattern, `duplicate object pattern field ${fieldName}`);
    }
    coveredFields.push(fieldName.copyBytes(0, fieldName.byteLength));
    let fieldType = "";
    match (aggregateFieldShape(
      modules,
      payloadModuleIndex,
      payloadType,
      fieldName
    )) {
      some(field) => {
        try requireVisibleField(
          module,
          modules,
          moduleIndex,
          tree,
          pattern,
          bindings,
          field
        );
        fieldType = field.typeName.copyBytes(0, field.typeName.byteLength);
      }
      none => {}
    }
    if (knownAggregate && fieldType.byteLength == 0) {
      throw matchError(
        module,
        tree,
        pattern,
        `payload ${payloadType} has no field ${fieldName}`
      );
    }
    const fieldChildren = copyIndices(tree.nodes[pattern].children);
    if (fieldChildren.length == 1) {
      let visiting = Array<String>();
      if (typeHasCleanup(modules, moduleIndex, fieldType, visiting)) {
        addMatchBorrowedValueBinding(
          inout bindings,
          tree.nodes[fieldChildren[0]].value,
          fieldType
        );
      } else {
        addValueBinding(
          inout bindings,
          tree.nodes[fieldChildren[0]].value,
          fieldType
        );
      }
    }
  }
}

function inferContextualObjectExpressionNode(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize,
  in expectedType: String,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): String throws ModuleResolveError {
  if (tree.nodes[index].kind != ExpressionKind.objectExpression) return "";
  let known = false;
  let genericParameters = Array<String>();
  match (typeSymbolLocation(modules, moduleIndex, expectedType)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          known = true;
          match (genericTypeShape(expectedType)) {
            some(generic) => {}
            none => {
              for (const parameter of signature.typeParameters) {
                genericParameters.push(parameter.copyBytes(0, parameter.byteLength));
              }
            }
          }
        }
        none => {}
      }
    }
    none => {}
  }
  if (!known) return "";
  const children = copyIndices(tree.nodes[index].children);
  let covered = Array<String>();
  let substitutions = Array<NativeValueBinding>();
  let childIndex: usize = 0;
  while (childIndex < children.length && childIndex < tree.nodes[index].labels.length) {
    const fieldName = tree.nodes[index].labels[childIndex].copyBytes(
      0,
      tree.nodes[index].labels[childIndex].byteLength
    );
    if (containsString(covered, fieldName)) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `duplicate field initializer "${fieldName}"`,
        tree.nodes[children[childIndex]].line,
        tree.nodes[children[childIndex]].column
      );
    }
    covered.push(fieldName.copyBytes(0, fieldName.byteLength));
    match (aggregateFieldShape(modules, moduleIndex, expectedType, fieldName)) {
      some(field) => {
        try requireVisibleField(
          module,
          modules,
          moduleIndex,
          tree,
          children[childIndex],
          bindings,
          field
        );
        const contextualFieldType = settledContextualType(
          field.typeName,
          genericParameters,
          substitutions
        );
        const actual = try inferExpressionNodeTypeExpected(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          children[childIndex],
          contextualFieldType,
          inout bindings,
          inout evidence
        );
        if (genericParameters.length > 0) {
          try bindGenericType(
            module,
            modules,
            moduleIndex,
            tree,
            children[childIndex],
            expectedType,
            field.typeName,
            actual,
            genericParameters,
            inout substitutions
          );
        }
        const concreteFieldType = substituteGenericType(
          field.typeName,
          substitutions
        );
        try requireExpressionType(
          module,
          modules,
          moduleIndex,
          tree,
          children[childIndex],
          concreteFieldType,
          actual
        );
        try consumeOwnedExpressionNode(
          module,
          modules,
          moduleIndex,
          tree,
          children[childIndex],
          concreteFieldType,
          false,
          inout bindings
        );
      }
      none => {
        throw resolutionError(
          ModuleResolveErrorKind.unknownMember,
          module.path,
          `type ${expectedType} has no field ${fieldName}`,
          tree.nodes[children[childIndex]].line,
          tree.nodes[children[childIndex]].column
        );
      }
    }
    childIndex = childIndex + 1;
  }
  match (typeSymbolLocation(modules, moduleIndex, expectedType)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          for (const field of signature.fields) {
            if (!containsString(covered, field.name)) {
              throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `missing field "${field.name}" when constructing ${expectedType}`,
                tree.nodes[index].line,
                tree.nodes[index].column
              );
            }
          }
        }
        none => {}
      }
    }
    none => {}
  }
  let arguments = Array<String>();
  for (const parameter of genericParameters) {
    const argument = valueBindingType(substitutions, parameter);
    if (argument.byteLength == 0) return "";
    arguments.push(argument);
  }
  let constraintSubstitutions = copyValueBindings(substitutions);
  match (genericTypeShape(expectedType)) {
    some(generic) => {
      match (typeSymbolLocation(modules, moduleIndex, expectedType)) {
        some(location) => {
          match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
            some(signature) => {
              let typeIndex: usize = 0;
              while (
                typeIndex < signature.typeParameters.length
                && typeIndex < generic.arguments.length
              ) {
                addValueBinding(
                  inout constraintSubstitutions,
                  signature.typeParameters[typeIndex],
                  generic.arguments[typeIndex]
                );
                typeIndex = typeIndex + 1;
              }
            }
            none => {}
          }
        }
        none => {}
      }
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, expectedType)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          let constraints = Array<ModuleTypeParameterConstraint>();
          for (const constraint of signature.typeParameterConstraints) {
            constraints.push(ModuleTypeParameterConstraint({
              parameter: constraint.parameter.copyBytes(0, constraint.parameter.byteLength),
              traitName: rebaseTypeName(
                modules,
                location.moduleIndex,
                moduleIndex,
                constraint.traitName
              ),
            }));
          }
          try requireGenericConstraints(
            module,
            modules,
            moduleIndex,
            tree,
            index,
            modules[location.moduleIndex].symbols[location.symbolIndex].name,
            constraints,
            constraintSubstitutions
          );
        }
        none => {}
      }
    }
    none => {}
  }
  if (genericParameters.length == 0) {
    return expectedType.copyBytes(0, expectedType.byteLength);
  }
  return parameterizedTypeName(expectedType, arguments);
}

function inferMatchExpressionNodeType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): String throws ModuleResolveError {
  const children = copyIndices(tree.nodes[index].children);
  if (children.length == 0) return "";
  const subjectType = try inferExpressionNodeType(
    module,
    modules,
    moduleIndex,
    arena,
    tree,
    children[0],
    inout bindings,
    inout evidence
  );
  try requireSettledExpressionType(module, tree, children[0], subjectType);
  if (subjectType.byteLength == 0) return "";
  const subjectIndex = children[0];
  const subjectRoot = expressionStorageRootName(tree, subjectIndex);
  const subjectRootType = valueBindingType(bindings, subjectRoot);
  let borrowedMatch = tree.nodes[index].value == "in";
  if (
    subjectRoot.byteLength > 0
    && valueBindingIsBorrowed(bindings, subjectRoot)
  ) borrowedMatch = true;
  if (
    tree.nodes[index].value == "in"
    && (
      subjectRoot.byteLength == 0
      || subjectRootType.byteLength == 0
    )
  ) {
    throw matchError(
      module,
      tree,
      subjectIndex,
      "match (in ...) requires stored enum storage"
    );
  }
  if (!borrowedMatch) {
    try consumeOwnedExpressionNode(
      module,
      modules,
      moduleIndex,
      tree,
      subjectIndex,
      subjectType,
      false,
      inout bindings
    );
  }
  let shapeOption = matchShape(modules, moduleIndex, subjectType);
  let shapeKnown = false;
  let shape = NativeMatchShape({ name: "", variants: Array<NativeMatchVariant>() });
  match (shapeOption) {
    some(known) => {
      shape = known;
      shapeKnown = true;
    }
    none => {}
  }
  if (!shapeKnown) {
    if (isDefinitelyNonMatchable(modules, moduleIndex, subjectType)) {
      throw matchError(module, tree, children[0], `match requires an enum value, found ${subjectType}`);
    }
    return "";
  }
  let covered = Array<String>();
  const expectedType = contextualExpectedType(bindings, tree, index);
  let resultType = "";
  let unresolvedArm = false;
  let hasContinuingArm = false;
  let hasContinuingFlow = false;
  let continuingBindings = copyValueBindings(bindings);
  let childIndex: usize = 1;
  while (childIndex < children.length) {
    const armIndex = children[childIndex];
    const variantName = tree.nodes[armIndex].value.copyBytes(
      0,
      tree.nodes[armIndex].value.byteLength
    );
    const variantIndex = matchVariantIndex(shape, variantName);
    if (variantIndex == shape.variants.length) {
      throw matchError(module, tree, armIndex, `unknown variant ${variantName}`);
    }
    if (containsString(covered, variantName)) {
      throw matchError(module, tree, armIndex, `duplicate match arm ${variantName}`);
    }
    covered.push(variantName.copyBytes(0, variantName.byteLength));
    let armBindings = copyValueBindings(bindings);
    if (borrowedMatch && subjectRoot.byteLength > 0) {
      borrowValueBindingInPlace(inout armBindings, subjectRoot);
    }
    try addMatchArmValueBindings(
      module,
      modules,
      moduleIndex,
      tree,
      armIndex,
      shape.variants[variantIndex],
      borrowedMatch,
      inout armBindings
    );
    const statements = copyIndices(tree.nodes[armIndex].statements);
    let armType = "";
    if (statements.length == 1) {
      armType = try inferMatchArmStatementType(
        module,
        modules,
        moduleIndex,
        arena,
        tree,
        statements[0],
        expectedType,
        inout armBindings,
        inout evidence
      );
    }
    if (armType != "__z_never") {
      if (!hasContinuingFlow) {
        continuingBindings = copyValueBindings(armBindings);
        hasContinuingFlow = true;
      } else {
        const previousBindings = copyValueBindings(continuingBindings);
        mergeBindingFlowStates(
          inout continuingBindings,
          previousBindings,
          armBindings
        );
      }
    }
    if (armType.byteLength == 0) unresolvedArm = true;
    else if (armType != "__z_never") {
      hasContinuingArm = true;
      if (resultType.byteLength == 0) resultType = armType.copyBytes(0, armType.byteLength);
      else if (!equivalentTypes(modules, moduleIndex, resultType, armType)) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `match arm produces ${armType}, but previous arms produce ${resultType}`,
          tree.nodes[armIndex].line,
          tree.nodes[armIndex].column
        );
      }
    }
    childIndex = childIndex + 1;
  }
  for (const variant of shape.variants) {
    if (!containsString(covered, variant.name)) {
      throw matchError(
        module,
        tree,
        index,
        `non-exhaustive match; missing ${shape.name}.${variant.name}`
      );
    }
  }
  if (hasContinuingFlow) {
    copyBindingFlowStates(inout bindings, continuingBindings);
  }
  if (unresolvedArm) return "";
  if (!hasContinuingArm) return "__z_never";
  return resultType;
}

function exportedFunctionLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): Option<ModuleSymbolLocation> {
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], name);
  if (
    symbolIndex < modules[moduleIndex].symbols.length
    && modules[moduleIndex].symbols[symbolIndex].exported
    && modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.functionSymbol
  ) return Option.some(ModuleSymbolLocation({ moduleIndex, symbolIndex }));
  return Option<ModuleSymbolLocation>.none;
}

function callableSymbolLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  calleeIndex: usize
): Option<ModuleSymbolLocation> {
  if (tree.nodes[calleeIndex].kind == ExpressionKind.identifierExpression) {
    const sourceName = tree.nodes[calleeIndex].value.copyBytes(
      0,
      tree.nodes[calleeIndex].value.byteLength
    );
    const name = identifierLookupName(sourceName);
    const symbolIndex = moduleSymbolIndex(modules[moduleIndex], name);
    if (symbolIndex < modules[moduleIndex].symbols.length) {
      if (modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.functionSymbol) {
        return Option.some(ModuleSymbolLocation({ moduleIndex, symbolIndex }));
      }
      if (modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.importedSymbol) {
        const importedName = modules[moduleIndex].symbols[symbolIndex].importedName.copyBytes(
          0,
          modules[moduleIndex].symbols[symbolIndex].importedName.byteLength
        );
        return match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
          some(target) => exportedFunctionLocation(modules, target, importedName);
          none => Option<ModuleSymbolLocation>.none;
        };
      }
    }
    return Option<ModuleSymbolLocation>.none;
  }
  if (
    tree.nodes[calleeIndex].kind == ExpressionKind.memberExpression
    && tree.nodes[calleeIndex].children.length == 1
  ) {
    const receiverIndex = tree.nodes[calleeIndex].children[0];
    if (tree.nodes[receiverIndex].kind != ExpressionKind.identifierExpression) {
      return Option<ModuleSymbolLocation>.none;
    }
    const namespace = tree.nodes[receiverIndex].value.copyBytes(
      0,
      tree.nodes[receiverIndex].value.byteLength
    );
    const member = tree.nodes[calleeIndex].value.copyBytes(
      0,
      tree.nodes[calleeIndex].value.byteLength
    );
    const memberName = identifierLookupName(member);
    const symbolIndex = moduleSymbolIndex(modules[moduleIndex], namespace);
    if (
      symbolIndex < modules[moduleIndex].symbols.length
      && modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.namespaceSymbol
    ) {
      return match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
        some(target) => exportedFunctionLocation(modules, target, memberName);
        none => Option<ModuleSymbolLocation>.none;
      };
    }
  }
  return Option<ModuleSymbolLocation>.none;
}

function callArgumentNodes(in children: Array<usize>): Array<usize> {
  let arguments = Array<usize>();
  let index: usize = 1;
  while (index < children.length) {
    arguments.push(children[index]);
    index = index + 1;
  }
  return arguments;
}

function inferExpressionNodeTypeExpected(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize,
  in expectedType: String,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): String throws ModuleResolveError {
  let expressionBindings = copyValueBindings(bindings);
  if (expectedType.byteLength > 0) {
    const bindingName = contextualExpectedBindingName(tree.nodes[index].offset);
    addValueBinding(inout expressionBindings, bindingName, expectedType);
  }
  const inferred = try inferExpressionNodeType(
    module,
    modules,
    moduleIndex,
    arena,
    tree,
    index,
    inout expressionBindings,
    inout evidence
  );
  copyBindingFlowStates(inout bindings, expressionBindings);
  return inferred;
}

function inferSignatureCallType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  calleeIndex: usize,
  callIndex: usize,
  in argumentNodes: Array<usize>,
  inout bindings: Array<NativeValueBinding>,
  in receiverRoot: String,
  in receiverMode: String,
  in functionName: String,
  in signature: ModuleFunctionSignature,
  in initialSubstitutions: Array<NativeValueBinding>,
  targetModuleIndex: usize,
  targetSymbolIndex: usize,
  in callKind: String,
  inout evidence: ModuleSemanticEvidence
): String throws ModuleResolveError {
  const argumentCount = argumentNodes.length;
  if (signature.parameterTypes.length != argumentCount) {
    throw genericCallError(
      module,
      tree,
      calleeIndex,
      `${functionName} expects ${signature.parameterTypes.length} argument(s), received ${argumentCount}`
    );
  }
  let accesses = Array<NativeCallAccess>();
  if (receiverRoot.byteLength > 0 && receiverMode.byteLength > 0) {
    try registerCallAccess(
      module,
      tree,
      calleeIndex,
      inout accesses,
      receiverRoot,
      receiverMode
    );
  }
  let accessIndex: usize = 0;
  while (accessIndex < argumentCount) {
    const nodeIndex = argumentNodes[accessIndex];
    const root = expressionStorageRootName(tree, nodeIndex);
    let capability = signature.parameterModes[accessIndex].copyBytes(
      0,
      signature.parameterModes[accessIndex].byteLength
    );
    if (
      capability == "value"
      && stringStartsWith(signature.parameterTypes[accessIndex], "Slice<")
    ) capability = "in";
    try registerCallAccess(
      module,
      tree,
      nodeIndex,
      inout accesses,
      root,
      capability
    );
    accessIndex = accessIndex + 1;
  }
  let substitutions = copyValueBindings(initialSubstitutions);
  let explicitTypeArguments = false;
  match (explicitCallTypeArguments(tree, calleeIndex)) {
    some(explicit) => {
      explicitTypeArguments = true;
      if (explicit.arguments.length != signature.typeParameters.length) {
        throw genericCallError(
          module,
          tree,
          calleeIndex,
          `${functionName} expects ${signature.typeParameters.length} type argument(s), received ${explicit.arguments.length}`
        );
      }
      let typeIndex: usize = 0;
      while (typeIndex < signature.typeParameters.length) {
        addValueBinding(
          inout substitutions,
          signature.typeParameters[typeIndex],
          explicit.arguments[typeIndex]
        );
        typeIndex = typeIndex + 1;
      }
    }
    none => {
      const expectedType = contextualExpectedType(bindings, tree, callIndex);
      if (expectedType.byteLength > 0) {
        try bindGenericType(
          module,
          modules,
          moduleIndex,
          tree,
          calleeIndex,
          functionName,
          signature.returnType,
          expectedType,
          signature.typeParameters,
          inout substitutions
        );
      }
    }
  }
  let valueTypeParameters = Array<String>();
  for (const typeParameter of signature.typeParameters) {
    const substituted = valueBindingType(substitutions, typeParameter);
    if (substituted.byteLength == 0) {
      valueTypeParameters.push(typeParameter.copyBytes(0, typeParameter.byteLength));
    }
  }
  let argumentTypes = Array<String>();
  let argumentIndex: usize = 0;
  while (argumentIndex < argumentCount) {
    const nodeIndex = argumentNodes[argumentIndex];
    const mode = signature.parameterModes[argumentIndex].copyBytes(
      0,
      signature.parameterModes[argumentIndex].byteLength
    );
    const argumentKind = tree.nodes[nodeIndex].kind;
    let access = "";
    let bindingName = "";
    let bindingIndex = nodeIndex;
    if (
      argumentKind == ExpressionKind.argumentReferenceExpression
      && tree.nodes[nodeIndex].children.length == 1
    ) {
      access = tree.nodes[nodeIndex].value.copyBytes(0, tree.nodes[nodeIndex].value.byteLength);
      bindingIndex = tree.nodes[nodeIndex].children[0];
      bindingName = identifierLookupName(tree.nodes[bindingIndex].value);
    }
    if (mode == "out" || mode == "inout") {
      if (access != mode) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `"${functionName}" requires ${mode} <mutable binding> for parameter ${argumentIndex + 1}`,
          tree.nodes[nodeIndex].line,
          tree.nodes[nodeIndex].column
        );
      }
      if (!valueBindingIsMutable(bindings, bindingName)) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `${mode} argument "${bindingName}" requires a mutable let binding`,
          tree.nodes[bindingIndex].line,
          tree.nodes[bindingIndex].column
        );
      }
      if (mode == "inout") {
        const initialization = valueBindingInitialization(bindings, bindingName);
        if (initialization != NativeInitializationState.initialized) {
          const message = initialization == NativeInitializationState.uninitialized
            ? `inout argument "${bindingName}" must be initialized before the call`
            : `inout argument "${bindingName}" may be uninitialized on another control-flow path`;
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            message,
            tree.nodes[bindingIndex].line,
            tree.nodes[bindingIndex].column
          );
        }
        const ownership = valueBindingOwnership(bindings, bindingName);
        if (ownership != NativeOwnershipState.available) {
          const message = ownership == NativeOwnershipState.moved
            ? `use of moved value "${bindingName}"`
            : `value "${bindingName}" may have moved on another control-flow path`;
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            message,
            tree.nodes[bindingIndex].line,
            tree.nodes[bindingIndex].column
          );
        }
      }
      argumentTypes.push(valueBindingType(bindings, bindingName));
    } else {
      if (access.byteLength > 0) {
        const expectation = mode == "in" ? "an immutable borrow" : "an owned value parameter";
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `${access} is not valid for ${expectation}`,
          tree.nodes[nodeIndex].line,
          tree.nodes[nodeIndex].column
        );
      }
      const expectedArgumentType = settledContextualType(
        signature.parameterTypes[argumentIndex],
        signature.typeParameters,
        substitutions
      );
      const argumentType = try inferExpressionNodeTypeExpected(
        module,
        modules,
        moduleIndex,
        arena,
        tree,
        nodeIndex,
        expectedArgumentType,
        inout bindings,
        inout evidence
      );
      if (
        mode == "value"
        && !stringStartsWith(signature.parameterTypes[argumentIndex], "Slice<")
      ) {
        try consumeOwnedExpressionNode(
          module,
          modules,
          moduleIndex,
          tree,
          nodeIndex,
          argumentType,
          false,
          inout bindings
        );
      }
      argumentTypes.push(argumentType);
    }
    if (!explicitTypeArguments) {
      try bindGenericType(
        module,
        modules,
        moduleIndex,
        tree,
        nodeIndex,
        functionName,
        signature.parameterTypes[argumentIndex],
        argumentTypes[argumentIndex],
        valueTypeParameters,
        inout substitutions
      );
    }
    argumentIndex = argumentIndex + 1;
  }
  for (const typeParameter of signature.typeParameters) {
    const substituted = valueBindingType(substitutions, typeParameter);
    if (substituted.byteLength == 0) return "";
  }
  try requireGenericConstraints(
    module,
    modules,
    moduleIndex,
    tree,
    calleeIndex,
    functionName,
    signature.typeParameterConstraints,
    substitutions
  );
  let parameterIndex: usize = 0;
  while (parameterIndex < argumentTypes.length) {
    const expected = substituteGenericType(
      signature.parameterTypes[parameterIndex],
      substitutions
    );
    try requireExpressionType(
      module,
      modules,
      moduleIndex,
      tree,
      argumentNodes[parameterIndex],
      expected,
      argumentTypes[parameterIndex]
    );
    parameterIndex = parameterIndex + 1;
  }
  parameterIndex = 0;
  while (parameterIndex < argumentTypes.length) {
    if (signature.parameterModes[parameterIndex] == "out") {
      const nodeIndex = argumentNodes[parameterIndex];
      const bindingIndex = tree.nodes[nodeIndex].children[0];
      const bindingName = identifierLookupName(tree.nodes[bindingIndex].value);
      setValueBindingInitialization(
        inout bindings,
        bindingName,
        NativeInitializationState.initialized
      );
      setValueBindingOwnership(
        inout bindings,
        bindingName,
        NativeOwnershipState.available
      );
    }
    parameterIndex = parameterIndex + 1;
  }
  let returnType = substituteGenericType(signature.returnType, substitutions);
  let errorType = "";
  if (signature.errorType.byteLength > 0) {
    errorType = substituteGenericType(signature.errorType, substitutions);
    match (throwingGeneratorHandleType(returnType, errorType)) {
      some(generatorType) => {
        returnType = generatorType;
      }
      none => {}
    }
  }
  if (substitutions.length > 0 && callKind != "value") {
    let typeParameters = Array<String>();
    let typeArguments = Array<String>();
    for (const substitution of substitutions) {
      typeParameters.push(substitution.name.copyBytes(0, substitution.name.byteLength));
      typeArguments.push(substitution.typeName.copyBytes(0, substitution.typeName.byteLength));
    }
    let parameterModes = Array<String>();
    let parameterTypes = Array<String>();
    let concreteIndex: usize = 0;
    while (concreteIndex < signature.parameterTypes.length) {
      parameterModes.push(signature.parameterModes[concreteIndex].copyBytes(
        0,
        signature.parameterModes[concreteIndex].byteLength
      ));
      parameterTypes.push(substituteGenericType(
        signature.parameterTypes[concreteIndex],
        substitutions
      ));
      concreteIndex = concreteIndex + 1;
    }
    evidence.callResolutions.push(ModuleCallResolution({
      offset: tree.nodes[callIndex].offset,
      line: tree.nodes[callIndex].line,
      column: tree.nodes[callIndex].column,
      targetModuleIndex,
      targetSymbolIndex,
      kind: callKind.copyBytes(0, callKind.byteLength),
      targetName: functionName.copyBytes(0, functionName.byteLength),
      asynchronous: signature.asynchronous,
      receiverMode: receiverMode.copyBytes(0, receiverMode.byteLength),
      typeParameters,
      typeArguments,
      parameterModes,
      parameterTypes,
      returnType: returnType.copyBytes(0, returnType.byteLength),
      errorType: errorType.copyBytes(0, errorType.byteLength),
    }));
  }
  if (signature.asynchronous) return "";
  if (errorType.byteLength > 0) {
    match (throwingGeneratorHandleType(returnType, errorType)) {
      some(generatorType) => return generatorType;
      none => {}
    }
    return pendingThrowingCallType(returnType, errorType);
  }
  return returnType;
}

function inferUnclassifiedCallArguments(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  in children: Array<usize>,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): void throws ModuleResolveError {
  let argumentTypes = Array<String>();
  let argumentIndex: usize = 1;
  while (argumentIndex < children.length) {
    const nodeIndex = children[argumentIndex];
    let awaitsForeignContext = false;
    if (tree.nodes[nodeIndex].kind == ExpressionKind.closureExpression) {
      for (const child of tree.nodes[nodeIndex].children) {
        if (
          tree.nodes[child].kind == ExpressionKind.closureParameterExpression
          && tree.nodes[child].labels[1].byteLength == 0
        ) awaitsForeignContext = true;
      }
    }
    if (awaitsForeignContext) {
      // Imported C/Objective-C/C++/Swift declarations are deliberately absent
      // from the stage-1 source-module graph. Stage 0 remains authoritative for
      // contextual closure typing at that boundary, so the native resolver must
      // defer instead of inventing a missing-type diagnostic.
      argumentTypes.push("");
      argumentIndex = argumentIndex + 2;
      continue;
    }
    const argumentType = try inferExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      nodeIndex,
      inout bindings,
      inout evidence
    );
    try requireSettledExpressionType(
      module,
      tree,
      nodeIndex,
      argumentType
    );
    if (
      tree.nodes[nodeIndex].kind == ExpressionKind.argumentReferenceExpression
      && tree.nodes[nodeIndex].value == "out"
      && tree.nodes[nodeIndex].children.length == 1
    ) {
      const bindingIndex = tree.nodes[nodeIndex].children[0];
      const bindingName = identifierLookupName(tree.nodes[bindingIndex].value);
      setValueBindingInitialization(
        inout bindings,
        bindingName,
        NativeInitializationState.initialized
      );
      setValueBindingOwnership(
        inout bindings,
        bindingName,
        NativeOwnershipState.available
      );
    }
    argumentTypes.push(argumentType);
    argumentIndex = argumentIndex + 1;
  }
}

function nativeClosureFunctionType(
  in tree: ExpressionTree,
  index: usize,
  in parameterModes: Array<String>,
  in parameterTypes: Array<String>,
  in returnType: String
): String {
  let output = TextBuffer();
  output.append("__z_native_function:");
  output.append("(");
  let first = true;
  let parameterIndex: usize = 0;
  for (const child of tree.nodes[index].children) {
    if (tree.nodes[child].kind != ExpressionKind.closureParameterExpression) continue;
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
  return output.finish();
}

function collectionMethodSignature(
  in ownerType: String,
  in methodName: String
): Option<ModuleFunctionSignature> {
  const generic = match (genericTypeShape(ownerType)) {
    some(generic) => generic;
    none => return Option<ModuleFunctionSignature>.none;
  };
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  let returnType = "";
  if (generic.base == "Map" && generic.arguments.length == 2) {
    const keyType = generic.arguments[0].copyBytes(0, generic.arguments[0].byteLength);
    const valueType = generic.arguments[1].copyBytes(0, generic.arguments[1].byteLength);
    if (methodName == "has") {
      parameterModes.push("in");
      parameterTypes.push(keyType.copyBytes(0, keyType.byteLength));
      returnType = "boolean";
    } else if (methodName == "get") {
      parameterModes.push("in");
      parameterTypes.push(keyType.copyBytes(0, keyType.byteLength));
      returnType = `Option<view ${valueType}>`;
    } else if (methodName == "set") {
      parameterModes.push("value");
      parameterTypes.push(keyType.copyBytes(0, keyType.byteLength));
      parameterModes.push("value");
      parameterTypes.push(valueType.copyBytes(0, valueType.byteLength));
      returnType = "void";
    } else if (methodName == "remove") {
      parameterModes.push("in");
      parameterTypes.push(keyType.copyBytes(0, keyType.byteLength));
      returnType = `Option<${valueType}>`;
    } else if (methodName == "clear") {
      returnType = "void";
    }
  } else if (generic.base == "Set" && generic.arguments.length == 1) {
    const elementType = generic.arguments[0].copyBytes(0, generic.arguments[0].byteLength);
    if (methodName == "has") {
      parameterModes.push("in");
      parameterTypes.push(elementType.copyBytes(0, elementType.byteLength));
      returnType = "boolean";
    } else if (methodName == "add") {
      parameterModes.push("value");
      parameterTypes.push(elementType.copyBytes(0, elementType.byteLength));
      returnType = "boolean";
    } else if (methodName == "remove") {
      parameterModes.push("in");
      parameterTypes.push(elementType.copyBytes(0, elementType.byteLength));
      returnType = `Option<${elementType}>`;
    } else if (methodName == "clear") {
      returnType = "void";
    }
  } else if (
    (
      generic.base == "Generator"
      || generic.base == "AsyncGenerator"
    )
    && (
      generic.arguments.length == 1
      || generic.arguments.length == 2
      || generic.arguments.length == 3
    )
    && methodName == "next"
  ) {
    const elementType = generic.arguments[0].copyBytes(
      0,
      generic.arguments[0].byteLength
    );
    if (generic.arguments.length == 1 || generic.arguments[1] == "void") {
      returnType = `Option<${elementType}>`;
    } else {
      returnType = `GeneratorStep<${elementType}, ${generic.arguments[1]}>`;
    }
    let errorType = "";
    if (generic.arguments.length == 3) {
      errorType = generic.arguments[2].copyBytes(
        0,
        generic.arguments[2].byteLength
      );
    }
    if (returnType.byteLength == 0) return Option<ModuleFunctionSignature>.none;
    return Option.some(ModuleFunctionSignature({
      asynchronous: generic.base == "AsyncGenerator",
      executorAffinity: "",
      typeParameters: Array<String>(),
      typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
      parameterModes,
      parameterTypes,
      returnType,
      errorType,
    }));
  }
  if (returnType.byteLength == 0) return Option<ModuleFunctionSignature>.none;
  return Option.some(ModuleFunctionSignature({
    asynchronous: false,
    executorAffinity: "",
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    parameterModes,
    parameterTypes,
    returnType,
    errorType: "",
  }));
}

function collectionMethodMutates(
  in ownerType: String,
  in methodName: String
): boolean {
  return match (genericTypeShape(ownerType)) {
    some(generic) => generic.base == "Map"
      ? methodName == "set" || methodName == "remove" || methodName == "clear"
      : generic.base == "Set"
        && (methodName == "add" || methodName == "remove" || methodName == "clear");
    none => false;
  };
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
            expectedSignature.parameterTypes.length != actualSignature.parameterTypes.length
            || expectedSignature.returnType.byteLength == 0
            || actualSignature.returnType.byteLength == 0
          ) return false;
          let index: usize = 0;
          while (index < expectedSignature.parameterTypes.length) {
            if (
              expectedSignature.parameterModes[index] != actualSignature.parameterModes[index]
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

function collectClosureExpressionCaptures(
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

function collectClosureStatementCaptures(
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

function inferExpressionNodeType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): String throws ModuleResolveError {
  const kind = tree.nodes[index].kind;
  const value = tree.nodes[index].value.copyBytes(0, tree.nodes[index].value.byteLength);
  const valueLength = value.byteLength;
  const children = copyIndices(tree.nodes[index].children);
  if (kind == ExpressionKind.numberExpression) return numberLiteralType(value);
  if (kind == ExpressionKind.stringExpression) return "String";
  if (kind == ExpressionKind.templateExpression) {
    for (const child of children) {
      if (tree.nodes[child].kind == ExpressionKind.templateTextExpression) continue;
      const embedded = try inferExpressionNodeType(
        module,
        modules,
        moduleIndex,
        arena,
        tree,
        child,
        inout bindings,
        inout evidence
      );
      try requireSettledExpressionType(module, tree, child, embedded);
    }
    return "String";
  }
  if (kind == ExpressionKind.booleanExpression) return "boolean";
  if (kind == ExpressionKind.nullExpression) return "null";
  if (
    kind == ExpressionKind.identifierExpression
    || kind == ExpressionKind.argumentBindingExpression
  ) {
    const lookup = identifierLookupName(value);
    try requireInitializedBinding(module, tree, index, bindings, lookup);
    return valueBindingType(bindings, lookup);
  }
  if (
    (kind == ExpressionKind.tryExpression || kind == ExpressionKind.attemptExpression)
    && children.length == 1
  ) {
    let enclosingError = "";
    if (kind == ExpressionKind.tryExpression) {
      enclosingError = valueBindingType(bindings, "__z_native_error_type");
      if (enclosingError.byteLength == 0) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "try requires an enclosing throwing function",
          tree.nodes[index].line,
          tree.nodes[index].column
        );
      }
    }
    const outcome = try inferExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[0],
      inout bindings,
      inout evidence
    );
    if (outcome.byteLength == 0) return "";
    match (pendingThrowingCallShape(outcome)) {
      some(call) => {
        if (kind == ExpressionKind.attemptExpression) {
          return `Result<${call.successType}, ${call.errorType}>`;
        }
        if (!equivalentTypes(modules, moduleIndex, enclosingError, call.errorType)) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `cannot propagate ${call.errorType} from a function throwing ${enclosingError}`,
            tree.nodes[index].line,
            tree.nodes[index].column
          );
        }
        return call.successType.copyBytes(0, call.successType.byteLength);
      }
      none => {
        const message = kind == ExpressionKind.attemptExpression
          ? "attempt requires a throwing function call"
          : "try requires a throwing function call";
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          message,
          tree.nodes[index].line,
          tree.nodes[index].column
        );
      }
    }
  }
  if (kind == ExpressionKind.newExpression) {
    match (typeSymbolLocation(modules, moduleIndex, value)) {
      some(location) => {
        if (
          modules[location.moduleIndex].symbols[location.symbolIndex].kind
          != ModuleSymbolKind.classSymbol
        ) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `new requires a class type; construct ${value} as ${value}({ ... })`,
            tree.nodes[index].line,
            tree.nodes[index].column
          );
        }
        match (
          in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature
        ) {
          some(typeSignature) => {
            match (in typeSignature.constructorSignature) {
              some(signature) => {
                let substitutions = Array<NativeValueBinding>();
                let callableSignature = rebaseModuleFunctionSignature(
                  modules,
                  location.moduleIndex,
                  moduleIndex,
                  signature
                );
                for (const constraint of typeSignature.typeParameterConstraints) {
                  callableSignature.typeParameterConstraints.push(ModuleTypeParameterConstraint({
                    parameter: constraint.parameter.copyBytes(0, constraint.parameter.byteLength),
                    traitName: rebaseTypeName(
                      modules,
                      location.moduleIndex,
                      moduleIndex,
                      constraint.traitName
                    ),
                  }));
                }
                match (genericTypeShape(value)) {
                  some(generic) => {
                    let typeIndex: usize = 0;
                    while (
                      typeIndex < typeSignature.typeParameters.length
                      && typeIndex < generic.arguments.length
                    ) {
                      addValueBinding(
                        inout substitutions,
                        typeSignature.typeParameters[typeIndex],
                        generic.arguments[typeIndex]
                      );
                      typeIndex = typeIndex + 1;
                    }
                    callableSignature.returnType = value.copyBytes(0, value.byteLength);
                  }
                  none => {
                    let typeIndex: usize = 0;
                    while (typeIndex < typeSignature.typeParameters.length) {
                      callableSignature.typeParameters.push(
                        typeSignature.typeParameters[typeIndex].copyBytes(
                          0,
                          typeSignature.typeParameters[typeIndex].byteLength
                        )
                      );
                      typeIndex = typeIndex + 1;
                    }
                    callableSignature.returnType = parameterizedTypeName(
                      value,
                      typeSignature.typeParameters
                    );
                  }
                }
                const targetName = modules[location.moduleIndex].symbols[
                  location.symbolIndex
                ].name.copyBytes(
                  0,
                  modules[location.moduleIndex].symbols[
                    location.symbolIndex
                  ].name.byteLength
                );
                return try inferSignatureCallType(
                  module,
                  modules,
                  moduleIndex,
                  arena,
                  tree,
                  index,
                  index,
                  children,
                  inout bindings,
                  "",
                  "",
                  `${targetName}.constructor`,
                  callableSignature,
                  substitutions,
                  location.moduleIndex,
                  location.symbolIndex,
                  "constructor",
                  inout evidence
                );
              }
              none => {
                if (
                  children.length != 1
                  || tree.nodes[children[0]].kind != ExpressionKind.objectExpression
                ) {
                  throw resolutionError(
                    ModuleResolveErrorKind.typeMismatch,
                    module.path,
                    "synthesized class initialization requires one object literal",
                    tree.nodes[index].line,
                    tree.nodes[index].column
                  );
                }
                const contextual = try inferContextualObjectExpressionNode(
                  module,
                  modules,
                  moduleIndex,
                  arena,
                  tree,
                  children[0],
                  value,
                  inout bindings,
                  inout evidence
                );
                if (contextual.byteLength > 0) return contextual;
              }
            }
          }
          none => {}
        }
      }
      none => {}
    }
    return "";
  }
  if (kind == ExpressionKind.variantExpression) {
    if (children.length == 2) {
      const variantName = tree.nodes[children[0]].value.copyBytes(
        0,
        tree.nodes[children[0]].value.byteLength
      );
      match (matchShape(modules, moduleIndex, value)) {
        some(shape) => {
          const variantIndex = matchVariantIndex(shape, variantName);
          if (variantIndex < shape.variants.length) {
            const expected = shape.variants[variantIndex].payloadType.copyBytes(
              0,
              shape.variants[variantIndex].payloadType.byteLength
            );
            let actual = "";
            if (tree.nodes[children[1]].kind == ExpressionKind.objectExpression) {
              actual = try inferContextualObjectExpressionNode(
                module,
                modules,
                moduleIndex,
                arena,
                tree,
                children[1],
                expected,
                inout bindings,
                inout evidence
              );
            } else {
              actual = try inferExpressionNodeType(
                module,
                modules,
                moduleIndex,
                arena,
                tree,
                children[1],
                inout bindings,
                inout evidence
              );
            }
            try requireExpressionType(
              module,
              modules,
              moduleIndex,
              tree,
              children[1],
              expected,
              actual
            );
            try consumeOwnedExpressionNode(
              module,
              modules,
              moduleIndex,
              tree,
              children[1],
              expected,
              false,
              inout bindings
            );
          }
        }
        none => {}
      }
    }
    return value.copyBytes(0, valueLength);
  }
  if (kind == ExpressionKind.matchExpression) {
    return try inferMatchExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      index,
      inout bindings,
      inout evidence
    );
  }
  if (kind == ExpressionKind.argumentReferenceExpression && children.length == 1) {
    if (value == "out") {
      const bindingName = identifierLookupName(tree.nodes[children[0]].value);
      return valueBindingType(bindings, bindingName);
    }
    return try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings, inout evidence);
  }
  if (kind == ExpressionKind.memberExpression && children.length == 1) {
    const receiverType = try inferExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[0],
      inout bindings,
      inout evidence
    );
    try requireSettledExpressionType(module, tree, children[0], receiverType);
    const memberName = identifierLookupName(value);
    if (receiverType.byteLength == 0) {
      const candidateType = typeExpressionName(tree, children[0]);
      match (matchShape(modules, moduleIndex, candidateType)) {
        some(shape) => {
          const variantIndex = matchVariantIndex(shape, memberName);
          if (
            variantIndex < shape.variants.length
            && shape.variants[variantIndex].payloadType.byteLength == 0
          ) return candidateType;
        }
        none => {}
      }
      return "";
    }
    match (genericTypeShape(receiverType)) {
      some(generic) => {
        if (
          memberName == "length"
          && (generic.base == "Map" || generic.base == "Set")
        ) return "usize";
      }
      none => {}
    }
    match (aggregateFieldShape(modules, moduleIndex, receiverType, memberName)) {
      some(field) => {
        try requireVisibleField(
          module,
          modules,
          moduleIndex,
          tree,
          index,
          bindings,
          field
        );
        return field.typeName.copyBytes(0, field.typeName.byteLength);
      }
      none => {}
    }
    if (hasKnownAggregate(modules, moduleIndex, receiverType)) {
      throw resolutionError(
        ModuleResolveErrorKind.unknownMember,
        module.path,
        `type ${receiverType} has no field ${memberName}`,
        tree.nodes[index].line,
        tree.nodes[index].column
      );
    }
    return "";
  }
  if (kind == ExpressionKind.unaryExpression && children.length == 1) {
    const operand = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings, inout evidence);
    try requireSettledExpressionType(module, tree, children[0], operand);
    if (operand.byteLength == 0) return "";
    if (value == "copy") {
      let copiedType = operand.copyBytes(0, operand.byteLength);
      if (stringStartsWith(copiedType, "view ")) {
        copiedType = copiedType.copyBytes(5, copiedType.byteLength);
      }
      let visiting = Array<String>();
      const copyable = typeSupportsExplicitCopy(modules, moduleIndex, copiedType, visiting);
      if (!copyable) {
        throw invalidOperator(module, tree, index, `type ${copiedType} cannot be explicitly copied`);
      }
      return copiedType;
    }
    if (value == "move") {
      if (stringStartsWith(operand, "view ")) {
        throw invalidOperator(module, tree, index, "cannot move a view because it does not own the referenced value");
      }
      let visiting = Array<String>();
      if (!typeHasCleanup(modules, moduleIndex, operand, visiting)) {
        throw invalidOperator(module, tree, index, `type ${operand} has no unique ownership to move`);
      }
      try consumeOwnedExpressionNode(
        module,
        modules,
        moduleIndex,
        tree,
        children[0],
        operand,
        true,
        inout bindings
      );
      return copiedString(operand);
    }
    if (value == "!" && operand == "boolean") return "boolean";
    if ((value == "+" || value == "-") && isNumericTypeName(operand)) return copiedString(operand);
    if (value == "~" && isIntegerTypeName(operand)) return copiedString(operand);
    const requirement = value == "!"
      ? "a boolean operand"
      : value == "~" ? "an integer operand" : "a numeric operand";
    throw invalidOperator(module, tree, index, `operator ${value} requires ${requirement}`);
  }
  if (kind == ExpressionKind.binaryExpression && children.length == 2) {
    let left = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings, inout evidence);
    try requireSettledExpressionType(module, tree, children[0], left);
    if (value == "&&" || value == "||") {
      const beforeRight = copyValueBindings(bindings);
      let rightBindings = copyValueBindings(bindings);
      const right = try inferExpressionNodeType(
        module,
        modules,
        moduleIndex,
        arena,
        tree,
        children[1],
        inout rightBindings,
        inout evidence
      );
      try requireSettledExpressionType(module, tree, children[1], right);
      mergeBindingFlowStates(inout bindings, beforeRight, rightBindings);
      if (left.byteLength == 0 || right.byteLength == 0) return "";
      if (left == "boolean" && right == "boolean") return "boolean";
      throw invalidOperator(module, tree, index, `operator ${value} requires boolean operands`);
    }
    let right = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[1], inout bindings, inout evidence);
    try requireSettledExpressionType(module, tree, children[1], right);
    if (left.byteLength == 0 || right.byteLength == 0) return "";
    if (isContextualNumericLiteral(tree, children[1]) && isNumericTypeName(left)) right = left.copyBytes(0, left.byteLength);
    else if (isContextualNumericLiteral(tree, children[0]) && isNumericTypeName(right)) left = right.copyBytes(0, right.byteLength);
    if (value == "+" || value == "-" || value == "*" || value == "/" || value == "%") {
      if (left == right && isNumericTypeName(left)) return copiedString(left);
      throw invalidOperator(module, tree, index, `operator ${value} requires matching numeric operands`);
    }
    if (value == "&" || value == "|" || value == "^" || value == "<<" || value == ">>") {
      if (left == right && isIntegerTypeName(left)) return copiedString(left);
      throw invalidOperator(module, tree, index, `operator ${value} requires matching integer operands`);
    }
    if (value == "<" || value == "<=" || value == ">" || value == ">=") {
      if (left == right && isNumericTypeName(left)) return "boolean";
      throw invalidOperator(module, tree, index, `operator ${value} requires matching numeric operands`);
    }
    if (value == "==" || value == "!=") {
      if (
        equivalentTypes(modules, moduleIndex, left, right)
        && (
          isNumericTypeName(left)
          || left == "boolean"
          || left == "String"
          || isKnownEnumType(modules, moduleIndex, left)
        )
      ) return "boolean";
      if ((left == "null" && isNullableTypeName(right)) || (right == "null" && isNullableTypeName(left))) return "boolean";
      throw invalidOperator(module, tree, index, `operator ${value} requires matching comparable operands`);
    }
    return "";
  }
  if (kind == ExpressionKind.valueBlockExpression) {
    const statements = copyIndices(tree.nodes[index].statements);
    if (statements.length == 0) return "";
    let blockBindings = copyValueBindings(bindings);
    const expectedReturn = valueBindingType(bindings, "__z_native_return_type");
    let statementIndex: usize = 0;
    while (statementIndex + 1 < statements.length) {
      const continues = try inferStatement(
        module,
        modules,
        moduleIndex,
        arena,
        statements[statementIndex],
        inout blockBindings,
        inout evidence,
        expectedReturn
      );
      if (!continues) return "__z_never";
      statementIndex = statementIndex + 1;
    }
    const expectedType = contextualExpectedType(bindings, tree, index);
    const result = try inferMatchArmStatementType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      statements[statements.length - 1],
      expectedType,
      inout blockBindings,
      inout evidence
    );
    copyBindingFlowStates(inout bindings, blockBindings);
    return result;
  }
  if (kind == ExpressionKind.ifExpression && children.length == 3) {
    const condition = try inferExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[0],
      inout bindings,
      inout evidence
    );
    try requireSettledExpressionType(module, tree, children[0], condition);
    if (condition.byteLength > 0) {
      try requireExpressionType(
        module,
        modules,
        moduleIndex,
        tree,
        children[0],
        "boolean",
        condition
      );
    }
    const expectedType = contextualExpectedType(bindings, tree, index);
    let thenBindings = copyValueBindings(bindings);
    let elseBindings = copyValueBindings(bindings);
    const thenType = try inferExpressionNodeTypeExpected(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[1],
      expectedType,
      inout thenBindings,
      inout evidence
    );
    const elseType = try inferExpressionNodeTypeExpected(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[2],
      expectedType,
      inout elseBindings,
      inout evidence
    );
    try requireSettledExpressionType(module, tree, children[1], thenType);
    try requireSettledExpressionType(module, tree, children[2], elseType);
    mergeBindingFlowStates(inout bindings, thenBindings, elseBindings);
    if (thenType == "__z_never") return elseType;
    if (elseType == "__z_never") return thenType;
    if (thenType.byteLength == 0 || elseType.byteLength == 0) return "";
    if (equivalentTypes(modules, moduleIndex, thenType, elseType)) {
      return thenType.copyBytes(0, thenType.byteLength);
    }
    throw resolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      `if-expression branches produce ${thenType} and ${elseType}`,
      tree.nodes[children[2]].line,
      tree.nodes[children[2]].column
    );
  }
  if (kind == ExpressionKind.whileExpression && children.length == 3) {
    const condition = try inferExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[0],
      inout bindings,
      inout evidence
    );
    try requireSettledExpressionType(module, tree, children[0], condition);
    if (condition.byteLength > 0) {
      try requireExpressionType(
        module,
        modules,
        moduleIndex,
        tree,
        children[0],
        "boolean",
        condition
      );
    }
    const expectedType = contextualExpectedType(bindings, tree, index);
    let elseBindings = copyValueBindings(bindings);
    const elseType = try inferExpressionNodeTypeExpected(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[2],
      expectedType,
      inout elseBindings,
      inout evidence
    );
    try requireSettledExpressionType(module, tree, children[2], elseType);
    let bodyBindings = copyValueBindings(bindings);
    let selectedType = elseType.copyBytes(0, elseType.byteLength);
    if (expectedType.byteLength > 0) {
      selectedType = expectedType.copyBytes(0, expectedType.byteLength);
    }
    const selectBinding = loopSelectTypeBindingName();
    addValueBinding(inout bodyBindings, selectBinding, selectedType);
    const bodyStatements = copyIndices(tree.nodes[children[1]].statements);
    const expectedReturn = valueBindingType(bindings, "__z_native_return_type");
    const bodyContinues = try inferStatementSequence(
      module,
      modules,
      moduleIndex,
      arena,
      bodyStatements,
      inout bodyBindings,
      inout evidence,
      expectedReturn
    );
    if (bodyContinues) {
      mergeBindingFlowStates(inout bindings, bodyBindings, elseBindings);
    } else {
      copyBindingFlowStates(inout bindings, elseBindings);
    }
    return elseType;
  }
  if (kind == ExpressionKind.forExpression && children.length == 4) {
    const iterableType = try inferExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[1],
      inout bindings,
      inout evidence
    );
    try requireSettledExpressionType(module, tree, children[1], iterableType);
    const elementType = iterationElementType(iterableType);
    const expectedType = contextualExpectedType(bindings, tree, index);
    let elseBindings = copyValueBindings(bindings);
    const elseType = try inferExpressionNodeTypeExpected(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[3],
      expectedType,
      inout elseBindings,
      inout evidence
    );
    try requireSettledExpressionType(module, tree, children[3], elseType);

    let bodyBindings = copyValueBindings(bindings);
    const patternChildren = copyIndices(tree.nodes[children[0]].children);
    for (const pattern of patternChildren) {
      if (tree.nodes[pattern].kind == ExpressionKind.matchBindingExpression) {
        addValueBinding(inout bodyBindings, tree.nodes[pattern].value, elementType);
      } else if (tree.nodes[pattern].kind == ExpressionKind.matchObjectFieldExpression) {
        const fieldType = iterationObjectFieldType(
          modules,
          moduleIndex,
          iterableType,
          tree.nodes[pattern].value
        );
        const fieldChildren = copyIndices(tree.nodes[pattern].children);
        if (fieldChildren.length > 0) {
          addValueBinding(
            inout bodyBindings,
            tree.nodes[fieldChildren[0]].value,
            fieldType
          );
        }
      }
    }
    let selectedType = elseType.copyBytes(0, elseType.byteLength);
    if (expectedType.byteLength > 0) {
      selectedType = expectedType.copyBytes(0, expectedType.byteLength);
    }
    const selectBinding = loopSelectTypeBindingName();
    addValueBinding(inout bodyBindings, selectBinding, selectedType);
    const bodyStatements = copyIndices(tree.nodes[children[2]].statements);
    const expectedReturn = valueBindingType(bindings, "__z_native_return_type");
    const bodyContinues = try inferStatementSequence(
      module,
      modules,
      moduleIndex,
      arena,
      bodyStatements,
      inout bodyBindings,
      inout evidence,
      expectedReturn
    );
    if (bodyContinues) {
      mergeBindingFlowStates(inout bindings, bodyBindings, elseBindings);
    } else {
      copyBindingFlowStates(inout bindings, elseBindings);
    }
    return elseType;
  }
  if (kind == ExpressionKind.conditionalExpression && children.length == 3) {
    const condition = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings, inout evidence);
    try requireSettledExpressionType(module, tree, children[0], condition);
    if (condition.byteLength > 0) {
      try requireExpressionType(module, modules, moduleIndex, tree, children[0], "boolean", condition);
    }
    let thenBindings = copyValueBindings(bindings);
    let elseBindings = copyValueBindings(bindings);
    const expectedType = contextualExpectedType(bindings, tree, index);
    const thenType = try inferExpressionNodeTypeExpected(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[1],
      expectedType,
      inout thenBindings,
      inout evidence
    );
    const elseType = try inferExpressionNodeTypeExpected(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[2],
      expectedType,
      inout elseBindings,
      inout evidence
    );
    try requireSettledExpressionType(module, tree, children[1], thenType);
    try requireSettledExpressionType(module, tree, children[2], elseType);
    if (thenType.byteLength == 0 || elseType.byteLength == 0) {
      mergeBindingFlowStates(inout bindings, thenBindings, elseBindings);
      return "";
    }
    if (equivalentTypes(modules, moduleIndex, thenType, elseType)) {
      try consumeOwnedExpressionNode(
        module,
        modules,
        moduleIndex,
        tree,
        children[1],
        thenType,
        false,
        inout thenBindings
      );
      try consumeOwnedExpressionNode(
        module,
        modules,
        moduleIndex,
        tree,
        children[2],
        elseType,
        false,
        inout elseBindings
      );
      mergeBindingFlowStates(inout bindings, thenBindings, elseBindings);
      return copiedString(thenType);
    }
    throw resolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      `conditional branches produce ${thenType} and ${elseType}`,
      tree.nodes[children[2]].line,
      tree.nodes[children[2]].column
    );
  }
  if (kind == ExpressionKind.arrayExpression) {
    if (children.length == 0) return "";
    let elementType = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings, inout evidence);
    try requireSettledExpressionType(module, tree, children[0], elementType);
    if (elementType.byteLength == 0) return "";
    try consumeOwnedExpressionNode(
      module,
      modules,
      moduleIndex,
      tree,
      children[0],
      elementType,
      false,
      inout bindings
    );
    let childIndex: usize = 1;
    while (childIndex < children.length) {
      const candidate = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[childIndex], inout bindings, inout evidence);
      try requireSettledExpressionType(module, tree, children[childIndex], candidate);
      if (candidate.byteLength == 0) return "";
      try requireExpressionType(module, modules, moduleIndex, tree, children[childIndex], elementType, candidate);
      try consumeOwnedExpressionNode(
        module,
        modules,
        moduleIndex,
        tree,
        children[childIndex],
        elementType,
        false,
        inout bindings
      );
      childIndex = childIndex + 1;
    }
    return `${elementType}[${children.length}]`;
  }
  if (kind == ExpressionKind.indexExpression && children.length == 2) {
    const owner = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings, inout evidence);
    const offset = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[1], inout bindings, inout evidence);
    try requireSettledExpressionType(module, tree, children[0], owner);
    try requireSettledExpressionType(module, tree, children[1], offset);
    if (offset.byteLength > 0 && !isIntegerTypeName(offset)) {
      throw invalidOperator(module, tree, children[1], `index requires an integer, found ${offset}`);
    }
    return arrayElementType(owner);
  }
  if (kind == ExpressionKind.closureExpression) {
    let returnType = "";
    let errorType = "";
    let bodyKind = "expression";
    if (tree.nodes[index].labels.length > 0) {
      returnType = tree.nodes[index].labels[0].copyBytes(
        0,
        tree.nodes[index].labels[0].byteLength
      );
    }
    if (tree.nodes[index].labels.length > 1) {
      errorType = tree.nodes[index].labels[1].copyBytes(
        0,
        tree.nodes[index].labels[1].byteLength
      );
    }
    if (tree.nodes[index].labels.length > 2) {
      bodyKind = tree.nodes[index].labels[2].copyBytes(
        0,
        tree.nodes[index].labels[2].byteLength
      );
    }
    if (errorType.byteLength > 0) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "throwing closure values are not implemented yet",
        tree.nodes[index].line,
        tree.nodes[index].column
      );
    }
    let contextualParameterModes = Array<String>();
    let contextualParameterTypes = Array<String>();
    const contextualType = contextualExpectedType(bindings, tree, index);
    match (nativeFunctionSignature(contextualType)) {
      some(signature) => {
        let closureParameterCount: usize = 0;
        for (const child of children) {
          if (tree.nodes[child].kind == ExpressionKind.closureParameterExpression) {
            closureParameterCount = closureParameterCount + 1;
          }
        }
        if (closureParameterCount != signature.parameterTypes.length) {
          throw resolutionError(
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
          contextualParameterTypes.push(parameterType.copyBytes(0, parameterType.byteLength));
        }
        if (returnType.byteLength == 0) {
          returnType = signature.returnType.copyBytes(0, signature.returnType.byteLength);
        } else if (!equivalentTypes(modules, moduleIndex, returnType, signature.returnType)) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `closure return type expects ${signature.returnType}, found ${returnType}`,
            tree.nodes[index].line,
            tree.nodes[index].column
          );
        }
      }
      none => {}
    }
    let localNames = Array<String>();
    let parameterNames = Array<String>();
    let resolvedParameterModes = Array<String>();
    let resolvedParameterTypes = Array<String>();
    let parameterIndex: usize = 0;
    for (const child of children) {
      if (tree.nodes[child].kind != ExpressionKind.closureParameterExpression) continue;
      const parameterName = tree.nodes[child].value.copyBytes(
        0,
        tree.nodes[child].value.byteLength
      );
      if (containsString(parameterNames, parameterName)) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `duplicate closure parameter "${parameterName}"`,
          tree.nodes[child].line,
          tree.nodes[child].column
        );
      }
      parameterNames.push(parameterName.copyBytes(0, parameterName.byteLength));
      localNames.push(parameterName.copyBytes(0, parameterName.byteLength));
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
          throw resolutionError(
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
        } else if (!equivalentTypes(modules, moduleIndex, parameterType, expectedParameterType)) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `closure parameter "${parameterName}" expects ${expectedParameterType}, found ${parameterType}`,
            tree.nodes[child].line,
            tree.nodes[child].column
          );
        }
      }
      if (parameterType.byteLength == 0) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `cannot infer the type of closure parameter "${parameterName}"`,
          tree.nodes[child].line,
          tree.nodes[child].column
        );
      }
      resolvedParameterModes.push(mode);
      resolvedParameterTypes.push(parameterType);
      parameterIndex = parameterIndex + 1;
    }
    let captures = Array<String>();
    if (bodyKind == "block") {
      let bodyNames = copyBindings(localNames);
      const statements = copyIndices(tree.nodes[index].statements);
      collectClosureStatementCaptures(
        arena,
        tree,
        statements,
        bindings,
        inout bodyNames,
        inout captures
      );
      if (returnType.byteLength == 0) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "a block-bodied closure requires an explicit or contextual return type",
          tree.nodes[index].line,
          tree.nodes[index].column
        );
      }
    } else {
      for (const child of children) {
        if (tree.nodes[child].kind == ExpressionKind.closureParameterExpression) continue;
        collectClosureExpressionCaptures(
          arena,
          tree,
          child,
          bindings,
          localNames,
          inout captures
        );
      }
    }
    let closureBindings = copyValueBindings(bindings);
    for (const capture of captures) {
      const initialization = valueBindingInitialization(bindings, capture);
      if (initialization != NativeInitializationState.initialized) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `cannot capture uninitialized value "${capture}"`,
          tree.nodes[index].line,
          tree.nodes[index].column
        );
      }
      const ownership = valueBindingOwnership(bindings, capture);
      if (ownership != NativeOwnershipState.available) {
        const message = ownership == NativeOwnershipState.moved
          ? `cannot capture moved value "${capture}"`
          : `cannot capture value "${capture}" because it may have moved`;
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          message,
          tree.nodes[index].line,
          tree.nodes[index].column
        );
      }
      const captureType = valueBindingType(bindings, capture);
      if (value == "move") {
        if (typeMovesOnOwnedUse(modules, moduleIndex, captureType)) {
          if (valueBindingIsBorrowed(bindings, capture)) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              `cannot move borrowed capture "${capture}"`,
              tree.nodes[index].line,
              tree.nodes[index].column
            );
          }
          setValueBindingOwnership(
            inout bindings,
            capture,
            NativeOwnershipState.moved
          );
        }
      } else {
        let visiting = Array<String>();
        if (typeHasCleanup(modules, moduleIndex, captureType, visiting)) {
          borrowClosureBindingInPlace(inout closureBindings, capture);
          borrowValueBindingInPlace(inout bindings, capture);
        }
      }
    }
    parameterIndex = 0;
    for (const child of children) {
      if (tree.nodes[child].kind != ExpressionKind.closureParameterExpression) continue;
      const parameterName = tree.nodes[child].value.copyBytes(
        0,
        tree.nodes[child].value.byteLength
      );
      const mode = resolvedParameterModes[parameterIndex].copyBytes(
        0,
        resolvedParameterModes[parameterIndex].byteLength
      );
      const parameterType = resolvedParameterTypes[parameterIndex].copyBytes(
        0,
        resolvedParameterTypes[parameterIndex].byteLength
      );
      if (mode == "inout") {
        addBorrowedValueBinding(inout closureBindings, parameterName, parameterType, true);
      } else if (mode == "out") {
        addUninitializedMutableValueBinding(
          inout closureBindings,
          parameterName,
          parameterType,
          true
        );
      } else if (mode == "in") {
        addBorrowedValueBinding(inout closureBindings, parameterName, parameterType, false);
      } else {
        addValueBinding(inout closureBindings, parameterName, parameterType);
      }
      parameterIndex = parameterIndex + 1;
    }
    addValueBinding(inout closureBindings, "__z_native_function_name", "closure");
    addValueBinding(inout closureBindings, "__z_native_return_type", returnType);
    if (bodyKind == "block") {
      const statements = copyIndices(tree.nodes[index].statements);
      try inferStatementSequence(
        module,
        modules,
        moduleIndex,
        arena,
        statements,
        inout closureBindings,
        inout evidence,
        returnType
      );
    } else {
      for (const child of children) {
        if (tree.nodes[child].kind == ExpressionKind.closureParameterExpression) continue;
        const actual = try inferExpressionNodeType(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          child,
          inout closureBindings,
          inout evidence
        );
        if (returnType.byteLength == 0) {
          returnType = actual.copyBytes(0, actual.byteLength);
        } else {
          try requireExpressionType(
            module,
            modules,
            moduleIndex,
            tree,
            child,
            returnType,
            actual
          );
        }
        try consumeOwnedExpressionNode(
          module,
          modules,
          moduleIndex,
          tree,
          child,
          returnType,
          false,
          inout closureBindings
        );
      }
    }
    return nativeClosureFunctionType(
      tree,
      index,
      resolvedParameterModes,
      resolvedParameterTypes,
      returnType
    );
  }
  if (kind == ExpressionKind.callExpression && children.length > 0) {
    const calleeIndex = children[0];
    if (
      tree.nodes[calleeIndex].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeIndex].children.length == 1
    ) {
      const enumReceiverIndex = tree.nodes[calleeIndex].children[0];
      const enumType = typeExpressionName(
        tree,
        enumReceiverIndex
      );
      const variantName = identifierLookupName(tree.nodes[calleeIndex].value);
      match (matchShape(modules, moduleIndex, enumType)) {
        some(shape) => {
          const variantIndex = matchVariantIndex(shape, variantName);
          if (variantIndex < shape.variants.length) {
            const expected = shape.variants[variantIndex].payloadType.copyBytes(
              0,
              shape.variants[variantIndex].payloadType.byteLength
            );
            if (expected.byteLength == 0 || children.length != 2) {
              const message = expected.byteLength == 0
                ? "payloadless variant does not accept a value"
                : "payload variant requires exactly one value";
              throw matchError(
                module,
                tree,
                calleeIndex,
                message
              );
            }
            let actual = "";
            if (tree.nodes[children[1]].kind == ExpressionKind.objectExpression) {
              actual = try inferContextualObjectExpressionNode(
                module,
                modules,
                moduleIndex,
                arena,
                tree,
                children[1],
                expected,
                inout bindings,
                inout evidence
              );
            } else {
              actual = try inferExpressionNodeType(
                module,
                modules,
                moduleIndex,
                arena,
                tree,
                children[1],
                inout bindings,
                inout evidence
              );
            }
            try requireExpressionType(
              module,
              modules,
              moduleIndex,
              tree,
              children[1],
              expected,
              actual
            );
            try consumeOwnedExpressionNode(
              module,
              modules,
              moduleIndex,
              tree,
              children[1],
              expected,
              false,
              inout bindings
            );
            return enumType;
          }
        }
        none => {}
      }
    }
    const constructionType = typeExpressionName(tree, calleeIndex);
    match (typeSymbolLocation(modules, moduleIndex, constructionType)) {
      some(location) => {
        const constructionKind = modules[location.moduleIndex].symbols[location.symbolIndex].kind;
        if (
          constructionKind == ModuleSymbolKind.structSymbol
          && children.length == 2
          && tree.nodes[children[1]].kind == ExpressionKind.objectExpression
          && !typeHasCustomConstructor(modules, moduleIndex, constructionType)
        ) {
          let expectedConstructionType = constructionType.copyBytes(
            0,
            constructionType.byteLength
          );
          const destinationType = contextualExpectedType(bindings, tree, index);
          match (genericTypeShape(destinationType)) {
            some(destination) => {
              let constructionBase = constructionType.copyBytes(
                0,
                constructionType.byteLength
              );
              match (genericTypeShape(constructionType)) {
                some(construction) => {
                  constructionBase = construction.base.copyBytes(
                    0,
                    construction.base.byteLength
                  );
                }
                none => {}
              }
              if (destination.base == constructionBase) {
                expectedConstructionType = destinationType.copyBytes(
                  0,
                  destinationType.byteLength
                );
              }
            }
            none => {}
          }
          const contextual = try inferContextualObjectExpressionNode(
            module,
            modules,
            moduleIndex,
            arena,
            tree,
            children[1],
            expectedConstructionType,
            inout bindings,
            inout evidence
          );
          if (contextual.byteLength > 0) return contextual;
        }
      }
      none => {}
    }
    if (tree.nodes[calleeIndex].kind == ExpressionKind.identifierExpression) {
      const callee = tree.nodes[calleeIndex].value.copyBytes(
        0,
        tree.nodes[calleeIndex].value.byteLength
      );
      const lookup = identifierLookupName(callee);
      const localType = valueBindingType(bindings, lookup);
      match (nativeFunctionSignature(localType)) {
        some(signature) => {
          const substitutions = Array<NativeValueBinding>();
          const arguments = callArgumentNodes(children);
          return try inferSignatureCallType(
            module,
            modules,
            moduleIndex,
            arena,
            tree,
            calleeIndex,
            index,
            arguments,
            inout bindings,
            "",
            "",
            lookup,
            signature,
            substitutions,
            0,
            0,
            "value",
            inout evidence
          );
        }
        none => {}
      }
      // A lexical value shadows a same-named module function. Its callability
      // remains unresolved until native value/function-type checking is complete.
      if (localType.byteLength > 0) {
        try inferUnclassifiedCallArguments(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          children,
          inout bindings,
          inout evidence
        );
        return "";
      }
      const base = identifierLookupName(callee);
      if (isNumericTypeName(base)) {
        try inferUnclassifiedCallArguments(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          children,
          inout bindings,
          inout evidence
        );
        return copiedString(base);
      }
      if (base == "Array" || base == "Map" || base == "Set") {
        try inferUnclassifiedCallArguments(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          children,
          inout bindings,
          inout evidence
        );
        return copiedString(callee);
      }
      for (const declaration of module.program.aggregates) {
        if (declaration.name == base) {
          try inferUnclassifiedCallArguments(
            module,
            modules,
            moduleIndex,
            arena,
            tree,
            children,
            inout bindings,
            inout evidence
          );
          return copiedString(callee);
        }
      }
    }
    const location = callableSymbolLocation(modules, moduleIndex, tree, calleeIndex);
    match (location) {
      some(location) => {
        match (in modules[location.moduleIndex].symbols[location.symbolIndex].functionSignature) {
          some(signature) => {
            const functionName = modules[location.moduleIndex].symbols[location.symbolIndex].name.copyBytes(
              0,
              modules[location.moduleIndex].symbols[location.symbolIndex].name.byteLength
            );
            const substitutions = Array<NativeValueBinding>();
            const callableSignature = rebaseModuleFunctionSignature(
              modules,
              location.moduleIndex,
              moduleIndex,
              signature
            );
            const argumentNodes = callArgumentNodes(children);
            return try inferSignatureCallType(
              module,
              modules,
              moduleIndex,
              arena,
              tree,
              calleeIndex,
              index,
              argumentNodes,
              inout bindings,
              "",
              "",
              functionName,
              callableSignature,
              substitutions,
              location.moduleIndex,
              location.symbolIndex,
              "function",
              inout evidence
            );
          }
          none => {}
        }
      }
      none => {}
    }
    if (
      tree.nodes[calleeIndex].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeIndex].children.length == 1
    ) {
      const receiverIndex = tree.nodes[calleeIndex].children[0];
      let ownerType = try inferExpressionNodeType(
        module,
        modules,
        moduleIndex,
        arena,
        tree,
        receiverIndex,
        inout bindings,
        inout evidence
      );
      try requireSettledExpressionType(module, tree, receiverIndex, ownerType);
      let staticMethod = false;
      if (ownerType.byteLength == 0) {
        const candidate = typeExpressionName(tree, receiverIndex);
        match (typeSymbolLocation(modules, moduleIndex, candidate)) {
          some(typeLocation) => {
            const typeKind = modules[typeLocation.moduleIndex].symbols[typeLocation.symbolIndex].kind;
            if (
              typeKind == ModuleSymbolKind.structSymbol
              || typeKind == ModuleSymbolKind.classSymbol
            ) {
              ownerType = candidate.copyBytes(0, candidate.byteLength);
              staticMethod = true;
            }
          }
          none => {}
        }
      }
      if (ownerType.byteLength > 0) {
        const methodName = identifierLookupName(tree.nodes[calleeIndex].value);
        match (collectionMethodSignature(ownerType, methodName)) {
          some(signature) => {
            let receiverRoot = "";
            let receiverAccess = "";
            if (collectionMethodMutates(ownerType, methodName)) {
              receiverRoot = expressionStorageRootName(tree, receiverIndex);
              if (
                receiverRoot.byteLength == 0
                || !valueBindingIsMutable(bindings, receiverRoot)
              ) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `mutable collection method "${methodName}" requires addressable let storage`,
                  tree.nodes[receiverIndex].line,
                  tree.nodes[receiverIndex].column
                );
              }
              receiverAccess = "inout";
            }
            const substitutions = Array<NativeValueBinding>();
            const argumentNodes = callArgumentNodes(children);
            return try inferSignatureCallType(
              module,
              modules,
              moduleIndex,
              arena,
              tree,
              calleeIndex,
              index,
              argumentNodes,
              inout bindings,
              receiverRoot,
              receiverAccess,
              `${ownerType}.${methodName}`,
              signature,
              substitutions,
              0,
              0,
              "value",
              inout evidence
            );
          }
          none => {}
        }
        match (callableMethodCallShape(
          modules,
          moduleIndex,
          bindings,
          ownerType,
          methodName,
          staticMethod
        )) {
          some(method) => {
            if (
              method.visibility == "private"
              && !activeOwnerMatchesMethod(modules, moduleIndex, bindings, method)
            ) {
              throw resolutionError(
                ModuleResolveErrorKind.unknownMember,
                module.path,
                `method "${method.name}" is private to type "${method.ownerName}"`,
                tree.nodes[calleeIndex].line,
                tree.nodes[calleeIndex].column
              );
            }
            if (
              !method.staticMethod
              && method.ownerTypeParameters.length != method.ownerTypeArguments.length
            ) return "";
            let receiverRoot = "";
            let receiverAccess = "";
            if (!method.staticMethod && method.receiverMode == "inout") {
              receiverRoot = expressionStorageRootName(tree, receiverIndex);
              if (receiverRoot.byteLength == 0) {
                let storageDescription = "addressable let storage";
                if (
                  modules[method.ownerModuleIndex].symbols[method.ownerSymbolIndex].kind
                  == ModuleSymbolKind.classSymbol
                ) storageDescription = "an addressable class reference";
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `mutable method "${method.name}" requires ${storageDescription}`,
                  tree.nodes[receiverIndex].line,
                  tree.nodes[receiverIndex].column
                );
              }
              const ownerKind = modules[method.ownerModuleIndex].symbols[method.ownerSymbolIndex].kind;
              if (
                (
                  ownerKind == ModuleSymbolKind.structSymbol
                  && !valueBindingIsMutable(bindings, receiverRoot)
                )
                || (
                  ownerKind == ModuleSymbolKind.classSymbol
                  && valueBindingIsBorrowed(bindings, receiverRoot)
                  && !valueBindingIsMutable(bindings, receiverRoot)
                )
              ) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `mutable method "${method.name}" cannot be called through immutable binding "${receiverRoot}"`,
                  tree.nodes[receiverIndex].line,
                  tree.nodes[receiverIndex].column
                );
              }
              receiverAccess = "inout";
            } else if (!method.staticMethod && method.receiverMode == "move") {
              receiverRoot = expressionStorageRootName(tree, receiverIndex);
              if (
                receiverRoot == "this"
                && valueBindingIsBorrowed(bindings, receiverRoot)
              ) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "cannot move the borrowed method receiver `this`; declare `move this`",
                  tree.nodes[receiverIndex].line,
                  tree.nodes[receiverIndex].column
                );
              }
              receiverAccess = "move";
            }
            let substitutions = Array<NativeValueBinding>();
            let ownerIndex: usize = 0;
            while (ownerIndex < method.ownerTypeParameters.length) {
              if (ownerIndex >= method.ownerTypeArguments.length) break;
              addValueBinding(
                inout substitutions,
                method.ownerTypeParameters[ownerIndex],
                method.ownerTypeArguments[ownerIndex]
              );
              ownerIndex = ownerIndex + 1;
            }
            const callableSignature = methodCallableSignature(method);
            const argumentNodes = callArgumentNodes(children);
            let callKind = "method";
            if (
              modules[method.ownerModuleIndex].symbols[method.ownerSymbolIndex].kind
              == ModuleSymbolKind.traitSymbol
            ) callKind = "value";
            const callType = try inferSignatureCallType(
              module,
              modules,
              moduleIndex,
              arena,
              tree,
              calleeIndex,
              index,
              argumentNodes,
              inout bindings,
              receiverRoot,
              receiverAccess,
              `${method.ownerName}.${method.name}`,
              callableSignature,
              substitutions,
              method.ownerModuleIndex,
              method.ownerSymbolIndex,
              callKind,
              inout evidence
            );
            if (receiverAccess == "move" && receiverRoot.byteLength > 0) {
              setValueBindingOwnership(
                inout bindings,
                receiverRoot,
                NativeOwnershipState.moved
              );
            }
            return callType;
          }
          none => {
            if (isActiveTypeParameter(bindings, ownerType)) {
              throw resolutionError(
                ModuleResolveErrorKind.unknownMember,
                module.path,
                `member "${methodName}" is not provided by the trait constraints on ${ownerType}`,
                tree.nodes[calleeIndex].line,
                tree.nodes[calleeIndex].column
              );
            }
            if (hasKnownAggregate(modules, moduleIndex, ownerType)) {
              let methodKind = "";
              if (staticMethod) methodKind = "static ";
              throw resolutionError(
                ModuleResolveErrorKind.unknownMember,
                module.path,
                `type ${ownerType} has no ${methodKind}method ${methodName}`,
                tree.nodes[calleeIndex].line,
                tree.nodes[calleeIndex].column
              );
            }
          }
        }
      }
    }
    try inferUnclassifiedCallArguments(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children,
      inout bindings,
      inout evidence
    );
    return "";
  }
  return "";
}

function inferExpressionTypeExpected(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in expression: ExpressionSyntax,
  in expectedType: String,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): String throws ModuleResolveError {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      let expressionBindings = copyValueBindings(bindings);
      if (expectedType.byteLength > 0) {
        const bindingName = contextualExpectedBindingName(tree.nodes[root].offset);
        addValueBinding(inout expressionBindings, bindingName, expectedType);
      }
      const inferred = try inferExpressionNodeType(
        module,
        modules,
        moduleIndex,
        arena,
        tree,
        root,
        inout expressionBindings,
        inout evidence
      );
      try requireSettledExpressionType(module, tree, root, inferred);
      let existingIndex: usize = 0;
      let recorded = false;
      while (existingIndex < evidence.expressionResolutions.length) {
        if (evidence.expressionResolutions[existingIndex].offset == tree.nodes[root].offset) {
          recorded = true;
        }
        existingIndex = existingIndex + 1;
      }
      if (!recorded && inferred.byteLength > 0 && inferred != "__z_never") {
        let typeIdentities = Array<ModuleTypeIdentity>();
        collectTypeIdentities(modules, moduleIndex, inferred, "", inout typeIdentities);
        evidence.expressionResolutions.push(ModuleExpressionResolution({
          offset: tree.nodes[root].offset,
          line: tree.nodes[root].line,
          column: tree.nodes[root].column,
          typeName: inferred.copyBytes(0, inferred.byteLength),
          typeIdentities,
        }));
      }
      copyBindingFlowStates(inout bindings, expressionBindings);
      select inferred;
    }
    none => "";
  };
}

function inferExpressionType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in expression: ExpressionSyntax,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): String throws ModuleResolveError {
  return try inferExpressionTypeExpected(
    module,
    modules,
    moduleIndex,
    arena,
    expression,
    "",
    inout bindings,
    inout evidence
  );
}

function requireExpressionSyntaxType(
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
      try requireExpressionType(module, modules, moduleIndex, tree, root, expected, actual);
    }
    none => {}
  }
}

function inferStatement(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  index: usize,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence,
  in expectedReturn: String
): boolean throws ModuleResolveError {
  const kind = arena.nodes[index].kind;
  const statementChildren = copyIndices(arena.nodes[index].children);
  if (kind == StatementKind.variableStatement) {
    let inferred = "";
    let contextualExpected = "";
    match (in arena.nodes[index].typeAnnotation) {
      some(type) => contextualExpected = type.name.copyBytes(0, type.name.byteLength);
      none => {}
    }
    match (in arena.nodes[index].expression) {
      some(expression) => inferred = try inferExpressionTypeExpected(
        module,
        modules,
        moduleIndex,
        arena,
        expression,
        contextualExpected,
        inout bindings,
        inout evidence
      );
      none => {}
    }
    let stored = inferred.copyBytes(0, inferred.byteLength);
    match (in arena.nodes[index].typeAnnotation) {
      some(type) => {
        match (in arena.nodes[index].expression) {
          some(expression) => try requireExpressionSyntaxType(
            module,
            modules,
            moduleIndex,
            expression,
            type.name,
            inferred
          );
          none => {}
        }
        const inferredFunctionType = nativeFunctionDisplayType(inferred);
        if (inferredFunctionType.byteLength == 0) {
          stored = type.name.copyBytes(0, type.name.byteLength);
        }
      }
      none => {
        match (in arena.nodes[index].expression) {
          some(expression) => {
            if (expression.offset >= arena.nodes[index].offset && stored.byteLength > 0) {
              let typeIdentities = Array<ModuleTypeIdentity>();
              collectTypeIdentities(modules, moduleIndex, stored, "", inout typeIdentities);
              evidence.bindingResolutions.push(ModuleBindingResolution({
                offset: arena.nodes[index].nameOffset,
                line: arena.nodes[index].nameLine,
                column: arena.nodes[index].nameColumn,
                name: arena.nodes[index].name.copyBytes(0, arena.nodes[index].name.byteLength),
                mutableBinding: arena.nodes[index].mutableBinding,
                typeName: stored.copyBytes(0, stored.byteLength),
                typeIdentities,
              }));
            }
          }
          none => {}
        }
      }
    }
    match (in arena.nodes[index].expression) {
      some(expression) => try consumeOwnedExpressionSyntax(
        module,
        modules,
        moduleIndex,
        expression,
        stored,
        inout bindings
      );
      none => {}
    }
    if (arena.nodes[index].mutableBinding) {
      match (in arena.nodes[index].expression) {
        some(expression) => addMutableValueBinding(
          inout bindings,
          arena.nodes[index].name,
          stored
        );
        none => addUninitializedMutableValueBinding(
          inout bindings,
          arena.nodes[index].name,
          stored,
          false
        );
      }
    } else {
      addValueBinding(inout bindings, arena.nodes[index].name, stored);
    }
    return true;
  }
  if (kind == StatementKind.destructureStatement) {
    let inferred = "";
    let sourceType = "";
    match (in arena.nodes[index].typeAnnotation) {
      some(type) => sourceType = type.name.copyBytes(0, type.name.byteLength);
      none => {}
    }
    match (in arena.nodes[index].expression) {
      some(expression) => {
        inferred = try inferExpressionTypeExpected(
          module,
          modules,
          moduleIndex,
          arena,
          expression,
          sourceType,
          inout bindings,
          inout evidence
        );
        if (sourceType.byteLength > 0) {
          try requireExpressionSyntaxType(
            module,
            modules,
            moduleIndex,
            expression,
            sourceType,
            inferred
          );
        } else {
          sourceType = inferred.copyBytes(0, inferred.byteLength);
        }
        try consumeOwnedExpressionSyntax(
          module,
          modules,
          moduleIndex,
          expression,
          sourceType,
          inout bindings
        );
      }
      none => {}
    }
    for (const binding of arena.nodes[index].objectBindings) {
      let fieldType = "";
      match (aggregateFieldShape(modules, moduleIndex, sourceType, binding.fieldName)) {
        some(field) => fieldType = field.typeName.copyBytes(0, field.typeName.byteLength);
        none => {}
      }
      let typeIdentities = Array<ModuleTypeIdentity>();
      collectTypeIdentities(modules, moduleIndex, fieldType, "", inout typeIdentities);
      evidence.bindingResolutions.push(ModuleBindingResolution({
        offset: binding.bindingOffset,
        line: binding.bindingLine,
        column: binding.bindingColumn,
        name: binding.bindingName.copyBytes(0, binding.bindingName.byteLength),
        mutableBinding: arena.nodes[index].mutableBinding,
        typeName: fieldType.copyBytes(0, fieldType.byteLength),
        typeIdentities,
      }));
      if (arena.nodes[index].mutableBinding) {
        addMutableValueBinding(inout bindings, binding.bindingName, fieldType);
      } else {
        addValueBinding(inout bindings, binding.bindingName, fieldType);
      }
    }
    return true;
  }
  if (kind == StatementKind.assignmentStatement) {
    let expected = "";
    match (in arena.nodes[index].expression) {
      some(target) => {
        match (in target.tree) {
          some(tree) => {
            const root = tree.root;
            if (tree.nodes[root].kind == ExpressionKind.identifierExpression) {
              expected = valueBindingType(bindings, tree.nodes[root].value);
              if (!valueBindingIsMutable(bindings, tree.nodes[root].value)) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `cannot assign to immutable binding "${tree.nodes[root].value}"`,
                  tree.nodes[root].line,
                  tree.nodes[root].column
                );
              }
            } else {
              expected = try inferExpressionNodeType(
                module,
                modules,
                moduleIndex,
                arena,
                tree,
                root,
                inout bindings,
                inout evidence
              );
            }
            if (
              tree.nodes[root].kind == ExpressionKind.memberExpression
              && tree.nodes[root].children.length == 1
            ) {
              const receiverIndex = tree.nodes[root].children[0];
              const receiverType = try inferExpressionNodeType(
                module,
                modules,
                moduleIndex,
                arena,
                tree,
                receiverIndex,
                inout bindings,
                inout evidence
              );
              const memberName = identifierLookupName(tree.nodes[root].value);
              match (aggregateFieldShape(modules, moduleIndex, receiverType, memberName)) {
                some(field) => {
                  const constructorType = valueBindingType(
                    bindings,
                    "__z_native_constructor_type"
                  );
                  const initializesThis = tree.nodes[receiverIndex].kind
                    == ExpressionKind.identifierExpression
                    && tree.nodes[receiverIndex].value == "this";
                  if (
                    field.readonlyField
                    && (constructorType.byteLength == 0 || !initializesThis)
                  ) {
                    throw resolutionError(
                      ModuleResolveErrorKind.unknownMember,
                      module.path,
                      `cannot assign to readonly field "${field.name}"`,
                      tree.nodes[root].line,
                      tree.nodes[root].column
                    );
                  }
                }
                none => {}
              }
            }
          }
          none => {}
        }
      }
      none => {}
    }
    match (in arena.nodes[index].secondExpression) {
      some(value) => {
        const actual = try inferExpressionTypeExpected(
          module,
          modules,
          moduleIndex,
          arena,
          value,
          expected,
          inout bindings,
          inout evidence
        );
        if (expected.byteLength > 0) {
          try requireExpressionSyntaxType(
            module,
            modules,
            moduleIndex,
            value,
            expected,
            actual
          );
        }
        let consumedType = expected.copyBytes(0, expected.byteLength);
        if (consumedType.byteLength == 0) {
          consumedType = actual.copyBytes(0, actual.byteLength);
        }
        try consumeOwnedExpressionSyntax(
          module,
          modules,
          moduleIndex,
          value,
          consumedType,
          inout bindings
        );
      }
      none => {}
    }
    match (in arena.nodes[index].expression) {
      some(target) => {
        match (in target.tree) {
          some(tree) => {
            const targetRoot = tree.root;
            if (tree.nodes[targetRoot].kind == ExpressionKind.identifierExpression) {
              setValueBindingInitialization(
                inout bindings,
                tree.nodes[targetRoot].value,
                NativeInitializationState.initialized
              );
              setValueBindingOwnership(
                inout bindings,
                tree.nodes[targetRoot].value,
                NativeOwnershipState.available
              );
            } else if (typeMovesOnOwnedUse(modules, moduleIndex, expected)) {
              const rootName = expressionStorageRootName(tree, targetRoot);
              if (
                rootName.byteLength > 0
                && valueBindingOwnership(bindings, rootName)
                  != NativeOwnershipState.available
              ) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `cannot replace a field after its owner "${rootName}" moves while evaluating the new value`,
                  tree.nodes[targetRoot].line,
                  tree.nodes[targetRoot].column
                );
              }
            }
          }
          none => {}
        }
      }
      none => {}
    }
    return true;
  }
  if (kind == StatementKind.throwStatement) {
    const expectedError = valueBindingType(bindings, "__z_native_error_type");
    if (expectedError.byteLength == 0) {
      let functionName = valueBindingType(bindings, "__z_native_function_name");
      if (functionName.byteLength == 0) functionName = "function";
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `function "${functionName}" does not declare an error type`,
        arena.nodes[index].line,
        arena.nodes[index].column
      );
    }
    match (in arena.nodes[index].expression) {
      some(expression) => {
        const actual = try inferExpressionTypeExpected(
          module,
          modules,
          moduleIndex,
          arena,
          expression,
          expectedError,
          inout bindings,
          inout evidence
        );
        try requireExpressionSyntaxType(
          module,
          modules,
          moduleIndex,
          expression,
          expectedError,
          actual
        );
        try consumeOwnedExpressionSyntax(
          module,
          modules,
          moduleIndex,
          expression,
          expectedError,
          inout bindings
        );
      }
      none => {}
    }
    return false;
  }
  if (kind == StatementKind.yieldStatement) {
    const expectedYield = valueBindingType(bindings, "__z_native_yield_type");
    match (in arena.nodes[index].expression) {
      some(expression) => {
        const actual = try inferExpressionTypeExpected(
          module,
          modules,
          moduleIndex,
          arena,
          expression,
          expectedYield,
          inout bindings,
          inout evidence
        );
        if (expectedYield.byteLength > 0) {
          try requireExpressionSyntaxType(
            module,
            modules,
            moduleIndex,
            expression,
            expectedYield,
            actual
          );
        }
        try consumeOwnedExpressionSyntax(
          module,
          modules,
          moduleIndex,
          expression,
          expectedYield,
          inout bindings
        );
      }
      none => {}
    }
    return true;
  }
  if (
    kind == StatementKind.expressionStatement
    || kind == StatementKind.matchStatement
  ) {
    match (in arena.nodes[index].expression) {
      some(expression) => {
        const expressionType = try inferExpressionType(
          module,
          modules,
          moduleIndex,
          arena,
          expression,
          inout bindings,
          inout evidence
        );
        if (expressionType == "__z_never") return false;
      }
      none => {}
    }
    return true;
  }
  if (kind == StatementKind.returnStatement || kind == StatementKind.selectStatement) {
    match (in arena.nodes[index].expression) {
      some(expression) => {
        let contextualExpected = "";
        if (kind == StatementKind.returnStatement) {
          contextualExpected = expectedReturn.copyBytes(0, expectedReturn.byteLength);
        } else {
          const selectBinding = loopSelectTypeBindingName();
          contextualExpected = valueBindingType(bindings, selectBinding);
        }
        const actual = try inferExpressionTypeExpected(
          module,
          modules,
          moduleIndex,
          arena,
          expression,
          contextualExpected,
          inout bindings,
          inout evidence
        );
        if (
          (kind == StatementKind.returnStatement && expectedReturn.byteLength > 0)
          || (kind == StatementKind.selectStatement && contextualExpected.byteLength > 0)
        ) {
          try requireExpressionSyntaxType(
            module,
            modules,
            moduleIndex,
            expression,
            contextualExpected,
            actual
          );
        }
        let consumedType = actual.copyBytes(0, actual.byteLength);
        if (contextualExpected.byteLength > 0) {
          consumedType = contextualExpected.copyBytes(0, contextualExpected.byteLength);
        }
        try consumeOwnedExpressionSyntax(
          module,
          modules,
          moduleIndex,
          expression,
          consumedType,
          inout bindings
        );
      }
      none => {
        if (kind == StatementKind.returnStatement && expectedReturn != "void") {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `expected ${expectedReturn}, found void`,
            arena.nodes[index].line,
            arena.nodes[index].column
          );
        }
      }
    }
    if (kind == StatementKind.returnStatement) {
      try requireInitializedOutputParameters(
        module,
        arena.nodes[index].line,
        arena.nodes[index].column,
        bindings
      );
    }
    return false;
  }
  if (kind == StatementKind.ifStatement || kind == StatementKind.whileStatement) {
    match (in arena.nodes[index].expression) {
      some(condition) => {
        const actual = try inferExpressionType(module, modules, moduleIndex, arena, condition, inout bindings, inout evidence);
        if (actual.byteLength > 0) {
          try requireExpressionSyntaxType(
            module,
            modules,
            moduleIndex,
            condition,
            "boolean",
            actual
          );
        }
      }
      none => {}
    }
  }
  if (kind == StatementKind.ifStatement) {
    let thenBindings = copyValueBindings(bindings);
    let elseBindings = copyValueBindings(bindings);
    let thenContinues = true;
    let elseContinues = true;
    if (statementChildren.length > 0) {
      thenContinues = try inferStatement(
        module,
        modules,
        moduleIndex,
        arena,
        statementChildren[0],
        inout thenBindings,
        inout evidence,
        expectedReturn
      );
    }
    if (statementChildren.length > 1) {
      elseContinues = try inferStatement(
        module,
        modules,
        moduleIndex,
        arena,
        statementChildren[1],
        inout elseBindings,
        inout evidence,
        expectedReturn
      );
    }
    if (thenContinues && elseContinues) {
      mergeBindingFlowStates(
        inout bindings,
        thenBindings,
        elseBindings
      );
    } else if (thenContinues) {
      copyBindingFlowStates(inout bindings, thenBindings);
    } else if (elseContinues) {
      copyBindingFlowStates(inout bindings, elseBindings);
    }
    return thenContinues || elseContinues;
  }
  if (kind == StatementKind.whileStatement) {
    const beforeLoop = copyValueBindings(bindings);
    let loopBindings = copyValueBindings(bindings);
    const loopContinues = try inferStatementSequence(
      module,
      modules,
      moduleIndex,
      arena,
      statementChildren,
      inout loopBindings,
      inout evidence,
      expectedReturn
    );
    if (loopContinues) {
      mergeBindingFlowStates(
        inout bindings,
        beforeLoop,
        loopBindings
      );
    } else {
      copyBindingFlowStates(inout bindings, beforeLoop);
    }
    return true;
  }
  if (
    kind == StatementKind.forStatement
    || kind == StatementKind.forAwaitStatement
    || kind == StatementKind.forTryAwaitStatement
  ) {
    const beforeLoop = copyValueBindings(bindings);
    let loopBindings = copyValueBindings(bindings);
    let elementType = "";
    let iterableType = "";
    match (in arena.nodes[index].expression) {
      some(iterable) => {
        iterableType = try inferExpressionType(module, modules, moduleIndex, arena, iterable, inout bindings, inout evidence);
        elementType = iterationElementType(iterableType);
      }
      none => {}
    }
    if (arena.nodes[index].name.byteLength > 0) {
      addValueBinding(inout loopBindings, arena.nodes[index].name, elementType);
    }
    for (const binding of arena.nodes[index].objectBindings) {
      const fieldType = iterationObjectFieldType(
        modules,
        moduleIndex,
        iterableType,
        binding.fieldName
      );
      addValueBinding(inout loopBindings, binding.bindingName, fieldType);
    }
    const loopContinues = try inferStatementSequence(
      module,
      modules,
      moduleIndex,
      arena,
      statementChildren,
      inout loopBindings,
      inout evidence,
      expectedReturn
    );
    if (loopContinues) {
      mergeBindingFlowStates(
        inout bindings,
        beforeLoop,
        loopBindings
      );
    } else {
      copyBindingFlowStates(inout bindings, beforeLoop);
    }
    return true;
  }
  if (kind == StatementKind.asyncScopeStatement) {
    let scopeBindings = copyValueBindings(bindings);
    if (arena.nodes[index].name.byteLength > 0) {
      addValueBinding(inout scopeBindings, arena.nodes[index].name, "TaskScope");
    }
    const scopeContinues = try inferStatementSequence(
      module,
      modules,
      moduleIndex,
      arena,
      statementChildren,
      inout scopeBindings,
      inout evidence,
      expectedReturn
    );
    if (scopeContinues) copyBindingFlowStates(inout bindings, scopeBindings);
    return scopeContinues;
  }
  let nestedBindings = copyValueBindings(bindings);
  const nestedContinues = try inferStatementSequence(
    module,
    modules,
    moduleIndex,
    arena,
    statementChildren,
    inout nestedBindings,
    inout evidence,
    expectedReturn
  );
  if (nestedContinues) copyBindingFlowStates(inout bindings, nestedBindings);
  return nestedContinues;
}

function inferStatementSequence(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in indices: Array<usize>,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence,
  in expectedReturn: String
): boolean throws ModuleResolveError {
  for (const index of indices) {
    const continues = try inferStatement(
      module,
      modules,
      moduleIndex,
      arena,
      index,
      inout bindings,
      inout evidence,
      expectedReturn
    );
    if (!continues) return false;
  }
  return true;
}

function functionValueBindings(in parameters: Array<Parameter>): Array<NativeValueBinding> {
  let bindings = Array<NativeValueBinding>();
  for (const parameter of parameters) {
    if (parameter.mode == ParameterMode.inputOutput) {
      addBorrowedValueBinding(
        inout bindings,
        parameter.name,
        parameter.type.name,
        true
      );
    } else if (parameter.mode == ParameterMode.output) {
      addUninitializedMutableValueBinding(
        inout bindings,
        parameter.name,
        parameter.type.name,
        true
      );
    } else if (parameter.mode == ParameterMode.input) {
      addBorrowedValueBinding(
        inout bindings,
        parameter.name,
        parameter.type.name,
        false
      );
    } else {
      addValueBinding(inout bindings, parameter.name, parameter.type.name);
    }
  }
  return bindings;
}

function statementContainsYield(
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind == StatementKind.yieldStatement) return true;
  for (const child of arena.nodes[index].children) {
    if (statementContainsYield(arena, child)) return true;
  }
  match (in arena.nodes[index].expression) {
    some(expression) => {
      match (in expression.tree) {
        some(tree) => {
          const root = tree.root;
          if (expressionNodeContainsYield(arena, tree, root)) return true;
        }
        none => {}
      }
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(expression) => {
      match (in expression.tree) {
        some(tree) => {
          const root = tree.root;
          if (expressionNodeContainsYield(arena, tree, root)) return true;
        }
        none => {}
      }
    }
    none => {}
  }
  return false;
}

function expressionNodeContainsYield(
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize
): boolean {
  for (const statement of tree.nodes[index].statements) {
    if (statementContainsYield(arena, statement)) return true;
  }
  for (const child of tree.nodes[index].children) {
    if (expressionNodeContainsYield(arena, tree, child)) return true;
  }
  return false;
}

function statementArenaContainsYield(in arena: StatementArena): boolean {
  for (const root of arena.roots) {
    if (statementContainsYield(arena, root)) return true;
  }
  return false;
}

function inferFunctionExpressions(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in declaration: FunctionDeclaration,
  in ownerType: String,
  in inheritedTypeParameters: Array<TypeParameter>,
  inout evidence: ModuleSemanticEvidence
): void throws ModuleResolveError {
  let bindings = functionValueBindings(declaration.parameters);
  let bodyReturnType = declaration.returnType.name.copyBytes(
    0,
    declaration.returnType.name.byteLength
  );
  if (statementArenaContainsYield(declaration.body)) {
    match (genericTypeShape(declaration.returnType.name)) {
      some(generator) => {
        if (
          generator.base == "Generator"
          || generator.base == "AsyncGenerator"
        ) {
          if (generator.arguments.length > 0) {
            addValueBinding(
              inout bindings,
              "__z_native_yield_type",
              generator.arguments[0]
            );
          }
          if (
            generator.arguments.length >= 2
            && generator.arguments[1] != "void"
          ) {
            bodyReturnType = generator.arguments[1].copyBytes(
              0,
              generator.arguments[1].byteLength
            );
          } else {
            bodyReturnType = "void";
          }
        }
      }
      none => {}
    }
  }
  addTypeParameterBindings(inout bindings, inheritedTypeParameters);
  addTypeParameterBindings(inout bindings, declaration.typeParameters);
  addValueBinding(inout bindings, "__z_native_function_name", declaration.name);
  addValueBinding(inout bindings, "__z_native_return_type", declaration.returnType.name);
  match (in declaration.errorType) {
    some(error) => addValueBinding(inout bindings, "__z_native_error_type", error.name);
    none => {}
  }
  if (!declaration.staticMethod && ownerType.byteLength > 0) {
    if (declaration.receiverMode == ReceiverMode.inputOutput) {
      addBorrowedValueBinding(inout bindings, "this", ownerType, true);
    } else if (declaration.receiverMode == ReceiverMode.move) {
      addMutableValueBinding(inout bindings, "this", ownerType);
    } else {
      addBorrowedValueBinding(inout bindings, "this", ownerType, false);
    }
  }
  if (ownerType.byteLength > 0) {
    addValueBinding(inout bindings, "__z_native_owner_type", ownerType);
  }
  try inferStatementSequence(
    module,
    modules,
    moduleIndex,
    declaration.body,
    declaration.body.roots,
    inout bindings,
    inout evidence,
    bodyReturnType
  );
  try requireInitializedOutputParameters(
    module,
    declaration.line,
    declaration.column,
    bindings
  );
}

function validateExpressionTypesAndLocals(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize
): ModuleSemanticEvidence throws ModuleResolveError {
  let evidence = ModuleSemanticEvidence({
    callResolutions: Array<ModuleCallResolution>(),
    bindingResolutions: Array<ModuleBindingResolution>(),
    expressionResolutions: Array<ModuleExpressionResolution>(),
  });
  const noTypeParameters = Array<TypeParameter>();
  for (const declaration of module.program.functions) {
    try inferFunctionExpressions(
      module,
      modules,
      moduleIndex,
      declaration,
      "",
      noTypeParameters,
      inout evidence
    );
  }
  for (const aggregate of module.program.aggregates) {
    match (in aggregate.constructorDeclaration) {
      some(initializer) => {
        let bindings = functionValueBindings(initializer.parameters);
        addValueBinding(inout bindings, "__z_native_function_name", "constructor");
        addValueBinding(inout bindings, "__z_native_return_type", "void");
        match (in initializer.errorType) {
          some(error) => addValueBinding(inout bindings, "__z_native_error_type", error.name);
          none => {}
        }
        addMutableValueBinding(inout bindings, "this", aggregate.name);
        addValueBinding(inout bindings, "__z_native_owner_type", aggregate.name);
        addValueBinding(inout bindings, "__z_native_constructor_type", aggregate.name);
        addTypeParameterBindings(inout bindings, aggregate.typeParameters);
        try inferStatementSequence(
          module,
          modules,
          moduleIndex,
          initializer.body,
          initializer.body.roots,
          inout bindings,
          inout evidence,
          "void"
        );
        try requireInitializedOutputParameters(
          module,
          initializer.line,
          initializer.column,
          bindings
        );
      }
      none => {}
    }
    for (const method of aggregate.methods) {
      try inferFunctionExpressions(
        module,
        modules,
        moduleIndex,
        method,
        aggregate.name,
        aggregate.typeParameters,
        inout evidence
      );
    }
    match (in aggregate.deinitializer) {
      some(deinitializer) => {
        let bindings = Array<NativeValueBinding>();
        addValueBinding(inout bindings, "__z_native_function_name", "deinit");
        addValueBinding(inout bindings, "__z_native_return_type", "void");
        addValueBinding(inout bindings, "this", aggregate.name);
        addValueBinding(inout bindings, "__z_native_owner_type", aggregate.name);
        addTypeParameterBindings(inout bindings, aggregate.typeParameters);
        try inferStatementSequence(
          module,
          modules,
          moduleIndex,
          deinitializer.body,
          deinitializer.body.roots,
          inout bindings,
          inout evidence,
          "void"
        );
      }
      none => {}
    }
  }
  return evidence;
}

export function resolveModules(
  in sources: Array<ModuleSource>,
  in entryPath: String
): ModuleGraph throws ModuleResolveError {
  const parsed = try parseModuleSources(sources);
  const entry = try findEntryModule(parsed, entryPath);
  let modules = try buildResolvedModules(parsed);
  let index: usize = 0;
  while (index < parsed.length) {
    try validateModuleTypes(parsed[index], modules, index);
    try validateModuleNames(parsed[index], modules[index].symbols);
    modules[index].semanticEvidence = try validateExpressionTypesAndLocals(parsed[index], modules, index);
    index = index + 1;
  }

  const dependencyOrder = try resolveModuleOrder(modules, entry);
  return ModuleGraph({ modules, dependencyOrder, entry });
}
