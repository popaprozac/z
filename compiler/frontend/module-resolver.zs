import { TextBuffer } from "std/text";
import { requireNativeAvailability, requireNativeReferenceAvailability } from "./semantic-native-availability.zs";
import { planNativeObjCSubclasses } from "./semantic-objc-subclass-plans.zs";
import { validateNativeObjCSubclassRawAccess } from "./semantic-objc-subclass-hygiene.zs";
import {
  nativeObjCSubclassBase,
  prepareNativeObjCSubclassTypes,
  validateNativeObjCSubclassDeclarations,
} from "./semantic-objc-subclasses.zs";
import {
  buildResolvedModules,
  findEntryModule,
  parseModuleSources,
  resolveModuleOrder,
} from "./module-graph.zs";
import {
  ParsedModule,
  ParsedModuleBatch,
  moduleSymbolIndex,
  moduleBindingName as bindingName,
} from "./module-symbols.zs";
import {
  isPublicCAbiReservedWord,
  resolveAggregateNames,
  validateModuleNames,
} from "./semantic-names.zs";
import { nativeInitializerSelector } from "./semantic-objc-subclass-bodies.zs";
import {
  NativeCallAccess,
  pendingAsyncCallShape,
  pendingAsyncCallType,
  pendingThrowingCallShape,
  pendingThrowingCallType,
  registerCallAccess,
  requireSettledExpressionType,
} from "./semantic-call-contracts.zs";
import {
  collectClosureExpressionCaptures,
  collectClosureStatementCaptures,
  nativeClosureFunctionType,
  resolveClosureSignature,
} from "./semantic-closures.zs";
import {
  applyExecutorCaptureMoves,
  prepareExecutorCaptureBindings,
  taskEffectType,
} from "./semantic-executor-placement.zs";
import {
  functionValueBindings,
  prepareFunctionBindings,
} from "./semantic-function-contexts.zs";
import {
  callableSymbolLocation,
  emptySemanticEvidence,
  foreignValueSymbolLocation,
  recordBindingResolution,
  recordExpressionResolution,
  recordForeignValueResolution,
  valueSymbolTargetName,
  recordForeignCallFacts,
  recordObjCCallFacts,
  recordCallResolution,
} from "./semantic-evidence.zs";
import {
  collectionMethodMutates,
  collectionMethodSignature,
  iterationElementType,
  iterationObjectFieldType,
  numberLiteralType,
  sourceCollectionTypeName,
  collectionHasLength,
  throwingGeneratorHandleType,
} from "./semantic-intrinsics.zs";
import { nativeStandardCall } from "./semantic-standard-library.zs";
import {
  NativeInitializationState,
  NativeOwnershipState,
  NativeValueBinding,
  activeSuspensionBorrowRoot,
  appendIndependentViewOwner,
  allowArenaBundleMove,
  addBorrowedValueBinding,
  addMatchBorrowedValueBinding,
  addMutableValueBinding,
  addUninitializedMutableValueBinding,
  addValueBinding,
  addViewValueBinding,
  borrowClosureBindingInPlace,
  borrowMatchValueBindingInPlace,
  borrowValueBindingInPlace,
  copyBindingFlowStates,
  copyValueBindings,
  closeArenaViewBindings,
  expressionViewOrigin,
  liveViewBindingForOwner,
  liveViewBindingForStoragePath,
  mergeViewOwners,
  invalidateContainedClassAlias,
  markObjectiveCStringCopy,
  restoreContainedClassAlias,
  ownerlessViewOwner,
  setExpressionViewOrigin,
  mergeBindingFlowStates,
  setValueBindingInitialization,
  setValueBindingClassAlias,
  setValueBindingClassAliasContained,
  setValueBindingOwnership,
  setValueBindingType,
  setValueBindingViewOwner,
  valueBindingInitialization,
  valueBindingClassAlias,
  valueBindingClassAliasIsContained,
  valueBindingIsBorrowed,
  valueBindingIsMatchBorrowed,
  valueBindingIsMutable,
  valueBindingOwnership,
  valueBindingType,
  valueBindingViewOwner,
  valueBindingViewPath,
  viewOwnerIsOwnerless,
} from "./semantic-flow-state.zs";
import {
  NativeForeignModuleContract,
  attachForeignContracts,
} from "./semantic-foreign.zs";
import {
  bindGenericType,
  genericCallError,
  parameterizedTypeName,
  requireGenericConstraints,
  settledContextualType,
} from "./semantic-generic-inference.zs";
import {
  consumeOwnedExpressionNode,
  consumeOwnedExpressionSyntax,
  expressionStorageRootName,
  identifierLookupName,
  requireInitializedBinding,
  requireInitializedOutputParameters,
  requireOwnedClosureEnvironment,
} from "./semantic-expression-ownership.zs";
import {
  isContextualNumericLiteral,
  isNativeObjectiveCStringType,
  nativeBorrowedCallbackType,
  requireExpressionSyntaxType,
  requireExpressionType,
} from "./semantic-expression-types.zs";
import {
  NativeAggregateConstructionShape,
  NativeMatchShape,
  NativeMatchVariant,
  NativeMethodCallShape,
  activeOwnerMatchesMethod,
  addTypeParameterBindings,
  aggregateConstructionShape,
  aggregateFieldShape,
  callableMethodCallShape,
  hasKnownAggregate,
  isForeignUnionType,
  isActiveTypeParameter,
  isKnownMatchVariant,
  matchShape,
  matchVariantIndex,
  methodCallableSignature,
  objectiveCClassPropertyShape,
  rebaseModuleFunctionSignature,
  typeExpressionName,
} from "./semantic-member-lookups.zs";
import {
  addMatchArmValueBindings,
  isDefinitelyNonMatchable,
  matchError,
  requireObjectDestructureCleanup,
  requireVisibleField,
} from "./semantic-pattern-validation.zs";
import {
  binaryOperatorType,
  unaryOperatorType,
} from "./semantic-operators.zs";
import {
  ModuleSymbolLocation,
  equivalentTypes,
  rebaseTypeName,
  semanticTypeIdentity,
  transparentTypeLocation,
  transparentTypeName,
  typeSatisfiesTrait,
  inferredTypeSymbolLocation,
  typeSymbolLocation,
} from "./semantic-type-identities.zs";
import {
  NativeFixedArrayShape,
  NativeGenericTypeShape,
  arrayElementType,
  genericTypeShape,
  isFloatTypeName,
  isIntegerTypeName,
  isIntrinsicTypeName,
  isNumericTypeName,
  isTypeSymbolKind,
  nativeFunctionDisplayType,
  nativeFunctionSignature,
  nativeFunctionTypeName,
  nullableTargetType,
  qualifiedTypeBase,
  qualifiedTypeMember,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import {
  typeHasMainExecutorLifecycle,
  validateModuleTypes,
} from "./semantic-type-validation.zs";
import {
  arenaOwnerBundleFieldName,
  substituteGenericType,
  typeContainsForeignValueStorage,
  typeContainsStoredView,
  typeHasCleanup,
  typeHasCustomConstructor,
  typeIsBorrowedForeignResource,
  typeIsForeignResource,
  typeIsForeignViewOnlyRecord,
  typeIsRetainedParameterViewAggregate,
  typeIsThreadShareable,
  typeIsThreadTransferable,
  typeIsArenaOwnerBundle,
  typeNameIsArena,
  typeMovesOnOwnedUse,
  typeSupportsExplicitCopy,
} from "./semantic-type-ownership.zs";
import {
  ModuleFunctionSignature,
  ModuleForeignUnionMatch,
  ModuleForeignUnionMatchVariant,
  ModuleGraph,
  ModuleObjCProtocolMethodResolution,
  ModuleObjCAdapterResolution,
  ModuleObjCRegistrationResolution,
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSemanticEvidence,
  ModuleSource,
  ModuleSymbol,
  ModuleSymbolKind,
  ModuleTypeParameterConstraint,
  ModuleTypeSignature,
  ResolvedModule,
  codedModuleResolutionError,
  moduleResolutionError,
} from "./semantic-model.zs";
import {
  AggregateDeclaration,
  ArrayBindingKind,
  ConstructorDeclaration,
  Declaration,
  DeclarationKind,
  EnumDeclaration,
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  FunctionDeclaration,
  ParameterMode,
  StatementArena,
  StatementKind,
  TraitDeclaration,
  TypeParameter,
  TypeReference,
  Visibility,
} from "./parser.zs";

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

function typeIsClassReference(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  for (const aggregate of module.program.aggregates) {
    if (
      aggregate.kind == DeclarationKind.classDeclaration
      && aggregate.name == typeName
    ) return true;
  }
  const location = inferredTypeSymbolLocation(modules, moduleIndex, typeName);
  return match (in location) {
    some(location) => modules[location.moduleIndex].symbols[location.symbolIndex].kind
      == ModuleSymbolKind.classSymbol;
    none => false;
  };
}

function aggregateClassAliasFieldBindingName(
  in owner: String,
  in field: String
): String {
  return `__z_native_class_field_alias:${owner}\t${field}`;
}

function memoryReplaceClassAliasBindingName(offset: usize): String {
  return `__z_native_memory_replace_alias:${offset}`;
}

function directAggregateClassAliasNodeIdentity(
  in tree: ExpressionTree,
  index: usize,
  in bindings: Array<NativeValueBinding>
): usize {
  if (
    tree.nodes[index].kind != ExpressionKind.memberExpression
    || tree.nodes[index].children.length != 1
  ) return 0;
  const receiver = tree.nodes[index].children[0];
  if (tree.nodes[receiver].kind != ExpressionKind.identifierExpression) {
    return 0;
  }
  const owner = identifierLookupName(tree.nodes[receiver].value);
  const field = identifierLookupName(tree.nodes[index].value);
  const bindingName = aggregateClassAliasFieldBindingName(owner, field);
  return valueBindingClassAlias(bindings, bindingName);
}

function directAggregateClassAliasNodeIsTracked(
  in tree: ExpressionTree,
  index: usize,
  in bindings: Array<NativeValueBinding>
): boolean {
  if (
    tree.nodes[index].kind != ExpressionKind.memberExpression
    || tree.nodes[index].children.length != 1
  ) return false;
  const receiver = tree.nodes[index].children[0];
  if (tree.nodes[receiver].kind != ExpressionKind.identifierExpression) {
    return false;
  }
  const owner = identifierLookupName(tree.nodes[receiver].value);
  const field = identifierLookupName(tree.nodes[index].value);
  const bindingName = aggregateClassAliasFieldBindingName(owner, field);
  const trackedType = valueBindingType(bindings, bindingName);
  return trackedType.byteLength > 0;
}

function expressionNodeClassAliasIdentity(
  in tree: ExpressionTree,
  root: usize,
  in bindings: Array<NativeValueBinding>,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize
): usize {
  if (tree.nodes[root].kind == ExpressionKind.callExpression) {
    const replacementBinding = memoryReplaceClassAliasBindingName(
      tree.nodes[root].offset
    );
    const replaced = valueBindingClassAlias(
      bindings,
      replacementBinding
    );
    if (replaced > 0) return replaced;
  }
  const projected = directAggregateClassAliasNodeIdentity(
    tree,
    root,
    bindings
  );
  if (projected > 0) return projected;
  if (
    tree.nodes[root].kind == ExpressionKind.unaryExpression
    && tree.nodes[root].value == "move"
    && tree.nodes[root].children.length == 1
  ) {
    const child = tree.nodes[root].children[0];
    return expressionNodeClassAliasIdentity(
      tree,
      child,
      bindings,
      modules,
      moduleIndex
    );
  }
      if (
        tree.nodes[root].kind == ExpressionKind.callExpression
        && tree.nodes[root].children.length > 0
      ) {
        const callee = tree.nodes[root].children[0];
        if (
          tree.nodes[callee].kind == ExpressionKind.memberExpression
          && tree.nodes[callee].value == "get"
          && tree.nodes[callee].children.length == 1
        ) {
          const receiver = tree.nodes[callee].children[0];
          match (foreignValueSymbolLocation(
            modules,
            moduleIndex,
            tree,
            receiver
          )) {
            some(location) => match (genericTypeShape(
              modules[location.moduleIndex].symbols[location.symbolIndex].valueType
            )) {
              some(generic) => {
                if (generic.base == "Once" && generic.arguments.length == 1) {
                  return moduleClassAliasIdentity(modules, location);
                }
              }
              none => {}
            }
            none => {}
          }
        }
        match (callableSymbolLocation(modules, moduleIndex, tree, callee)) {
          some(location) => match (in modules[location.moduleIndex]
            .symbols[location.symbolIndex].functionSignature) {
            some(signature) => {
              if (signature.classIdentitySource.byteLength > 0) {
                const sourceIndex = moduleSymbolIndex(
                  modules[location.moduleIndex],
                  signature.classIdentitySource
                );
                if (
                  sourceIndex < modules[location.moduleIndex].symbols.length
                  && modules[location.moduleIndex].symbols[sourceIndex].kind
                    == ModuleSymbolKind.constantSymbol
                ) return moduleClassAliasIdentity(
                  modules,
                  ModuleSymbolLocation({
                    moduleIndex: location.moduleIndex,
                    symbolIndex: sourceIndex,
                  })
                );
              }
            }
            none => {}
          }
          none => {}
        }
      }
      if (tree.nodes[root].kind == ExpressionKind.identifierExpression) {
        const name = identifierLookupName(tree.nodes[root].value);
        const existing = valueBindingClassAlias(bindings, name);
        return existing > 0
          ? existing
          : localClassAliasIdentity(tree.nodes[root].offset);
      }
      if (
        tree.nodes[root].kind == ExpressionKind.argumentReferenceExpression
        && tree.nodes[root].children.length == 1
      ) {
        const name = identifierLookupName(
          tree.nodes[tree.nodes[root].children[0]].value
        );
        const existing = valueBindingClassAlias(bindings, name);
        return existing > 0
          ? existing
          : localClassAliasIdentity(tree.nodes[root].offset);
      }
      return localClassAliasIdentity(tree.nodes[root].offset);
}

function expressionClassAliasIdentity(
  in expression: ExpressionSyntax,
  in bindings: Array<NativeValueBinding>,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize
): usize {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      select expressionNodeClassAliasIdentity(
        tree,
        root,
        bindings,
        modules,
        moduleIndex
      );
    }
    none => localClassAliasIdentity(expression.offset);
  };
}

function setAggregateClassAliasField(
  inout bindings: Array<NativeValueBinding>,
  in owner: String,
  in field: String,
  in fieldType: String,
  identity: usize
): void {
  const bindingName = aggregateClassAliasFieldBindingName(owner, field);
  const existingType = valueBindingType(bindings, bindingName);
  if (existingType.byteLength == 0) {
    addValueBinding(inout bindings, bindingName, fieldType);
  }
  setValueBindingClassAlias(inout bindings, bindingName, identity);
}

function recordAggregateClassAliasFields(
  in module: ParsedModule,
  in expression: ExpressionSyntax,
  in bindingName: String,
  in storedType: String,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  inout bindings: Array<NativeValueBinding>
): void {
  match (aggregateConstructionShape(modules, moduleIndex, storedType)) {
    some(construction) => {
      if (!construction.valueStruct) return;
      for (const fieldName of construction.allFields) {
        match (aggregateFieldShape(
          modules,
          moduleIndex,
          storedType,
          fieldName
        )) {
          some(field) => {
            if (typeIsClassReference(
              module,
              modules,
              moduleIndex,
              field.typeName
            )) setAggregateClassAliasField(
              inout bindings,
              bindingName,
              fieldName,
              field.typeName,
              0
            );
          }
          none => {}
        }
      }
    }
    none => return;
  }
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      if (
        tree.nodes[root].kind == ExpressionKind.callExpression
        && tree.nodes[root].children.length > 0
      ) {
        const callee = tree.nodes[root].children[0];
        match (callableSymbolLocation(modules, moduleIndex, tree, callee)) {
          some(location) => match (in modules[location.moduleIndex]
            .symbols[location.symbolIndex].functionSignature) {
            some(signature) => {
              let sourceIndex: usize = 0;
              while (
                sourceIndex < signature.classIdentityFieldNames.length
                && sourceIndex < signature.classIdentityParameterIndices.length
              ) {
                const fieldName = view signature.classIdentityFieldNames[sourceIndex];
                const parameterIndex = signature.classIdentityParameterIndices[sourceIndex];
                const argumentIndex = parameterIndex + 1;
                if (argumentIndex < tree.nodes[root].children.length) {
                  const argumentNode = tree.nodes[root].children[argumentIndex];
                  match (aggregateFieldShape(
                    modules,
                    moduleIndex,
                    storedType,
                    fieldName
                  )) {
                    some(field) => {
                      if (typeIsClassReference(
                        module,
                        modules,
                        moduleIndex,
                        field.typeName
                      )) setAggregateClassAliasField(
                        inout bindings,
                        bindingName,
                        fieldName,
                        field.typeName,
                        expressionNodeClassAliasIdentity(
                          tree,
                          argumentNode,
                          bindings,
                          modules,
                          moduleIndex
                        )
                      );
                    }
                    none => {}
                  }
                }
                sourceIndex = sourceIndex + 1;
              }
              if (signature.classIdentityFieldNames.length > 0) return;
            }
            none => {}
          }
          none => {}
        }
      }
      if (
        tree.nodes[root].kind != ExpressionKind.callExpression
        || tree.nodes[root].children.length != 2
      ) return;
      const callee = tree.nodes[root].children[0];
      const constructionType = typeExpressionName(tree, callee);
      if (!equivalentTypes(
        modules,
        moduleIndex,
        storedType,
        constructionType
      )) return;
      match (typeSymbolLocation(modules, moduleIndex, constructionType)) {
        some(location) => {
          if (
            modules[location.moduleIndex].symbols[location.symbolIndex].kind
              != ModuleSymbolKind.structSymbol
          ) return;
        }
        none => return;
      }
      const object = tree.nodes[root].children[1];
      if (tree.nodes[object].kind != ExpressionKind.objectExpression) return;
      let index: usize = 0;
      while (
        index < tree.nodes[object].children.length
        && index < tree.nodes[object].labels.length
      ) {
        const fieldName = tree.nodes[object].labels[index].copyBytes(
          0,
          tree.nodes[object].labels[index].byteLength
        );
        if (fieldName == "...") return;
        match (aggregateFieldShape(
          modules,
          moduleIndex,
          storedType,
          fieldName
        )) {
          some(field) => {
            if (typeIsClassReference(
              module,
              modules,
              moduleIndex,
              field.typeName
            )) {
              const fieldNode = tree.nodes[object].children[index];
              setAggregateClassAliasField(
                inout bindings,
                bindingName,
                fieldName,
                field.typeName,
                expressionNodeClassAliasIdentity(
                  tree,
                  fieldNode,
                  bindings,
                  modules,
                  moduleIndex
                )
              );
            }
          }
          none => {}
        }
        index = index + 1;
      }
    }
    none => {}
  }
}

function localClassAliasIdentity(offset: usize): usize {
  // Lexical identities are even; canonical module-cell identities are odd.
  // That makes the two namespaces disjoint without carrying runtime metadata.
  return (offset + 1) * 2;
}

function moduleClassAliasIdentity(
  in modules: Array<ResolvedModule>,
  in location: ModuleSymbolLocation
): usize {
  let ordinal: usize = 0;
  let index: usize = 0;
  while (index < location.moduleIndex) {
    ordinal = ordinal + modules[index].symbols.length;
    index = index + 1;
  }
  return (ordinal + location.symbolIndex) * 2 + 1;
}

function expressionNodeClassAliasIsContained(
  in tree: ExpressionTree,
  index: usize,
  in bindings: Array<NativeValueBinding>
): boolean {
  if (tree.nodes[index].kind == ExpressionKind.callExpression) {
    const replacement = memoryReplaceClassAliasBindingName(
      tree.nodes[index].offset
    );
    const replacementType = valueBindingType(bindings, replacement);
    if (replacementType.byteLength > 0) {
      return valueBindingClassAliasIsContained(bindings, replacement);
    }
  }
  if (tree.nodes[index].kind == ExpressionKind.newExpression) return true;
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
    const name = identifierLookupName(tree.nodes[index].value);
    return valueBindingClassAliasIsContained(
      bindings,
      name
    );
  }
  if (
    tree.nodes[index].kind == ExpressionKind.argumentReferenceExpression
    && tree.nodes[index].children.length == 1
  ) {
    const name = identifierLookupName(
      tree.nodes[tree.nodes[index].children[0]].value
    );
    return valueBindingClassAliasIsContained(
      bindings,
      name
    );
  }
  if (
    tree.nodes[index].kind == ExpressionKind.unaryExpression
    && tree.nodes[index].value == "move"
    && tree.nodes[index].children.length == 1
  ) {
    const child = tree.nodes[index].children[0];
    return expressionNodeClassAliasIsContained(
      tree,
      child,
      bindings
    );
  }
  return false;
}

function expressionClassAliasIsContained(
  in expression: ExpressionSyntax,
  in bindings: Array<NativeValueBinding>,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      if (tree.nodes[root].kind == ExpressionKind.newExpression) {
        match (typeSymbolLocation(modules, moduleIndex, typeName)) {
          some(location) => match (
            in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature
          ) {
            some(signature) => match (in signature.constructorSignature) {
              some(_) => return false;
              none => {}
            }
            none => {}
          }
          none => {}
        }
      }
      return expressionNodeClassAliasIsContained(tree, root, bindings);
    }
    none => false;
  };
}

function invalidateLocallyContainedClassBinding(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in root: String,
  inout bindings: Array<NativeValueBinding>
): void throws ModuleResolveError {
  if (
    root.byteLength == 0
    || !valueBindingClassAliasIsContained(bindings, root)
  ) return;
  const view = liveViewBindingForOwner(bindings, root);
  if (view.byteLength > 0) throw resolutionError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    `cannot let ARC class identity "${root}" escape while view "${view}" is live`,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
  invalidateContainedClassAlias(
    inout bindings,
    valueBindingClassAlias(bindings, root)
  );
}

function invalidateLocallyContainedClassNode(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  inout bindings: Array<NativeValueBinding>
): void throws ModuleResolveError {
  const root = expressionStorageRootName(tree, index);
  try invalidateLocallyContainedClassBinding(
    module,
    tree,
    index,
    root,
    inout bindings
  );
}

function expressionCapabilityAccess(
  in tree: ExpressionTree,
  index: usize
): String {
  const kind = tree.nodes[index].kind;
  if (kind == ExpressionKind.argumentReferenceExpression) {
    return tree.nodes[index].value.copyBytes(0, tree.nodes[index].value.byteLength);
  }
  if (
    kind == ExpressionKind.memberExpression
    && tree.nodes[index].children.length == 1
  ) {
    const child = tree.nodes[index].children[0];
    return expressionCapabilityAccess(tree, child);
  }
  return "";
}

function expressionCapabilityBindingIndex(
  in tree: ExpressionTree,
  index: usize
): usize {
  const kind = tree.nodes[index].kind;
  if (
    kind == ExpressionKind.argumentReferenceExpression
    && tree.nodes[index].children.length == 1
  ) {
    const child = tree.nodes[index].children[0];
    return expressionCapabilityBindingIndex(tree, child);
  }
  if (
    kind == ExpressionKind.memberExpression
    && tree.nodes[index].children.length == 1
  ) {
    const child = tree.nodes[index].children[0];
    return expressionCapabilityBindingIndex(tree, child);
  }
  return index;
}

function expressionDirectFieldPath(
  in tree: ExpressionTree,
  index: usize
): String {
  const root = expressionStorageRootName(tree, index);
  if (root.byteLength == 0) return "";
  let reversed = Array<String>();
  let current = index;
  if (tree.nodes[current].kind == ExpressionKind.argumentReferenceExpression) {
    if (tree.nodes[current].children.length != 1) return root;
    current = tree.nodes[current].children[0];
  }
  while (
    tree.nodes[current].kind == ExpressionKind.memberExpression
    && tree.nodes[current].children.length == 1
  ) {
    if (tree.nodes[current].optionalAccess) return root;
    reversed.push(tree.nodes[current].value.copyBytes(
      0,
      tree.nodes[current].value.byteLength
    ));
    current = tree.nodes[current].children[0];
  }
  if (
    tree.nodes[current].kind != ExpressionKind.identifierExpression
    && tree.nodes[current].kind != ExpressionKind.argumentBindingExpression
  ) return root;
  let path = root.copyBytes(0, root.byteLength);
  let fieldIndex = reversed.length;
  while (fieldIndex > 0) {
    fieldIndex = fieldIndex - 1;
    path = `${path}.${reversed[fieldIndex]}`;
  }
  return path;
}

function projectedFieldCount(in tree: ExpressionTree, index: usize): usize {
  let count: usize = 0;
  let current = index;
  if (
    tree.nodes[current].kind == ExpressionKind.argumentReferenceExpression
    && tree.nodes[current].children.length == 1
  ) current = tree.nodes[current].children[0];
  while (
    tree.nodes[current].kind == ExpressionKind.memberExpression
    && tree.nodes[current].children.length == 1
  ) {
    count = count + 1;
    current = tree.nodes[current].children[0];
  }
  return count;
}

function requireProjectedCapabilityValuePath(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in bindings: Array<NativeValueBinding>,
  mutableAccess: boolean
): void throws ModuleResolveError {
  if (projectedFieldCount(tree, index) == 0) return;
  const root = expressionStorageRootName(tree, index);
  let ownerType = valueBindingType(bindings, root);
  let reversed = Array<String>();
  let current = index;
  if (
    tree.nodes[current].kind == ExpressionKind.argumentReferenceExpression
    && tree.nodes[current].children.length == 1
  ) current = tree.nodes[current].children[0];
  while (
    tree.nodes[current].kind == ExpressionKind.memberExpression
    && tree.nodes[current].children.length == 1
  ) {
    reversed.push(tree.nodes[current].value.copyBytes(
      0,
      tree.nodes[current].value.byteLength
    ));
    current = tree.nodes[current].children[0];
  }
  let fieldIndex = reversed.length;
  const rootIsDirectClass = typeIsClassReference(
    module,
    modules,
    moduleIndex,
    ownerType
  );
  let stableSharedProjection = false;
  if (rootIsDirectClass && !mutableAccess && reversed.length > 0) {
    match (aggregateFieldShape(
      modules,
      moduleIndex,
      ownerType,
      reversed[reversed.length - 1]
    )) {
      some(field) => stableSharedProjection = field.readonlyField;
      none => {}
    }
  }
  if (
    rootIsDirectClass
    && !stableSharedProjection
    && !valueBindingClassAliasIsContained(bindings, root)
  ) {
    throw resolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      `class-field projection requires locally contained ARC identity "${root}"`,
      tree.nodes[index].line,
      tree.nodes[index].column
    );
  }
  while (fieldIndex > 0) {
    fieldIndex = fieldIndex - 1;
    const directClassField = fieldIndex + 1 == reversed.length
      && rootIsDirectClass;
    if (
      typeIsClassReference(module, modules, moduleIndex, ownerType)
      && !directClassField
    ) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "projected capability access currently crosses fixed-layout value-struct fields only",
        tree.nodes[index].line,
        tree.nodes[index].column
      );
    }
    match (aggregateFieldShape(
      modules,
      moduleIndex,
      ownerType,
      reversed[fieldIndex]
    )) {
      some(field) => {
        if (mutableAccess && field.objectiveCGetter.byteLength > 0) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `Objective-C property "${field.name}" cannot be passed as inout; property setter lowering remains deferred`,
            tree.nodes[index].line,
            tree.nodes[index].column
          );
        }
        if (mutableAccess && field.readonlyField) throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `cannot pass readonly field "${field.name}" as inout`,
          tree.nodes[index].line,
          tree.nodes[index].column
        );
        ownerType = field.typeName.copyBytes(0, field.typeName.byteLength);
      }
      none => {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "projected capability access currently crosses fixed-layout value-struct fields only",
          tree.nodes[index].line,
          tree.nodes[index].column
        );
      }
    }
  }
  if (
    typeIsClassReference(module, modules, moduleIndex, ownerType)
    && (
      mutableAccess
      || !isNativeObjectiveCObjectType(modules, moduleIndex, ownerType)
    )
  ) {
    throw resolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "projected capability access cannot borrow ARC class identity in this shape-stability tier",
      tree.nodes[index].line,
      tree.nodes[index].column
    );
  }
}

function copyIndices(in indices: Array<usize>): Array<usize> {
  let copied = Array<usize>();
  for (const index of indices) {
    copied.push(index);
  }
  return copied;
}

function closureCaptureNames(
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize,
  in bindings: Array<NativeValueBinding>
): Array<String> {
  let localNames = Array<String>();
  for (const child of tree.nodes[index].children) {
    if (tree.nodes[child].kind == ExpressionKind.closureParameterExpression) {
      localNames.push(tree.nodes[child].value.copyBytes(
        0,
        tree.nodes[child].value.byteLength
      ));
    }
  }
  let captures = Array<String>();
  let bodyKind = "expression";
  if (tree.nodes[index].labels.length > 2) {
    bodyKind = tree.nodes[index].labels[2].copyBytes(
      0,
      tree.nodes[index].labels[2].byteLength
    );
  }
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
  } else {
    for (const child of tree.nodes[index].children) {
      if (tree.nodes[child].kind == ExpressionKind.closureParameterExpression) {
        continue;
      }
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
  return captures;
}

function closureCaptureModeBindingName(in capture: String): String {
  return `__z_native_closure_capture_mode_${capture}`;
}

function closureCaptureClassMutationBindingName(in capture: String): String {
  return `__z_native_closure_class_mutation_${capture}`;
}

function closureCaptureEvidenceBindingName(
  offset: usize,
  in capture: String
): String {
  return `__z_native_closure_capture_evidence_${offset}_${capture}`;
}

function markClosureCaptureMutation(
  inout bindings: Array<NativeValueBinding>,
  in root: String
): void {
  if (root.byteLength == 0) return;
  const marker = closureCaptureModeBindingName(root);
  const existing = valueBindingType(bindings, marker);
  if (existing.byteLength > 0) {
    setValueBindingType(inout bindings, marker, "inout");
  }
}

function contextualExpectedBindingName(offset: usize): String {
  return `__z_native_contextual_expected:${offset}`;
}

function loopSelectTypeBindingName(): String {
  return "__z_native_loop_select_type";
}

function regionControlFlowBindingName(): String {
  return "__z_native_region_control_flow";
}

function markRegionControlFlow(
  inout bindings: Array<NativeValueBinding>,
  in kind: String
): void {
  const binding = regionControlFlowBindingName();
  const existing = valueBindingType(bindings, binding);
  if (existing == "loop") return;
  if (existing.byteLength > 0) {
    setValueBindingType(inout bindings, binding, kind);
  } else {
    addValueBinding(inout bindings, binding, kind);
  }
}

function requireSettledRegionProvenance(
  in module: ParsedModule,
  in bindings: Array<NativeValueBinding>,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  for (const binding of bindings) {
    if (binding.viewOwner != "__z_native_mixed_view_owner") continue;
    throw resolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      `view-bearing collection "${binding.name}" must establish the same Arena provenance on every continuing path`,
      line,
      column
    );
  }
}

function storedViewOwnerForExpression(
  in bindings: Array<NativeValueBinding>,
  in tree: ExpressionTree,
  index: usize
): String {
  const direct = expressionViewOrigin(bindings, tree.nodes[index].offset);
  if (direct.byteLength > 0) return direct;
  if (
    tree.nodes[index].kind == ExpressionKind.unaryExpression
    && (
      tree.nodes[index].value == "move"
      || tree.nodes[index].value == "view"
    )
    && tree.nodes[index].children.length == 1
  ) {
    const child = tree.nodes[index].children[0];
    return storedViewOwnerForExpression(bindings, tree, child);
  }
  const root = expressionStorageRootName(tree, index);
  if (root.byteLength == 0) return "";
  if (root == "this") return "this";
  const inherited = valueBindingViewOwner(bindings, root);
  if (inherited.byteLength > 0) return inherited;
  if (valueBindingIsBorrowed(bindings, root)) {
    return root.copyBytes(0, root.byteLength);
  }
  return "";
}

function validateRetainedParameterViewAggregateReturn(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in expression: ExpressionSyntax,
  in expectedType: String,
  in bindings: Array<NativeValueBinding>
): void throws ModuleResolveError {
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      let directConstruction = false;
      let initializer: usize = root;
      if (
        tree.nodes[root].kind == ExpressionKind.callExpression
        && tree.nodes[root].children.length == 2
      ) {
        const callee = tree.nodes[root].children[0];
        const candidate = tree.nodes[root].children[1];
        if (
          tree.nodes[callee].kind == ExpressionKind.identifierExpression
          && tree.nodes[callee].value == expectedType
          && tree.nodes[candidate].kind == ExpressionKind.objectExpression
        ) {
          directConstruction = true;
          initializer = candidate;
        }
      }
      if (directConstruction) {
        for (const label of tree.nodes[initializer].labels) {
          if (label == "...") throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "a retained view-bearing aggregate return cannot use struct spread",
            tree.nodes[initializer].line,
            tree.nodes[initializer].column
          );
        }
        match (typeSymbolLocation(modules, moduleIndex, expectedType)) {
          some(location) => match (in modules[location.moduleIndex].symbols[
            location.symbolIndex
          ].typeSignature) {
            some(signature) => {
              for (const field of signature.fields) {
                if (!stringStartsWith(field.typeName, "view ")) continue;
                let fieldIndex: usize = 0;
                let found = false;
                while (
                  fieldIndex < tree.nodes[initializer].labels.length
                  && fieldIndex < tree.nodes[initializer].children.length
                ) {
                  if (tree.nodes[initializer].labels[fieldIndex] == field.name) {
                    found = true;
                    const fieldExpression = tree.nodes[initializer].children[fieldIndex];
                    if (
                      tree.nodes[fieldExpression].kind != ExpressionKind.unaryExpression
                      || tree.nodes[fieldExpression].value != "view"
                      || tree.nodes[fieldExpression].children.length != 1
                    ) throw resolutionError(
                      ModuleResolveErrorKind.typeMismatch,
                      module.path,
                      `retained view field "${field.name}" must use an explicit view expression`,
                      tree.nodes[fieldExpression].line,
                      tree.nodes[fieldExpression].column
                    );
                    break;
                  }
                  fieldIndex = fieldIndex + 1;
                }
                if (!found) throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `retained view field "${field.name}" must be initialized directly at the return`,
                  tree.nodes[initializer].line,
                  tree.nodes[initializer].column
                );
              }
            }
            none => {}
          }
          none => {}
        }
      }
      const owner = expressionViewOrigin(bindings, tree.nodes[root].offset);
      const ownerViewOwner = valueBindingViewOwner(bindings, owner);
      if (
        owner.byteLength == 0
        || viewOwnerIsOwnerless(owner)
        || owner == "__z_native_mixed_view_owner"
        || !valueBindingIsBorrowed(bindings, owner)
        || valueBindingIsMutable(bindings, owner)
        || valueBindingIsMatchBorrowed(bindings, owner)
        || ownerViewOwner.byteLength > 0
      ) throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "a retained view-bearing aggregate must borrow every view field from one immutable input or receiver",
        tree.nodes[root].line,
        tree.nodes[root].column
      );
    }
    none => {}
  }
}

function expressionHasProvenBorrowedStorage(
  in bindings: Array<NativeValueBinding>,
  in tree: ExpressionTree,
  index: usize
): boolean {
  const root = expressionStorageRootName(tree, index);
  if (root == "this") return true;
  if (root.byteLength > 0 && valueBindingIsBorrowed(bindings, root)) return true;
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) return false;
  const direct = expressionViewOrigin(bindings, tree.nodes[index].offset);
  return direct.byteLength > 0 && direct != ownerlessViewOwner();
}

function storedViewOwnerForStatement(
  in arena: StatementArena,
  index: usize,
  in bindings: Array<NativeValueBinding>
): String {
  match (in arena.nodes[index].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        return storedViewOwnerForExpression(bindings, tree, root);
      }
      none => {}
    }
    none => {}
  }
  if (arena.nodes[index].children.length > 0) {
    const children = copyIndices(arena.nodes[index].children);
    const finalChild = children[children.length - 1];
    return storedViewOwnerForStatement(
      arena,
      finalChild,
      bindings
    );
  }
  return "";
}

function contextualExpectedType(
  in bindings: Array<NativeValueBinding>,
  in tree: ExpressionTree,
  index: usize
): String {
  const bindingName = contextualExpectedBindingName(tree.nodes[index].offset);
  return valueBindingType(bindings, bindingName);
}

function currentExecutorContext(
  in bindings: Array<NativeValueBinding>
): String {
  return valueBindingType(bindings, "__z_native_executor_context");
}

function requireMainExecutorContext(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in bindings: Array<NativeValueBinding>,
  in requiredAffinity: String,
  in subject: String
): void throws ModuleResolveError {
  if (
    requiredAffinity.byteLength == 0
    || requiredAffinity != "thread.main"
    || currentExecutorContext(bindings) == "thread.main"
  ) return;
  let length = tree.nodes[index].value.byteLength;
  if (length == 0) length = 1;
  throw codedModuleResolutionError(
    ModuleResolveErrorKind.typeMismatch,
    "Z0711",
    module.path,
    `${subject} requires thread.main executor context`,
    tree.nodes[index].line,
    tree.nodes[index].column,
    length
  );
}

function requireNoLexicalBorrowAtSuspension(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in bindings: Array<NativeValueBinding>
): void throws ModuleResolveError {
  const returnType = valueBindingType(bindings, "__z_native_return_type");
  match (genericTypeShape(returnType)) {
    some(shape) => {
      if (shape.base == "AsyncGenerator") return;
    }
    none => {}
  }
  const root = activeSuspensionBorrowRoot(bindings);
  if (root.byteLength == 0) return;
  throw codedModuleResolutionError(
    ModuleResolveErrorKind.typeMismatch,
    "Z0704",
    module.path,
    `cannot await while borrowed storage "${root}" is live`,
    tree.nodes[index].line,
    tree.nodes[index].column,
    5
  );
}

function aggregateExecutorAffinity(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  symbolIndex: usize
): String {
  if (
    moduleIndex >= modules.length
    || symbolIndex >= modules[moduleIndex].symbols.length
  ) return "";
  return match (
    in modules[moduleIndex].symbols[symbolIndex].typeSignature
  ) {
    some(signature) => signature.executorAffinity.copyBytes(
      0,
      signature.executorAffinity.byteLength
    );
    none => "";
  };
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

function importedStandardType(
  in module: ParsedModule,
  in localName: String,
  in header: String,
  in importedName: String
): boolean {
  for (const declaration of module.program.imports) {
    if (declaration.header != header || !declaration.selective) continue;
    for (const binding of declaration.bindings) {
      if (
        binding.localName == localName
        && binding.importedName == importedName
      ) return true;
    }
  }
  return false;
}

function importedStandardNamespace(
  in module: ParsedModule,
  in localName: String,
  in header: String
): boolean {
  for (const declaration of module.program.imports) {
    if (
      !declaration.selective
      && declaration.moduleName == localName
      && declaration.header == header
    ) return true;
  }
  return false;
}

function importsStandardChannel(in module: ParsedModule): boolean {
  for (const declaration of module.program.imports) {
    if (declaration.header == "std/channel") return true;
  }
  return false;
}

function standardChannelTypeKind(
  in module: ParsedModule,
  in localName: String
): String {
  if (!importsStandardChannel(module)) return "";
  const names = Array<String>(
    "Channel",
    "Sender",
    "Receiver",
    "SyncSender",
    "SyncReceiver",
    "ChannelClosed"
  );
  for (const name of names) {
    if (
      localName == name
      || importedStandardType(
        module,
        localName,
        "std/channel",
        name
      )
    ) return name.copyBytes(0, name.byteLength);
  }
  return "";
}

function channelCallSignature(
  asynchronous: boolean,
  in parameterType: String,
  in returnType: String,
  in errorType: String
): ModuleFunctionSignature {
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  if (parameterType.byteLength > 0) {
    parameterModes.push("value");
    parameterTypes.push(parameterType.copyBytes(0, parameterType.byteLength));
  }
  return ModuleFunctionSignature({
    asynchronous,
    executorAffinity: "",
    threadContract: "",
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    parameterModes,
    parameterTypes,
    viewParameter: Option<usize>.none,
    invalidatesParameters: Array<usize>(),
    invalidatesLifetimes: Array<String>(),
    returnType: returnType.copyBytes(0, returnType.byteLength),
    errorType: errorType.copyBytes(0, errorType.byteLength),
  });
}

function memoryReplaceSignature(in valueType: String): ModuleFunctionSignature {
  let parameterModes = Array<String>();
  parameterModes.push("inout");
  parameterModes.push("value");
  let parameterTypes = Array<String>();
  parameterTypes.push(valueType.copyBytes(0, valueType.byteLength));
  parameterTypes.push(valueType.copyBytes(0, valueType.byteLength));
  return ModuleFunctionSignature({
    asynchronous: false,
    executorAffinity: "",
    threadContract: "",
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    parameterModes,
    parameterTypes,
    viewParameter: Option<usize>.none,
    invalidatesParameters: Array<usize>(),
    invalidatesLifetimes: Array<String>(),
    returnType: valueType.copyBytes(0, valueType.byteLength),
    errorType: "",
  });
}

function typeContainsClassReferenceStorage(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  inout visiting: Array<String>
): boolean {
  if (typeIsClassReference(module, modules, moduleIndex, typeName)) return true;
  match (genericTypeShape(typeName)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        if (typeContainsClassReferenceStorage(
          module,
          modules,
          moduleIndex,
          argument,
          inout visiting
        )) return true;
      }
    }
    none => {}
  }
  for (const seen of visiting) {
    if (seen == typeName) return false;
  }
  visiting.push(typeName.copyBytes(0, typeName.byteLength));
  match (inferredTypeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => match (
      in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature
    ) {
      some(signature) => {
        for (const field of signature.fields) {
          if (typeContainsClassReferenceStorage(
            module,
            modules,
            moduleIndex,
            field.typeName,
            inout visiting
          )) return true;
        }
        for (const variant of signature.variants) {
          if (
            variant.payloadType.byteLength > 0
            && typeContainsClassReferenceStorage(
              module,
              modules,
              moduleIndex,
              variant.payloadType,
              inout visiting
            )
          ) return true;
        }
      }
      none => {}
    }
    none => {}
  }
  return false;
}

function mutexPayloadSupported(in typeName: String): boolean {
  if (
    typeName == "void"
    || stringStartsWith(typeName, "view ")
    || stringStartsWith(typeName, "Slice<")
  ) return false;
  match (genericTypeShape(typeName)) {
    some(generic) => {
      if (
        generic.base == "Once"
        || generic.base == "OnceLifetime"
        || generic.base == "Mutex"
        || generic.base == "Task"
      ) return false;
      for (const argument of generic.arguments) {
        if (!mutexPayloadSupported(argument)) return false;
      }
    }
    none => {}
  }
  return true;
}

function mutexResultBorrowsProtectedStorage(in typeName: String): boolean {
  if (
    stringStartsWith(typeName, "view ")
    || stringStartsWith(typeName, "Slice<")
  ) return true;
  match (genericTypeShape(typeName)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        if (mutexResultBorrowsProtectedStorage(argument)) return true;
      }
    }
    none => {}
  }
  return false;
}

function inferMatchArmStatementType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  statementIndex: usize,
  in expectedType: String,
  releaseBindingIndex: usize,
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
          if (
            !typeHasCleanup(modules, moduleIndex, target, visiting)
            && !typeIsForeignViewOnlyRecord(modules, moduleIndex, target)
          ) {
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
      releaseUnusedViewBindings(
        arena,
        children,
        index,
        releaseBindingIndex,
        inout bindings
      );
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
    releaseUnusedViewBindings(
      arena,
      children,
      children.length - 1,
      releaseBindingIndex,
      inout bindings
    );
    return try inferMatchArmStatementType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[children.length - 1],
      expectedType,
      releaseBindingIndex,
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
  let construction = NativeAggregateConstructionShape({
    name: "",
    valueStruct: false,
    customDeinit: false,
    genericInstance: false,
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    fields: Array<String>(),
    allFields: Array<String>(),
  });
  match (aggregateConstructionShape(modules, moduleIndex, expectedType)) {
    some(shape) => construction = move shape;
    none => return "";
  }
  const constructionAffinity = typeHasMainExecutorLifecycle(
    modules,
    moduleIndex,
    expectedType
  ) ? "thread.main" : "";
  try requireMainExecutorContext(
    module,
    tree,
    index,
    bindings,
    constructionAffinity,
    `construction of "${expectedType}"`
  );
  let genericParameters = Array<String>();
  if (!construction.genericInstance) {
    for (const parameter of construction.typeParameters) {
      genericParameters.push(parameter.copyBytes(0, parameter.byteLength));
    }
  }
  const children = copyIndices(tree.nodes[index].children);
  if (children.length != tree.nodes[index].labels.length) {
    throw resolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "malformed object initializer",
      tree.nodes[index].line,
      tree.nodes[index].column
    );
  }
  let hasSpread = children.length > 0
    && tree.nodes[index].labels[0] == "...";
  const arenaBundleField = arenaOwnerBundleFieldName(
    modules,
    moduleIndex,
    expectedType
  );
  let arenaBundleOwner = "";
  if (arenaBundleField.byteLength > 0) {
    if (hasSpread) throw resolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "Arena-owned graph bundles cannot use struct spread in the first closed-region tier",
      tree.nodes[index].line,
      tree.nodes[index].column
    );
    let arenaInitializer: usize = 0;
    let hasArenaInitializer = false;
    let arenaIndex: usize = 0;
    while (arenaIndex < tree.nodes[index].labels.length) {
      if (tree.nodes[index].labels[arenaIndex] == arenaBundleField) {
        arenaInitializer = children[arenaIndex];
        hasArenaInitializer = true;
        break;
      }
      arenaIndex = arenaIndex + 1;
    }
    if (
      !hasArenaInitializer
      || tree.nodes[arenaInitializer].kind != ExpressionKind.unaryExpression
      || tree.nodes[arenaInitializer].value != "move"
      || tree.nodes[arenaInitializer].children.length != 1
    ) throw resolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      `Arena-owned graph bundle field "${arenaBundleField}" must explicitly move a named Arena`,
      tree.nodes[index].line,
      tree.nodes[index].column
    );
    const arenaOperand = tree.nodes[arenaInitializer].children[0];
    if (tree.nodes[arenaOperand].kind != ExpressionKind.identifierExpression) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `Arena-owned graph bundle field "${arenaBundleField}" must explicitly move a named Arena`,
        tree.nodes[arenaOperand].line,
        tree.nodes[arenaOperand].column
      );
    }
    arenaBundleOwner = identifierLookupName(tree.nodes[arenaOperand].value);
    const arenaOwnerType = valueBindingType(bindings, arenaBundleOwner);
    if (!typeNameIsArena(modules, moduleIndex, arenaOwnerType)) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "Arena-owned graph bundle requires a local Arena owner",
        tree.nodes[arenaOperand].line,
        tree.nodes[arenaOperand].column
      );
    }
    try requireInitializedBinding(
      module,
      tree,
      arenaOperand,
      bindings,
      arenaBundleOwner
    );
    allowArenaBundleMove(
      inout bindings,
      tree.nodes[arenaOperand].offset
    );
  }
  let labelIndex: usize = 1;
  while (labelIndex < tree.nodes[index].labels.length) {
    if (tree.nodes[index].labels[labelIndex] == "...") {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "a struct spread must be the first object initializer entry",
        tree.nodes[children[labelIndex]].line,
        tree.nodes[children[labelIndex]].column
      );
    }
    labelIndex = labelIndex + 1;
  }
  let explicitFields = Array<String>();
  let explicitIndex: usize = hasSpread ? usize(1) : usize(0);
  while (explicitIndex < tree.nodes[index].labels.length) {
    const explicitName = tree.nodes[index].labels[explicitIndex].copyBytes(
      0,
      tree.nodes[index].labels[explicitIndex].byteLength
    );
    if (containsString(explicitFields, explicitName)) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `duplicate field initializer "${explicitName}"`,
        tree.nodes[children[explicitIndex]].line,
        tree.nodes[children[explicitIndex]].column
      );
    }
    explicitFields.push(move explicitName);
    explicitIndex = explicitIndex + 1;
  }
  let covered = Array<String>();
  let substitutions = Array<NativeValueBinding>();
  if (hasSpread) {
    if (!construction.valueStruct) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "struct spread requires a Z value struct",
        tree.nodes[index].line,
        tree.nodes[index].column
      );
    }
    if (construction.customDeinit) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `struct spread is not available for ${expectedType} because it declares deinit`,
        tree.nodes[index].line,
        tree.nodes[index].column
      );
    }
    let nativeVisiting = Array<String>();
    if (typeContainsForeignValueStorage(
      modules,
      moduleIndex,
      expectedType,
      nativeVisiting
    )) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `struct spread is not available for ${expectedType} because it contains native value storage`,
        tree.nodes[index].line,
        tree.nodes[index].column
      );
    }

    const spreadIndex = children[0];
    let spreadMode = "";
    let sourceIndex = spreadIndex;
    if (tree.nodes[spreadIndex].kind == ExpressionKind.unaryExpression) {
      spreadMode = tree.nodes[spreadIndex].value.copyBytes(
        0,
        tree.nodes[spreadIndex].value.byteLength
      );
      if (
        (spreadMode != "copy" && spreadMode != "move")
        || tree.nodes[spreadIndex].children.length != 1
      ) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "struct spread accepts only plain, copy, or move capability",
          tree.nodes[spreadIndex].line,
          tree.nodes[spreadIndex].column
        );
      }
      sourceIndex = tree.nodes[spreadIndex].children[0];
    }
    if (tree.nodes[sourceIndex].kind != ExpressionKind.identifierExpression) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "struct spread currently requires a named local source",
        tree.nodes[sourceIndex].line,
        tree.nodes[sourceIndex].column
      );
    }
    const sourceName = identifierLookupName(tree.nodes[sourceIndex].value);
    const sourceBindingType = valueBindingType(bindings, sourceName);
    if (sourceBindingType.byteLength == 0) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "struct spread currently requires a named local source",
        tree.nodes[sourceIndex].line,
        tree.nodes[sourceIndex].column
      );
    }
    try requireInitializedBinding(
      module,
      tree,
      sourceIndex,
      bindings,
      sourceName
    );
    const sourceType = try inferExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      sourceIndex,
      inout bindings,
      inout evidence
    );
    try requireSettledExpressionType(module, tree, sourceIndex, sourceType);
    recordExpressionResolution(
      modules,
      moduleIndex,
      tree,
      sourceIndex,
      sourceType,
      inout evidence
    );

    const expectedLocation = typeSymbolLocation(
      modules,
      moduleIndex,
      expectedType
    );
    const sourceLocation = typeSymbolLocation(
      modules,
      moduleIndex,
      sourceType
    );
    let sameNominal = false;
    match (in expectedLocation) {
      some(expectedIdentity) => match (in sourceLocation) {
        some(sourceIdentity) => {
          sameNominal = expectedIdentity.moduleIndex
            == sourceIdentity.moduleIndex
            && expectedIdentity.symbolIndex == sourceIdentity.symbolIndex;
        }
        none => {}
      }
      none => {}
    }
    if (!sameNominal) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `struct spread for ${expectedType} requires the same nominal struct, found ${sourceType}`,
        tree.nodes[sourceIndex].line,
        tree.nodes[sourceIndex].column
      );
    }

    if (construction.genericInstance) {
      if (!equivalentTypes(
        modules,
        moduleIndex,
        expectedType,
        sourceType
      )) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `struct spread for ${expectedType} requires the same nominal specialization, found ${sourceType}`,
          tree.nodes[sourceIndex].line,
          tree.nodes[sourceIndex].column
        );
      }
    } else if (genericParameters.length > 0) {
      match (genericTypeShape(sourceType)) {
        some(generic) => {
          if (generic.arguments.length != genericParameters.length) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              `struct spread for ${expectedType} cannot infer its generic arguments from ${sourceType}`,
              tree.nodes[sourceIndex].line,
              tree.nodes[sourceIndex].column
            );
          }
          let genericIndex: usize = 0;
          while (genericIndex < genericParameters.length) {
            addValueBinding(
              inout substitutions,
              genericParameters[genericIndex],
              generic.arguments[genericIndex]
            );
            genericIndex = genericIndex + 1;
          }
        }
        none => {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `struct spread for ${expectedType} requires concrete generic arguments`,
            tree.nodes[sourceIndex].line,
            tree.nodes[sourceIndex].column
          );
        }
      }
    } else if (!equivalentTypes(modules, moduleIndex, expectedType, sourceType)) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `struct spread for ${expectedType} requires the same nominal specialization, found ${sourceType}`,
        tree.nodes[sourceIndex].line,
        tree.nodes[sourceIndex].column
      );
    }

    for (const fieldName of construction.allFields) {
      if (containsString(explicitFields, fieldName)) continue;
      match (aggregateFieldShape(
        modules,
        moduleIndex,
        expectedType,
        fieldName
      )) {
        some(field) => {
          const retainedType = substituteGenericType(
            field.typeName,
            substitutions
          );
          if (
            spreadMode.byteLength == 0
            && typeMovesOnOwnedUse(modules, moduleIndex, retainedType)
          ) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              `plain struct spread cannot retain ownership-bearing field "${fieldName}" of type ${retainedType}`,
              tree.nodes[spreadIndex].line,
              tree.nodes[spreadIndex].column
            );
          }
          if (spreadMode == "copy") {
            let copyVisiting = Array<String>();
            if (!typeSupportsExplicitCopy(
              modules,
              moduleIndex,
              retainedType,
              copyVisiting
            )) {
              throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `copy struct spread cannot copy field "${fieldName}" of type ${retainedType}`,
                tree.nodes[spreadIndex].line,
                tree.nodes[spreadIndex].column
              );
            }
          }
        }
        none => {}
      }
    }
    if (spreadMode == "move") {
      if (!typeMovesOnOwnedUse(modules, moduleIndex, sourceType)) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `type ${sourceType} has no unique ownership to move`,
          tree.nodes[spreadIndex].line,
          tree.nodes[spreadIndex].column
        );
      }
      try consumeOwnedExpressionNode(
        module,
        modules,
        moduleIndex,
        tree,
        sourceIndex,
        sourceType,
        true,
        inout bindings
      );
    }
    if (spreadIndex != sourceIndex) {
      recordExpressionResolution(
        modules,
        moduleIndex,
        tree,
        spreadIndex,
        sourceType,
        inout evidence
      );
    }
  }
  let childIndex: usize = hasSpread ? usize(1) : usize(0);
  let storedViewOwner = "";
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
        let bundleFieldVisiting = Array<String>();
        const fieldExpression = children[childIndex];
        if (
          arenaBundleOwner.byteLength > 0
          && typeContainsStoredView(
            modules,
            moduleIndex,
            contextualFieldType,
            bundleFieldVisiting
          )
        ) {
          const bundleFieldOwner = storedViewOwnerForExpression(
            bindings,
            tree,
            fieldExpression
          );
          if (
            bundleFieldOwner.byteLength > 0
            && bundleFieldOwner != arenaBundleOwner
          ) throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `every dependent field in Arena-owned graph bundle "${expectedType}" must borrow from the moved Arena "${arenaBundleOwner}"`,
            tree.nodes[fieldExpression].line,
            tree.nodes[fieldExpression].column
          );
          if (
            bundleFieldOwner == arenaBundleOwner
            && tree.nodes[fieldExpression].kind == ExpressionKind.unaryExpression
            && tree.nodes[fieldExpression].value == "move"
            && tree.nodes[fieldExpression].children.length == 1
          ) {
            const movedField = tree.nodes[fieldExpression].children[0];
            allowArenaBundleMove(
              inout bindings,
              tree.nodes[movedField].offset
            );
          }
        }
        let optionalPayloadType = "";
        if (field.optionalField) {
          match (genericTypeShape(contextualFieldType)) {
            some(generic) => {
              if (generic.base == "Option" && generic.arguments.length == 1) {
                optionalPayloadType = generic.arguments[0].copyBytes(
                  0,
                  generic.arguments[0].byteLength
                );
              }
            }
            none => {}
          }
        }
        let actual = "";
        if (
          optionalPayloadType.byteLength > 0
          && tree.nodes[children[childIndex]].kind == ExpressionKind.objectExpression
        ) {
          actual = try inferContextualObjectExpressionNode(
            module,
            modules,
            moduleIndex,
            arena,
            tree,
            children[childIndex],
            optionalPayloadType,
            inout bindings,
            inout evidence
          );
        } else {
          actual = try inferExpressionNodeTypeExpected(
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
        }
        let liftsOptionalPayload = optionalPayloadType.byteLength > 0
          && !equivalentTypes(
            modules,
            moduleIndex,
            contextualFieldType,
            actual
          );
        if (genericParameters.length > 0) {
          let genericPattern = field.typeName.copyBytes(
            0,
            field.typeName.byteLength
          );
          if (liftsOptionalPayload) {
            match (genericTypeShape(genericPattern)) {
              some(generic) => {
                if (generic.base == "Option" && generic.arguments.length == 1) {
                  genericPattern = generic.arguments[0].copyBytes(
                    0,
                    generic.arguments[0].byteLength
                  );
                }
              }
              none => {}
            }
          }
          try bindGenericType(
            module,
            modules,
            moduleIndex,
            tree,
            children[childIndex],
            expectedType,
            genericPattern,
            actual,
            genericParameters,
            inout substitutions
          );
        }
        const concreteFieldType = substituteGenericType(
          field.typeName,
          substitutions
        );
        let consumedFieldType = concreteFieldType.copyBytes(
          0,
          concreteFieldType.byteLength
        );
        if (liftsOptionalPayload) {
          match (genericTypeShape(concreteFieldType)) {
            some(generic) => {
              if (generic.base == "Option" && generic.arguments.length == 1) {
                consumedFieldType = generic.arguments[0].copyBytes(
                  0,
                  generic.arguments[0].byteLength
                );
              }
            }
            none => {}
          }
        }
        try requireExpressionType(
          module,
          modules,
          moduleIndex,
          tree,
          children[childIndex],
          consumedFieldType,
          actual
        );
        if (typeIsClassReference(
          module,
          modules,
          moduleIndex,
          consumedFieldType
        )) {
          try invalidateLocallyContainedClassNode(
            module,
            tree,
            children[childIndex],
            inout bindings
          );
        }
        let viewVisiting = Array<String>();
        if (typeContainsStoredView(
          modules,
          moduleIndex,
          concreteFieldType,
          viewVisiting
        )) {
          const fieldOwner = storedViewOwnerForExpression(
            bindings,
            tree,
            children[childIndex]
          );
          if (fieldOwner.byteLength == 0) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              `view-bearing field "${fieldName}" must be initialized directly from proven borrowed storage`,
              tree.nodes[children[childIndex]].line,
              tree.nodes[children[childIndex]].column
            );
          }
          if (storedViewOwner.byteLength == 0) {
            storedViewOwner = fieldOwner.copyBytes(0, fieldOwner.byteLength);
          } else {
            const mergedOwner = mergeViewOwners(storedViewOwner, fieldOwner);
            if (mergedOwner == "__z_native_mixed_view_owner") {
              throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `view-bearing struct "${expectedType}" must borrow from exactly one owner`,
                tree.nodes[index].line,
                tree.nodes[index].column
              );
            }
            storedViewOwner = move mergedOwner;
          }
        }
        try consumeOwnedExpressionNode(
          module,
          modules,
          moduleIndex,
          tree,
          children[childIndex],
          consumedFieldType,
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
  for (const fieldName of construction.fields) {
    if (!hasSpread && !containsString(covered, fieldName)) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `missing field "${fieldName}" when constructing ${expectedType}`,
        tree.nodes[index].line,
        tree.nodes[index].column
      );
    }
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
      let typeIndex: usize = 0;
      while (
        typeIndex < construction.typeParameters.length
        && typeIndex < generic.arguments.length
      ) {
        addValueBinding(
          inout constraintSubstitutions,
          construction.typeParameters[typeIndex],
          generic.arguments[typeIndex]
        );
        typeIndex = typeIndex + 1;
      }
    }
    none => {}
  }
  try requireGenericConstraints(
    module,
    modules,
    moduleIndex,
    tree,
    index,
    construction.name,
    construction.typeParameterConstraints,
    constraintSubstitutions,
    bindings
  );
  let aggregateViewVisiting = Array<String>();
  if (
    arenaBundleOwner.byteLength > 0
    && storedViewOwner != arenaBundleOwner
  ) throw resolutionError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    `every dependent field in Arena-owned graph bundle "${expectedType}" must borrow from the moved Arena "${arenaBundleOwner}"`,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
  if (arenaBundleOwner.byteLength > 0) {
    closeArenaViewBindings(inout bindings, arenaBundleOwner);
  } else if (typeContainsStoredView(
    modules,
    moduleIndex,
    expectedType,
    aggregateViewVisiting
  )) {
    if (storedViewOwner.byteLength == 0) {
      storedViewOwner = ownerlessViewOwner();
    }
    setExpressionViewOrigin(
      inout bindings,
      tree.nodes[index].offset,
      storedViewOwner
    );
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
  recordExpressionResolution(
    modules,
    moduleIndex,
    tree,
    subjectIndex,
    subjectType,
    inout evidence
  );
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
  let matchSubjectType = subjectType.copyBytes(0, subjectType.byteLength);
  if (
    stringStartsWith(matchSubjectType, "view ")
    && matchSubjectType.byteLength > 5
  ) matchSubjectType = matchSubjectType.copyBytes(
    5,
    matchSubjectType.byteLength
  );
  let storedViewEnum = false;
  match (typeSymbolLocation(modules, moduleIndex, matchSubjectType)) {
    some(location) => {
      if (
        modules[location.moduleIndex].symbols[location.symbolIndex].kind
        == ModuleSymbolKind.enumSymbol
      ) {
        let subjectViewVisiting = Array<String>();
        storedViewEnum = typeContainsStoredView(
          modules,
          moduleIndex,
          subjectType,
          subjectViewVisiting
        );
      }
    }
    none => {}
  }
  const subjectViewOwner = valueBindingViewOwner(bindings, subjectRoot);
  const optionalViewSubject = subjectViewOwner.byteLength > 0
    && stringStartsWith(subjectType, "Option<view ");
  const subjectOwnership = valueBindingOwnership(bindings, subjectRoot);
  if (
    storedViewEnum
    && (
      tree.nodes[index].value != "in"
      || subjectRoot.byteLength == 0
      || (
        subjectViewOwner.byteLength == 0
        && !valueBindingIsBorrowed(bindings, subjectRoot)
      )
    )
  ) {
    throw matchError(
      module,
      tree,
      subjectIndex,
      "a view-bearing enum must be matched from proven storage with match (in value)"
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
      shape = move known;
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
  if (shape.foreignUnion) {
    if (tree.nodes[index].value != "in") {
      throw matchError(
        module,
        tree,
        index,
        "discriminated native union match requires match (in value)"
      );
    }
    let recorded = false;
    for (const existing of evidence.foreignUnionMatches) {
      if (
        existing.offset == tree.nodes[index].offset
        && existing.line == tree.nodes[index].line
        && existing.column == tree.nodes[index].column
      ) recorded = true;
    }
    if (!recorded) {
      let variants = Array<ModuleForeignUnionMatchVariant>();
      for (const variant of shape.variants) {
        let values = Array<String>();
        for (const value of variant.foreignValues) {
          values.push(value.copyBytes(0, value.byteLength));
        }
        variants.push(ModuleForeignUnionMatchVariant({
          name: variant.name.copyBytes(0, variant.name.byteLength),
          member: variant.foreignMember.copyBytes(
            0,
            variant.foreignMember.byteLength
          ),
          payloadType: variant.payloadType.copyBytes(
            0,
            variant.payloadType.byteLength
          ),
          values,
          fallback: variant.foreignFallback,
        }));
      }
      evidence.foreignUnionMatches.push(ModuleForeignUnionMatch({
        offset: tree.nodes[index].offset,
        line: tree.nodes[index].line,
        column: tree.nodes[index].column,
        unionType: subjectType.copyBytes(0, subjectType.byteLength),
        discriminantMember: shape.foreignDiscriminantMember.copyBytes(
          0,
          shape.foreignDiscriminantMember.byteLength
        ),
        discriminantType: shape.foreignDiscriminantType.copyBytes(
          0,
          shape.foreignDiscriminantType.byteLength
        ),
        variants,
      }));
    }
  }
  let covered = Array<String>();
  const expectedType = contextualExpectedType(bindings, tree, index);
  let resultType = "";
  let resultViewOwner = "";
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
    const wildcard = variantName == "_";
    if (
      wildcard
      && tree.nodes[armIndex].labels.length > 0
      && tree.nodes[armIndex].labels[0] != "none"
    ) {
      throw matchError(
        module,
        tree,
        armIndex,
        "the wildcard match arm cannot bind a payload; write _ => ..."
      );
    }
    if (wildcard && childIndex + 1 < children.length) {
      throw matchError(
        module,
        tree,
        children[childIndex + 1],
        "unreachable match arm after wildcard; move _ to the final arm"
      );
    }
    const variantIndex = matchVariantIndex(shape, variantName);
    if (!wildcard && variantIndex == shape.variants.length) {
      throw matchError(module, tree, armIndex, `unknown variant ${variantName}`);
    }
    if (containsString(covered, variantName)) {
      throw matchError(module, tree, armIndex, `duplicate match arm ${variantName}`);
    }
    if (
      !wildcard
      &&
      shape.foreignUnion
      && tree.nodes[armIndex].labels.length > 0
      && tree.nodes[armIndex].labels[0] == "object"
    ) {
      throw matchError(
        module,
        tree,
        armIndex,
        "discriminated native union payloads require one direct view binding; destructure the view inside the arm"
      );
    }
    covered.push(variantName.copyBytes(0, variantName.byteLength));
    let armBindings = copyValueBindings(bindings);
    const armBindingIndex = armBindings.length;
    markRegionControlFlow(inout armBindings, "branch");
    if (borrowedMatch && subjectRoot.byteLength > 0) {
      borrowMatchValueBindingInPlace(inout armBindings, subjectRoot);
    }
    if (optionalViewSubject && subjectRoot.byteLength > 0) {
      setValueBindingOwnership(
        inout armBindings,
        subjectRoot,
        NativeOwnershipState.moved
      );
    }
    if (!wildcard) try addMatchArmValueBindings(
        module,
        modules,
        moduleIndex,
        tree,
        armIndex,
        shape.variants[variantIndex],
        borrowedMatch,
        subjectRoot,
        inout armBindings,
        inout evidence
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
        armBindingIndex,
        inout armBindings,
        inout evidence
      );
    }
    if (optionalViewSubject && subjectRoot.byteLength > 0) {
      setValueBindingOwnership(
        inout armBindings,
        subjectRoot,
        subjectOwnership
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
      let armViewVisiting = Array<String>();
      if (typeContainsStoredView(
        modules,
        moduleIndex,
        armType,
        armViewVisiting
      )) {
        const armOwner = storedViewOwnerForStatement(
          arena,
          statements[0],
          armBindings
        );
        if (armOwner.byteLength == 0) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "every continuing arm of a view-bearing match expression must produce proven stored provenance",
            tree.nodes[armIndex].line,
            tree.nodes[armIndex].column
          );
        }
        if (resultViewOwner.byteLength == 0) {
          resultViewOwner = armOwner.copyBytes(0, armOwner.byteLength);
        } else {
          const mergedOwner = mergeViewOwners(resultViewOwner, armOwner);
          if (mergedOwner == "__z_native_mixed_view_owner") {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              "a view-bearing match expression cannot join values from different Arena owners",
              tree.nodes[armIndex].line,
              tree.nodes[armIndex].column
            );
          }
          resultViewOwner = move mergedOwner;
        }
      }
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
    if (!containsString(covered, "_") && !containsString(covered, variant.name)) {
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
    try requireSettledRegionProvenance(
      module,
      bindings,
      tree.nodes[index].line,
      tree.nodes[index].column
    );
  }
  if (unresolvedArm) return "";
  if (!hasContinuingArm) return "__z_never";
  if (resultViewOwner.byteLength > 0) setExpressionViewOrigin(
    inout bindings,
    tree.nodes[index].offset,
    resultViewOwner
  );
  return resultType;
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

struct NativeObjCRegistrationCall {
  callIndex: usize;
  receiverIndex: usize;
  receiverPath: String;
  method: NativeMethodCallShape;
  arguments: Array<usize>;
}

function objcRegistrationError(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in message: String
): ModuleResolveError {
  return codedModuleResolutionError(
    ModuleResolveErrorKind.typeMismatch,
    "Z0812",
    module.path,
    message,
    tree.nodes[index].line,
    tree.nodes[index].column,
    1
  );
}

function objcAdapterError(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in message: String
): ModuleResolveError {
  return codedModuleResolutionError(
    ModuleResolveErrorKind.typeMismatch,
    "Z0817",
    module.path,
    message,
    tree.nodes[index].line,
    tree.nodes[index].column,
    1
  );
}

function objcRegistrationCall(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  callIndex: usize,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): NativeObjCRegistrationCall throws ModuleResolveError {
  if (tree.nodes[callIndex].kind != ExpressionKind.callExpression) {
    throw objcRegistrationError(
      module,
      tree,
      callIndex,
      "objc.register add/remove values must be Objective-C method calls"
    );
  }
  const callChildren = copyIndices(tree.nodes[callIndex].children);
  if (callChildren.length == 0) throw objcRegistrationError(
    module,
    tree,
    callIndex,
    "objc.register add/remove values must be Objective-C method calls"
  );
  const calleeIndex = callChildren[0];
  if (
    tree.nodes[calleeIndex].kind != ExpressionKind.memberExpression
    || tree.nodes[calleeIndex].children.length != 1
  ) throw objcRegistrationError(
    module,
    tree,
    callIndex,
    "objc.register add/remove values must be Objective-C method calls"
  );
  const receiverIndex = tree.nodes[calleeIndex].children[0];
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
  try requireSettledExpressionType(module, tree, receiverIndex, receiverType);
  recordExpressionResolution(
    modules,
    moduleIndex,
    tree,
    receiverIndex,
    receiverType,
    inout evidence
  );
  const methodName = identifierLookupName(tree.nodes[calleeIndex].value);
  const arguments = callArgumentNodes(callChildren);
  const method = match (callableMethodCallShape(
    modules,
    moduleIndex,
    bindings,
    receiverType,
    methodName,
    false,
    arguments.length,
    tree.nodes[callIndex].labels
  )) {
    some(value) => value;
    none => throw objcRegistrationError(
      module,
      tree,
      calleeIndex,
      `objc.register could not resolve Objective-C method "${methodName}"`
    );
  };
  if (method.objectiveCSelector.byteLength == 0) {
    throw objcRegistrationError(
      module,
      tree,
      calleeIndex,
      "objc.register accepts imported Objective-C methods only"
    );
  }
  let requiredAffinity = method.signature.executorAffinity.copyBytes(
    0,
    method.signature.executorAffinity.byteLength
  );
  if (requiredAffinity.byteLength == 0) requiredAffinity =
    aggregateExecutorAffinity(
      modules,
      method.ownerModuleIndex,
      method.ownerSymbolIndex
    );
  try requireMainExecutorContext(
    module,
    tree,
    callIndex,
    bindings,
    requiredAffinity,
    `Objective-C registration method "${method.ownerName}.${method.objectiveCSelector}"`
  );
  const receiverPath = expressionDirectFieldPath(tree, receiverIndex);
  if (receiverPath.byteLength == 0) throw objcRegistrationError(
    module,
    tree,
    receiverIndex,
    "objc.register requires add/remove calls on stable named receiver storage"
  );
  return NativeObjCRegistrationCall({
    callIndex,
    receiverIndex,
    receiverPath,
    method,
    arguments,
  });
}

function stableObjCRegistrationArgument(
  in tree: ExpressionTree,
  index: usize
): boolean {
  const kind = tree.nodes[index].kind;
  return kind == ExpressionKind.identifierExpression
    || kind == ExpressionKind.stringExpression
    || kind == ExpressionKind.numberExpression
    || kind == ExpressionKind.booleanExpression
    || kind == ExpressionKind.nullExpression;
}

function sameObjCRegistrationArgument(
  in tree: ExpressionTree,
  left: usize,
  right: usize
): boolean {
  return stableObjCRegistrationArgument(tree, left)
    && stableObjCRegistrationArgument(tree, right)
    && tree.nodes[left].kind == tree.nodes[right].kind
    && tree.nodes[left].value == tree.nodes[right].value;
}

function inferObjCRegistrationMethodCall(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  in call: NativeObjCRegistrationCall,
  replaceParameter: usize,
  in replacementType: String,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): void throws ModuleResolveError {
  let signature = methodCallableSignature(call.method);
  if (replaceParameter < signature.parameterTypes.length) {
    signature.parameterTypes[replaceParameter] = replacementType.copyBytes(
      0,
      replacementType.byteLength
    );
  }
  const substitutions = Array<NativeValueBinding>();
  const calleeIndex = tree.nodes[call.callIndex].children[0];
  const result = try inferSignatureCallType(
    module,
    modules,
    moduleIndex,
    arena,
    tree,
    calleeIndex,
    call.callIndex,
    call.arguments,
    inout bindings,
    "",
    "",
    `${call.method.ownerName}.${call.method.name}`,
    signature,
    substitutions,
    call.method.ownerModuleIndex,
    call.method.ownerSymbolIndex,
    "method",
    inout evidence
  );
  if (call.method.objectiveCSelector.byteLength > 0) {
    recordResolvedObjCCallFacts(
      modules,
      tree,
      call.callIndex,
      call.method,
      inout evidence
    );
  }
  if (result != "void") throw objcRegistrationError(
    module,
    tree,
    call.callIndex,
    "objc.register add/remove methods must both return void"
  );
}

function recordResolvedObjCCallFacts(
  in modules: Array<ResolvedModule>,
  in tree: ExpressionTree,
  callIndex: usize,
  in method: NativeMethodCallShape,
  inout evidence: ModuleSemanticEvidence
): void {
  if (
    method.objectiveCSelector.byteLength == 0
    || method.ownerModuleIndex >= modules.length
    || method.ownerSymbolIndex
      >= modules[method.ownerModuleIndex].symbols.length
  ) return;
  const owner = view modules[method.ownerModuleIndex].symbols[
    method.ownerSymbolIndex
  ];
  let receiverNativeType = owner.importedName.copyBytes(
    0,
    owner.importedName.byteLength
  );
  match (in owner.typeSignature) {
    some(signature) => {
      if (signature.foreignNativeName.byteLength > 0) {
        receiverNativeType = signature.foreignNativeName.copyBytes(
          0,
          signature.foreignNativeName.byteLength
        );
      }
    }
    none => {}
  }
  recordObjCCallFacts(
    tree,
    callIndex,
    owner.foreignHeader,
    method.objectiveCSelector,
    receiverNativeType,
    method.objectiveCNativeReturnType,
    method.objectiveCParameterNativeTypes,
    method.objectiveCAsyncCallbackParameter,
    method.objectiveCAsyncResultParameter,
    method.objectiveCAsyncErrorParameter,
    inout evidence
  );
}

function requireResolvedObjCAdapterProtocols(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  in argumentNodes: Array<usize>,
  in method: NativeMethodCallShape,
  in evidence: ModuleSemanticEvidence
): void throws ModuleResolveError {
  for (const protocol of method.objectiveCParameterProtocols) {
    if (protocol.parameterIndex >= argumentNodes.length) continue;
    const argumentNode = argumentNodes[protocol.parameterIndex];
    const found = evidence.expressionResolutionIndices.get(
      tree.nodes[argumentNode].offset
    );
    let resolutionIndex = evidence.expressionResolutions.length;
    match (in found) {
      some(index) => resolutionIndex = index;
      none => {}
    }
    if (resolutionIndex >= evidence.expressionResolutions.length) continue;
    const actualType = view evidence.expressionResolutions[
      resolutionIndex
    ].typeName;
    match (genericTypeShape(actualType)) {
      some(generic) => {
        if (
          qualifiedTypeMember(generic.base) != "Adapter"
          || generic.arguments.length != 1
        ) continue;
        if (!equivalentTypes(
          modules,
          moduleIndex,
          protocol.protocolName,
          generic.arguments[0]
        )) throw objcAdapterError(
          module,
          tree,
          argumentNode,
          `Objective-C method ${method.ownerName}.${method.name} requires ${protocol.protocolName}, found ${actualType}`
        );
      }
      none => {}
    }
  }
}

function inferObjCRegistration(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  callIndex: usize,
  in namespaceName: String,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): String throws ModuleResolveError {
  const arguments = callArgumentNodes(tree.nodes[callIndex].children);
  if (arguments.length != 1) throw objcRegistrationError(
    module,
    tree,
    callIndex,
    "objc.register expects one { add, remove } descriptor"
  );
  const descriptorIndex = arguments[0];
  if (tree.nodes[descriptorIndex].kind != ExpressionKind.objectExpression) {
    throw objcRegistrationError(
      module,
      tree,
      descriptorIndex,
      "objc.register expects an object with exactly add and remove"
    );
  }
  let addIndex = tree.nodes.length;
  let removeIndex = tree.nodes.length;
  let fieldIndex: usize = 0;
  while (fieldIndex < tree.nodes[descriptorIndex].labels.length) {
    const label = view tree.nodes[descriptorIndex].labels[fieldIndex];
    if (label == "add") addIndex = tree.nodes[descriptorIndex].children[fieldIndex];
    else if (label == "remove") {
      removeIndex = tree.nodes[descriptorIndex].children[fieldIndex];
    } else throw objcRegistrationError(
      module,
      tree,
      descriptorIndex,
      "objc.register descriptor permits only add and remove"
    );
    fieldIndex = fieldIndex + 1;
  }
  if (
    addIndex >= tree.nodes.length
    || removeIndex >= tree.nodes.length
    || tree.nodes[descriptorIndex].labels.length != 2
  ) throw objcRegistrationError(
    module,
    tree,
    descriptorIndex,
    "objc.register expects exactly one add and one remove method call"
  );
  const add = try objcRegistrationCall(
    module,
    modules,
    moduleIndex,
    arena,
    tree,
    addIndex,
    inout bindings,
    inout evidence
  );
  const remove = try objcRegistrationCall(
    module,
    modules,
    moduleIndex,
    arena,
    tree,
    removeIndex,
    inout bindings,
    inout evidence
  );
  if (add.receiverPath != remove.receiverPath) throw objcRegistrationError(
    module,
    tree,
    remove.receiverIndex,
    "objc.register add and remove must use the same Objective-C receiver"
  );
  let handlerParameter = add.arguments.length;
  for (const protocol of add.method.objectiveCParameterProtocols) {
    if (handlerParameter == add.arguments.length) {
      handlerParameter = protocol.parameterIndex;
    } else if (handlerParameter != protocol.parameterIndex) {
      throw objcRegistrationError(
        module,
        tree,
        add.callIndex,
        "objc.register add method must accept exactly one id<Protocol> parameter"
      );
    }
  }
  if (handlerParameter >= add.arguments.length) throw objcRegistrationError(
    module,
    tree,
    add.callIndex,
    "objc.register add method must accept exactly one id<Protocol> parameter"
  );
  if (remove.method.objectiveCParameterProtocols.length > 0) {
    throw objcRegistrationError(
      module,
      tree,
      remove.callIndex,
      "objc.register remove method cannot require another protocol adapter"
    );
  }
  const handlerNode = add.arguments[handlerParameter];
  if (tree.nodes[handlerNode].kind != ExpressionKind.identifierExpression) {
    throw objcRegistrationError(
      module,
      tree,
      handlerNode,
      "objc.register protocol owners must be stored Z class bindings"
    );
  }
  const handlerName = identifierLookupName(tree.nodes[handlerNode].value);
  const handlerType = valueBindingType(bindings, handlerName);
  const handlerLocation = match (typeSymbolLocation(
    modules,
    moduleIndex,
    handlerType
  )) {
    some(location) => location;
    none => throw objcRegistrationError(
      module,
      tree,
      handlerNode,
      "objc.register protocol owner must have a known Z class type"
    );
  };
  if (
    modules[handlerLocation.moduleIndex].symbols[handlerLocation.symbolIndex].kind
      != ModuleSymbolKind.classSymbol
  ) throw objcRegistrationError(
    module,
    tree,
    handlerNode,
    "objc.register protocol owner must be a Z class"
  );
  for (const protocol of add.method.objectiveCParameterProtocols) {
    if (!typeSatisfiesTrait(
      modules,
      moduleIndex,
      handlerType,
      protocol.protocolName
    )) throw objcRegistrationError(
      module,
      tree,
      handlerNode,
      `${handlerType} does not implement Objective-C protocol ${protocol.protocolName}`
    );
  }
  let removeArgumentIndex: usize = 0;
  let removeArgumentSources = Array<usize>();
  while (removeArgumentIndex < remove.arguments.length) {
    const removeArgument = remove.arguments[removeArgumentIndex];
    let matchCount: usize = 0;
    let matchedAddArgument: usize = add.arguments.length;
    let addArgumentIndex: usize = 0;
    while (addArgumentIndex < add.arguments.length) {
      if (
        addArgumentIndex != handlerParameter
        && sameObjCRegistrationArgument(
          tree,
          add.arguments[addArgumentIndex],
          removeArgument
        )
        && addArgumentIndex
          < add.method.objectiveCParameterNativeTypes.length
        && removeArgumentIndex
          < remove.method.objectiveCParameterNativeTypes.length
        && add.method.objectiveCParameterNativeTypes[addArgumentIndex]
          == remove.method.objectiveCParameterNativeTypes[removeArgumentIndex]
      ) {
        matchCount = matchCount + 1;
        matchedAddArgument = addArgumentIndex;
      }
      addArgumentIndex = addArgumentIndex + 1;
    }
    if (matchCount != 1) throw objcRegistrationError(
      module,
      tree,
      removeArgument,
      "objc.register remove arguments must reuse exactly one add-time named or literal value with the same native ABI type"
    );
    removeArgumentSources.push(matchedAddArgument);
    removeArgumentIndex = removeArgumentIndex + 1;
  }
  try inferObjCRegistrationMethodCall(
    module,
    modules,
    moduleIndex,
    arena,
    tree,
    add,
    handlerParameter,
    handlerType,
    inout bindings,
    inout evidence
  );
  const noReplacementParameter = remove.arguments.length;
  try inferObjCRegistrationMethodCall(
    module,
    modules,
    moduleIndex,
    arena,
    tree,
    remove,
    noReplacementParameter,
    "",
    inout bindings,
    inout evidence
  );
  const receiverSymbol = view modules[add.method.ownerModuleIndex].symbols[
    add.method.ownerSymbolIndex
  ];
  let receiverNativeType = receiverSymbol.importedName.copyBytes(
    0,
    receiverSymbol.importedName.byteLength
  );
  match (in receiverSymbol.typeSignature) {
    some(signature) => {
      if (signature.foreignNativeName.byteLength > 0) {
        receiverNativeType = signature.foreignNativeName.copyBytes(
          0,
          signature.foreignNativeName.byteLength
        );
      }
    }
    none => {}
  }
  let protocolNativeNames = Array<String>();
  let protocolMethods = Array<ModuleObjCProtocolMethodResolution>();
  for (const protocol of add.method.objectiveCParameterProtocols) {
    const protocolLocation = match (typeSymbolLocation(
      modules,
      moduleIndex,
      protocol.protocolName
    )) {
      some(location) => location;
      none => throw objcRegistrationError(
        module,
        tree,
        handlerNode,
        `objc.register lost Objective-C protocol metadata for ${protocol.protocolName}`
      );
    };
    const protocolSymbol = view modules[protocolLocation.moduleIndex].symbols[
      protocolLocation.symbolIndex
    ];
    match (in protocolSymbol.typeSignature) {
      some(protocolSignature) => {
        let protocolNativeName = protocolSymbol.importedName.copyBytes(
          0,
          protocolSymbol.importedName.byteLength
        );
        if (protocolSignature.foreignNativeName.byteLength > 0) {
          protocolNativeName = protocolSignature.foreignNativeName.copyBytes(
            0,
            protocolSignature.foreignNativeName.byteLength
          );
        }
        let protocolAlreadyPresent = false;
        for (const existing of protocolNativeNames) {
          if (existing == protocolNativeName) protocolAlreadyPresent = true;
        }
        if (!protocolAlreadyPresent) protocolNativeNames.push(
          protocolNativeName.copyBytes(0, protocolNativeName.byteLength)
        );
        for (const requirement of protocolSignature.methods) {
          if (
            requirement.staticMethod
            || requirement.objectiveCSelector.byteLength == 0
          ) continue;
          let targetName = "";
          match (in modules[handlerLocation.moduleIndex].symbols[
            handlerLocation.symbolIndex
          ].typeSignature) {
            some(handlerSignature) => {
              for (const method of handlerSignature.methods) {
                if (
                  !method.staticMethod
                  && (
                    method.objectiveCImplementationSelector
                      == requirement.objectiveCSelector
                    || (
                      method.objectiveCImplementationSelector.byteLength == 0
                      && method.name == requirement.name
                    )
                  )
                ) {
                  targetName = method.name.copyBytes(0, method.name.byteLength);
                }
              }
            }
            none => {}
          }
          if (targetName.byteLength == 0) {
            if (requirement.objectiveCRequired) throw objcRegistrationError(
              module,
              tree,
              handlerNode,
              `${handlerType} does not provide Objective-C protocol method ${requirement.name}`
            );
            continue;
          }
          let nativeParameterTypes = Array<String>();
          for (const nativeType of requirement.objectiveCParameterNativeTypes) {
            nativeParameterTypes.push(nativeType.copyBytes(
              0,
              nativeType.byteLength
            ));
          }
          protocolMethods.push(ModuleObjCProtocolMethodResolution({
            protocolNativeName: protocolNativeName.copyBytes(
              0,
              protocolNativeName.byteLength
            ),
            targetName,
            selector: requirement.objectiveCSelector.copyBytes(
              0,
              requirement.objectiveCSelector.byteLength
            ),
            nativeReturnType: requirement.objectiveCNativeReturnType.copyBytes(
              0,
              requirement.objectiveCNativeReturnType.byteLength
            ),
            nativeParameterTypes,
          }));
        }
      }
      none => throw objcRegistrationError(
        module,
        tree,
        handlerNode,
        `objc.register lost Objective-C protocol metadata for ${protocol.protocolName}`
      );
    }
  }
  let addParameterNativeTypes = Array<String>();
  for (const nativeType of add.method.objectiveCParameterNativeTypes) {
    addParameterNativeTypes.push(nativeType.copyBytes(0, nativeType.byteLength));
  }
  let removeParameterNativeTypes = Array<String>();
  for (const nativeType of remove.method.objectiveCParameterNativeTypes) {
    removeParameterNativeTypes.push(nativeType.copyBytes(
      0,
      nativeType.byteLength
    ));
  }
  evidence.objectiveCRegistrations.push(ModuleObjCRegistrationResolution({
    moduleIndex,
    offset: tree.nodes[callIndex].offset,
    line: tree.nodes[callIndex].line,
    column: tree.nodes[callIndex].column,
    foreignHeader: receiverSymbol.foreignHeader.copyBytes(
      0,
      receiverSymbol.foreignHeader.byteLength
    ),
    receiverNativeType,
    ownerType: handlerType.copyBytes(0, handlerType.byteLength),
    ownerModuleIndex: handlerLocation.moduleIndex,
    ownerSymbolIndex: handlerLocation.symbolIndex,
    protocolNativeNames,
    protocolMethods,
    addSelector: add.method.objectiveCSelector.copyBytes(
      0,
      add.method.objectiveCSelector.byteLength
    ),
    addParameterNativeTypes,
    handlerParameter,
    removeSelector: remove.method.objectiveCSelector.copyBytes(
      0,
      remove.method.objectiveCSelector.byteLength
    ),
    removeParameterNativeTypes,
    removeArgumentSources,
  }));
  return `${namespaceName}.Registration`;
}

function inferObjCAdapter(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  callIndex: usize,
  calleeIndex: usize,
  in namespaceName: String,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): String throws ModuleResolveError {
  const explicit = match (explicitCallTypeArguments(tree, calleeIndex)) {
    some(arguments) => arguments;
    none => throw objcAdapterError(
      module,
      tree,
      calleeIndex,
      "objc.adapt requires one explicit Objective-C protocol type"
    );
  };
  if (explicit.arguments.length != 1) throw objcAdapterError(
    module,
    tree,
    calleeIndex,
    `objc.adapt expects one protocol type argument, received ${explicit.arguments.length}`
  );
  const arguments = callArgumentNodes(tree.nodes[callIndex].children);
  if (arguments.length != 1) throw objcAdapterError(
    module,
    tree,
    callIndex,
    `objc.adapt expects one stored Z class controller, received ${arguments.length}`
  );
  const ownerNode = arguments[0];
  if (tree.nodes[ownerNode].kind != ExpressionKind.identifierExpression) {
    throw objcAdapterError(
      module,
      tree,
      ownerNode,
      "objc.adapt requires a stored Z class binding so the adapter can retain its controller"
    );
  }
  const ownerName = identifierLookupName(tree.nodes[ownerNode].value);
  try requireInitializedBinding(
    module,
    tree,
    ownerNode,
    bindings,
    ownerName
  );
  const ownerType = try inferExpressionNodeType(
    module,
    modules,
    moduleIndex,
    arena,
    tree,
    ownerNode,
    inout bindings,
    inout evidence
  );
  try requireSettledExpressionType(module, tree, ownerNode, ownerType);
  recordExpressionResolution(
    modules,
    moduleIndex,
    tree,
    ownerNode,
    ownerType,
    inout evidence
  );
  const ownerLocation = match (typeSymbolLocation(
    modules,
    moduleIndex,
    ownerType
  )) {
    some(location) => location;
    none => throw objcAdapterError(
      module,
      tree,
      ownerNode,
      "objc.adapt controller must have a known Z class type"
    );
  };
  if (
    modules[ownerLocation.moduleIndex].symbols[ownerLocation.symbolIndex].kind
      != ModuleSymbolKind.classSymbol
  ) throw objcAdapterError(
    module,
    tree,
    ownerNode,
    "objc.adapt controller must be a Z class"
  );

  const protocolType = explicit.arguments[0].copyBytes(
    0,
    explicit.arguments[0].byteLength
  );
  const protocolLocation = match (typeSymbolLocation(
    modules,
    moduleIndex,
    protocolType
  )) {
    some(location) => location;
    none => throw objcAdapterError(
      module,
      tree,
      calleeIndex,
      `objc.adapt cannot resolve Objective-C protocol ${protocolType}`
    );
  };
  const protocolSymbol = view modules[protocolLocation.moduleIndex].symbols[
    protocolLocation.symbolIndex
  ];
  if (!typeSatisfiesTrait(
    modules,
    moduleIndex,
    ownerType,
    protocolType
  )) throw objcAdapterError(
    module,
    tree,
    ownerNode,
    `${ownerType} does not implement Objective-C protocol ${protocolType}`
  );

  const requiredAffinity = "thread.main";
  let protocolNativeName = protocolSymbol.importedName.copyBytes(
    0,
    protocolSymbol.importedName.byteLength
  );
  let protocolMetadataPresent = false;
  let protocolMetadataValid = false;
  let protocolMethods = Array<ModuleObjCProtocolMethodResolution>();
  match (in protocolSymbol.typeSignature) {
    some(protocolSignature) => {
      protocolMetadataPresent = true;
      protocolMetadataValid = protocolSignature.foreignKind == "objcProtocol";
      if (protocolSignature.foreignNativeName.byteLength > 0) {
        protocolNativeName = protocolSignature.foreignNativeName.copyBytes(
          0,
          protocolSignature.foreignNativeName.byteLength
        );
      }
      for (const requirement of protocolSignature.methods) {
        if (
          requirement.staticMethod
          || requirement.objectiveCSelector.byteLength == 0
        ) continue;
        let targetName = "";
        match (in modules[ownerLocation.moduleIndex].symbols[
          ownerLocation.symbolIndex
        ].typeSignature) {
          some(ownerSignature) => {
            for (const method of ownerSignature.methods) {
              if (
                !method.staticMethod
                && (
                  method.objectiveCImplementationSelector
                    == requirement.objectiveCSelector
                  || (
                    method.objectiveCImplementationSelector.byteLength == 0
                    && method.name == requirement.name
                  )
                )
              ) targetName = method.name.copyBytes(0, method.name.byteLength);
            }
          }
          none => {}
        }
        if (targetName.byteLength == 0) {
          if (requirement.objectiveCRequired) throw objcAdapterError(
            module,
            tree,
            ownerNode,
            `${ownerType} does not provide Objective-C protocol method ${requirement.name}`
          );
          continue;
        }
        let nativeParameterTypes = Array<String>();
        for (const nativeType of requirement.objectiveCParameterNativeTypes) {
          nativeParameterTypes.push(nativeType.copyBytes(
            0,
            nativeType.byteLength
          ));
        }
        protocolMethods.push(ModuleObjCProtocolMethodResolution({
          protocolNativeName: protocolNativeName.copyBytes(
            0,
            protocolNativeName.byteLength
          ),
          targetName,
          selector: requirement.objectiveCSelector.copyBytes(
            0,
            requirement.objectiveCSelector.byteLength
          ),
          nativeReturnType: requirement.objectiveCNativeReturnType.copyBytes(
            0,
            requirement.objectiveCNativeReturnType.byteLength
          ),
          nativeParameterTypes,
        }));
      }
    }
    none => {}
  }
  if (!protocolMetadataPresent) throw objcAdapterError(
    module,
    tree,
    calleeIndex,
    `objc.adapt lost Objective-C protocol metadata for ${protocolType}`
  );
  if (!protocolMetadataValid) throw objcAdapterError(
    module,
    tree,
    calleeIndex,
    `objc.adapt requires an imported Objective-C protocol, found ${protocolType}`
  );
  try requireMainExecutorContext(
    module,
    tree,
    callIndex,
    bindings,
    requiredAffinity,
    `Objective-C protocol adapter for ${protocolType}`
  );
  let protocolNativeNames = Array<String>();
  protocolNativeNames.push(protocolNativeName.copyBytes(
    0,
    protocolNativeName.byteLength
  ));
  evidence.objectiveCAdapters.push(ModuleObjCAdapterResolution({
    moduleIndex,
    offset: tree.nodes[callIndex].offset,
    line: tree.nodes[callIndex].line,
    column: tree.nodes[callIndex].column,
    ownerType: ownerType.copyBytes(0, ownerType.byteLength),
    ownerModuleIndex: ownerLocation.moduleIndex,
    ownerSymbolIndex: ownerLocation.symbolIndex,
    protocolType: protocolType.copyBytes(0, protocolType.byteLength),
    protocolNativeNames,
    protocolMethods,
  }));
  return `${namespaceName}.Adapter<${protocolType}>`;
}

function hasNativeObjCRegistrationMetadata(
  in modules: Array<ResolvedModule>
): boolean {
  for (const module of modules) {
    for (const symbol of module.symbols) {
      match (in symbol.typeSignature) {
        some(signature) => {
          if (signature.foreignKind == "objcInterface") return true;
        }
        none => {}
      }
    }
  }
  return false;
}

function isNativeObjectiveCObjectType(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  const nullableTarget = nullableTargetType(typeName);
  let target = typeName.copyBytes(0, typeName.byteLength);
  if (nullableTarget.byteLength > 0) target = nullableTarget;
  if (target == "id") return true;
  return match (inferredTypeSymbolLocation(modules, moduleIndex, target)) {
    some(location) => {
      const symbol = view modules[location.moduleIndex]
        .symbols[location.symbolIndex];
      if (symbol.kind != ModuleSymbolKind.classSymbol) return false;
      return match (in symbol.typeSignature) {
        some(signature) => signature.foreignKind == "objcInterface";
        none => false;
      };
    }
    none => false;
  };
}

function optionalReceiverPayloadType(in typeName: String): Option<String> {
  match (genericTypeShape(typeName)) {
    some(generic) => {
      if (generic.base == "Option" && generic.arguments.length == 1) {
        return Option.some(generic.arguments[0].copyBytes(
          0,
          generic.arguments[0].byteLength
        ));
      }
    }
    none => {}
  }
  return Option<String>.none;
}

function optionalValueType(in typeName: String): String {
  if (typeName == "void") return "void";
  match (optionalReceiverPayloadType(typeName)) {
    some(_) => return typeName.copyBytes(0, typeName.byteLength);
    none => {}
  }
  return `Option<${typeName}>`;
}

function optionalCallType(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in typeName: String
): String throws ModuleResolveError {
  match (pendingThrowingCallShape(typeName)) {
    some(_) => throw resolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "native optional-call effect projection remains deferred; Stage 0 is authoritative",
      tree.nodes[index].line,
      tree.nodes[index].column
    );
    none => {}
  }
  match (pendingAsyncCallShape(typeName)) {
    some(_) => throw resolutionError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "native optional-call effect projection remains deferred; Stage 0 is authoritative",
      tree.nodes[index].line,
      tree.nodes[index].column
    );
    none => {}
  }
  return optionalValueType(typeName);
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
  const viewOwner = expressionViewOrigin(
    expressionBindings,
    tree.nodes[index].offset
  );
  copyBindingFlowStates(inout bindings, expressionBindings);
  if (
    expectedType == "String"
    && isNativeObjectiveCStringType(modules, moduleIndex, inferred)
  ) markObjectiveCStringCopy(inout bindings, tree.nodes[index].offset);
  if (viewOwner.byteLength > 0) {
    setExpressionViewOrigin(
      inout bindings,
      tree.nodes[index].offset,
      viewOwner
    );
  }
  return inferred;
}

function applyNullConditionNarrowing(
  in tree: ExpressionTree,
  index: usize,
  conditionIsTrue: boolean,
  inout bindings: Array<NativeValueBinding>
): void {
  const node = view tree.nodes[index];
  const children = copyIndices(node.children);
  if (
    node.kind == ExpressionKind.unaryExpression
    && node.value == "!"
    && children.length == 1
  ) {
    applyNullConditionNarrowing(
      tree,
      children[0],
      !conditionIsTrue,
      inout bindings
    );
    return;
  }
  if (
    node.kind != ExpressionKind.binaryExpression
    || children.length != 2
  ) return;
  if (node.value == "&&" && conditionIsTrue) {
    applyNullConditionNarrowing(tree, children[0], true, inout bindings);
    applyNullConditionNarrowing(tree, children[1], true, inout bindings);
    return;
  }
  if (node.value == "||" && !conditionIsTrue) {
    applyNullConditionNarrowing(tree, children[0], false, inout bindings);
    applyNullConditionNarrowing(tree, children[1], false, inout bindings);
    return;
  }
  if (node.value != "==" && node.value != "!=") return;
  const left = children[0];
  const right = children[1];
  let bindingNode = tree.nodes.length;
  if (
    tree.nodes[left].kind == ExpressionKind.identifierExpression
    && tree.nodes[right].kind == ExpressionKind.nullExpression
  ) bindingNode = left;
  else if (
    tree.nodes[right].kind == ExpressionKind.identifierExpression
    && tree.nodes[left].kind == ExpressionKind.nullExpression
  ) bindingNode = right;
  if (bindingNode >= tree.nodes.length) return;
  const provesNonNull = node.value == "!="
    ? conditionIsTrue
    : !conditionIsTrue;
  if (!provesNonNull) return;
  const bindingName = identifierLookupName(tree.nodes[bindingNode].value);
  const currentType = valueBindingType(bindings, bindingName);
  const target = nullableTargetType(currentType);
  if (target.byteLength > 0) {
    setValueBindingType(inout bindings, bindingName, target);
  }
}

function recordInferredOutBinding(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in name: String,
  useOffset: usize,
  in typeName: String,
  inout evidence: ModuleSemanticEvidence
): void {
  let declaration = arena.nodes.length;
  let declarationOffset: usize = 0;
  let nodeIndex: usize = 0;
  while (nodeIndex < arena.nodes.length) {
    const node = view arena.nodes[nodeIndex];
    if (
      node.kind == StatementKind.variableStatement
      && node.name == name
      && node.nameOffset <= useOffset
      && (declaration == arena.nodes.length || node.nameOffset >= declarationOffset)
    ) {
      declaration = nodeIndex;
      declarationOffset = node.nameOffset;
    }
    nodeIndex = nodeIndex + 1;
  }
  if (declaration >= arena.nodes.length) return;
  for (const node of arena.nodes) {
    if (node.nameOffset != arena.nodes[declaration].nameOffset) continue;
    for (const resolution of evidence.bindingResolutions) {
      if (resolution.offset == node.nameOffset) return;
    }
    recordBindingResolution(modules, moduleIndex, node.nameOffset,
      node.nameLine, node.nameColumn, name, node.mutableBinding,
      typeName, inout evidence);
    return;
  }
}

function declaredCallableTypeParameterCount(
  in modules: Array<ResolvedModule>,
  targetModuleIndex: usize,
  targetSymbolIndex: usize,
  in callKind: String,
  in functionName: String,
  fallback: usize
): usize {
  if (
    callKind != "method"
    && callKind != "staticMethod"
  ) return fallback;
  if (
    targetModuleIndex >= modules.length
    || targetSymbolIndex >= modules[targetModuleIndex].symbols.length
  ) return fallback;
  const symbol = view modules[targetModuleIndex].symbols[targetSymbolIndex];
  match (in symbol.typeSignature) {
    some(owner) => {
      for (const method of owner.methods) {
        const target = `${symbol.name}.${method.name}`;
        if (target == functionName) return method.signature.typeParameters.length;
      }
    }
    none => {}
  }
  return fallback;
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
  let requiredExecutor = signature.executorAffinity.copyBytes(
    0,
    signature.executorAffinity.byteLength
  );
  if (signature.threadContract == "thread.main") {
    requiredExecutor = "thread.main";
  }
  try requireMainExecutorContext(
    module,
    tree,
    callIndex,
    bindings,
    requiredExecutor,
    `function "${functionName}"`
  );
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
    let receiverIdentity = valueBindingClassAlias(bindings, receiverRoot);
    let receiverPath = receiverRoot.copyBytes(0, receiverRoot.byteLength);
    let registeredReceiverRoot = receiverRoot.copyBytes(
      0,
      receiverRoot.byteLength
    );
    let receiverAliasUnknown = false;
    if (
      tree.nodes[calleeIndex].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeIndex].children.length == 1
    ) {
      const receiverNode = tree.nodes[calleeIndex].children[0];
      receiverPath = expressionDirectFieldPath(tree, receiverNode);
      const projectedIdentity = directAggregateClassAliasNodeIdentity(
        tree,
        receiverNode,
        bindings
      );
      receiverAliasUnknown = projectedIdentity == 0
        && directAggregateClassAliasNodeIsTracked(
          tree,
          receiverNode,
          bindings
        );
      if (projectedIdentity > 0 || receiverAliasUnknown) {
        receiverIdentity = projectedIdentity;
        registeredReceiverRoot = receiverPath.copyBytes(
          0,
          receiverPath.byteLength
        );
      }
    }
    if (receiverMode == "inout" || receiverMode == "out" || receiverMode == "move") {
      markClosureCaptureMutation(inout bindings, receiverRoot);
      const liveView = liveViewBindingForOwner(bindings, receiverRoot);
      if (liveView.byteLength > 0) {
        const action = receiverMode == "move" ? "move" : "mutate";
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `cannot ${action} "${receiverRoot}" while view "${liveView}" is live`,
          tree.nodes[calleeIndex].line,
          tree.nodes[calleeIndex].column
        );
      }
    }
    try registerCallAccess(
      module,
      tree,
      calleeIndex,
      inout accesses,
      registeredReceiverRoot,
      receiverPath,
      receiverIdentity,
      receiverAliasUnknown,
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
    let accessIdentity = valueBindingClassAlias(bindings, root);
    const accessPath = expressionDirectFieldPath(tree, nodeIndex);
    const projectedIdentity = directAggregateClassAliasNodeIdentity(
      tree,
      nodeIndex,
      bindings
    );
    const accessAliasUnknown = projectedIdentity == 0
      && directAggregateClassAliasNodeIsTracked(
        tree,
        nodeIndex,
        bindings
      );
    let registeredRoot = root.copyBytes(0, root.byteLength);
    if (projectedIdentity > 0 || accessAliasUnknown) {
      accessIdentity = projectedIdentity;
      registeredRoot = accessPath.copyBytes(0, accessPath.byteLength);
    }
    if (
      root.byteLength > 0
      && (capability == "inout" || capability == "out" || capability == "move")
    ) {
      markClosureCaptureMutation(inout bindings, root);
      const mutationPath = capability == "inout"
        ? accessPath.copyBytes(0, accessPath.byteLength)
        : root.copyBytes(0, root.byteLength);
      const liveView = liveViewBindingForStoragePath(
        bindings,
        root,
        mutationPath
      );
      if (liveView.byteLength > 0) {
        const action = capability == "move" ? "move" : "mutate";
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `cannot ${action} "${mutationPath}" while view "${liveView}" is live`,
          tree.nodes[nodeIndex].line,
          tree.nodes[nodeIndex].column
        );
      }
    }
    try registerCallAccess(
      module,
      tree,
      nodeIndex,
      inout accesses,
      registeredRoot,
      accessPath,
      accessIdentity,
      accessAliasUnknown,
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
    const access = expressionCapabilityAccess(tree, nodeIndex);
    let bindingName = "";
    const bindingIndex = expressionCapabilityBindingIndex(tree, nodeIndex);
    if (access.byteLength > 0) {
      bindingName = identifierLookupName(tree.nodes[bindingIndex].value);
    }
    if (mode == "out" || mode == "inout") {
      if (
        access != mode
        || (mode == "out" && projectedFieldCount(tree, nodeIndex) > 0)
      ) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `"${functionName}" requires ${mode} <mutable binding> for parameter ${argumentIndex + 1}`,
          tree.nodes[nodeIndex].line,
          tree.nodes[nodeIndex].column
        );
      }
      const capabilityOwnerType = valueBindingType(bindings, bindingName);
      const ownedClassProjection = projectedFieldCount(tree, nodeIndex) > 0
        && typeIsClassReference(
          module,
          modules,
          moduleIndex,
          capabilityOwnerType
        )
        && !valueBindingIsBorrowed(bindings, bindingName);
      if (
        !valueBindingIsMutable(bindings, bindingName)
        && !ownedClassProjection
      ) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `${mode} argument "${bindingName}" requires a mutable let binding`,
          tree.nodes[bindingIndex].line,
          tree.nodes[bindingIndex].column
        );
      }
      if (mode == "inout") {
        if (projectedFieldCount(tree, nodeIndex) > 0) {
          if (signature.asynchronous) throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "projected inout cannot cross an async suspension in this shape-stability tier",
            tree.nodes[nodeIndex].line,
            tree.nodes[nodeIndex].column
          );
          try requireProjectedCapabilityValuePath(
            module,
            modules,
            moduleIndex,
            tree,
            nodeIndex,
            bindings,
            true
          );
        }
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
      let bindingType = valueBindingType(bindings, bindingName);
      if (mode == "inout" && projectedFieldCount(tree, nodeIndex) > 0) {
        bindingType = try inferExpressionNodeTypeExpected(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          nodeIndex,
          signature.parameterTypes[argumentIndex],
          inout bindings,
          inout evidence
        );
      }
      if (mode == "out" && bindingType.byteLength == 0) {
        bindingType = settledContextualType(
          signature.parameterTypes[argumentIndex],
          signature.typeParameters,
          substitutions
        );
        if (bindingType.byteLength > 0) {
          setValueBindingType(inout bindings, bindingName, bindingType);
          recordInferredOutBinding(
            modules,
            moduleIndex,
            arena,
            bindingName,
            tree.nodes[bindingIndex].offset,
            bindingType,
            inout evidence
          );
        }
      }
      argumentTypes.push(move bindingType);
    } else {
      if (access.byteLength > 0 && !(mode == "in" && access == "in")) {
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
      const inferredNode = access == "in" && projectedFieldCount(tree, nodeIndex) == 0
        ? bindingIndex
        : nodeIndex;
      if (
        access == "in"
        && projectedFieldCount(tree, nodeIndex) > 0
        && signature.asynchronous
      ) throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "a projected field borrow cannot cross an async suspension in this shape-stability tier",
        tree.nodes[nodeIndex].line,
        tree.nodes[nodeIndex].column
      );
      if (access == "in" && projectedFieldCount(tree, nodeIndex) > 0) {
        try requireProjectedCapabilityValuePath(
          module,
          modules,
          moduleIndex,
          tree,
          nodeIndex,
          bindings,
          false
        );
      }
      let inferenceExpectedType = expectedArgumentType.copyBytes(
        0,
        expectedArgumentType.byteLength
      );
      if (mode == "in" && !signature.asynchronous
        && tree.nodes[inferredNode].kind == ExpressionKind.closureExpression) {
        inferenceExpectedType = nativeBorrowedCallbackType(
          modules, moduleIndex, inferenceExpectedType
        );
      }
      if (mode == "in" && tree.nodes[inferredNode].kind == ExpressionKind.identifierExpression) {
        const inferredName = identifierLookupName(tree.nodes[inferredNode].value);
        const inferredBindingType = valueBindingType(bindings, inferredName);
        if (stringStartsWith(inferredBindingType, "view ")) {
          const viewTarget = inferredBindingType.copyBytes(
            5,
            inferredBindingType.byteLength
          );
          let acceptsView = equivalentTypes(
            modules,
            moduleIndex,
            expectedArgumentType,
            viewTarget
          );
          for (const typeParameter of valueTypeParameters) {
            if (expectedArgumentType == typeParameter) acceptsView = true;
          }
          if (acceptsView) inferenceExpectedType = move inferredBindingType;
        }
      }
      let inlineClosureCaptures = Array<String>();
      if (tree.nodes[nodeIndex].kind == ExpressionKind.closureExpression) {
        inlineClosureCaptures = closureCaptureNames(
          arena,
          tree,
          nodeIndex,
          bindings
        );
        // Expected-type inference runs against a copied flow-state array.
        // Predeclare capture evidence so its updated mode is copied back into
        // the enclosing call's bindings after the closure body is checked.
        for (const capture of inlineClosureCaptures) {
          const captureEvidenceName = closureCaptureEvidenceBindingName(
            tree.nodes[nodeIndex].offset,
            capture
          );
          const captureEvidence = valueBindingType(
            bindings,
            captureEvidenceName
          );
          if (captureEvidence.byteLength == 0) {
            addValueBinding(inout bindings, captureEvidenceName, "in");
          }
        }
      }
      const argumentType = try inferExpressionNodeTypeExpected(
        module,
        modules,
        moduleIndex,
        arena,
        tree,
        inferredNode,
        inferenceExpectedType,
        inout bindings,
        inout evidence
      );
      if (mode == "in" && stringStartsWith(argumentType, "__z_native_function:borrowed ")) {
        let proven = false;
        for (const parameter of signature.nonEscapingParameters) {
          if (parameter == argumentIndex) proven = true;
        }
        if (!proven) throw codedModuleResolutionError(
          ModuleResolveErrorKind.typeMismatch, "Z0212", module.path,
          `borrowed callback cannot enter "${functionName}" without a proven non-escaping parameter; use a move closure with an owned environment`,
          tree.nodes[nodeIndex].line, tree.nodes[nodeIndex].column, 1
        );
      }
      if (tree.nodes[nodeIndex].kind == ExpressionKind.closureExpression) {
        for (const capture of inlineClosureCaptures) {
          const captureIdentity = valueBindingClassAlias(bindings, capture);
          if (captureIdentity == 0) continue;
          const captureEvidenceName = closureCaptureEvidenceBindingName(
            tree.nodes[nodeIndex].offset,
            capture
          );
          let captureMode = valueBindingType(
            bindings,
            captureEvidenceName
          );
          if (captureMode.byteLength == 0) captureMode = "in";
          let captureAccesses = Array<NativeCallAccess>();
          for (const existingAccess of accesses) {
            captureAccesses.push(NativeCallAccess({
              root: existingAccess.root.copyBytes(
                0,
                existingAccess.root.byteLength
              ),
              path: existingAccess.path.copyBytes(
                0,
                existingAccess.path.byteLength
              ),
              aliasIdentity: existingAccess.aliasIdentity,
              aliasUnknown: existingAccess.aliasUnknown,
              capability: existingAccess.capability.copyBytes(
                0,
                existingAccess.capability.byteLength
              ),
            }));
          }
          try registerCallAccess(
            module,
            tree,
            nodeIndex,
            inout captureAccesses,
            capture,
            capture,
            captureIdentity,
            false,
            captureMode
          );
        }
      }
      if (
        mode == "value"
        && !stringStartsWith(signature.parameterTypes[argumentIndex], "Slice<")
      ) {
        if (typeIsClassReference(
          module,
          modules,
          moduleIndex,
          argumentType
        )) {
          try invalidateLocallyContainedClassNode(
            module,
            tree,
            nodeIndex,
            inout bindings
          );
        }
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
      let genericArgumentType = argumentTypes[argumentIndex].copyBytes(
        0,
        argumentTypes[argumentIndex].byteLength
      );
      if (
        mode == "in"
        && stringStartsWith(genericArgumentType, "view ")
        && !stringStartsWith(signature.parameterTypes[argumentIndex], "view ")
      ) {
        genericArgumentType = genericArgumentType.copyBytes(
          5,
          genericArgumentType.byteLength
        );
      }
      try bindGenericType(
        module,
        modules,
        moduleIndex,
        tree,
        nodeIndex,
        functionName,
        signature.parameterTypes[argumentIndex],
        genericArgumentType,
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
    substitutions,
    bindings
  );
  let parameterIndex: usize = 0;
  while (parameterIndex < argumentTypes.length) {
    const expected = substituteGenericType(
      signature.parameterTypes[parameterIndex],
      substitutions
    );
    let requiredExpected = expected.copyBytes(0, expected.byteLength);
    if (signature.parameterModes[parameterIndex] == "in" && !signature.asynchronous
      && tree.nodes[argumentNodes[parameterIndex]].kind == ExpressionKind.closureExpression) {
      requiredExpected = nativeBorrowedCallbackType(
        modules, moduleIndex, requiredExpected
      );
    }
    if (
      signature.parameterModes[parameterIndex] == "in"
      && stringStartsWith(argumentTypes[parameterIndex], "view ")
    ) {
      const viewTarget = argumentTypes[parameterIndex].copyBytes(
        5,
        argumentTypes[parameterIndex].byteLength
      );
      if (equivalentTypes(modules, moduleIndex, expected, viewTarget)) {
        requiredExpected = argumentTypes[parameterIndex].copyBytes(
          0,
          argumentTypes[parameterIndex].byteLength
        );
      }
    }
    if (
      callKind == "foreign"
      && requiredExpected == "cstring"
      && argumentTypes[parameterIndex] == "String"
    ) {
      parameterIndex = parameterIndex + 1;
      continue;
    }
    if (
      requiredExpected == "Slice<u8>"
      && argumentTypes[parameterIndex] == "embed.StaticBytes"
    ) {
      parameterIndex = parameterIndex + 1;
      continue;
    }
    try requireExpressionType(
      module,
      modules,
      moduleIndex,
      tree,
      argumentNodes[parameterIndex],
      requiredExpected,
      argumentTypes[parameterIndex]
    );
    parameterIndex = parameterIndex + 1;
  }
  for (const invalidatedParameter of signature.invalidatesParameters) {
    if (invalidatedParameter >= argumentNodes.length) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `native invalidation through ${functionName} has no matching owner argument`,
        tree.nodes[callIndex].line,
        tree.nodes[callIndex].column
      );
    }
    const owner = expressionStorageRootName(
      tree,
      argumentNodes[invalidatedParameter]
    );
    if (owner.byteLength == 0) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `native invalidation through ${functionName} requires a named owner binding`,
        tree.nodes[argumentNodes[invalidatedParameter]].line,
        tree.nodes[argumentNodes[invalidatedParameter]].column
      );
    }
    const liveView = liveViewBindingForOwner(bindings, owner);
    if (liveView.byteLength > 0) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `cannot call "${functionName}" because it can invalidate views derived from "${owner}" while view "${liveView}" is live`,
        tree.nodes[argumentNodes[invalidatedParameter]].line,
        tree.nodes[argumentNodes[invalidatedParameter]].column
      );
    }
  }
  for (const lifetime of signature.invalidatesLifetimes) {
    const liveView = liveViewBindingForOwner(bindings, lifetime);
    if (liveView.byteLength > 0) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `cannot call "${functionName}" because it invalidates native lifetime "${lifetime}" while view "${liveView}" is live`,
        tree.nodes[callIndex].line,
        tree.nodes[callIndex].column
      );
    }
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
  let resultViewParameters = Array<usize>();
  match (in signature.viewParameter) {
    some(viewParameter) => resultViewParameters.push(viewParameter);
    none => {}
  }
  for (const viewParameter of signature.viewParameters) {
    let present = false;
    for (const existing of resultViewParameters) {
      if (existing == viewParameter) present = true;
    }
    if (!present) resultViewParameters.push(viewParameter);
  }
  let resultViewOwner = "";
  for (const viewParameter of resultViewParameters) {
    if (viewParameter >= argumentNodes.length) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `borrowed result from ${functionName} has no matching owner argument`,
        tree.nodes[callIndex].line,
        tree.nodes[callIndex].column
      );
    }
    const owner = expressionStorageRootName(
      tree,
      argumentNodes[viewParameter]
    );
    if (owner.byteLength == 0) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `owner-tied borrowed result from ${functionName} requires a named owner binding`,
        tree.nodes[argumentNodes[viewParameter]].line,
        tree.nodes[argumentNodes[viewParameter]].column
      );
    }
    resultViewOwner = appendIndependentViewOwner(
      resultViewOwner,
      owner
    );
  }
  if (resultViewOwner.byteLength > 0) {
    setExpressionViewOrigin(
      inout bindings,
      tree.nodes[callIndex].offset,
      resultViewOwner
    );
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
  if (callKind != "value") {
    const callableTypeParameterCount = declaredCallableTypeParameterCount(
      modules,
      targetModuleIndex,
      targetSymbolIndex,
      callKind,
      functionName,
      signature.typeParameters.length
    );
    recordCallResolution(
      tree,
      callIndex,
      targetModuleIndex,
      targetSymbolIndex,
      callKind,
      functionName,
      signature,
      callableTypeParameterCount,
      substitutions,
      receiverMode,
      returnType,
      errorType,
      inout evidence
    );
  }
  if (signature.asynchronous) {
    match (genericTypeShape(returnType)) {
      some(generic) => {
        if (generic.base == "AsyncGenerator") return returnType;
      }
      none => {}
    }
    return pendingAsyncCallType(returnType, errorType);
  }
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
      let bodyKind = "expression";
      let returnType = "";
      if (tree.nodes[nodeIndex].labels.length > 0) {
        returnType = tree.nodes[nodeIndex].labels[0].copyBytes(
          0,
          tree.nodes[nodeIndex].labels[0].byteLength
        );
      }
      if (tree.nodes[nodeIndex].labels.length > 2) {
        bodyKind = tree.nodes[nodeIndex].labels[2].copyBytes(
          0,
          tree.nodes[nodeIndex].labels[2].byteLength
        );
      }
      if (bodyKind == "block" && returnType.byteLength == 0) {
        awaitsForeignContext = true;
      }
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

function isIntegerConstructionSource(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  if (isIntegerTypeName(typeName) || isFloatTypeName(typeName)) return true;
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      match (
        in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature
      ) {
        some(signature) => {
          return signature.foreignNativeName.byteLength > 0
            && isIntegerTypeName(signature.foreignUnderlyingType);
        }
        none => {}
      }
    }
    none => {}
  }
  return false;
}

function identifierCallableTypeName(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  match (callableSymbolLocation(modules, moduleIndex, tree, index)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[
        location.symbolIndex
      ].functionSignature) {
        some(signature) => {
          let callableSignature = rebaseModuleFunctionSignature(
            modules,
            location.moduleIndex,
            moduleIndex,
            signature
          );
          if (callableSignature.executorAffinity == "thread.main") {
            callableSignature.threadContract = "thread.main";
            callableSignature.executorAffinity = "";
          }
          return Option.some(nativeFunctionTypeName(callableSignature));
        }
        none => {}
      }
    }
    none => {}
  }
  return Option<String>.none;
}

function effectiveCollectionMethodSignature(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in ownerType: String,
  in methodName: String
): Option<ModuleFunctionSignature> {
  const signature = match (collectionMethodSignature(ownerType, methodName)) {
    some(signature) => signature;
    none => return Option<ModuleFunctionSignature>.none;
  };
  let effective = move signature;
  let collectionOwnerType = ownerType.copyBytes(0, ownerType.byteLength);
  if (
    stringStartsWith(collectionOwnerType, "readonly ")
    && collectionOwnerType.byteLength > 9
  ) collectionOwnerType = collectionOwnerType.copyBytes(
    9,
    collectionOwnerType.byteLength
  );
  collectionOwnerType = sourceCollectionTypeName(in collectionOwnerType);
  match (genericTypeShape(collectionOwnerType)) {
    some(mapType) => {
      if (
        mapType.base == "Map"
        && mapType.arguments.length == 2
        && methodName == "get"
      ) {
        const transparentValue = transparentTypeName(
          modules,
          moduleIndex,
          mapType.arguments[1]
        );
        match (nativeFunctionSignature(transparentValue)) {
          some(_) => effective.returnType = `Option<${mapType.arguments[1]}>`;
          none => match (
            inferredTypeSymbolLocation(modules, moduleIndex, transparentValue)
          ) {
            some(location) => {
              if (
                modules[location.moduleIndex].symbols[
                  location.symbolIndex
                ].kind == ModuleSymbolKind.classSymbol
              ) effective.returnType = `Option<${mapType.arguments[1]}>`;
            }
            none => {}
          }
        }
      }
    }
    none => {}
  }
  return Option.some(move effective);
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
  const node = view tree.nodes[index];
  const kind = node.kind;
  const value = view node.value;
  const valueLength = value.byteLength;
  const children = view node.children;
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
      recordExpressionResolution(
        modules,
        moduleIndex,
        tree,
        child,
        embedded,
        inout evidence
      );
    }
    return "String";
  }
  if (kind == ExpressionKind.booleanExpression) return "boolean";
  if (kind == ExpressionKind.nullExpression) return "null";
  if (kind == ExpressionKind.weakExpression && children.length == 1) {
    const target = try inferExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[0],
      inout bindings,
      inout evidence
    );
    try requireSettledExpressionType(module, tree, children[0], target);
    const location = match (typeSymbolLocation(modules, moduleIndex, target)) {
      some(location) => location;
      none => throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `weak expects a class value, found ${target}`,
        tree.nodes[children[0]].line,
        tree.nodes[children[0]].column
      );
    };
    if (
      modules[location.moduleIndex].symbols[location.symbolIndex].kind
      != ModuleSymbolKind.classSymbol
    ) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `weak expects a class value, found ${target}`,
        tree.nodes[children[0]].line,
        tree.nodes[children[0]].column
      );
    }
    const weakAffinity = typeHasMainExecutorLifecycle(
      modules,
      moduleIndex,
      target
    ) ? "thread.main" : "";
    try requireMainExecutorContext(
      module,
      tree,
      index,
      bindings,
      weakAffinity,
      `weak reference construction for "${target}"`
    );
    return `Weak<${target}>`;
  }
  if (
    kind == ExpressionKind.identifierExpression
    || kind == ExpressionKind.argumentBindingExpression
  ) {
    const lookup = identifierLookupName(value);
    const bindingType = valueBindingType(bindings, lookup);
    if (bindingType.byteLength > 0) {
      try requireInitializedBinding(module, tree, index, bindings, lookup);
      return bindingType;
    }
    match (foreignValueSymbolLocation(modules, moduleIndex, tree, index)) {
      some(location) => {
        const targetName = valueSymbolTargetName(modules, location);
        recordForeignValueResolution(
          modules,
          moduleIndex,
          tree,
          index,
          modules[location.moduleIndex].symbols[
            location.symbolIndex
          ].valueType,
          targetName,
          inout evidence
        );
        return modules[location.moduleIndex].symbols[
          location.symbolIndex
        ].valueType.copyBytes(
          0,
          modules[location.moduleIndex].symbols[
            location.symbolIndex
          ].valueType.byteLength
        );
      }
      none => {}
    }
    match (identifierCallableTypeName(modules, moduleIndex, tree, index)) {
      some(callableType) => {
        match (nativeFunctionSignature(callableType)) {
          some(signature) => {
            const requiredExecutor = signature.threadContract
              == "thread.main"
              ? "thread.main"
              : "";
            try requireMainExecutorContext(
              module,
              tree,
              index,
              bindings,
              requiredExecutor,
              `function value "${lookup}"`
            );
          }
          none => {}
        }
        return move callableType;
      }
      none => {}
    }
    try requireInitializedBinding(module, tree, index, bindings, lookup);
    return "";
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
          node.line,
          node.column
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
            node.line,
            node.column
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
          node.line,
          node.column
        );
      }
    }
  }
  if (kind == ExpressionKind.executorPlacementExpression) {
    const asyncContext = valueBindingType(
      bindings,
      "__z_native_async_context"
    );
    if (asyncContext.byteLength == 0) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "executor placement requires an enclosing async function",
        node.line,
        node.column
      );
    }
    let declaredReturn = "";
    let declaredError = "";
    let bodyKind = "";
    if (node.labels.length > 0) {
      const label = node.labels[0].copyBytes(
        0,
        node.labels[0].byteLength
      );
      if (label.byteLength > 0) {
        declaredReturn = label.copyBytes(0, label.byteLength);
      }
    }
    if (declaredReturn.byteLength == 0) {
      const contextualReturn = contextualExpectedType(
        bindings,
        tree,
        index
      );
      if (contextualReturn.byteLength > 0) {
        declaredReturn = contextualReturn.copyBytes(
          0,
          contextualReturn.byteLength
        );
      } else {
        declaredReturn = "void";
      }
    }
    if (node.labels.length > 1) {
      declaredError = node.labels[1].copyBytes(
        0,
        node.labels[1].byteLength
      );
    }
    if (node.labels.length > 2) {
      bodyKind = node.labels[2].copyBytes(
        0,
        node.labels[2].byteLength
      );
    }
    if (bodyKind == "call" && children.length > 2) {
      const callIndex = children[children.length - 1];
      let placedBindings = copyValueBindings(bindings);
      addValueBinding(
        inout placedBindings,
        "__z_native_executor_context",
        "thread.main"
      );
      const outcome = try inferExpressionNodeType(
        module,
        modules,
        moduleIndex,
        arena,
        tree,
        callIndex,
        inout placedBindings,
        inout evidence
      );
      copyBindingFlowStates(inout bindings, placedBindings);
      if (outcome.byteLength == 0) return "";
      let successType = outcome.copyBytes(0, outcome.byteLength);
      let errorType = "";
      match (pendingAsyncCallShape(outcome)) {
        some(call) => {
          successType = call.successType.copyBytes(
            0,
            call.successType.byteLength
          );
          errorType = call.errorType.copyBytes(0, call.errorType.byteLength);
        }
        none => {
          match (pendingThrowingCallShape(outcome)) {
            some(call) => {
              successType = call.successType.copyBytes(
                0,
                call.successType.byteLength
              );
              errorType = call.errorType.copyBytes(
                0,
                call.errorType.byteLength
              );
            }
            none => {}
          }
        }
      }
      if (node.value == "spawn") {
        return taskEffectType(successType, errorType);
      }
      if (errorType.byteLength > 0) {
        return pendingThrowingCallType(successType, errorType);
      }
      return successType;
    }

    let blockBindings = copyValueBindings(bindings);
    let movedCaptures = Array<String>();
    const capturesReady = try prepareExecutorCaptureBindings(
      module,
      modules,
      moduleIndex,
      tree,
      children,
      bindings,
      inout blockBindings,
      inout movedCaptures
    );
    if (!capturesReady) return "";
    addValueBinding(
      inout blockBindings,
      "__z_native_executor_context",
      "thread.main"
    );
    const selectBinding = loopSelectTypeBindingName();
    addValueBinding(inout blockBindings, selectBinding, declaredReturn);
    if (declaredError.byteLength > 0) {
      addValueBinding(
        inout blockBindings,
        "__z_native_error_type",
        declaredError
      );
    }
    const statements = copyIndices(node.statements);
    const expectedReturn = valueBindingType(
      bindings,
      "__z_native_return_type"
    );
    try inferStatementSequence(
      module,
      modules,
      moduleIndex,
      arena,
      statements,
      inout blockBindings,
      inout evidence,
      expectedReturn
    );
    if (node.value != "spawn") {
      copyBindingFlowStates(inout bindings, blockBindings);
    }
    applyExecutorCaptureMoves(movedCaptures, inout bindings);
    if (node.value == "spawn") {
      return taskEffectType(declaredReturn, declaredError);
    }
    if (declaredError.byteLength > 0) {
      return pendingThrowingCallType(declaredReturn, declaredError);
    }
    return declaredReturn;
  }
  if (kind == ExpressionKind.awaitExpression && children.length == 1) {
    const asyncContext = valueBindingType(
      bindings,
      "__z_native_async_context"
    );
    if (asyncContext.byteLength == 0) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "await requires an enclosing async function",
        node.line,
        node.column
      );
    }
    try requireNoLexicalBorrowAtSuspension(
      module,
      tree,
      index,
      bindings
    );
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
    match (genericTypeShape(outcome)) {
      some(task) => {
        if (
          task.base == "Task"
          && (task.arguments.length == 1 || task.arguments.length == 2)
        ) {
          try consumeOwnedExpressionNode(
            module,
            modules,
            moduleIndex,
            tree,
            children[0],
            outcome,
            false,
            inout bindings
          );
          if (task.arguments.length == 2) {
            return pendingThrowingCallType(
              task.arguments[0],
              task.arguments[1]
            );
          }
          return task.arguments[0].copyBytes(
            0,
            task.arguments[0].byteLength
          );
        }
      }
      none => {}
    }
    match (pendingAsyncCallShape(outcome)) {
      some(call) => {
        if (call.errorType.byteLength > 0) {
          return pendingThrowingCallType(call.successType, call.errorType);
        }
        return call.successType.copyBytes(0, call.successType.byteLength);
      }
      none => {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "await requires an async call or Task value",
          node.line,
          node.column
        );
      }
    }
  }
  if (kind == ExpressionKind.spawnExpression && children.length == 1) {
    const asyncContext = valueBindingType(
      bindings,
      "__z_native_async_context"
    );
    if (asyncContext.byteLength == 0) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "task requires an enclosing async function",
        node.line,
        node.column
      );
    }
    if (tree.nodes[children[0]].kind != ExpressionKind.callExpression) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "task requires a direct async function or method call",
        node.line,
        node.column
      );
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
    match (pendingAsyncCallShape(outcome)) {
      some(call) => {
        return taskEffectType(call.successType, call.errorType);
      }
      none => {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "task requires a direct async function or method call",
          node.line,
          node.column
        );
      }
    }
  }
  if (kind == ExpressionKind.newExpression) {
    if (
      value == "TaskScope"
      || importedStandardType(module, value, "std/async", "TaskScope")
    ) {
      if (children.length != 0) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "TaskScope construction expects no arguments",
          node.line,
          node.column
        );
      }
      return value.copyBytes(0, value.byteLength);
    }
    const constructionType = transparentTypeName(
      modules,
      moduleIndex,
      value
    );
    match (typeSymbolLocation(modules, moduleIndex, constructionType)) {
      some(surfaceLocation) => {
        const location = transparentTypeLocation(modules, surfaceLocation);
        if (
          modules[location.moduleIndex].symbols[location.symbolIndex].kind
          != ModuleSymbolKind.classSymbol
        ) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `new requires a class type; construct ${value} as ${value}({ ... })`,
            node.line,
            node.column
          );
        }
        const constructionAffinity = typeHasMainExecutorLifecycle(
          modules,
          moduleIndex,
          constructionType
        ) ? "thread.main" : "";
        try requireMainExecutorContext(
          module,
          tree,
          index,
          bindings,
          constructionAffinity,
          `construction of class "${value}"`
        );
        match (
          in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature
        ) {
          some(typeSignature) => {
            match (in typeSignature.constructorSignature) {
              some(signature) => {
                if (typeSignature.constructorVisibility == "private") {
                  const activeOwner = valueBindingType(
                    bindings,
                    "__z_native_owner_type"
                  );
                  if (
                    activeOwner.byteLength == 0
                    || !equivalentTypes(
                      modules,
                      moduleIndex,
                      activeOwner,
                      value
                    )
                  ) {
                    throw resolutionError(
                      ModuleResolveErrorKind.unknownMember,
                      module.path,
                      `constructor for class "${value}" is private`,
                      node.line,
                      node.column
                    );
                  }
                }
                if (
                  typeSignature.constructorVisibility == "internal"
                  && (
                    modules[moduleIndex].packageIdentity.byteLength == 0
                    || modules[moduleIndex].packageIdentity
                      != modules[location.moduleIndex].packageIdentity
                  )
                ) {
                  const className = modules[location.moduleIndex].symbols[
                    location.symbolIndex
                  ].name.copyBytes(
                    0,
                    modules[location.moduleIndex].symbols[
                      location.symbolIndex
                    ].name.byteLength
                  );
                  throw resolutionError(
                    ModuleResolveErrorKind.unknownMember,
                    module.path,
                    `constructor for class "${className}" is internal to its package`,
                    node.line,
                    node.column
                  );
                }
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
                    node.line,
                    node.column
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
            let payloadOwner = "";
            if (stringStartsWith(expected, "view ")) {
              payloadOwner = storedViewOwnerForExpression(
                bindings,
                tree,
                children[1]
              );
              if (
                payloadOwner.byteLength == 0
                || !expressionHasProvenBorrowedStorage(
                  bindings,
                  tree,
                  children[1]
                )
              ) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "a view can enter Option only from proven borrowed storage",
                  tree.nodes[children[1]].line,
                  tree.nodes[children[1]].column
                );
              }
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
            if (payloadOwner.byteLength > 0) {
              setExpressionViewOrigin(
                inout bindings,
                tree.nodes[index].offset,
                payloadOwner
              );
            }
            let requiredPayload = expected.copyBytes(0, expected.byteLength);
            if (
              payloadOwner.byteLength > 0
              && !viewOwnerIsOwnerless(payloadOwner)
              && stringStartsWith(expected, "view ")
            ) {
              requiredPayload = expected.copyBytes(5, expected.byteLength);
            }
            try requireExpressionType(
              module,
              modules,
              moduleIndex,
              tree,
              children[1],
              requiredPayload,
              actual
            );
            if (typeIsClassReference(
              module,
              modules,
              moduleIndex,
              requiredPayload
            )) {
              try invalidateLocallyContainedClassNode(
                module,
                tree,
                children[1],
                inout bindings
              );
            }
            let storedViewVisiting = Array<String>();
            const storedViewPayload = typeContainsStoredView(
              modules,
              moduleIndex,
              expected,
              storedViewVisiting
            );
            if (storedViewPayload) {
              const storedPayloadOwner = storedViewOwnerForExpression(
                bindings,
                tree,
                children[1]
              );
              if (storedPayloadOwner.byteLength == 0) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `view-bearing variant "${value}.${variantName}" requires proven stored provenance`,
                  tree.nodes[children[1]].line,
                  tree.nodes[children[1]].column
                );
              }
              setExpressionViewOrigin(
                inout bindings,
                tree.nodes[index].offset,
                storedPayloadOwner
              );
            } else {
              let enumViewVisiting = Array<String>();
              if (typeContainsStoredView(
                modules,
                moduleIndex,
                value,
                enumViewVisiting
              )) {
                const ownerlessOwner = ownerlessViewOwner();
                setExpressionViewOrigin(
                  inout bindings,
                  tree.nodes[index].offset,
                  ownerlessOwner
                );
              }
            }
            if (!stringStartsWith(expected, "view ")) try consumeOwnedExpressionNode(
              module,
              modules,
              moduleIndex,
              tree,
              children[1],
              expected,
              storedViewPayload,
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
    match (foreignValueSymbolLocation(modules, moduleIndex, tree, index)) {
      some(location) => {
        const targetName = valueSymbolTargetName(modules, location);
        recordForeignValueResolution(
          modules,
          moduleIndex,
          tree,
          index,
          modules[location.moduleIndex].symbols[
            location.symbolIndex
          ].valueType,
          targetName,
          inout evidence
        );
        return modules[location.moduleIndex].symbols[
          location.symbolIndex
        ].valueType.copyBytes(
          0,
          modules[location.moduleIndex].symbols[
            location.symbolIndex
          ].valueType.byteLength
        );
      }
      none => {}
    }
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
    recordExpressionResolution(
      modules,
      moduleIndex,
      tree,
      children[0],
      receiverType,
      inout evidence
    );
    const memberName = identifierLookupName(value);
    if (receiverType.byteLength == 0) {
      const candidateType = typeExpressionName(tree, children[0]);
      match (objectiveCClassPropertyShape(
        modules,
        moduleIndex,
        candidateType,
        memberName
      )) {
        some(property) => {
          let requiredAffinity = property.executorAffinity.copyBytes(
            0,
            property.executorAffinity.byteLength
          );
          if (requiredAffinity.byteLength == 0) {
            requiredAffinity = aggregateExecutorAffinity(
              modules,
              property.ownerModuleIndex,
              property.ownerSymbolIndex
            );
          }
          try requireMainExecutorContext(
            module,
            tree,
            index,
            bindings,
            requiredAffinity,
            `Objective-C class property "${candidateType}.${memberName}"`
          );
          recordExpressionResolution(
            modules,
            moduleIndex,
            tree,
            index,
            property.typeName,
            inout evidence
          );
          return property.typeName.copyBytes(
            0,
            property.typeName.byteLength
          );
        }
        none => {}
      }
      match (matchShape(modules, moduleIndex, candidateType)) {
        some(shape) => {
          const variantIndex = matchVariantIndex(shape, memberName);
          if (
            variantIndex < shape.variants.length
            && shape.variants[variantIndex].payloadType.byteLength == 0
          ) {
            let enumViewVisiting = Array<String>();
            if (typeContainsStoredView(
              modules,
              moduleIndex,
              candidateType,
              enumViewVisiting
            )) {
              const ownerlessOwner = ownerlessViewOwner();
              setExpressionViewOrigin(
                inout bindings,
                node.offset,
                ownerlessOwner
              );
            }
            return candidateType;
          }
        }
        none => {}
      }
      return "";
    }
    let receiverValueType = receiverType.copyBytes(0, receiverType.byteLength);
    if (node.optionalAccess) {
      match (optionalReceiverPayloadType(receiverType)) {
        some(payload) => receiverValueType = payload.copyBytes(
          0,
          payload.byteLength
        );
        none => throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `optional access requires Option<T>, found ${receiverType}`,
          tree.nodes[children[0]].line,
          tree.nodes[children[0]].column
        );
      }
    }
    const receiverWasView = stringStartsWith(receiverValueType, "view ");
    if (receiverWasView) {
      receiverValueType = receiverValueType.copyBytes(5, receiverValueType.byteLength);
    }
    if (memberName == "length") {
      const lengthOwnerType = transparentTypeName(modules, moduleIndex, receiverValueType);
      if (collectionHasLength(lengthOwnerType)) {
        recordExpressionResolution(
          modules,
          moduleIndex,
          tree,
          index,
          "usize",
          inout evidence
        );
        return "usize";
      }
    }
    if (
      receiverValueType == "embed.StaticBytes"
      && memberName == "length"
    ) {
      recordExpressionResolution(
        modules,
        moduleIndex,
        tree,
        index,
        "usize",
        inout evidence
      );
      return "usize";
    }
    if (receiverValueType == "String") {
      if (memberName == "byteLength") {
        recordExpressionResolution(
          modules,
          moduleIndex,
          tree,
          index,
          "usize",
          inout evidence
        );
        return "usize";
      }
      if (memberName == "isEmpty") {
        recordExpressionResolution(
          modules,
          moduleIndex,
          tree,
          index,
          "boolean",
          inout evidence
        );
        return "boolean";
      }
    }
    match (aggregateFieldShape(modules, moduleIndex, receiverValueType, memberName)) {
      some(field) => {
        const nativeSubclassContext = valueBindingType(bindings, "__z_native_objc_subclass_base");
        if (nativeSubclassContext.byteLength > 0) {
          try requireNativeReferenceAvailability(module, modules, moduleIndex, receiverValueType, node.line, node.column);
          try requireNativeAvailability(module, field.objectiveCAvailability, field.name, node.line, node.column);
        }
        match (typeSymbolLocation(modules, moduleIndex, receiverValueType)) {
          some(location) => {
            match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
              some(signature) => {
                if (signature.foreignKind == "viewRecord" && !receiverWasView) {
                  throw resolutionError(
                    ModuleResolveErrorKind.typeMismatch,
                    module.path,
                    `native record "${receiverValueType}" can only be inspected through a view`,
                    node.line,
                    node.column
                  );
                }
              }
              none => {}
            }
          }
          none => {}
        }
        if (field.foreignUnion) {
          if (
            valueBindingType(bindings, "__z_native_unsafe_union_access")
            != "true"
          ) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              `native union member "${memberName}" requires an unsafe boundary`,
              node.line,
              node.column
            );
          }
        }
        try requireVisibleField(
          module,
          modules,
          moduleIndex,
          tree,
          index,
          bindings,
          field
        );
        let requiredAffinity = field.executorAffinity.copyBytes(
          0,
          field.executorAffinity.byteLength
        );
        if (requiredAffinity.byteLength == 0) {
          requiredAffinity = aggregateExecutorAffinity(
            modules,
            field.ownerModuleIndex,
            field.ownerSymbolIndex
          );
        }
        try requireMainExecutorContext(
          module,
          tree,
          index,
          bindings,
          requiredAffinity,
          `field "${field.ownerName}.${field.name}"`
        );
        let fieldType = field.typeName.copyBytes(
          0,
          field.typeName.byteLength
        );
        if (
          node.optionalAccess
          && field.objectiveCGetter.byteLength > 0
        ) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `optional Objective-C property access "${field.name}" remains deferred in the native compiler`,
            node.line,
            node.column
          );
        }
        if (node.optionalAccess) {
          let projectedType = fieldType.copyBytes(0, fieldType.byteLength);
          let visiting = Array<String>();
          if (typeHasCleanup(
            modules,
            moduleIndex,
            projectedType,
            visiting
          )) projectedType = `view ${projectedType}`;
          fieldType = optionalValueType(projectedType);
        }
        if (field.viewLifetime.byteLength > 0) {
          setExpressionViewOrigin(
            inout bindings,
            node.offset,
            field.viewLifetime
          );
        }
        let fieldViewVisiting = Array<String>();
        if (
          field.viewLifetime.byteLength == 0
          && typeContainsStoredView(
            modules,
            moduleIndex,
            field.typeName,
            fieldViewVisiting
          )
        ) {
          const receiverOwner = storedViewOwnerForExpression(
            bindings,
            tree,
            children[0]
          );
          if (receiverOwner.byteLength == 0) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              `view-bearing field "${memberName}" requires a named composite owner`,
              tree.nodes[children[0]].line,
              tree.nodes[children[0]].column
            );
          }
          setExpressionViewOrigin(
            inout bindings,
            node.offset,
            receiverOwner
          );
        }
        recordExpressionResolution(
          modules,
          moduleIndex,
          tree,
          index,
          fieldType,
          inout evidence
        );
        return fieldType;
      }
      none => {}
    }
    if (hasKnownAggregate(modules, moduleIndex, receiverValueType)) {
      throw resolutionError(
        ModuleResolveErrorKind.unknownMember,
        module.path,
        `type ${receiverValueType} has no field ${memberName}`,
        node.line,
        node.column
      );
    }
    return "";
  }
  if (kind == ExpressionKind.unaryExpression && children.length == 1) {
    const operand = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings, inout evidence);
    try requireSettledExpressionType(module, tree, children[0], operand);
    recordExpressionResolution(
      modules,
      moduleIndex,
      tree,
      children[0],
      operand,
      inout evidence
    );
    const result = try unaryOperatorType(
      module,
      modules,
      moduleIndex,
      tree,
      index,
      value,
      operand,
      isActiveTypeParameter(bindings, operand)
    );
    if (value == "view" && result.byteLength > 0) {
      const operandIndex = children[0];
      const localRoot = expressionStorageRootName(tree, operandIndex);
      if (localRoot.byteLength == 0) throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "`view` requires a named local owner",
        tree.nodes[operandIndex].line,
        tree.nodes[operandIndex].column
      );
      const inheritedOwner = valueBindingViewOwner(bindings, localRoot);
      const owner = inheritedOwner.byteLength > 0
        ? inheritedOwner.copyBytes(0, inheritedOwner.byteLength)
        : localRoot.copyBytes(0, localRoot.byteLength);
      if (typeIsClassReference(module, modules, moduleIndex, operand)) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "`view` projects value storage rather than ARC class identity",
          tree.nodes[operandIndex].line,
          tree.nodes[operandIndex].column
        );
      }
      const projectedPath = expressionDirectFieldPath(tree, operandIndex);
      if (inheritedOwner.byteLength == 0 && projectedPath != localRoot) {
        try requireProjectedCapabilityValuePath(
          module,
          modules,
          moduleIndex,
          tree,
          operandIndex,
          bindings,
          false
        );
      }
      setExpressionViewOrigin(
        inout bindings,
        tree.nodes[index].offset,
        owner
      );
    }
    if (value == "move" && result.byteLength > 0) {
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
    }
    return result;
  }
  if (kind == ExpressionKind.binaryExpression && children.length == 2) {
    let left = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings, inout evidence);
    try requireSettledExpressionType(module, tree, children[0], left);
    if (value == "instanceof") {
      if (
        left.byteLength > 0
        && !isNativeObjectiveCObjectType(modules, moduleIndex, left)
      ) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `instanceof expects an Objective-C object on the left, found ${left}`,
          tree.nodes[children[0]].line,
          tree.nodes[children[0]].column
        );
      }
      const targetName = typeExpressionName(tree, children[1]);
      let targetIsObjectiveCClass = false;
      let targetWasResolved = false;
      if (targetName.byteLength > 0) {
        match (typeSymbolLocation(modules, moduleIndex, targetName)) {
          some(location) => {
            targetWasResolved = true;
            const symbol = view modules[location.moduleIndex]
              .symbols[location.symbolIndex];
            if (symbol.kind == ModuleSymbolKind.classSymbol) {
              match (in symbol.typeSignature) {
                some(signature) => {
                  targetIsObjectiveCClass =
                    signature.foreignKind == "objcInterface";
                }
                none => {}
              }
            }
          }
          none => {}
        }
      }
      if (
        targetName.byteLength == 0
        || (targetWasResolved && !targetIsObjectiveCClass)
      ) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "instanceof expects an imported Objective-C class on the right",
          tree.nodes[children[1]].line,
          tree.nodes[children[1]].column
        );
      }
      recordExpressionResolution(
        modules,
        moduleIndex,
        tree,
        children[0],
        left,
        inout evidence
      );
      recordExpressionResolution(
        modules,
        moduleIndex,
        tree,
        index,
        "boolean",
        inout evidence
      );
      return "boolean";
    }
    if (value == "&&" || value == "||") {
      const beforeRight = copyValueBindings(bindings);
      let rightBindings = copyValueBindings(bindings);
      applyNullConditionNarrowing(
        tree,
        children[0],
        value == "&&",
        inout rightBindings
      );
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
      const result = try binaryOperatorType(
        module,
        modules,
        moduleIndex,
        tree,
        index,
        value,
        left,
        right
      );
      recordExpressionResolution(
        modules,
        moduleIndex,
        tree,
        children[0],
        left,
        inout evidence
      );
      recordExpressionResolution(
        modules,
        moduleIndex,
        tree,
        children[1],
        right,
        inout evidence
      );
      recordExpressionResolution(
        modules,
        moduleIndex,
        tree,
        index,
        result,
        inout evidence
      );
      return result;
    }
    let right = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[1], inout bindings, inout evidence);
    try requireSettledExpressionType(module, tree, children[1], right);
    if (left.byteLength == 0 || right.byteLength == 0) return "";
    if (
      isContextualNumericLiteral(tree, children[1])
      && (
        isNumericTypeName(left)
        || isActiveTypeParameter(bindings, left)
      )
    ) right = left.copyBytes(0, left.byteLength);
    else if (
      isContextualNumericLiteral(tree, children[0])
      && (
        isNumericTypeName(right)
        || isActiveTypeParameter(bindings, right)
      )
    ) left = right.copyBytes(0, right.byteLength);
    if (
      left == right
      && isActiveTypeParameter(bindings, left)
      && (
        value == "<"
        || value == "<="
        || value == ">"
        || value == ">="
      )
    ) return "boolean";
    const result = try binaryOperatorType(
      module,
      modules,
      moduleIndex,
      tree,
      index,
      value,
      left,
      right
    );
    recordExpressionResolution(
      modules,
      moduleIndex,
      tree,
      children[0],
      left,
      inout evidence
    );
    recordExpressionResolution(
      modules,
      moduleIndex,
      tree,
      children[1],
      right,
      inout evidence
    );
    recordExpressionResolution(
      modules,
      moduleIndex,
      tree,
      index,
      result,
      inout evidence
    );
    return result;
  }
  if (kind == ExpressionKind.valueBlockExpression) {
    const statements = copyIndices(node.statements);
    if (statements.length == 0) return "";
    let blockBindings = copyValueBindings(bindings);
    const blockBindingIndex = blockBindings.length;
    const expectedReturn = valueBindingType(bindings, "__z_native_return_type");
    let statementIndex: usize = 0;
    while (statementIndex + 1 < statements.length) {
      releaseUnusedViewBindings(
        arena,
        statements,
        statementIndex,
        blockBindingIndex,
        inout blockBindings
      );
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
    releaseUnusedViewBindings(
      arena,
      statements,
      statements.length - 1,
      blockBindingIndex,
      inout blockBindings
    );
    const expectedType = contextualExpectedType(bindings, tree, index);
    const result = try inferMatchArmStatementType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      statements[statements.length - 1],
      expectedType,
      blockBindingIndex,
      inout blockBindings,
      inout evidence
    );
    const resultOwner = storedViewOwnerForStatement(
      arena,
      statements[statements.length - 1],
      blockBindings
    );
    copyBindingFlowStates(inout bindings, blockBindings);
    if (resultOwner.byteLength > 0) setExpressionViewOrigin(
      inout bindings,
      node.offset,
      resultOwner
    );
    return result;
  }
  if (kind == ExpressionKind.unsafeExpression) {
    const statements = copyIndices(node.statements);
    if (
      statements.length != 1
      || arena.nodes[statements[0]].kind != StatementKind.selectStatement
    ) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "the first native unsafe-expression tier requires exactly one `select value;`",
        node.line,
        node.column
      );
    }
    let unsafeBindings = copyValueBindings(bindings);
    addValueBinding(
      inout unsafeBindings,
      "__z_native_unsafe_union_access",
      "true"
    );
    const unsafeBindingIndex = unsafeBindings.length;
    const expectedType = contextualExpectedType(bindings, tree, index);
    const result = try inferMatchArmStatementType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      statements[0],
      expectedType,
      unsafeBindingIndex,
      inout unsafeBindings,
      inout evidence
    );
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
    markRegionControlFlow(inout thenBindings, "branch");
    markRegionControlFlow(inout elseBindings, "branch");
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
    const thenOwner = storedViewOwnerForExpression(
      thenBindings,
      tree,
      children[1]
    );
    const elseOwner = storedViewOwnerForExpression(
      elseBindings,
      tree,
      children[2]
    );
    try requireSettledExpressionType(module, tree, children[1], thenType);
    try requireSettledExpressionType(module, tree, children[2], elseType);
    if (thenType == "__z_never") {
      copyBindingFlowStates(inout bindings, elseBindings);
      if (elseOwner.byteLength > 0) setExpressionViewOrigin(
        inout bindings,
        node.offset,
        elseOwner
      );
      return elseType;
    }
    if (elseType == "__z_never") {
      copyBindingFlowStates(inout bindings, thenBindings);
      if (thenOwner.byteLength > 0) setExpressionViewOrigin(
        inout bindings,
        node.offset,
        thenOwner
      );
      return thenType;
    }
    mergeBindingFlowStates(inout bindings, thenBindings, elseBindings);
    try requireSettledRegionProvenance(
      module,
      bindings,
      tree.nodes[index].line,
      tree.nodes[index].column
    );
    if (thenType.byteLength == 0 || elseType.byteLength == 0) return "";
    if (equivalentTypes(modules, moduleIndex, thenType, elseType)) {
      let resultViewVisiting = Array<String>();
      if (typeContainsStoredView(
        modules,
        moduleIndex,
        thenType,
        resultViewVisiting
      )) {
        if (thenOwner.byteLength == 0 || elseOwner.byteLength == 0) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "every continuing branch of a view-bearing if expression must produce proven stored provenance",
            node.line,
            node.column
          );
        }
        const mergedOwner = mergeViewOwners(thenOwner, elseOwner);
        if (mergedOwner == "__z_native_mixed_view_owner") {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "a view-bearing if expression cannot join values from different Arena owners",
            node.line,
            node.column
          );
        }
        setExpressionViewOrigin(
          inout bindings,
          node.offset,
          mergedOwner
        );
      }
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
    markRegionControlFlow(inout elseBindings, "loop");
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
    markRegionControlFlow(inout bodyBindings, "loop");
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
    markRegionControlFlow(inout elseBindings, "loop");
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
    markRegionControlFlow(inout bodyBindings, "loop");
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
    markRegionControlFlow(inout thenBindings, "branch");
    markRegionControlFlow(inout elseBindings, "branch");
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
      try requireSettledRegionProvenance(
        module,
        bindings,
        tree.nodes[index].line,
        tree.nodes[index].column
      );
      return "";
    }
    if (equivalentTypes(modules, moduleIndex, thenType, elseType)) {
      // Preserve the selected value's type independently of the condition,
      // which has the same start offset as the whole conditional expression.
      recordExpressionResolution(
        modules, moduleIndex, tree, children[1], thenType, inout evidence
      );
      recordExpressionResolution(
        modules, moduleIndex, tree, children[2], elseType, inout evidence
      );
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
      try requireSettledRegionProvenance(
        module,
        bindings,
        tree.nodes[index].line,
        tree.nodes[index].column
      );
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
    if (typeIsClassReference(module, modules, moduleIndex, elementType)) {
      try invalidateLocallyContainedClassNode(
        module,
        tree,
        children[0],
        inout bindings
      );
    }
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
      if (typeIsClassReference(module, modules, moduleIndex, elementType)) {
        try invalidateLocallyContainedClassNode(
          module,
          tree,
          children[childIndex],
          inout bindings
        );
      }
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
    recordExpressionResolution(
      modules,
      moduleIndex,
      tree,
      children[0],
      owner,
      inout evidence
    );
    if (offset.byteLength > 0 && !isIntegerTypeName(offset)) {
      throw moduleResolutionError(
        ModuleResolveErrorKind.invalidOperator,
        module.path,
        `index requires an integer, found ${offset}`,
        tree.nodes[children[1]].line,
        tree.nodes[children[1]].column
      );
    }
    const elementType = arrayElementType(owner);
    let elementViewVisiting = Array<String>();
    if (typeContainsStoredView(
      modules,
      moduleIndex,
      elementType,
      elementViewVisiting
    )) {
      const ownerOrigin = storedViewOwnerForExpression(
        bindings,
        tree,
        children[0]
      );
      if (ownerOrigin.byteLength > 0) setExpressionViewOrigin(
        inout bindings,
        node.offset,
        ownerOrigin
      );
    }
    return elementType;
  }
  if (kind == ExpressionKind.closureExpression) {
    let returnType = "";
    let errorType = "";
    let bodyKind = "expression";
    if (node.labels.length > 0) {
      returnType = node.labels[0].copyBytes(
        0,
        node.labels[0].byteLength
      );
    }
    if (node.labels.length > 1) {
      errorType = node.labels[1].copyBytes(
        0,
        node.labels[1].byteLength
      );
    }
    if (node.labels.length > 2) {
      bodyKind = node.labels[2].copyBytes(
        0,
        node.labels[2].byteLength
      );
    }
    const contextualType = contextualExpectedType(bindings, tree, index);
    const closureSignature = try resolveClosureSignature(
      module,
      modules,
      moduleIndex,
      tree,
      index,
      contextualType,
      returnType,
      errorType
    );
    returnType = closureSignature.returnType.copyBytes(
      0,
      closureSignature.returnType.byteLength
    );
    const captures = closureCaptureNames(arena, tree, index, bindings);
    if (bodyKind == "block" && returnType.byteLength == 0) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "a block-bodied closure requires an explicit or contextual return type",
        node.line,
        node.column
      );
    }
    let closureBindings = copyValueBindings(bindings);
    const closureRegionControlFlow = regionControlFlowBindingName();
    const inheritedRegionControlFlow = valueBindingType(
      closureBindings,
      closureRegionControlFlow
    );
    if (inheritedRegionControlFlow.byteLength > 0) {
      setValueBindingType(
        inout closureBindings,
        closureRegionControlFlow,
        "false"
      );
    } else {
      addValueBinding(
        inout closureBindings,
        closureRegionControlFlow,
        "false"
      );
    }
    const closureAsynchronous = node.labels.length > 3
      && node.labels[3] == "async";
    const closureAsyncContext = closureAsynchronous ? "true" : "";
    addValueBinding(
      inout closureBindings,
      "__z_native_async_context",
      closureAsyncContext
    );
    const closureExecutorContext = closureSignature.threadContract
      == "thread.any"
      ? ""
      : closureSignature.threadContract == "thread.main"
        ? "thread.main"
        : valueBindingType(
          bindings,
          "__z_native_closure_executor_context"
        );
    if (closureSignature.threadContract == "thread.main") {
      try requireMainExecutorContext(
        module,
        tree,
        index,
        bindings,
        "thread.main",
        "thread.main function value construction"
      );
    }
    addValueBinding(
      inout closureBindings,
      "__z_native_executor_context",
      closureExecutorContext
    );
    for (const capture of captures) {
      const captureModeName = closureCaptureModeBindingName(capture);
      addValueBinding(
        inout closureBindings,
        captureModeName,
        "in"
      );
      const captureType = valueBindingType(bindings, capture);
      const classMutationName = closureCaptureClassMutationBindingName(
        capture
      );
      const inheritedClassMutation = valueBindingType(
        bindings,
        classMutationName
      );
      const mutableClassIdentity = typeIsClassReference(
        module,
        modules,
        moduleIndex,
        captureType
      ) && (
        inheritedClassMutation == "true"
        ||
        !valueBindingIsBorrowed(bindings, capture)
        || valueBindingIsMutable(bindings, capture)
      );
      const classMutationAccess = mutableClassIdentity ? "true" : "false";
      addValueBinding(
        inout closureBindings,
        classMutationName,
        classMutationAccess
      );
    }
    for (const capture of captures) {
      const initialization = valueBindingInitialization(bindings, capture);
      if (initialization != NativeInitializationState.initialized) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `cannot capture uninitialized value "${capture}"`,
          node.line,
          node.column
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
          node.line,
          node.column
        );
      }
      const captureType = valueBindingType(bindings, capture);
      if (closureSignature.threadContract == "thread.any") {
        if (valueBindingIsBorrowed(bindings, capture)) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `borrowed capture "${capture}" cannot enter a thread-any function value`,
            node.line,
            node.column
          );
        }
        if (
          !isActiveTypeParameter(bindings, captureType)
          && !typeIsThreadShareable(modules, moduleIndex, captureType)
        ) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `capture "${capture}" of type "${captureType}" is not shareable across arbitrary threads`,
            node.line,
            node.column
          );
        }
      }
      if (value == "move") try requireOwnedClosureEnvironment(
        module, modules, moduleIndex, captureType, node.line, node.column
      );
      if (typeIsBorrowedForeignResource(
        modules,
        moduleIndex,
        captureType
      )) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `borrowed native resource "${capture}" cannot escape into a closure`,
          node.line,
          node.column
        );
      }
      if (
        value == "move"
        && typeIsClassReference(
          module,
          modules,
          moduleIndex,
          captureType
        )
      ) {
        try invalidateLocallyContainedClassBinding(
          module,
          tree,
          index,
          capture,
          inout bindings
        );
      }
      if (value == "move") {
        if (
          !stringStartsWith(captureType, "Mutex<")
          && typeMovesOnOwnedUse(modules, moduleIndex, captureType)
        ) {
          if (valueBindingIsBorrowed(bindings, capture)) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              `cannot move borrowed capture "${capture}"`,
              node.line,
              node.column
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
    let parameterIndex: usize = 0;
    for (const child of children) {
      if (tree.nodes[child].kind != ExpressionKind.closureParameterExpression) continue;
      const parameterName = tree.nodes[child].value.copyBytes(
        0,
        tree.nodes[child].value.byteLength
      );
      const mode = closureSignature.parameterModes[parameterIndex].copyBytes(
        0,
        closureSignature.parameterModes[parameterIndex].byteLength
      );
      const parameterType = closureSignature.parameterTypes[parameterIndex].copyBytes(
        0,
        closureSignature.parameterTypes[parameterIndex].byteLength
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
    if (closureSignature.errorType.byteLength > 0) {
      addValueBinding(
        inout closureBindings,
        "__z_native_error_type",
        closureSignature.errorType
      );
    }
    if (bodyKind == "block") {
      const statements = copyIndices(node.statements);
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
    for (const capture of captures) {
      const captureModeName = closureCaptureModeBindingName(capture);
      const mode = valueBindingType(
        closureBindings,
        captureModeName
      );
      const evidenceName = closureCaptureEvidenceBindingName(
        node.offset,
        capture
      );
      const existingEvidence = valueBindingType(bindings, evidenceName);
      if (existingEvidence.byteLength > 0) {
        setValueBindingType(inout bindings, evidenceName, mode);
      } else {
        addValueBinding(inout bindings, evidenceName, mode);
      }
    }
    return nativeClosureFunctionType(
      tree,
      index,
      closureSignature.parameterModes,
      closureSignature.parameterTypes,
      returnType,
      closureSignature.errorType,
      closureSignature.threadContract,
      closureSignature.asynchronous,
      captures.length > 0 && value != "move"
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
      if (enumType == "Option" && variantName == "fromNullable") {
        if (children.length != 2) {
          throw matchError(
            module,
            tree,
            calleeIndex,
            "Option.fromNullable requires exactly one nullable value"
          );
        }
        const payloadIndex = children[1];
        const actual = try inferExpressionNodeType(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          payloadIndex,
          inout bindings,
          inout evidence
        );
        const viewOwner = expressionViewOrigin(
          bindings,
          tree.nodes[payloadIndex].offset
        );
        const payloadType = nullableTargetType(actual);
        if (payloadType.byteLength == 0) {
          throw matchError(
            module,
            tree,
            payloadIndex,
            `Option.fromNullable expects T | null, found ${actual}`
          );
        }
        if (
          typeIsBorrowedForeignResource(modules, moduleIndex, actual)
          && viewOwner.byteLength == 0
        ) {
          throw matchError(
            module,
            tree,
            payloadIndex,
            "Option.fromNullable cannot lift a borrowed native resource into owned Option storage"
          );
        }
        try consumeOwnedExpressionNode(
          module,
          modules,
          moduleIndex,
          tree,
          payloadIndex,
          actual,
          false,
          inout bindings
        );
        if (viewOwner.byteLength > 0) {
          setExpressionViewOrigin(
            inout bindings,
            tree.nodes[index].offset,
            viewOwner
          );
        }
        return `Option<${payloadType}>`;
      }
      if (enumType == "Option" && variantName == "some") {
        if (children.length != 2) {
          throw matchError(
            module,
            tree,
            calleeIndex,
            "Option.some requires exactly one value"
          );
        }
        const payloadIndex = children[1];
        let expectedPayload = "";
        let optionType = "";
        const contextualOption = contextualExpectedType(
          bindings,
          tree,
          index
        );
        match (genericTypeShape(contextualOption)) {
          some(generic) => {
            if (generic.base == "Option" && generic.arguments.length == 1) {
              optionType = contextualOption.copyBytes(
                0,
                contextualOption.byteLength
              );
              expectedPayload = generic.arguments[0].copyBytes(
                0,
                generic.arguments[0].byteLength
              );
            }
          }
          none => {}
        }
        let payloadOwner = "";
        if (stringStartsWith(expectedPayload, "view ")) {
          payloadOwner = storedViewOwnerForExpression(
            bindings,
            tree,
            payloadIndex
          );
          if (
            payloadOwner.byteLength == 0
            || !expressionHasProvenBorrowedStorage(
              bindings,
              tree,
              payloadIndex
            )
          ) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              "a view can enter Option only from proven borrowed storage",
              tree.nodes[payloadIndex].line,
              tree.nodes[payloadIndex].column
            );
          }
        }
        const payloadType = try inferExpressionNodeTypeExpected(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          payloadIndex,
          expectedPayload,
          inout bindings,
          inout evidence
        );
        try requireSettledExpressionType(
          module,
          tree,
          payloadIndex,
          payloadType
        );
        if (payloadOwner.byteLength > 0) {
          setExpressionViewOrigin(
            inout bindings,
            tree.nodes[index].offset,
            payloadOwner
          );
        }
        if (expectedPayload.byteLength > 0) {
          let requiredPayload = expectedPayload.copyBytes(
            0,
            expectedPayload.byteLength
          );
          if (
            payloadOwner.byteLength > 0
            && !viewOwnerIsOwnerless(payloadOwner)
            && stringStartsWith(expectedPayload, "view ")
          ) requiredPayload = expectedPayload.copyBytes(
            5,
            expectedPayload.byteLength
          );
          try requireExpressionType(
            module,
            modules,
            moduleIndex,
            tree,
            payloadIndex,
            requiredPayload,
            payloadType
          );
        } else {
          expectedPayload = payloadType.copyBytes(0, payloadType.byteLength);
        }
        if (!stringStartsWith(expectedPayload, "view ")) {
          try consumeOwnedExpressionNode(
            module,
            modules,
            moduleIndex,
            tree,
            payloadIndex,
            expectedPayload,
            false,
            inout bindings
          );
        }
        if (optionType.byteLength > 0) return optionType;
        let optionArguments = Array<String>();
        optionArguments.push(expectedPayload.copyBytes(
          0,
          expectedPayload.byteLength
        ));
        return parameterizedTypeName("Option", optionArguments);
      }
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
            let payloadOwner = "";
            if (stringStartsWith(expected, "view ")) {
              payloadOwner = storedViewOwnerForExpression(
                bindings,
                tree,
                children[1]
              );
              if (
                payloadOwner.byteLength == 0
                || !expressionHasProvenBorrowedStorage(
                  bindings,
                  tree,
                  children[1]
                )
              ) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "a view can enter Option only from proven borrowed storage",
                  tree.nodes[children[1]].line,
                  tree.nodes[children[1]].column
                );
              }
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
            if (payloadOwner.byteLength > 0) {
              setExpressionViewOrigin(
                inout bindings,
                tree.nodes[index].offset,
                payloadOwner
              );
            }
            let requiredPayload = expected.copyBytes(0, expected.byteLength);
            if (
              payloadOwner.byteLength > 0
              && !viewOwnerIsOwnerless(payloadOwner)
              && stringStartsWith(expected, "view ")
            ) {
              requiredPayload = expected.copyBytes(5, expected.byteLength);
            }
            try requireExpressionType(
              module,
              modules,
              moduleIndex,
              tree,
              children[1],
              requiredPayload,
              actual
            );
            let storedViewVisiting = Array<String>();
            const storedViewPayload = typeContainsStoredView(
              modules,
              moduleIndex,
              expected,
              storedViewVisiting
            );
            if (storedViewPayload) {
              const storedPayloadOwner = storedViewOwnerForExpression(
                bindings,
                tree,
                children[1]
              );
              if (storedPayloadOwner.byteLength == 0) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `view-bearing variant "${enumType}.${variantName}" requires proven stored provenance`,
                  tree.nodes[children[1]].line,
                  tree.nodes[children[1]].column
                );
              }
              setExpressionViewOrigin(
                inout bindings,
                tree.nodes[index].offset,
                storedPayloadOwner
              );
            } else {
              let enumViewVisiting = Array<String>();
              if (typeContainsStoredView(
                modules,
                moduleIndex,
                enumType,
                enumViewVisiting
              )) {
                const ownerlessOwner = ownerlessViewOwner();
                setExpressionViewOrigin(
                  inout bindings,
                  tree.nodes[index].offset,
                  ownerlessOwner
                );
              }
            }
            if (!stringStartsWith(expected, "view ")) try consumeOwnedExpressionNode(
              module,
              modules,
              moduleIndex,
              tree,
              children[1],
              expected,
              storedViewPayload,
              inout bindings
            );
            return enumType;
          }
        }
        none => {}
      }
    }
    // Type aliases are transparent at construction sites too. In particular,
    // an alias of a generic empty marker such as `Protocol()` must retain the
    // concrete generic arguments so an enclosing generic call can infer and
    // record its checked call resolution.
    const authoredConstructionType = typeExpressionName(tree, calleeIndex);
    const constructionType = transparentTypeName(
      modules,
      moduleIndex,
      authoredConstructionType
    );
    const constructionLocation = authoredConstructionType == constructionType
      ? typeSymbolLocation(modules, moduleIndex, constructionType)
      : inferredTypeSymbolLocation(modules, moduleIndex, constructionType);
    match (constructionLocation) {
      some(location) => {
        const constructionKind = modules[location.moduleIndex].symbols[location.symbolIndex].kind;
        if (isForeignUnionType(modules, moduleIndex, constructionType)) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `native union "${constructionType}" cannot be constructed as a Z struct`,
            node.line,
            node.column
          );
        }
        match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
          some(signature) => {
            if (signature.foreignKind == "viewRecord") {
              throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `native record "${constructionType}" is view-only and cannot be constructed as a Z value`,
                node.line,
                node.column
              );
            }
          }
          none => {}
        }
        if (typeIsForeignResource(modules, moduleIndex, constructionType)) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `native value resource "${constructionType}" cannot be constructed with a Z struct literal`,
            node.line,
            node.column
          );
        }
        if (
          constructionKind == ModuleSymbolKind.structSymbol
          && children.length == 1
          && !typeHasCustomConstructor(modules, moduleIndex, constructionType)
        ) {
          match (aggregateConstructionShape(modules, moduleIndex, constructionType)) {
            some(shape) => {
              if (shape.fields.length == 0) {
                return constructionType.copyBytes(0, constructionType.byteLength);
              }
            }
            none => {}
          }
        }
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
          if (contextual.byteLength > 0) {
            const storedViewOwner = expressionViewOrigin(
              bindings,
              tree.nodes[children[1]].offset
            );
            if (storedViewOwner.byteLength > 0) {
              setExpressionViewOrigin(
                inout bindings,
                tree.nodes[index].offset,
                storedViewOwner
              );
            }
            return contextual;
          }
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
      const callableLocalType = transparentTypeName(
        modules,
        moduleIndex,
        localType
      );
      match (nativeFunctionSignature(callableLocalType)) {
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
      if (isIntegerTypeName(base) || isFloatTypeName(base)) {
        if (children.length != 2) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `${base} numeric construction expects exactly one numeric value`,
            node.line,
            node.column
          );
        }
        const argument = children[1];
        const actual = try inferExpressionNodeType(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          argument,
          inout bindings,
          inout evidence
        );
        if (actual.byteLength == 0) {
          // Stage 1 intentionally defers foreign scalar identity until that
          // ABI evidence enters the native graph. Stage 0 remains authoritative
          // for this conversion rather than inventing a conflicting type.
          return copiedString(base);
        }
        try requireSettledExpressionType(module, tree, argument, actual);
        if (!isIntegerConstructionSource(modules, moduleIndex, actual)) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `${base} numeric construction requires a numeric value, found ${actual}`,
            tree.nodes[argument].line,
            tree.nodes[argument].column
          );
        }
        recordExpressionResolution(
          modules,
          moduleIndex,
          tree,
          argument,
          actual,
          inout evidence
        );
        return copiedString(base);
      }
      if (importedStandardType(
        module,
        base,
        "std/memory",
        "Arena"
      )) {
        const arguments = callArgumentNodes(children);
        if (arguments.length > 1) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "Arena() expects no arguments or one options object",
            node.line,
            node.column
          );
        }
        if (arguments.length == 1) {
          const options = arguments[0];
          if (
            tree.nodes[options].kind != ExpressionKind.objectExpression
            || tree.nodes[options].children.length != 1
            || tree.nodes[options].labels.length != 1
            || tree.nodes[options].labels[0] != "initialCapacity"
          ) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              "Arena options require exactly initialCapacity",
              tree.nodes[options].line,
              tree.nodes[options].column
            );
          }
          const capacity = tree.nodes[options].children[0];
          const actual = try inferExpressionNodeTypeExpected(
            module,
            modules,
            moduleIndex,
            arena,
            tree,
            capacity,
            "usize",
            inout bindings,
            inout evidence
          );
          try requireExpressionType(
            module,
            modules,
            moduleIndex,
            tree,
            capacity,
            "usize",
            actual
          );
        }
        return copiedString(base);
      }
      if (importedStandardType(
        module,
        base,
        "std/memory",
        "replace"
      )) {
        const arguments = callArgumentNodes(children);
        if (arguments.length != 2) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `replace expects 2 arguments, received ${arguments.length}`,
            node.line,
            node.column
          );
        }
        const target = arguments[0];
        if (expressionCapabilityAccess(tree, target) != "inout") {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "replace requires inout <mutable storage> for its first argument",
            tree.nodes[target].line,
            tree.nodes[target].column
          );
        }
        const valueType = try inferExpressionNodeType(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          target,
          inout bindings,
          inout evidence
        );
        try requireSettledExpressionType(module, tree, target, valueType);
        let storedViewVisiting = Array<String>();
        if (typeContainsStoredView(
          modules,
          moduleIndex,
          valueType,
          storedViewVisiting
        )) throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `replace cannot exchange view-bearing storage ${valueType} in the first ownership tier`,
          tree.nodes[target].line,
          tree.nodes[target].column
        );
        if (!typeIsClassReference(
          module,
          modules,
          moduleIndex,
          valueType
        )) {
          let classStorageVisiting = Array<String>();
          if (typeContainsClassReferenceStorage(
            module,
            modules,
            moduleIndex,
            valueType,
            inout classStorageVisiting
          )) throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `replace cannot exchange aggregate storage containing ARC class identity ${valueType} in the first ownership tier`,
            tree.nodes[target].line,
            tree.nodes[target].column
          );
        }
        const replacement = arguments[1];
        const replacementRoot = expressionStorageRootName(tree, replacement);
        const explicitMove = tree.nodes[replacement].kind
            == ExpressionKind.unaryExpression
          && tree.nodes[replacement].value == "move";
        if (
          replacementRoot.byteLength > 0
          && typeMovesOnOwnedUse(modules, moduleIndex, valueType)
          && !explicitMove
        ) throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "replacing from an existing owner requires an explicit move",
          tree.nodes[replacement].line,
          tree.nodes[replacement].column
        );
        const substitutions = Array<NativeValueBinding>();
        const signature = memoryReplaceSignature(valueType);
        let displacedClassIdentity: usize = 0;
        let displacedClassContained = false;
        let replacementClassIdentity: usize = 0;
        let replacementClassContained = false;
        const exchangesClassIdentity = typeIsClassReference(
          module,
          modules,
          moduleIndex,
          valueType
        );
        if (exchangesClassIdentity) {
          displacedClassIdentity = expressionNodeClassAliasIdentity(
            tree,
            target,
            bindings,
            modules,
            moduleIndex
          );
          displacedClassContained = expressionNodeClassAliasIsContained(
            tree,
            target,
            bindings
          );
          replacementClassIdentity = expressionNodeClassAliasIdentity(
            tree,
            replacement,
            bindings,
            modules,
            moduleIndex
          );
          replacementClassContained = expressionNodeClassAliasIsContained(
            tree,
            replacement,
            bindings
          );
        }
        const resultType = try inferSignatureCallType(
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
          "replace",
          signature,
          substitutions,
          0,
          0,
          "value",
          inout evidence
        );
        if (exchangesClassIdentity) {
          const resultBinding = memoryReplaceClassAliasBindingName(node.offset);
          const existingResultType = valueBindingType(bindings, resultBinding);
          if (existingResultType.byteLength == 0) {
            addValueBinding(inout bindings, resultBinding, valueType);
          }
          setValueBindingClassAlias(
            inout bindings,
            resultBinding,
            displacedClassIdentity
          );
          setValueBindingClassAliasContained(
            inout bindings,
            resultBinding,
            displacedClassContained
          );
          const targetRoot = expressionStorageRootName(tree, target);
          if (targetRoot.byteLength > 0 && projectedFieldCount(tree, target) == 0) {
            setValueBindingClassAlias(
              inout bindings,
              targetRoot,
              replacementClassIdentity
            );
            setValueBindingClassAliasContained(
              inout bindings,
              targetRoot,
              replacementClassContained
            );
          }
          if (replacementClassContained) {
            restoreContainedClassAlias(
              inout bindings,
              replacementClassIdentity
            );
          }
        }
        return resultType;
      }
      let mutexBindingName = base.copyBytes(0, base.byteLength);
      match (genericTypeShape(callee)) {
        some(generic) => mutexBindingName = generic.base.copyBytes(
          0,
          generic.base.byteLength
        );
        none => {}
      }
      if (importedStandardType(
        module,
        mutexBindingName,
        "std/sync",
        "Mutex"
      )) {
        const arguments = callArgumentNodes(children);
        if (arguments.length != 1) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "Mutex<T>(value) expects exactly one value",
            node.line,
            node.column
          );
        }
        const argument = arguments[0];
        let valueType = "";
        match (genericTypeShape(callee)) {
          some(mutex) => {
            if (mutex.arguments.length != 1) {
              throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `Mutex expects one type argument, received ${mutex.arguments.length}`,
                tree.nodes[calleeIndex].line,
                tree.nodes[calleeIndex].column
              );
            }
            valueType = mutex.arguments[0].copyBytes(
              0,
              mutex.arguments[0].byteLength
            );
          }
          none => {}
        }
        const actual = try inferExpressionNodeTypeExpected(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          argument,
          valueType,
          inout bindings,
          inout evidence
        );
        try requireSettledExpressionType(module, tree, argument, actual);
        if (valueType.byteLength == 0) {
          valueType = actual.copyBytes(0, actual.byteLength);
        } else {
          try requireExpressionType(
            module,
            modules,
            moduleIndex,
            tree,
            argument,
            valueType,
            actual
          );
        }
        if (!mutexPayloadSupported(valueType)) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `Mutex cannot own ${valueType} in the first synchronization tier`,
            tree.nodes[calleeIndex].line,
            tree.nodes[calleeIndex].column
          );
        }
        let visiting = Array<String>();
        const root = expressionStorageRootName(tree, argument);
        const explicitMove = tree.nodes[argument].kind
            == ExpressionKind.unaryExpression
          && tree.nodes[argument].value == "move";
        if (
          root.byteLength > 0
          && typeHasCleanup(
            modules,
            moduleIndex,
            valueType,
            visiting
          )
          && !explicitMove
        ) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "initializing Mutex from an existing owner requires an explicit move",
            tree.nodes[argument].line,
            tree.nodes[argument].column
          );
        }
        try consumeOwnedExpressionNode(
          module,
          modules,
          moduleIndex,
          tree,
          argument,
          valueType,
          false,
          inout bindings
        );
        let typeArguments = Array<String>();
        typeArguments.push(valueType);
        return parameterizedTypeName("Mutex", typeArguments);
      }
      if (base == "Array") {
        match (genericTypeShape(callee)) {
          some(array) => {
            if (array.arguments.length == 1) {
              const elementType = array.arguments[0].copyBytes(
                0,
                array.arguments[0].byteLength
              );
              const arguments = callArgumentNodes(children);
              let storedViewVisiting = Array<String>();
              const storedViewElement = typeContainsStoredView(
                modules,
                moduleIndex,
                elementType,
                storedViewVisiting
              );
              let storedViewOwner = "";
              if (storedViewElement) {
                let valueStructElement = false;
                match (typeSymbolLocation(modules, moduleIndex, elementType)) {
                  some(location) => {
                    valueStructElement = modules[location.moduleIndex]
                      .symbols[location.symbolIndex].kind
                      == ModuleSymbolKind.structSymbol;
                  }
                  none => {}
                }
                if (!valueStructElement) {
                  throw resolutionError(
                    ModuleResolveErrorKind.typeMismatch,
                    module.path,
                    `Array<${elementType}> cannot carry stored provenance in the first container tier`,
                    node.line,
                    node.column
                  );
                }
              }
              for (const argument of arguments) {
                const actual = try inferExpressionNodeTypeExpected(
                  module,
                  modules,
                  moduleIndex,
                  arena,
                  tree,
                  argument,
                  elementType,
                  inout bindings,
                  inout evidence
                );
                try requireExpressionType(
                  module,
                  modules,
                  moduleIndex,
                  tree,
                  argument,
                  elementType,
                  actual
                );
                if (storedViewElement) {
                  const elementOwner = storedViewOwnerForExpression(
                    bindings,
                    tree,
                    argument
                  );
                  if (elementOwner.byteLength == 0) {
                    throw resolutionError(
                      ModuleResolveErrorKind.typeMismatch,
                      module.path,
                      "a view-bearing Array element must come directly from proven borrowed storage",
                      tree.nodes[argument].line,
                      tree.nodes[argument].column
                    );
                  }
                  if (storedViewOwner.byteLength == 0) {
                    storedViewOwner = elementOwner.copyBytes(
                      0,
                      elementOwner.byteLength
                    );
                  } else {
                    const mergedOwner = mergeViewOwners(
                      storedViewOwner,
                      elementOwner
                    );
                    if (mergedOwner == "__z_native_mixed_view_owner") {
                      throw resolutionError(
                        ModuleResolveErrorKind.typeMismatch,
                        module.path,
                        "a view-bearing Array must borrow from exactly one owner",
                        node.line,
                        node.column
                      );
                    }
                    storedViewOwner = move mergedOwner;
                  }
                }
                if (storedViewElement) {
                  if (
                    tree.nodes[argument].kind
                    == ExpressionKind.identifierExpression
                  ) {
                    const argumentRoot = expressionStorageRootName(
                      tree,
                      argument
                    );
                    setValueBindingOwnership(
                      inout bindings,
                      argumentRoot,
                      NativeOwnershipState.moved
                    );
                  } else {
                    try consumeOwnedExpressionNode(
                      module,
                      modules,
                      moduleIndex,
                      tree,
                      argument,
                      elementType,
                      true,
                      inout bindings
                    );
                  }
                } else {
                  try consumeOwnedExpressionNode(
                    module,
                    modules,
                    moduleIndex,
                    tree,
                    argument,
                    elementType,
                    false,
                    inout bindings
                  );
                }
              }
              if (storedViewElement) {
                setExpressionViewOrigin(
                  inout bindings,
                  node.offset,
                  storedViewOwner
                );
              }
              return copiedString(callee);
            }
          }
          none => {}
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
        return copiedString(callee);
      }
      if (base == "Once") {
        match (genericTypeShape(callee)) {
          some(once) => {
            if (
              once.arguments.length == 1
              && children.length == 1
            ) return copiedString(callee);
          }
          none => {}
        }
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "Once<T>() expects one type argument and no values",
          node.line,
          node.column
        );
      }
      if (base == "Map") {
        match (genericTypeShape(callee)) {
          some(map) => {
            if (map.arguments.length == 2) {
              let storedViewVisiting = Array<String>();
              if (typeContainsStoredView(
                modules,
                moduleIndex,
                map.arguments[1],
                storedViewVisiting
              )) {
                let valueStruct = false;
                match (typeSymbolLocation(
                  modules,
                  moduleIndex,
                  map.arguments[1]
                )) {
                  some(location) => valueStruct = modules[
                    location.moduleIndex
                  ].symbols[location.symbolIndex].kind
                    == ModuleSymbolKind.structSymbol;
                  none => {}
                }
                if (!valueStruct) {
                  throw resolutionError(
                    ModuleResolveErrorKind.typeMismatch,
                    module.path,
                    `Map cannot carry stored provenance for value type ${map.arguments[1]} in the first container tier`,
                    tree.nodes[calleeIndex].line,
                    tree.nodes[calleeIndex].column
                  );
                }
              }
            }
          }
          none => {}
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
        return copiedString(callee);
      }
      if (base == "Set") {
        match (genericTypeShape(callee)) {
          some(set) => {
            if (set.arguments.length == 1) {
              let storedViewVisiting = Array<String>();
              if (typeContainsStoredView(
                modules,
                moduleIndex,
                set.arguments[0],
                storedViewVisiting
              )) {
                let valueStruct = false;
                match (typeSymbolLocation(
                  modules,
                  moduleIndex,
                  set.arguments[0]
                )) {
                  some(location) => valueStruct = modules[
                    location.moduleIndex
                  ].symbols[location.symbolIndex].kind
                    == ModuleSymbolKind.structSymbol;
                  none => {}
                }
                if (!valueStruct) {
                  throw resolutionError(
                    ModuleResolveErrorKind.typeMismatch,
                    module.path,
                    `Set cannot carry stored provenance for element type ${set.arguments[0]} in the first container tier`,
                    tree.nodes[calleeIndex].line,
                    tree.nodes[calleeIndex].column
                  );
                }
              }
            }
          }
          none => {}
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
        return copiedString(callee);
      }
      if (base == "TextBuffer") {
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
            let functionName = modules[location.moduleIndex].symbols[location.symbolIndex].name.copyBytes(
              0,
              modules[location.moduleIndex].symbols[location.symbolIndex].name.byteLength
            );
            let callKind = "function";
            if (
              modules[location.moduleIndex].symbols[location.symbolIndex].kind
                == ModuleSymbolKind.importedSymbol
            ) {
              match (
                in modules[location.moduleIndex].symbols[location.symbolIndex].targetModule
              ) {
                some(_) => {}
                none => {
                  functionName = modules[location.moduleIndex]
                    .symbols[location.symbolIndex]
                    .importedName
                    .copyBytes(
                      0,
                      modules[location.moduleIndex]
                        .symbols[location.symbolIndex]
                        .importedName
                        .byteLength
                    );
                  callKind = "foreign";
                }
              }
            }
            const substitutions = Array<NativeValueBinding>();
            const callableSignature = rebaseModuleFunctionSignature(
              modules,
              location.moduleIndex,
              moduleIndex,
              signature
            );
            const argumentNodes = callArgumentNodes(children);
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
              "",
              "",
              functionName,
              callableSignature,
              substitutions,
              location.moduleIndex,
              location.symbolIndex,
              callKind,
              inout evidence
            );
            if (callKind == "foreign") {
              recordForeignCallFacts(
                tree,
                index,
                modules[location.moduleIndex].symbols[location.symbolIndex],
                inout evidence
              );
            }
            return callType;
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
      const optionalMethodCall = tree.nodes[calleeIndex].optionalAccess;
      if (
        tree.nodes[receiverIndex].kind
          == ExpressionKind.identifierExpression
      ) {
        const namespaceName = identifierLookupName(
          tree.nodes[receiverIndex].value
        );
        const memberName = identifierLookupName(
          tree.nodes[calleeIndex].value
        );
        if (
          memberName == "spawn"
          && importedStandardType(
            module,
            namespaceName,
            "std/thread",
            "thread"
          )
        ) {
          let workerBindings = copyValueBindings(bindings);
          addValueBinding(
            inout workerBindings,
            "__z_native_executor_context",
            ""
          );
          try inferUnclassifiedCallArguments(
            module,
            modules,
            moduleIndex,
            arena,
            tree,
            children,
            inout workerBindings,
            inout evidence
          );
          copyBindingFlowStates(inout bindings, workerBindings);
          return "";
        }
        if (
          memberName == "adapt"
          && importedStandardNamespace(
            module,
            namespaceName,
            "std/objc"
          )
          // The hybrid source batch does not carry Clang protocol metadata
          // yet. Defer this call to Stage 0 just like other unavailable
          // foreign ABI semantics instead of inventing a native rejection.
          && hasNativeObjCRegistrationMetadata(modules)
        ) return try inferObjCAdapter(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          index,
          calleeIndex,
          namespaceName,
          inout bindings,
          inout evidence
        );
        if (
          memberName == "register"
          && importedStandardNamespace(
            module,
            namespaceName,
            "std/objc"
          )
          && hasNativeObjCRegistrationMetadata(modules)
        ) return try inferObjCRegistration(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          index,
          namespaceName,
          inout bindings,
          inout evidence
        );
        if (
          memberName == "connect"
          && importedStandardNamespace(
            module,
            namespaceName,
            "std/objc"
          )
        ) {
          // Stage 0 proves the target/action object's executor contract from
          // imported Objective-C metadata. That metadata is not in the native
          // source-module graph yet, so retain the proven caller executor while
          // validating the callback instead of treating it as an arbitrary
          // closure. A non-main caller remains unknown and cannot gain affinity.
          let connectionBindings = copyValueBindings(bindings);
          const connectionExecutorContext = currentExecutorContext(bindings);
          addValueBinding(
            inout connectionBindings,
            "__z_native_closure_executor_context",
            connectionExecutorContext
          );
          try inferUnclassifiedCallArguments(
            module,
            modules,
            moduleIndex,
            arena,
            tree,
            children,
            inout connectionBindings,
            inout evidence
          );
          copyBindingFlowStates(inout bindings, connectionBindings);
          return "";
        }
        if (
          memberName == "pool"
          && importedStandardNamespace(
            module,
            namespaceName,
            "std/objc"
          )
        ) {
          const argumentNodes = callArgumentNodes(children);
          if (argumentNodes.length != 1) {
            throw genericCallError(
              module,
              tree,
              calleeIndex,
              `objc.pool expects 1 argument, received ${argumentNodes.length}`
            );
          }
          const operation = argumentNodes[0];
          const operationType = try inferExpressionNodeType(
            module,
            modules,
            moduleIndex,
            arena,
            tree,
            operation,
            inout bindings,
            inout evidence
          );
          const signature = match (nativeFunctionSignature(operationType)) {
            some(signature) => signature;
            none => throw genericCallError(
              module,
              tree,
              operation,
              "objc.pool expects one synchronous zero-argument closure"
            );
          };
          if (
            signature.asynchronous
            || signature.parameterTypes.length != 0
          ) throw genericCallError(
            module,
            tree,
            operation,
            "objc.pool expects one synchronous zero-argument closure"
          );
          if (signature.errorType.byteLength > 0) {
            return pendingThrowingCallType(
              signature.returnType,
              signature.errorType
            );
          }
          return signature.returnType.copyBytes(
            0,
            signature.returnType.byteLength
          );
        }
        let standardArgumentType = "";
        if (
          memberName == "trunc"
          && importedStandardNamespace(
            module,
            namespaceName,
            "std/math"
          )
        ) {
          const mathArguments = callArgumentNodes(children);
          if (mathArguments.length != 1) {
            throw genericCallError(
              module,
              tree,
              calleeIndex,
              `math.trunc expects 1 argument, received ${mathArguments.length}`
            );
          }
          standardArgumentType = try inferExpressionNodeType(
            module,
            modules,
            moduleIndex,
            arena,
            tree,
            mathArguments[0],
            inout bindings,
            inout evidence
          );
          if (
            standardArgumentType != "f32"
            && standardArgumentType != "f64"
          ) throw genericCallError(
            module,
            tree,
            mathArguments[0],
            `math.trunc requires f32 or f64, found ${standardArgumentType}`
          );
        }
        match (nativeStandardCall(
          module.program,
          namespaceName,
          memberName,
          children.length - 1,
          standardArgumentType
        )) {
          some(standard) => {
            const namespaceSymbol = moduleSymbolIndex(
              modules[moduleIndex],
              namespaceName
            );
            if (
              namespaceSymbol
                < modules[moduleIndex].symbols.length
            ) {
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
                "",
                "",
                standard.name,
                standard.signature,
                substitutions,
                moduleIndex,
                namespaceSymbol,
                "standard",
                inout evidence
              );
            }
          }
          none => {}
        }
        const foreignNamespaceIndex = moduleSymbolIndex(
          modules[moduleIndex],
          namespaceName
        );
        if (
          foreignNamespaceIndex < modules[moduleIndex].symbols.length
          && modules[moduleIndex].symbols[foreignNamespaceIndex].kind
            == ModuleSymbolKind.namespaceSymbol
          && modules[moduleIndex].symbols[foreignNamespaceIndex]
            .foreignHeader.byteLength > 0
        ) {
          throw resolutionError(
            ModuleResolveErrorKind.missingExport,
            module.path,
            `native contract for "${modules[moduleIndex].symbols[foreignNamespaceIndex].foreignHeader}" has no checked function "${memberName}"`,
            tree.nodes[calleeIndex].line,
            tree.nodes[calleeIndex].column
          );
        }
      }
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
      recordExpressionResolution(
        modules,
        moduleIndex,
        tree,
        receiverIndex,
        ownerType,
        inout evidence
      );
      if (optionalMethodCall) {
        match (optionalReceiverPayloadType(ownerType)) {
          some(payload) => ownerType = payload.copyBytes(
            0,
            payload.byteLength
          );
          none => throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `optional call requires Option<T>, found ${ownerType}`,
            tree.nodes[receiverIndex].line,
            tree.nodes[receiverIndex].column
          );
        }
      }
      if (stringStartsWith(ownerType, "view ")) {
        ownerType = ownerType.copyBytes(5, ownerType.byteLength);
      }
      let staticMethod = false;
      if (ownerType.byteLength == 0) {
        const candidate = typeExpressionName(tree, receiverIndex);
        const candidateBase = qualifiedTypeBase(candidate);
        if (
          qualifiedTypeMember(candidate) == "NSData"
          && importedStandardNamespace(
            module,
            candidateBase,
            "Foundation/Foundation.h"
          )
        ) {
          ownerType = candidate.copyBytes(0, candidate.byteLength);
          staticMethod = true;
        } else {
          let channelFactory = false;
          match (genericTypeShape(candidate)) {
            some(generic) => {
              channelFactory = generic.arguments.length == 1
                && standardChannelTypeKind(module, generic.base) == "Channel";
            }
            none => {}
          }
          if (channelFactory) {
            ownerType = candidate.copyBytes(0, candidate.byteLength);
            staticMethod = true;
          } else {
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
        }
      }
      if (ownerType.byteLength > 0) {
        const methodName = identifierLookupName(tree.nodes[calleeIndex].value);
        if (staticMethod) {
          match (genericTypeShape(ownerType)) {
            some(channel) => {
              if (
                channel.arguments.length == 1
                && standardChannelTypeKind(module, channel.base) == "Channel"
              ) {
                if (optionalMethodCall) throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "optional call cannot invoke Channel.bounded",
                  tree.nodes[calleeIndex].line,
                  tree.nodes[calleeIndex].column
                );
                if (methodName != "bounded") throw resolutionError(
                  ModuleResolveErrorKind.unknownMember,
                  module.path,
                  `Channel has no static method "${methodName}"; use Channel<T>.bounded(capacity)`,
                  tree.nodes[calleeIndex].line,
                  tree.nodes[calleeIndex].column
                );
                const argumentNodes = callArgumentNodes(children);
                if (argumentNodes.length != 1) throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `Channel.bounded expects 1 capacity argument, received ${argumentNodes.length}`,
                  tree.nodes[index].line,
                  tree.nodes[index].column
                );
                const capacity = argumentNodes[0];
                const capacityType = try inferExpressionNodeType(
                  module,
                  modules,
                  moduleIndex,
                  arena,
                  tree,
                  capacity,
                  inout bindings,
                  inout evidence
                );
                try requireSettledExpressionType(
                  module,
                  tree,
                  capacity,
                  capacityType
                );
                if (!isIntegerTypeName(capacityType)) throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `Channel.bounded capacity must be an integer, found ${capacityType}`,
                  tree.nodes[capacity].line,
                  tree.nodes[capacity].column
                );
                if (
                  tree.nodes[capacity].kind == ExpressionKind.numberExpression
                  && tree.nodes[capacity].value == "0"
                ) throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "Channel.bounded capacity must be greater than zero",
                  tree.nodes[capacity].line,
                  tree.nodes[capacity].column
                );
                const payload = view channel.arguments[0];
                if (!typeIsThreadTransferable(
                  modules,
                  moduleIndex,
                  payload
                )) throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `Channel message type ${payload} is not transferable across threads`,
                  tree.nodes[receiverIndex].line,
                  tree.nodes[receiverIndex].column
                );
                return `Channel.Endpoints<${payload}>`;
              }
            }
            none => {}
          }
        }
        if (
          staticMethod
          && qualifiedTypeMember(ownerType) == "NSData"
          && (methodName == "copy" || methodName == "borrow")
        ) {
          if (optionalMethodCall) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              "optional call cannot invoke an NSData byte bridge",
              tree.nodes[calleeIndex].line,
              tree.nodes[calleeIndex].column
            );
          }
          let parameterModes = Array<String>();
          parameterModes.push("in");
          let parameterTypes = Array<String>();
          parameterTypes.push(methodName == "borrow"
            ? "embed.StaticBytes"
            : "Slice<u8>");
          const signature = ModuleFunctionSignature({
            asynchronous: false,
            executorAffinity: "",
            threadContract: "",
            typeParameters: Array<String>(),
            typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
            parameterModes,
            parameterTypes,
            viewParameter: Option<usize>.none,
            invalidatesParameters: Array<usize>(),
            invalidatesLifetimes: Array<String>(),
            returnType: ownerType.copyBytes(0, ownerType.byteLength),
            errorType: "",
          });
          const dataNamespace = qualifiedTypeBase(ownerType);
          const dataSymbolIndex = moduleSymbolIndex(
            modules[moduleIndex],
            dataNamespace
          );
          if (
            dataSymbolIndex >= modules[moduleIndex].symbols.length
            || modules[moduleIndex].symbols[dataSymbolIndex].kind
              != ModuleSymbolKind.namespaceSymbol
          ) throw resolutionError(
            ModuleResolveErrorKind.unknownType,
            module.path,
            `could not resolve Objective-C type ${ownerType}`,
            tree.nodes[receiverIndex].line,
            tree.nodes[receiverIndex].column
          );
          const substitutions = Array<NativeValueBinding>();
          const argumentNodes = callArgumentNodes(children);
          const dataCallKind = methodName == "borrow"
            ? "objectiveCDataBorrow"
            : "objectiveCDataCopy";
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
            `${ownerType}.${methodName}`,
            signature,
            substitutions,
            moduleIndex,
            dataSymbolIndex,
            dataCallKind,
            inout evidence
          );
        }
        if (
          ownerType == "TaskScope"
          || importedStandardType(
            module,
            ownerType,
            "std/async",
            "TaskScope"
          )
        ) {
          if (optionalMethodCall) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              "optional call cannot invoke TaskScope methods",
              tree.nodes[calleeIndex].line,
              tree.nodes[calleeIndex].column
            );
          }
          const argumentNodes = callArgumentNodes(children);
          if (methodName == "schedule") {
            if (
              argumentNodes.length != 2
              || tree.nodes[argumentNodes[1]].kind
                != ExpressionKind.closureExpression
            ) throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              "TaskScope.schedule expects thread.main and one async closure",
              node.line,
              node.column
            );
            const closureIndex = argumentNodes[1];
            const parameterModes = Array<String>();
            const parameterTypes = Array<String>();
            const contextualType = nativeClosureFunctionType(
              tree,
              closureIndex,
              parameterModes,
              parameterTypes,
              "void",
              "",
              "",
              true,
              false
            );
            let taskScopeBindings = copyValueBindings(bindings);
            addValueBinding(
              inout taskScopeBindings,
              "__z_native_closure_executor_context",
              "thread.main"
            );
            const closureType = try inferExpressionNodeTypeExpected(
              module,
              modules,
              moduleIndex,
              arena,
              tree,
              closureIndex,
              contextualType,
              inout taskScopeBindings,
              inout evidence
            );
            copyBindingFlowStates(inout bindings, taskScopeBindings);
            match (nativeFunctionSignature(closureType)) {
              some(signature) => {
                if (
                  !signature.asynchronous
                  || signature.parameterTypes.length != 0
                  || signature.returnType != "void"
                  || signature.errorType.byteLength > 0
                ) throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "TaskScope.schedule requires async () => void",
                  tree.nodes[closureIndex].line,
                  tree.nodes[closureIndex].column
                );
              }
              none => throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                "TaskScope.schedule could not resolve its async closure",
                tree.nodes[closureIndex].line,
                tree.nodes[closureIndex].column
              );
            }
            return "TaskControl";
          }
          if (methodName == "close" || methodName == "cancel") {
            if (argumentNodes.length != 0) {
              throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `TaskScope.${methodName} expects no arguments`,
                node.line,
                node.column
              );
            }
            return "Task<void>";
          }
          throw resolutionError(
            ModuleResolveErrorKind.unknownMember,
            module.path,
            `TaskScope has no method "${methodName}"`,
            tree.nodes[calleeIndex].line,
            tree.nodes[calleeIndex].column
          );
        }
        if (
          ownerType == "TaskControl"
          || importedStandardType(
            module,
            ownerType,
            "std/async",
            "TaskControl"
          )
        ) {
          const argumentNodes = callArgumentNodes(children);
          if (methodName == "requestCancel" && argumentNodes.length == 0) {
            return "boolean";
          }
          throw resolutionError(
            ModuleResolveErrorKind.unknownMember,
            module.path,
            `TaskControl has no method "${methodName}"`,
            tree.nodes[calleeIndex].line,
            tree.nodes[calleeIndex].column
          );
        }
        if (
          ownerType == "Arena"
          || importedStandardType(
            module,
            ownerType,
            "std/memory",
            "Arena"
          )
        ) {
          if (
            valueBindingType(bindings, "__z_native_async_context")
              == "true"
          ) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              "Arena access cannot cross suspension in the first region tier",
              tree.nodes[calleeIndex].line,
              tree.nodes[calleeIndex].column
            );
          }
          if (optionalMethodCall) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              "optional call cannot invoke Arena methods",
              tree.nodes[calleeIndex].line,
              tree.nodes[calleeIndex].column
            );
          }
          const receiverRoot = expressionStorageRootName(
            tree,
            receiverIndex
          );
          if (receiverRoot.byteLength == 0) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              "Arena methods require named storage",
              tree.nodes[receiverIndex].line,
              tree.nodes[receiverIndex].column
            );
          }
          if (!valueBindingIsMutable(bindings, receiverRoot)) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              `Arena.${methodName} requires addressable let storage`,
              tree.nodes[receiverIndex].line,
              tree.nodes[receiverIndex].column
            );
          }
          const argumentNodes = callArgumentNodes(children);
          if (methodName == "reset") {
            if (argumentNodes.length != 0) {
              throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `"reset" expects 0 arguments, received ${argumentNodes.length}`,
                node.line,
                node.column
              );
            }
            const liveView = liveViewBindingForOwner(
              bindings,
              receiverRoot
            );
            if (liveView.byteLength > 0) {
              throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `cannot reset Arena "${receiverRoot}" while view "${liveView}" is live`,
                tree.nodes[receiverIndex].line,
                tree.nodes[receiverIndex].column
              );
            }
            return "void";
          }
          if (methodName != "create") {
            throw resolutionError(
              ModuleResolveErrorKind.unknownMember,
              module.path,
              `Arena has no method "${methodName}"`,
              tree.nodes[calleeIndex].line,
              tree.nodes[calleeIndex].column
            );
          }
          if (argumentNodes.length != 1) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              `"create" expects 1 argument, received ${argumentNodes.length}`,
              node.line,
              node.column
            );
          }
          const argument = argumentNodes[0];
          const actual = try inferExpressionNodeType(
            module,
            modules,
            moduleIndex,
            arena,
            tree,
            argument,
            inout bindings,
            inout evidence
          );
          try requireSettledExpressionType(module, tree, argument, actual);
          if (
            actual == "void"
            || actual == "Arena"
            || importedStandardType(
              module,
              actual,
              "std/memory",
              "Arena"
            )
            || stringStartsWith(actual, "view ")
            || stringStartsWith(actual, "Slice<")
            || stringStartsWith(actual, "Task<")
          ) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              `Arena.create cannot store ${actual}`,
              tree.nodes[argument].line,
              tree.nodes[argument].column
            );
          }
          match (typeSymbolLocation(modules, moduleIndex, actual)) {
            some(location) => {
              if (
                modules[location.moduleIndex].symbols[location.symbolIndex].kind
                  == ModuleSymbolKind.classSymbol
              ) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "Arena.create does not directly root reference-identity objects in the first tier",
                  tree.nodes[argument].line,
                  tree.nodes[argument].column
                );
              }
            }
            none => {}
          }
          let storedViewVisiting = Array<String>();
          if (typeContainsStoredView(
            modules,
            moduleIndex,
            actual,
            storedViewVisiting
          )) {
            const storedViewOwner = storedViewOwnerForExpression(
              bindings,
              tree,
              argument
            );
            if (storedViewOwner == "__z_native_mixed_view_owner") {
              const argumentRoot = expressionStorageRootName(tree, argument);
              throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `view-bearing collection "${argumentRoot}" must establish the same Arena provenance on every continuing path`,
                tree.nodes[argument].line,
                tree.nodes[argument].column
              );
            }
            if (
              !viewOwnerIsOwnerless(storedViewOwner)
              && storedViewOwner != receiverRoot
            ) {
              throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                "Arena.create can store a view-bearing value only in the Arena that owns every embedded view",
                tree.nodes[argument].line,
                tree.nodes[argument].column
              );
            }
            const argumentRoot = expressionStorageRootName(tree, argument);
            if (argumentRoot.byteLength > 0) {
              setValueBindingOwnership(
                inout bindings,
                argumentRoot,
                NativeOwnershipState.moved
              );
            }
          } else {
            try consumeOwnedExpressionNode(
              module,
              modules,
              moduleIndex,
              tree,
              argument,
              actual,
              false,
              inout bindings
            );
          }
          setExpressionViewOrigin(
            inout bindings,
            tree.nodes[index].offset,
            receiverRoot
          );
          return `view ${actual}`;
        }
        match (genericTypeShape(ownerType)) {
          some(channel) => {
            const endpointKind = standardChannelTypeKind(
              module,
              channel.base
            );
            if (
              channel.arguments.length == 1
              && (
                endpointKind == "Sender"
                || endpointKind == "Receiver"
                || endpointKind == "SyncSender"
                || endpointKind == "SyncReceiver"
              )
            ) {
              if (optionalMethodCall) throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `optional call cannot invoke ${endpointKind}.${methodName}; unwrap the endpoint first`,
                tree.nodes[calleeIndex].line,
                tree.nodes[calleeIndex].column
              );
              const receiverRoot = expressionStorageRootName(
                tree,
                receiverIndex
              );
              if (receiverRoot.byteLength == 0) throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `Channel endpoint method "${methodName}" requires a named handle`,
                tree.nodes[receiverIndex].line,
                tree.nodes[receiverIndex].column
              );
              const payload = view channel.arguments[0];
              const argumentNodes = callArgumentNodes(children);
              let signature = channelCallSignature(
                false,
                "",
                "",
                ""
              );
              let receiverMode = "";
              if (
                methodName == "send"
                && (endpointKind == "Sender" || endpointKind == "SyncSender")
              ) {
                signature = channelCallSignature(
                  endpointKind == "Sender",
                  payload,
                  "void",
                  `ChannelClosed<${payload}>`
                );
                if (argumentNodes.length == 1) {
                  const argument = argumentNodes[0];
                  let visiting = Array<String>();
                  const argumentRoot = expressionStorageRootName(
                    tree,
                    argument
                  );
                  const explicitMove = tree.nodes[argument].kind
                      == ExpressionKind.unaryExpression
                    && tree.nodes[argument].value == "move";
                  if (
                    argumentRoot.byteLength > 0
                    && typeHasCleanup(
                      modules,
                      moduleIndex,
                      payload,
                      visiting
                    )
                    && !explicitMove
                  ) throw resolutionError(
                    ModuleResolveErrorKind.typeMismatch,
                    module.path,
                    "sending an existing message owner requires an explicit move",
                    tree.nodes[argument].line,
                    tree.nodes[argument].column
                  );
                }
              } else if (
                methodName == "receive"
                && (endpointKind == "Receiver" || endpointKind == "SyncReceiver")
              ) {
                signature = channelCallSignature(
                  endpointKind == "Receiver",
                  "",
                  `Option<${payload}>`,
                  ""
                );
              } else if (
                methodName == "close"
                && (endpointKind == "Sender" || endpointKind == "SyncSender")
              ) {
                signature = channelCallSignature(false, "", "void", "");
              } else if (methodName == "sync" && endpointKind == "Sender") {
                signature = channelCallSignature(
                  false,
                  "",
                  `SyncSender<${payload}>`,
                  ""
                );
              } else if (methodName == "sync" && endpointKind == "Receiver") {
                signature = channelCallSignature(
                  false,
                  "",
                  `SyncReceiver<${payload}>`,
                  ""
                );
                receiverMode = "move";
              } else throw resolutionError(
                ModuleResolveErrorKind.unknownMember,
                module.path,
                `${ownerType} has no method "${methodName}"`,
                tree.nodes[calleeIndex].line,
                tree.nodes[calleeIndex].column
              );
              const substitutions = Array<NativeValueBinding>();
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
                receiverMode,
                `${ownerType}.${methodName}`,
                signature,
                substitutions,
                0,
                0,
                "value",
                inout evidence
              );
              if (receiverMode == "move") {
                setValueBindingOwnership(
                  inout bindings,
                  receiverRoot,
                  NativeOwnershipState.moved
                );
              }
              return callType;
            }
          }
          none => {}
        }
        match (genericTypeShape(ownerType)) {
          some(mutex) => {
            if (mutex.base == "Mutex" && mutex.arguments.length == 1) {
              if (methodName != "withLock") {
                throw resolutionError(
                  ModuleResolveErrorKind.unknownMember,
                  module.path,
                  `Mutex has no method "${methodName}"`,
                  tree.nodes[calleeIndex].line,
                  tree.nodes[calleeIndex].column
                );
              }
              if (optionalMethodCall) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "optional call cannot invoke Mutex.withLock; unwrap the Mutex first",
                  tree.nodes[calleeIndex].line,
                  tree.nodes[calleeIndex].column
                );
              }
              const receiverRoot = expressionStorageRootName(
                tree,
                receiverIndex
              );
              if (receiverRoot.byteLength == 0) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "Mutex.withLock requires stable named storage",
                  tree.nodes[receiverIndex].line,
                  tree.nodes[receiverIndex].column
                );
              }
              const argumentNodes = callArgumentNodes(children);
              if (
                argumentNodes.length != 1
                || tree.nodes[argumentNodes[0]].kind
                  != ExpressionKind.closureExpression
              ) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "Mutex.withLock expects one inline closure",
                  node.line,
                  node.column
                );
              }
              const closureIndex = argumentNodes[0];
              let parameterNodes = Array<usize>();
              for (const child of tree.nodes[closureIndex].children) {
                if (
                  tree.nodes[child].kind
                    == ExpressionKind.closureParameterExpression
                ) parameterNodes.push(child);
              }
              if (parameterNodes.length != 1) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `Mutex.withLock expects one closure parameter, found ${parameterNodes.length}`,
                  tree.nodes[closureIndex].line,
                  tree.nodes[closureIndex].column
                );
              }
              const parameterIndex = parameterNodes[0];
              const mode = tree.nodes[parameterIndex].labels[0].copyBytes(
                0,
                tree.nodes[parameterIndex].labels[0].byteLength
              );
              if (mode != "in" && mode != "inout") {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "Mutex.withLock closure parameters require `in` or `inout`",
                  tree.nodes[parameterIndex].line,
                  tree.nodes[parameterIndex].column
                );
              }
              let returnType = "";
              let errorType = "";
              if (tree.nodes[closureIndex].labels.length > 0) {
                returnType = tree.nodes[closureIndex].labels[0].copyBytes(
                  0,
                  tree.nodes[closureIndex].labels[0].byteLength
                );
              }
              if (tree.nodes[closureIndex].labels.length > 1) {
                errorType = tree.nodes[closureIndex].labels[1].copyBytes(
                  0,
                  tree.nodes[closureIndex].labels[1].byteLength
                );
              }
              if (mutexResultBorrowsProtectedStorage(returnType)) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "a borrowed value cannot escape Mutex.withLock",
                  tree.nodes[closureIndex].line,
                  tree.nodes[closureIndex].column
                );
              }
              let parameterModes = Array<String>();
              parameterModes.push(mode);
              let parameterTypes = Array<String>();
              parameterTypes.push(mutex.arguments[0].copyBytes(
                0,
                mutex.arguments[0].byteLength
              ));
              const contextualReturnType = returnType.byteLength == 0
                ? "__z_native_infer_return"
                : returnType.copyBytes(0, returnType.byteLength);
              const contextualType = nativeClosureFunctionType(
                tree,
                closureIndex,
                parameterModes,
                parameterTypes,
                contextualReturnType,
                errorType,
                "",
                false,
                true
              );
              let withLockBindings = copyValueBindings(bindings);
              const inheritedExecutorContext = currentExecutorContext(
                bindings
              );
              addValueBinding(
                inout withLockBindings,
                "__z_native_closure_executor_context",
                inheritedExecutorContext
              );
              const closureType = try inferExpressionNodeTypeExpected(
                module,
                modules,
                moduleIndex,
                arena,
                tree,
                closureIndex,
                contextualType,
                inout withLockBindings,
                inout evidence
              );
              copyBindingFlowStates(inout bindings, withLockBindings);
              const closureSignature = match (
                nativeFunctionSignature(closureType)
              ) {
                some(signature) => signature;
                none => throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "Mutex.withLock could not resolve its closure signature",
                  tree.nodes[closureIndex].line,
                  tree.nodes[closureIndex].column
                );
              };
              returnType = closureSignature.returnType.copyBytes(
                0,
                closureSignature.returnType.byteLength
              );
              errorType = closureSignature.errorType.copyBytes(
                0,
                closureSignature.errorType.byteLength
              );
              if (mutexResultBorrowsProtectedStorage(returnType)) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "a borrowed value cannot escape Mutex.withLock",
                  tree.nodes[closureIndex].line,
                  tree.nodes[closureIndex].column
                );
              }
              recordExpressionResolution(
                modules,
                moduleIndex,
                tree,
                closureIndex,
                closureType,
                inout evidence
              );
              if (errorType.byteLength > 0) {
                return pendingThrowingCallType(returnType, errorType);
              }
              return returnType;
            }
          }
          none => {}
        }
        const readonlyOwnerType = transparentTypeName(modules, moduleIndex, ownerType);
        if (stringStartsWith(readonlyOwnerType, "readonly ")) {
          const mutableShape = readonlyOwnerType.copyBytes(9, readonlyOwnerType.byteLength);
          if (collectionHasLength(mutableShape)
            && (collectionMethodMutates(mutableShape, methodName) || methodName == "freeze")) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              `readonly collection has no mutating method "${methodName}"`,
              tree.nodes[calleeIndex].line,
              tree.nodes[calleeIndex].column
            );
          }
        }
        match (effectiveCollectionMethodSignature(
          modules,
          moduleIndex,
          ownerType,
          methodName
        )) {
          some(effectiveSignature) => {
            let receiverRoot = "";
            let receiverAccess = "";
            if (methodName == "freeze") {
              if (optionalMethodCall) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "optional call cannot consume a collection; use an explicit match",
                  tree.nodes[calleeIndex].line,
                  tree.nodes[calleeIndex].column
                );
              }
              receiverRoot = expressionStorageRootName(tree, receiverIndex);
              if (receiverRoot.byteLength == 0) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  "collection freeze requires named owned storage",
                  tree.nodes[receiverIndex].line,
                  tree.nodes[receiverIndex].column
                );
              }
              receiverAccess = "move";
            } else if (collectionMethodMutates(ownerType, methodName)) {
              if (optionalMethodCall) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `optional call cannot invoke mutating method "${methodName}"; use an explicit match`,
                  tree.nodes[calleeIndex].line,
                  tree.nodes[calleeIndex].column
                );
              }
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
              const liveView = liveViewBindingForOwner(
                bindings,
                receiverRoot
              );
              if (liveView.byteLength > 0) {
                throw resolutionError(
                  ModuleResolveErrorKind.typeMismatch,
                  module.path,
                  `cannot mutate "${receiverRoot}" while view "${liveView}" is live`,
                  tree.nodes[calleeIndex].line,
                  tree.nodes[calleeIndex].column
                );
              }
            }
            const substitutions = Array<NativeValueBinding>();
            const argumentNodes = callArgumentNodes(children);
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
              `${ownerType}.${methodName}`,
              effectiveSignature,
              substitutions,
              0,
              0,
              "value",
              inout evidence
            );
            if (receiverAccess == "move") {
              setValueBindingOwnership(
                inout bindings,
                receiverRoot,
                NativeOwnershipState.moved
              );
            }
            if (methodName == "push") {
              match (genericTypeShape(ownerType)) {
                some(array) => {
                  if (array.base == "Array" && array.arguments.length == 1) {
                    let storedViewVisiting = Array<String>();
                    if (typeContainsStoredView(
                      modules,
                      moduleIndex,
                      array.arguments[0],
                      storedViewVisiting
                    )) {
                      if (argumentNodes.length != 1) {
                        throw resolutionError(
                          ModuleResolveErrorKind.typeMismatch,
                          module.path,
                          "Array.push expects one view-bearing value",
                          tree.nodes[index].line,
                          tree.nodes[index].column
                        );
                      }
                      const argument = argumentNodes[0];
                      const elementOwner = storedViewOwnerForExpression(
                        bindings,
                        tree,
                        argument
                      );
                      if (elementOwner.byteLength == 0) {
                        throw resolutionError(
                          ModuleResolveErrorKind.typeMismatch,
                          module.path,
                          "a view-bearing Array element must come directly from one proven Arena",
                          tree.nodes[argument].line,
                          tree.nodes[argument].column
                        );
                      }
                      const arrayOwner = valueBindingViewOwner(
                        bindings,
                        receiverRoot
                      );
                      if (arrayOwner == "__z_native_mixed_view_owner") {
                        throw resolutionError(
                          ModuleResolveErrorKind.typeMismatch,
                          module.path,
                          `view-bearing Array "${receiverRoot}" must establish the same Arena provenance on every continuing path`,
                          tree.nodes[index].line,
                          tree.nodes[index].column
                        );
                      }
                      if (
                        arrayOwner.byteLength > 0
                        && mergeViewOwners(arrayOwner, elementOwner)
                          == "__z_native_mixed_view_owner"
                      ) {
                        throw resolutionError(
                          ModuleResolveErrorKind.typeMismatch,
                          module.path,
                          `Array "${receiverRoot}" already carries provenance from another Arena`,
                          tree.nodes[argument].line,
                          tree.nodes[argument].column
                        );
                      }
                      if (arrayOwner.byteLength == 0) {
                        const controlBinding = regionControlFlowBindingName();
                        const controlFlow = valueBindingType(
                          bindings,
                          controlBinding
                        );
                        if (controlFlow == "loop") {
                          throw resolutionError(
                            ModuleResolveErrorKind.typeMismatch,
                            module.path,
                            `the first push into view-bearing Array "${receiverRoot}" cannot occur in a loop`,
                            tree.nodes[index].line,
                            tree.nodes[index].column
                          );
                        }
                        setValueBindingViewOwner(
                          inout bindings,
                          receiverRoot,
                          elementOwner
                        );
                      } else {
                        const mergedOwner = mergeViewOwners(
                          arrayOwner,
                          elementOwner
                        );
                        if (mergedOwner != arrayOwner) setValueBindingViewOwner(
                          inout bindings,
                          receiverRoot,
                          mergedOwner
                        );
                      }
                      if (
                        tree.nodes[argument].kind
                        == ExpressionKind.identifierExpression
                      ) {
                        const argumentRoot = expressionStorageRootName(
                          tree,
                          argument
                        );
                        setValueBindingOwnership(
                          inout bindings,
                          argumentRoot,
                          NativeOwnershipState.moved
                        );
                      } else {
                        try consumeOwnedExpressionNode(
                          module,
                          modules,
                          moduleIndex,
                          tree,
                          argument,
                          array.arguments[0],
                          true,
                          inout bindings
                        );
                      }
                    }
                  }
                }
                none => {}
              }
            }
            match (genericTypeShape(ownerType)) {
              some(map) => {
                if (map.base == "Map" && map.arguments.length == 2) {
                  let storedViewVisiting = Array<String>();
                  const storedViewValue = typeContainsStoredView(
                    modules,
                    moduleIndex,
                    map.arguments[1],
                    storedViewVisiting
                  );
                  if (methodName == "get") {
                    const transparentValue = transparentTypeName(
                      modules,
                      moduleIndex,
                      map.arguments[1]
                    );
                    let returnsOwnedFunction = false;
                    match (nativeFunctionSignature(transparentValue)) {
                      some(_) => returnsOwnedFunction = true;
                      none => {}
                    }
                    if (!returnsOwnedFunction) {
                      const storageRoot = expressionStorageRootName(
                        tree,
                        receiverIndex
                      );
                      if (storageRoot.byteLength > 0) setExpressionViewOrigin(
                        inout bindings,
                        tree.nodes[index].offset,
                        storageRoot
                      );
                    }
                  }
                  if (storedViewValue && methodName == "set") {
                    if (argumentNodes.length != 2) {
                      throw resolutionError(
                        ModuleResolveErrorKind.typeMismatch,
                        module.path,
                        "Map.set expects a key and one view-bearing value",
                        tree.nodes[index].line,
                        tree.nodes[index].column
                      );
                    }
                    const argument = argumentNodes[1];
                    const valueOwner = storedViewOwnerForExpression(
                      bindings,
                      tree,
                      argument
                    );
                    if (
                      valueOwner.byteLength == 0
                      || valueOwner == "__z_native_mixed_view_owner"
                    ) {
                      throw resolutionError(
                        ModuleResolveErrorKind.typeMismatch,
                        module.path,
                        "a view-bearing Map value must come directly from one proven Arena",
                        tree.nodes[argument].line,
                        tree.nodes[argument].column
                      );
                    }
                    const mapOwner = valueBindingViewOwner(
                      bindings,
                      receiverRoot
                    );
                    if (mapOwner == "__z_native_mixed_view_owner") {
                      throw resolutionError(
                        ModuleResolveErrorKind.typeMismatch,
                        module.path,
                        `view-bearing Map "${receiverRoot}" must establish the same Arena provenance on every continuing path`,
                        tree.nodes[index].line,
                        tree.nodes[index].column
                      );
                    }
                    if (
                      mapOwner.byteLength > 0
                      && mergeViewOwners(mapOwner, valueOwner)
                        == "__z_native_mixed_view_owner"
                    ) {
                      throw resolutionError(
                        ModuleResolveErrorKind.typeMismatch,
                        module.path,
                        `Map "${receiverRoot}" already carries provenance from another Arena`,
                        tree.nodes[argument].line,
                        tree.nodes[argument].column
                      );
                    }
                    if (mapOwner.byteLength == 0) {
                      const controlBinding = regionControlFlowBindingName();
                      const controlFlow = valueBindingType(
                        bindings,
                        controlBinding
                      );
                      if (controlFlow == "loop") {
                        throw resolutionError(
                          ModuleResolveErrorKind.typeMismatch,
                          module.path,
                          `the first set into view-bearing Map "${receiverRoot}" cannot occur in a loop`,
                          tree.nodes[index].line,
                          tree.nodes[index].column
                        );
                      }
                      setValueBindingViewOwner(
                        inout bindings,
                        receiverRoot,
                        valueOwner
                      );
                    }
                    const argumentRoot = expressionStorageRootName(
                      tree,
                      argument
                    );
                    if (argumentRoot.byteLength > 0) {
                      setValueBindingOwnership(
                        inout bindings,
                        argumentRoot,
                        NativeOwnershipState.moved
                      );
                    } else {
                      try consumeOwnedExpressionNode(
                        module,
                        modules,
                        moduleIndex,
                        tree,
                        argument,
                        map.arguments[1],
                        true,
                        inout bindings
                      );
                    }
                  }
                  if (storedViewValue && methodName == "remove") {
                    const mapOwner = valueBindingViewOwner(
                      bindings,
                      receiverRoot
                    );
                    if (mapOwner.byteLength > 0) setExpressionViewOrigin(
                      inout bindings,
                      tree.nodes[index].offset,
                      mapOwner
                    );
                  }
                }
              }
              none => {}
            }
            match (genericTypeShape(ownerType)) {
              some(set) => {
                if (set.base == "Set" && set.arguments.length == 1) {
                  let storedViewVisiting = Array<String>();
                  const storedViewElement = typeContainsStoredView(
                    modules,
                    moduleIndex,
                    set.arguments[0],
                    storedViewVisiting
                  );
                  if (storedViewElement && methodName == "add") {
                    if (argumentNodes.length != 1) {
                      throw resolutionError(
                        ModuleResolveErrorKind.typeMismatch,
                        module.path,
                        "Set.add expects one view-bearing element",
                        tree.nodes[index].line,
                        tree.nodes[index].column
                      );
                    }
                    const argument = argumentNodes[0];
                    const elementOwner = storedViewOwnerForExpression(
                      bindings,
                      tree,
                      argument
                    );
                    if (
                      elementOwner.byteLength == 0
                      || elementOwner == "__z_native_mixed_view_owner"
                    ) {
                      throw resolutionError(
                        ModuleResolveErrorKind.typeMismatch,
                        module.path,
                        "a view-bearing Set element must come directly from one proven Arena",
                        tree.nodes[argument].line,
                        tree.nodes[argument].column
                      );
                    }
                    const setOwner = valueBindingViewOwner(
                      bindings,
                      receiverRoot
                    );
                    if (setOwner == "__z_native_mixed_view_owner") {
                      throw resolutionError(
                        ModuleResolveErrorKind.typeMismatch,
                        module.path,
                        `view-bearing Set "${receiverRoot}" must establish the same Arena provenance on every continuing path`,
                        tree.nodes[index].line,
                        tree.nodes[index].column
                      );
                    }
                    if (
                      setOwner.byteLength > 0
                      && mergeViewOwners(setOwner, elementOwner)
                        == "__z_native_mixed_view_owner"
                    ) {
                      throw resolutionError(
                        ModuleResolveErrorKind.typeMismatch,
                        module.path,
                        `Set "${receiverRoot}" already carries provenance from another Arena`,
                        tree.nodes[argument].line,
                        tree.nodes[argument].column
                      );
                    }
                    if (setOwner.byteLength == 0) {
                      const controlBinding = regionControlFlowBindingName();
                      const controlFlow = valueBindingType(
                        bindings,
                        controlBinding
                      );
                      if (controlFlow == "loop") {
                        throw resolutionError(
                          ModuleResolveErrorKind.typeMismatch,
                          module.path,
                          `the first add into view-bearing Set "${receiverRoot}" cannot occur in a loop`,
                          tree.nodes[index].line,
                          tree.nodes[index].column
                        );
                      }
                      setValueBindingViewOwner(
                        inout bindings,
                        receiverRoot,
                        elementOwner
                      );
                    }
                    const argumentRoot = expressionStorageRootName(
                      tree,
                      argument
                    );
                    if (argumentRoot.byteLength > 0) {
                      setValueBindingOwnership(
                        inout bindings,
                        argumentRoot,
                        NativeOwnershipState.moved
                      );
                    } else {
                      try consumeOwnedExpressionNode(
                        module,
                        modules,
                        moduleIndex,
                        tree,
                        argument,
                        set.arguments[0],
                        true,
                        inout bindings
                      );
                    }
                  }
                  if (storedViewElement && methodName == "remove") {
                    const setOwner = valueBindingViewOwner(
                      bindings,
                      receiverRoot
                    );
                    if (setOwner.byteLength > 0) setExpressionViewOrigin(
                      inout bindings,
                      tree.nodes[index].offset,
                      setOwner
                    );
                  }
                }
              }
              none => {}
            }
            if (optionalMethodCall) {
              return try optionalCallType(
                module,
                tree,
                calleeIndex,
                callType
              );
            }
            return callType;
          }
          none => {}
        }
        if (!staticMethod) {
          match (aggregateFieldShape(
            modules,
            moduleIndex,
            ownerType,
            methodName
          )) {
            some(field) => {
              try requireVisibleField(
                module,
                modules,
                moduleIndex,
                tree,
                calleeIndex,
                bindings,
                field
              );
              const callableFieldType = transparentTypeName(
                modules,
                moduleIndex,
                field.typeName
              );
              match (nativeFunctionSignature(callableFieldType)) {
                some(signature) => {
                  const substitutions = Array<NativeValueBinding>();
                  const argumentNodes = callArgumentNodes(children);
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
                    "",
                    "",
                    `${ownerType}.${methodName}`,
                    signature,
                    substitutions,
                    field.ownerModuleIndex,
                    field.ownerSymbolIndex,
                    "value",
                    inout evidence
                  );
                  if (optionalMethodCall) {
                    return try optionalCallType(
                      module,
                      tree,
                      calleeIndex,
                      callType
                    );
                  }
                  return callType;
                }
                none => {}
              }
            }
            none => {}
          }
        }
        match (callableMethodCallShape(
          modules,
          moduleIndex,
          bindings,
          ownerType,
          methodName,
          staticMethod,
          children.length - 1,
          tree.nodes[index].labels
        )) {
          some(method) => {
            const selector = view method.objectiveCSelector;
            if (nativeInitializerSelector(selector)
              || selector == "alloc" || selector == "allocWithZone:" || selector == "new"
              || selector == "dealloc" || selector == "retain" || selector == "release"
              || selector == "autorelease" || selector == "retainCount") {
              const subclassBase = nativeObjCSubclassBase(modules, moduleIndex, ownerType);
              if (subclassBase.byteLength > 0) {
                throw codedModuleResolutionError(ModuleResolveErrorKind.typeMismatch, "Z0814", module.path,
                  "native subclass lifecycle operations must use `new` and the checked constructor, not an inherited lifecycle method",
                  tree.nodes[index].line, tree.nodes[index].column, 1);
              }
            }
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
              method.visibility == "internal"
              && (
                (
                  tree.nodes[calleeIndex].syntheticPackageIdentity.byteLength > 0
                  && tree.nodes[calleeIndex].syntheticPackageIdentity
                    != modules[method.ownerModuleIndex].packageIdentity
                )
                || (
                  tree.nodes[calleeIndex].syntheticPackageIdentity.byteLength == 0
                  && (
                    modules[moduleIndex].packageIdentity.byteLength == 0
                    || modules[moduleIndex].packageIdentity
                      != modules[method.ownerModuleIndex].packageIdentity
                  )
                )
              )
            ) {
              throw resolutionError(
                ModuleResolveErrorKind.unknownMember,
                module.path,
                `method "${method.name}" is internal to its package`,
                tree.nodes[calleeIndex].line,
                tree.nodes[calleeIndex].column
              );
            }
            if (
              !method.staticMethod
              && method.ownerTypeParameters.length != method.ownerTypeArguments.length
            ) return "";
            if (
              optionalMethodCall
              && (
                method.receiverMode == "inout"
                || method.receiverMode == "move"
              )
            ) {
              throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `optional call cannot invoke ${method.receiverMode} receiver method "${method.name}"; use an explicit match`,
                tree.nodes[calleeIndex].line,
                tree.nodes[calleeIndex].column
              );
            }
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
              const capturedClassMutationName = closureCaptureClassMutationBindingName(
                receiverRoot
              );
              const capturedClassMutation = valueBindingType(
                bindings,
                capturedClassMutationName
              );
              if (
                (
                  ownerKind == ModuleSymbolKind.structSymbol
                  && !valueBindingIsMutable(bindings, receiverRoot)
                )
                || (
                  ownerKind == ModuleSymbolKind.classSymbol
                  && valueBindingIsBorrowed(bindings, receiverRoot)
                  && !valueBindingIsMutable(bindings, receiverRoot)
                  && capturedClassMutation != "true"
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
            let requiredAffinity = method.signature.executorAffinity.copyBytes(
              0,
              method.signature.executorAffinity.byteLength
            );
            if (requiredAffinity.byteLength == 0) {
              requiredAffinity = aggregateExecutorAffinity(
                modules,
                method.ownerModuleIndex,
                method.ownerSymbolIndex
              );
            }
            try requireMainExecutorContext(
              module,
              tree,
              index,
              bindings,
              requiredAffinity,
              `method "${method.ownerName}.${method.name}"`
            );
            const callableSignature = methodCallableSignature(method);
            const argumentNodes = callArgumentNodes(children);
            let callKind = staticMethod ? "staticMethod" : "method";
            const nativeBase = valueBindingType(bindings, "__z_native_objc_subclass_base");
            if (!staticMethod && nativeBase.byteLength > 0
              && tree.nodes[receiverIndex].kind == ExpressionKind.identifierExpression
              && tree.nodes[receiverIndex].value == "super") {
              const initializerOffset = valueBindingType(bindings, "__z_native_objc_initializer_offset");
              callKind = initializerOffset == `${tree.nodes[index].offset}`
                ? "objcSuperInitializer" : "objcSuper";
            }
            if (nativeBase.byteLength > 0 && method.objectiveCSelector.byteLength > 0) {
              try requireNativeReferenceAvailability(module, modules, moduleIndex, ownerType, tree.nodes[index].line, tree.nodes[index].column);
              try requireNativeAvailability(module, method.objectiveCAvailability, method.objectiveCSelector, tree.nodes[index].line, tree.nodes[index].column);
              if ((method.objectiveCConsumesSelf && callKind != "objcSuperInitializer")
                || method.objectiveCConsumedParameters.length > 0) {
                throw codedModuleResolutionError(ModuleResolveErrorKind.typeMismatch, "Z0814", module.path,
                  "consuming Objective-C calls inside native subclass bodies require a later ownership tier",
                  tree.nodes[index].line, tree.nodes[index].column, 1);
              }
              if (method.objectiveCVariadic || method.signature.asynchronous) {
                throw codedModuleResolutionError(ModuleResolveErrorKind.typeMismatch, "Z0814", module.path,
                  "native subclass bodies require synchronous, non-variadic Objective-C calls",
                  tree.nodes[index].line, tree.nodes[index].column, 1);
              }
            }
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
            try requireResolvedObjCAdapterProtocols(
              module,
              modules,
              moduleIndex,
              tree,
              argumentNodes,
              method,
              evidence
            );
            if (method.objectiveCSelector.byteLength > 0) {
              recordResolvedObjCCallFacts(
                modules,
                tree,
                index,
                method,
                inout evidence
              );
            }
            if (
              !method.staticMethod
              && typeIsRetainedParameterViewAggregate(
                modules,
                moduleIndex,
                callType
              )
            ) {
              const borrowedReceiver = expressionStorageRootName(
                tree,
                receiverIndex
              );
              if (borrowedReceiver.byteLength == 0) throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `retained view result from ${method.ownerName}.${method.name} requires a named owner binding`,
                tree.nodes[receiverIndex].line,
                tree.nodes[receiverIndex].column
              );
              let resultOwner = valueBindingViewOwner(
                bindings,
                borrowedReceiver
              );
              if (resultOwner.byteLength == 0) {
                resultOwner = borrowedReceiver.copyBytes(
                  0,
                  borrowedReceiver.byteLength
                );
              }
              setExpressionViewOrigin(
                inout bindings,
                tree.nodes[index].offset,
                resultOwner
              );
            }
            if (receiverAccess == "move" && receiverRoot.byteLength > 0) {
              setValueBindingOwnership(
                inout bindings,
                receiverRoot,
                NativeOwnershipState.moved
              );
            }
            if (optionalMethodCall) {
              return try optionalCallType(
                module,
                tree,
                calleeIndex,
                callType
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
      recordExpressionResolution(
        modules,
        moduleIndex,
        tree,
        root,
        inferred,
        inout evidence
      );
      const viewOwner = expressionViewOrigin(
        expressionBindings,
        tree.nodes[root].offset
      );
      copyBindingFlowStates(inout bindings, expressionBindings);
      if (
        expectedType == "String"
        && isNativeObjectiveCStringType(modules, moduleIndex, inferred)
      ) markObjectiveCStringCopy(inout bindings, tree.nodes[root].offset);
      if (viewOwner.byteLength > 0) {
        setExpressionViewOrigin(
          inout bindings,
          tree.nodes[root].offset,
          viewOwner
        );
      }
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
    if (
      contextualExpected == "String"
      && qualifiedTypeMember(inferred) == "NSString"
    ) inferred = "String";
    let stored = inferred.copyBytes(0, inferred.byteLength);
    let viewOwner = "";
    let viewPath = "";
    let directArenaView = false;
    match (in arena.nodes[index].expression) {
      some(expression) => match (in expression.tree) {
        some(tree) => {
          viewOwner = expressionViewOrigin(
            bindings,
            tree.nodes[tree.root].offset
          );
          if (
            viewOwner.byteLength > 0
            && tree.nodes[tree.root].kind == ExpressionKind.unaryExpression
            && tree.nodes[tree.root].value == "view"
            && tree.nodes[tree.root].children.length == 1
          ) {
            const operand = tree.nodes[tree.root].children[0];
            const operandRoot = expressionStorageRootName(tree, operand);
            const inheritedOwner = valueBindingViewOwner(
              bindings,
              operandRoot
            );
            if (inheritedOwner.byteLength > 0) {
              viewPath = valueBindingViewPath(bindings, operandRoot);
            } else {
              const candidatePath = expressionDirectFieldPath(tree, operand);
              if (candidatePath != viewOwner) {
                viewPath = move candidatePath;
              }
            }
          }
          if (
            viewOwner.byteLength > 0
            && tree.nodes[tree.root].kind == ExpressionKind.callExpression
            && tree.nodes[tree.root].children.length > 0
          ) {
            const callee = tree.nodes[tree.root].children[0];
            directArenaView = tree.nodes[callee].kind
              == ExpressionKind.memberExpression
              && tree.nodes[callee].value == "create";
          }
          let storedViewVisiting = Array<String>();
          if (
            viewOwner.byteLength == 0
            && typeContainsStoredView(
              modules,
              moduleIndex,
              inferred,
              storedViewVisiting
            )
          ) {
            const expressionRoot = tree.root;
            const sourceRoot = expressionStorageRootName(
              tree,
              expressionRoot
            );
            const sourceViewOwner = valueBindingViewOwner(
              bindings,
              sourceRoot
            );
            if (
              sourceRoot.byteLength > 0
              && sourceViewOwner.byteLength > 0
            ) {
              throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `view-bearing value "${sourceRoot}" cannot be copied; store it directly in its owner Arena`,
                tree.nodes[tree.root].line,
                tree.nodes[tree.root].column
              );
            }
          }
        }
        none => {}
      }
      none => {}
    }
    if (
      directArenaView
      && !stringStartsWith(stored, "view ")
    ) stored = `view ${stored}`;
    const borrowedForeignResource = typeIsBorrowedForeignResource(
      modules,
      moduleIndex,
      inferred
    );
    let storedViewContainer = false;
    let storedViewContainerKind = "collection";
    match (genericTypeShape(inferred)) {
      some(container) => {
        if (container.base == "Array" && container.arguments.length == 1) {
          let visiting = Array<String>();
          storedViewContainer = typeContainsStoredView(
            modules,
            moduleIndex,
            container.arguments[0],
            visiting
          );
          storedViewContainerKind = "Array";
        } else if (container.base == "Map" && container.arguments.length == 2) {
          let visiting = Array<String>();
          storedViewContainer = typeContainsStoredView(
            modules,
            moduleIndex,
            container.arguments[1],
            visiting
          );
          storedViewContainerKind = "Map";
        } else if (container.base == "Set" && container.arguments.length == 1) {
          let visiting = Array<String>();
          storedViewContainer = typeContainsStoredView(
            modules,
            moduleIndex,
            container.arguments[0],
            visiting
          );
          storedViewContainerKind = "Set";
        }
      }
      none => {}
    }
    if (
      storedViewContainer
      && viewOwner.byteLength == 0
      && !arena.nodes[index].mutableBinding
    ) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `an empty view-bearing ${storedViewContainerKind} must use let so its first insertion can establish Arena provenance`,
        arena.nodes[index].line,
        arena.nodes[index].column
      );
    }
    if (
      (borrowedForeignResource || viewOwner.byteLength > 0)
      && (
        arena.nodes[index].mutableBinding
        || (borrowedForeignResource && contextualExpected.byteLength > 0)
      )
    ) {
      throw resolutionError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "a borrowed native resource must be bound directly to an inferred const local",
        arena.nodes[index].line,
        arena.nodes[index].column
      );
    }
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
              const bindingOffset = arena.nodes[index].nameOffset;
              const bindingLine = arena.nodes[index].nameLine;
              const bindingColumn = arena.nodes[index].nameColumn;
              const bindingName = arena.nodes[index].name.copyBytes(
                0,
                arena.nodes[index].name.byteLength
              );
              const mutableBinding = arena.nodes[index].mutableBinding;
              recordBindingResolution(
                modules,
                moduleIndex,
                bindingOffset,
                bindingLine,
                bindingColumn,
                bindingName,
                mutableBinding,
                stored,
                inout evidence
              );
            }
          }
          none => {}
        }
      }
    }
    match (in arena.nodes[index].expression) {
      some(expression) => {
        // A directly inferred lexical closure is not an owning function value.
        // Keep its environment provenance until a later storage/call boundary.
        let lexicalClosure = false;
        match (in arena.nodes[index].typeAnnotation) {
          none => match (in expression.tree) {
            some(tree) => lexicalClosure = tree.nodes[tree.root].kind == ExpressionKind.closureExpression;
            none => {}
          }
          some(type) => {}
        }
        if (inferred.byteLength > 0 && !lexicalClosure) {
          try consumeOwnedExpressionSyntax(
            module,
            modules,
            moduleIndex,
            expression,
            stored,
            inout bindings
          );
        }
      }
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
    } else if (viewOwner.byteLength > 0) {
      addViewValueBinding(
        inout bindings,
        arena.nodes[index].name,
        stored,
        viewOwner,
        viewPath
      );
    } else if (borrowedForeignResource) {
      addBorrowedValueBinding(
        inout bindings,
        arena.nodes[index].name,
        stored,
        false
      );
    } else {
      addValueBinding(inout bindings, arena.nodes[index].name, stored);
    }
    if (typeIsClassReference(module, modules, moduleIndex, stored)) {
      match (in arena.nodes[index].expression) {
        some(expression) => {
          const identity = expressionClassAliasIdentity(
            expression,
            bindings,
            modules,
            moduleIndex
          );
          setValueBindingClassAlias(
            inout bindings,
            arena.nodes[index].name,
            identity
          );
          setValueBindingClassAliasContained(
            inout bindings,
            arena.nodes[index].name,
            expressionClassAliasIsContained(
              expression,
              bindings,
              modules,
              moduleIndex,
              stored
            )
          );
        }
        none => {}
      }
    }
    match (in arena.nodes[index].expression) {
      some(expression) => recordAggregateClassAliasFields(
        module,
        expression,
        arena.nodes[index].name,
        stored,
        modules,
        moduleIndex,
        inout bindings
      );
      none => {}
    }
    return true;
  }
  if (kind == StatementKind.destructureStatement) {
    let inferred = "";
    let sourceType = "";
    let retainedViewOwner = "";
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
        if (typeIsRetainedParameterViewAggregate(
          modules,
          moduleIndex,
          sourceType
        )) {
          if (arena.nodes[index].mutableBinding) throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "retained view aggregate destructuring requires immutable const bindings",
            arena.nodes[index].line,
            arena.nodes[index].column
          );
          match (in expression.tree) {
            some(tree) => {
              const root = tree.root;
              retainedViewOwner = storedViewOwnerForExpression(
                bindings,
                tree,
                root
              );
              if (
                retainedViewOwner.byteLength == 0
                || viewOwnerIsOwnerless(retainedViewOwner)
                || retainedViewOwner == "__z_native_mixed_view_owner"
              ) throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                "retained view aggregate destructuring requires one proven owner",
                tree.nodes[root].line,
                tree.nodes[root].column
              );
            }
            none => {}
          }
        }
        if (arena.nodes[index].arrayBindings.length == 0) {
          try requireObjectDestructureCleanup(
            module, modules, moduleIndex, sourceType,
            arena.nodes[index].line, arena.nodes[index].column
          );
          try consumeOwnedExpressionSyntax(
            module,
            modules,
            moduleIndex,
            expression,
            sourceType,
            inout bindings
          );
        }
      }
      none => {}
    }
    if (arena.nodes[index].arrayBindings.length > 0) {
      let viewed = false;
      let viewOwner = "";
      if (stringStartsWith(sourceType, "view ") && sourceType.byteLength > 5) {
        viewed = true;
        sourceType = sourceType.copyBytes(5, sourceType.byteLength);
        match (in arena.nodes[index].expression) {
          some(expression) => match (in expression.tree) {
            some(tree) => {
              const root = tree.root;
              if (
                tree.nodes[root].kind == ExpressionKind.unaryExpression
                && tree.nodes[root].value == "view"
                && tree.nodes[root].children.length == 1
              ) {
                const operand = tree.nodes[root].children[0];
                viewOwner = expressionStorageRootName(tree, operand);
              }
            }
            none => {}
          }
          none => {}
        }
        if (viewOwner.byteLength == 0) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "array view destructuring requires named stable storage",
            arena.nodes[index].line,
            arena.nodes[index].column
          );
        }
      }
      const elementType = iterationElementType(sourceType);
      if (elementType.byteLength == 0) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `array destructuring requires contiguous collection storage, found ${sourceType}`,
          arena.nodes[index].line,
          arena.nodes[index].column
        );
      }
      let visiting = Array<String>();
      const elementNeedsCleanup = typeHasCleanup(
        modules,
        moduleIndex,
        elementType,
        visiting
      );
      let referenceIdentity = false;
      match (typeSymbolLocation(modules, moduleIndex, elementType)) {
        some(location) => referenceIdentity = modules[location.moduleIndex]
          .symbols[location.symbolIndex].kind == ModuleSymbolKind.classSymbol;
        none => {}
      }
      for (const binding of arena.nodes[index].arrayBindings) {
        if (binding.kind == ArrayBindingKind.discard) continue;
        if (binding.kind == ArrayBindingKind.rest && !viewed) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "array rest is a borrowed Slice and requires an explicit view source",
            binding.line,
            binding.column
          );
        }
        if (
          binding.kind == ArrayBindingKind.binding
          && elementNeedsCleanup
          && !viewed
        ) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `destructuring ownership-bearing ${elementType} elements requires an explicit view`,
            binding.line,
            binding.column
          );
        }
        let bindingType = elementType.copyBytes(0, elementType.byteLength);
        let borrowed = false;
        if (binding.kind == ArrayBindingKind.rest) {
          bindingType = `Slice<${elementType}>`;
          borrowed = true;
        } else if (viewed && elementNeedsCleanup) {
          borrowed = true;
          if (!referenceIdentity) bindingType = `view ${elementType}`;
        }
        const bindingName = binding.bindingName.copyBytes(
          0,
          binding.bindingName.byteLength
        );
        recordBindingResolution(
          modules,
          moduleIndex,
          binding.bindingOffset,
          binding.bindingLine,
          binding.bindingColumn,
          bindingName,
          false,
          bindingType,
          inout evidence
        );
        if (borrowed) {
          addViewValueBinding(
            inout bindings,
            bindingName,
            bindingType,
            viewOwner,
            ""
          );
        } else {
          addValueBinding(inout bindings, bindingName, bindingType);
        }
      }
      return true;
    }
    for (const binding of arena.nodes[index].objectBindings) {
      let fieldType = "";
      match (aggregateFieldShape(modules, moduleIndex, sourceType, binding.fieldName)) {
        some(field) => fieldType = field.typeName.copyBytes(0, field.typeName.byteLength);
        none => {}
      }
      const bindingOffset = binding.bindingOffset;
      const bindingLine = binding.bindingLine;
      const bindingColumn = binding.bindingColumn;
      const bindingName = binding.bindingName.copyBytes(
        0,
        binding.bindingName.byteLength
      );
      const mutableBinding = arena.nodes[index].mutableBinding;
      recordBindingResolution(
        modules,
        moduleIndex,
        bindingOffset,
        bindingLine,
        bindingColumn,
        bindingName,
        mutableBinding,
        fieldType,
        inout evidence
      );
      if (
        retainedViewOwner.byteLength > 0
        && stringStartsWith(fieldType, "view ")
      ) {
        addViewValueBinding(
          inout bindings,
          bindingName,
          fieldType,
          retainedViewOwner,
          ""
        );
      } else if (mutableBinding) {
        addMutableValueBinding(inout bindings, bindingName, fieldType);
      } else {
        addValueBinding(inout bindings, bindingName, fieldType);
      }
    }
    return true;
  }
  if (kind == StatementKind.assignmentStatement) {
    let expected = "";
    let assignmentBinding = "";
    let assignmentFieldOwner = "";
    let assignmentFieldName = "";
    let assignmentObjectiveCProperty = false;
    match (in arena.nodes[index].expression) {
      some(target) => {
        match (in target.tree) {
          some(tree) => {
            const root = tree.root;
            const mutationRoot = expressionStorageRootName(tree, root);
            const mutationPath = expressionDirectFieldPath(tree, root);
            if (mutationRoot.byteLength > 0) {
              const mutationType = mutationRoot == "this" ? valueBindingType(bindings, mutationRoot) : "";
              const nativeBase = mutationType.byteLength > 0 ? nativeObjCSubclassBase(modules, moduleIndex, mutationType) : "";
              if (nativeBase.byteLength > 0) {
                let member = root;
                while (tree.nodes[member].kind == ExpressionKind.memberExpression && tree.nodes[member].children.length == 1
                  && tree.nodes[tree.nodes[member].children[0]].kind == ExpressionKind.memberExpression) {
                  member = tree.nodes[member].children[0];
                }
                if (tree.nodes[member].kind == ExpressionKind.memberExpression) {
                  match (aggregateFieldShape(modules, moduleIndex, mutationType, tree.nodes[member].value)) {
                    some(field) => {
                      if (field.nativeSubclassStorage && !valueBindingIsMutable(bindings, mutationRoot)) {
                        throw resolutionError(ModuleResolveErrorKind.typeMismatch, module.path,
                          "native stored field mutation requires inout this", tree.nodes[root].line, tree.nodes[root].column);
                      }
                    }
                    none => {}
                  }
                }
              }
              markClosureCaptureMutation(inout bindings, mutationRoot);
              const liveView = liveViewBindingForStoragePath(
                bindings,
                mutationRoot,
                mutationPath
              );
              if (liveView.byteLength > 0) throw resolutionError(
                ModuleResolveErrorKind.typeMismatch,
                module.path,
                `cannot mutate "${mutationPath}" while view "${liveView}" is live`,
                tree.nodes[root].line,
                tree.nodes[root].column
              );
            }
            if (tree.nodes[root].kind == ExpressionKind.identifierExpression) {
              assignmentBinding = tree.nodes[root].value.copyBytes(
                0,
                tree.nodes[root].value.byteLength
              );
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
              assignmentObjectiveCProperty = isNativeObjectiveCObjectType(
                modules,
                moduleIndex,
                receiverType
              );
              const memberName = identifierLookupName(tree.nodes[root].value);
              if (tree.nodes[receiverIndex].kind == ExpressionKind.identifierExpression) {
                assignmentFieldOwner = identifierLookupName(
                  tree.nodes[receiverIndex].value
                );
                assignmentFieldName = memberName.copyBytes(
                  0,
                  memberName.byteLength
                );
              }
              match (aggregateFieldShape(modules, moduleIndex, receiverType, memberName)) {
                some(field) => {
                  if (field.nativeSubclassStorage) assignmentObjectiveCProperty = false;
                  const nativeSubclassContext = valueBindingType(bindings, "__z_native_objc_subclass_base");
                  if (nativeSubclassContext.byteLength > 0) {
                    try requireNativeReferenceAvailability(module, modules, moduleIndex, receiverType, arena.nodes[index].line, arena.nodes[index].column);
                    try requireNativeAvailability(module, field.objectiveCAvailability, field.name, arena.nodes[index].line, arena.nodes[index].column);
                  }
                  if (
                    field.objectiveCGetter.byteLength > 0
                    || field.objectiveCSetter.byteLength > 0
                  ) {
                    assignmentObjectiveCProperty = true;
                  }
                  match (in modules[field.ownerModuleIndex].symbols[
                    field.ownerSymbolIndex
                  ].typeSignature) {
                    some(signature) => {
                      if (signature.foreignKind == "objcInterface") {
                        assignmentObjectiveCProperty = true;
                      }
                    }
                    none => {}
                  }
                  const constructorType = valueBindingType(
                    bindings,
                    "__z_native_constructor_type"
                  );
                  const initializesThis = tree.nodes[receiverIndex].kind
                    == ExpressionKind.identifierExpression
                    && tree.nodes[receiverIndex].value == "this";
                  let nativeFieldInitialization = false;
                  if (field.nativeSubclassStorage && field.readonlyField) {
                    const initializationKey = `__z_native_field_init_${arena.nodes[index].offset}`;
                    nativeFieldInitialization = valueBindingType(bindings, initializationKey) == "true";
                  }
                  if (
                    field.readonlyField
                    && (field.nativeSubclassStorage
                      ? !nativeFieldInitialization
                      : (constructorType.byteLength == 0 || !initializesThis))
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
        if (
          assignmentBinding.byteLength == 0
          && typeIsClassReference(
            module,
            modules,
            moduleIndex,
            consumedType
          )
        ) {
          match (in value.tree) {
            some(valueTree) => {
              const valueRoot = valueTree.root;
              try invalidateLocallyContainedClassNode(
                module,
                valueTree,
                valueRoot,
                inout bindings
              );
            }
            none => {}
          }
        }
        // When native resolution cannot classify a foreign destination, Stage
        // 0 remains authoritative for its setter and ownership semantics. Do
        // not invent an owned transfer solely from the right-hand side.
        if (
          expected.byteLength > 0
          && !assignmentObjectiveCProperty
        ) {
          try consumeOwnedExpressionSyntax(
            module,
            modules,
            moduleIndex,
            value,
            consumedType,
            inout bindings
          );
        }
        if (
          assignmentBinding.byteLength > 0
          && typeIsClassReference(module, modules, moduleIndex, consumedType)
        ) {
          const identity = expressionClassAliasIdentity(
            value,
            bindings,
            modules,
            moduleIndex
          );
          setValueBindingClassAlias(
            inout bindings,
            assignmentBinding,
            identity
          );
          setValueBindingClassAliasContained(
            inout bindings,
            assignmentBinding,
            expressionClassAliasIsContained(
              value,
              bindings,
              modules,
              moduleIndex,
              consumedType
            )
          );
        }
        if (assignmentBinding.byteLength > 0) {
          recordAggregateClassAliasFields(
            module,
            value,
            assignmentBinding,
            consumedType,
            modules,
            moduleIndex,
            inout bindings
          );
        } else if (
          assignmentFieldOwner.byteLength > 0
          && typeIsClassReference(
            module,
            modules,
            moduleIndex,
            consumedType
          )
        ) {
          setAggregateClassAliasField(
            inout bindings,
            assignmentFieldOwner,
            assignmentFieldName,
            consumedType,
            expressionClassAliasIdentity(
              value,
              bindings,
              modules,
              moduleIndex
            )
          );
        }
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
          kind == StatementKind.returnStatement
          && typeIsRetainedParameterViewAggregate(
            modules,
            moduleIndex,
            contextualExpected
          )
        ) try validateRetainedParameterViewAggregateReturn(
          module,
          modules,
          moduleIndex,
          expression,
          contextualExpected,
          bindings
        );
        if (
          kind == StatementKind.returnStatement
          && typeIsBorrowedForeignResource(modules, moduleIndex, actual)
        ) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "a borrowed native resource cannot be returned from Z code",
            arena.nodes[index].line,
            arena.nodes[index].column
          );
        }
        if (
          (kind == StatementKind.returnStatement && expectedReturn.byteLength > 0)
          || (kind == StatementKind.selectStatement && contextualExpected.byteLength > 0)
        ) {
          let acceptsBorrowedView = false;
          let returningView = false;
          if (
            kind == StatementKind.returnStatement
            && stringStartsWith(contextualExpected, "view ")
          ) {
            const target = contextualExpected.copyBytes(
              5,
              contextualExpected.byteLength
            );
            let actualTarget = actual.copyBytes(0, actual.byteLength);
            if (stringStartsWith(actualTarget, "view ")) {
              actualTarget = actualTarget.copyBytes(5, actualTarget.byteLength);
            }
            if (equivalentTypes(modules, moduleIndex, target, actualTarget)) {
              returningView = true;
              match (in expression.tree) {
                some(tree) => {
                  const root = tree.root;
                  const expressionKind = tree.nodes[root].kind;
                  const owner = expressionStorageRootName(tree, root);
                  const callOwner = expressionViewOrigin(
                    bindings,
                    tree.nodes[root].offset
                  );
                  const ownerViewOwner = valueBindingViewOwner(
                    bindings,
                    owner
                  );
                  const callOwnerViewOwner = valueBindingViewOwner(
                    bindings,
                    callOwner
                  );
                  if (
                    (
                      expressionKind == ExpressionKind.identifierExpression
                      || expressionKind == ExpressionKind.memberExpression
                      || expressionKind == ExpressionKind.indexExpression
                    )
                    && valueBindingIsBorrowed(bindings, owner)
                    && !valueBindingIsMutable(bindings, owner)
                    && !valueBindingIsMatchBorrowed(bindings, owner)
                    && ownerViewOwner.byteLength == 0
                  ) acceptsBorrowedView = true;
                  else if (
                    callOwner.byteLength > 0
                    && valueBindingIsBorrowed(bindings, callOwner)
                    && !valueBindingIsMutable(bindings, callOwner)
                    && !valueBindingIsMatchBorrowed(bindings, callOwner)
                    && callOwnerViewOwner.byteLength == 0
                  ) acceptsBorrowedView = true;
                }
                none => {}
              }
            }
          }
          if (returningView && !acceptsBorrowedView) {
            throw resolutionError(
              ModuleResolveErrorKind.typeMismatch,
              module.path,
              "a parameter-provenanced view must return an immutable input, one of its fields, or one of its indexed elements",
              arena.nodes[index].line,
              arena.nodes[index].column
            );
          }
          if (!acceptsBorrowedView) {
            try requireExpressionSyntaxType(
              module,
              modules,
              moduleIndex,
              expression,
              contextualExpected,
              actual
            );
          }
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
    markRegionControlFlow(inout thenBindings, "branch");
    markRegionControlFlow(inout elseBindings, "branch");
    match (in arena.nodes[index].expression) {
      some(condition) => match (in condition.tree) {
        some(tree) => {
          const root = tree.root;
          applyNullConditionNarrowing(
            tree,
            root,
            true,
            inout thenBindings
          );
          applyNullConditionNarrowing(
            tree,
            root,
            false,
            inout elseBindings
          );
          if (
            tree.nodes[root].kind == ExpressionKind.binaryExpression
            && tree.nodes[root].children.length == 2
            && tree.nodes[root].value == "instanceof"
          ) {
            const left = tree.nodes[root].children[0];
            const right = tree.nodes[root].children[1];
            if (tree.nodes[left].kind == ExpressionKind.identifierExpression) {
              const targetName = typeExpressionName(tree, right);
              if (targetName.byteLength > 0) {
                const bindingName = identifierLookupName(
                  tree.nodes[left].value
                );
                setValueBindingType(
                  inout thenBindings,
                  bindingName,
                  targetName
                );
              }
            }
          }
        }
        none => {}
      }
      none => {}
    }
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
    if (thenContinues || elseContinues) {
      try requireSettledRegionProvenance(
        module,
        bindings,
        arena.nodes[index].line,
        arena.nodes[index].column
      );
    }
    return thenContinues || elseContinues;
  }
  if (kind == StatementKind.whileStatement) {
    const beforeLoop = copyValueBindings(bindings);
    let loopBindings = copyValueBindings(bindings);
    markRegionControlFlow(inout loopBindings, "loop");
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
    markRegionControlFlow(inout loopBindings, "loop");
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
      if (elementType.byteLength > 0) {
        const bindingName = arena.nodes[index].name.copyBytes(
          0,
          arena.nodes[index].name.byteLength
        );
        const bindingOffset = arena.nodes[index].nameOffset;
        const bindingLine = arena.nodes[index].nameLine;
        const bindingColumn = arena.nodes[index].nameColumn;
        recordBindingResolution(
          modules,
          moduleIndex,
          bindingOffset,
          bindingLine,
          bindingColumn,
          bindingName,
          false,
          elementType,
          inout evidence
        );
      }
    }
    for (const binding of arena.nodes[index].objectBindings) {
      const fieldType = iterationObjectFieldType(
        modules,
        moduleIndex,
        iterableType,
        binding.fieldName
      );
      addValueBinding(inout loopBindings, binding.bindingName, fieldType);
      if (fieldType.byteLength > 0) {
        const bindingName = binding.bindingName.copyBytes(
          0,
          binding.bindingName.byteLength
        );
        recordBindingResolution(
          modules,
          moduleIndex,
          binding.bindingOffset,
          binding.bindingLine,
          binding.bindingColumn,
          bindingName,
          false,
          fieldType,
          inout evidence
        );
      }
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
    const asyncContext = valueBindingType(bindings, "__z_native_async_context");
    if (asyncContext.byteLength == 0) {
      throw codedModuleResolutionError(ModuleResolveErrorKind.typeMismatch, "Z0703", module.path,
        "async scope requires an enclosing async function",
        arena.nodes[index].line, arena.nodes[index].column, 1);
    }
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

function expressionUsesBinding(
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize,
  in name: String
): boolean {
  if (
    (
      tree.nodes[index].kind == ExpressionKind.identifierExpression
      || tree.nodes[index].kind == ExpressionKind.argumentBindingExpression
      || tree.nodes[index].kind == ExpressionKind.argumentReferenceExpression
    )
    && identifierLookupName(tree.nodes[index].value) == name
  ) return true;
  for (const child of tree.nodes[index].children) {
    if (expressionUsesBinding(arena, tree, child, name)) return true;
  }
  for (const statement of tree.nodes[index].statements) {
    if (statementUsesBinding(arena, statement, name)) return true;
  }
  return false;
}

function statementUsesBinding(
  in arena: StatementArena,
  index: usize,
  in name: String
): boolean {
  match (in arena.nodes[index].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        if (expressionUsesBinding(arena, tree, root, name)) return true;
      }
      none => {}
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        if (expressionUsesBinding(arena, tree, root, name)) return true;
      }
      none => {}
    }
    none => {}
  }
  for (const child of arena.nodes[index].children) {
    if (statementUsesBinding(arena, child, name)) return true;
  }
  return false;
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
  let position: usize = 0;
  while (position < indices.length) {
    releaseUnusedViewBindings(arena, indices, position, 0, inout bindings);
    const index = indices[position];
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
    position = position + 1;
  }
  return true;
}

function releaseUnusedViewBindings(
  in arena: StatementArena,
  in indices: Array<usize>,
  position: usize,
  firstBindingIndex: usize,
  inout bindings: Array<NativeValueBinding>
): void {
  let bindingIndex = firstBindingIndex;
  while (bindingIndex < bindings.length) {
    if (
      bindings[bindingIndex].viewOwner.byteLength > 0
    ) {
      let usedLater = false;
      let remaining = position;
      while (remaining < indices.length && !usedLater) {
        usedLater = statementUsesBinding(
          arena,
          indices[remaining],
          bindings[bindingIndex].name
        );
        remaining = remaining + 1;
      }
      bindings[bindingIndex].viewLive = usedLater;
    }
    bindingIndex = bindingIndex + 1;
  }
}

function inferFunctionExpressions(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in declaration: FunctionDeclaration,
  in ownerType: String,
  in ownerExecutorAffinity: String,
  in inheritedTypeParameters: Array<TypeParameter>,
  inout evidence: ModuleSemanticEvidence
): void throws ModuleResolveError {
  let bindings = functionValueBindings(declaration.parameters);
  const bodyReturnType = prepareFunctionBindings(
    declaration,
    ownerType,
    ownerExecutorAffinity,
    inheritedTypeParameters,
    inout bindings
  );
  for (const parameter of declaration.parameters) {
    if (typeIsClassReference(module, modules, moduleIndex, parameter.type.name)) {
      setValueBindingClassAlias(
        inout bindings,
        parameter.name,
        localClassAliasIdentity(parameter.offset)
      );
    }
  }
  if (
    ownerType.byteLength > 0
    && typeIsClassReference(module, modules, moduleIndex, ownerType)
  ) setValueBindingClassAlias(
    inout bindings,
    "this",
    localClassAliasIdentity(declaration.offset)
  );
  const nativeBase = nativeObjCSubclassBase(modules, moduleIndex, ownerType);
  if (!declaration.staticMethod && nativeBase.byteLength > 0) {
    addBorrowedValueBinding(inout bindings, "super", nativeBase, false);
    setValueBindingClassAlias(inout bindings, "super", localClassAliasIdentity(declaration.offset));
    addValueBinding(inout bindings, "__z_native_objc_subclass_base", nativeBase);
  }
  const continues = try inferStatementSequence(
    module,
    modules,
    moduleIndex,
    declaration.body,
    declaration.body.roots,
    inout bindings,
    inout evidence,
    bodyReturnType
  );
  if (nativeBase.byteLength > 0 && bodyReturnType != "void" && continues) {
    throw codedModuleResolutionError(ModuleResolveErrorKind.typeMismatch, "Z0814", module.path,
      "a native override must return a value on every continuing path",
      declaration.line, declaration.column, 1);
  }
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
  let evidence = emptySemanticEvidence();
  for (const aggregate of module.program.aggregates) {
    match (in aggregate.nativeBase) {
      some(_) => {
        evidence = try validateNativeObjCSubclassBodyTypes(module, modules, moduleIndex);
        evidence.objectiveCSubclasses = try planNativeObjCSubclasses(module, modules, moduleIndex, evidence);
        break;
      }
      none => {}
    }
  }
  const noTypeParameters = Array<TypeParameter>();
  for (const declaration of module.program.functions) {
    try inferFunctionExpressions(
      module,
      modules,
      moduleIndex,
      declaration,
      "",
      "",
      noTypeParameters,
      inout evidence
    );
  }
  for (const aggregate of module.program.aggregates) {
    match (in aggregate.nativeBase) { some(_) => continue; none => {} }
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
        if (aggregate.kind == DeclarationKind.classDeclaration) {
          setValueBindingClassAlias(
            inout bindings,
            "this",
            localClassAliasIdentity(initializer.offset)
          );
        }
        addValueBinding(inout bindings, "__z_native_owner_type", aggregate.name);
        addValueBinding(inout bindings, "__z_native_constructor_type", aggregate.name);
        let lifecycleExecutorAffinity = aggregate.executorAffinity.copyBytes(
          0,
          aggregate.executorAffinity.byteLength
        );
        if (lifecycleExecutorAffinity.byteLength == 0) {
          for (const field of aggregate.fields) {
            if (field.executorAffinity == "thread.main") {
              lifecycleExecutorAffinity = "thread.main";
            }
          }
        }
        if (lifecycleExecutorAffinity == "thread.main") {
          addValueBinding(
            inout bindings,
            "__z_native_executor_context",
            "thread.main"
          );
        }
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
        aggregate.executorAffinity,
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
        if (aggregate.kind == DeclarationKind.classDeclaration) {
          setValueBindingClassAlias(
            inout bindings,
            "this",
            localClassAliasIdentity(deinitializer.offset)
          );
        }
        addValueBinding(inout bindings, "__z_native_owner_type", aggregate.name);
        let lifecycleExecutorAffinity = aggregate.executorAffinity.copyBytes(
          0,
          aggregate.executorAffinity.byteLength
        );
        if (lifecycleExecutorAffinity.byteLength == 0) {
          for (const field of aggregate.fields) {
            if (field.executorAffinity == "thread.main") {
              lifecycleExecutorAffinity = "thread.main";
            }
          }
        }
        if (lifecycleExecutorAffinity == "thread.main") {
          addValueBinding(
            inout bindings,
            "__z_native_executor_context",
            "thread.main"
          );
        }
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

// Uses the ordinary expression/call/loan checker, but never the ordinary Z
// record constructor path. The returned facts remain behind the native
// subclass execution gate until availability and lowering are complete.
export function validateNativeObjCSubclassBodyTypes(
  in module: ParsedModule, in modules: Array<ResolvedModule>, moduleIndex: usize
): ModuleSemanticEvidence throws ModuleResolveError {
  let evidence = emptySemanticEvidence();
  let validatedTypes = false;
  for (const aggregate of module.program.aggregates) {
    match (in aggregate.nativeBase) { some(_) => {} none => continue; }
    const base = nativeObjCSubclassBase(modules, moduleIndex, aggregate.name);
    if (base.byteLength == 0) continue;
    if (!validatedTypes) {
      if (!importedStandardType(module, "thread", "std/thread", "thread")) {
        throw codedModuleResolutionError(ModuleResolveErrorKind.typeMismatch, "Z0814", module.path,
          "native subclass affinity requires the imported thread.main capability from std/thread",
          aggregate.line, aggregate.column, 1);
      }
      try validateModuleTypes(module, modules, moduleIndex);
      validatedTypes = true;
    }
    try resolveAggregateNames(module, modules[moduleIndex].symbols, aggregate);
    match (in aggregate.constructorDeclaration) {
      some(initializer) => {
        let bindings = functionValueBindings(initializer.parameters);
        addValueBinding(inout bindings, "__z_native_function_name", "constructor");
        addValueBinding(inout bindings, "__z_native_return_type", "void");
        addValueBinding(inout bindings, "__z_native_owner_type", aggregate.name);
        addValueBinding(inout bindings, "__z_native_executor_context", "thread.main");
        addValueBinding(inout bindings, "__z_native_objc_subclass_base", base);
        addBorrowedValueBinding(inout bindings, "this", aggregate.name, true);
        let fieldIndex: usize = 0;
        while (fieldIndex < aggregate.fields.length && fieldIndex + 1 < initializer.body.roots.length) {
          const assignment = view initializer.body.nodes[initializer.body.roots[fieldIndex + 1]];
          addValueBinding(inout bindings, `__z_native_field_init_${assignment.offset}`, "true");
          fieldIndex = fieldIndex + 1;
        }
        addBorrowedValueBinding(inout bindings, "super", base, false);
        const alias = localClassAliasIdentity(initializer.offset);
        setValueBindingClassAlias(inout bindings, "this", alias);
        setValueBindingClassAlias(inout bindings, "super", alias);
        const first = view initializer.body.nodes[initializer.body.roots[0]];
        match (in first.expression) {
          some(expression) => match (in expression.tree) {
            some(tree) => addValueBinding(inout bindings, "__z_native_objc_initializer_offset", `${tree.nodes[tree.root].offset}`);
            none => {}
          }
          none => {}
        }
        try inferStatementSequence(module, modules, moduleIndex, initializer.body,
          initializer.body.roots, inout bindings, inout evidence, "void");
      }
      none => {}
    }
    for (const method of aggregate.methods) {
      try inferFunctionExpressions(module, modules, moduleIndex, method,
        aggregate.name, aggregate.executorAffinity, aggregate.typeParameters, inout evidence);
    }
    match (in aggregate.deinitializer) {
      some(deinitializer) => {
        let bindings = Array<NativeValueBinding>();
        addValueBinding(inout bindings, "__z_native_function_name", "deinit");
        addValueBinding(inout bindings, "__z_native_return_type", "void");
        addValueBinding(inout bindings, "__z_native_owner_type", aggregate.name);
        addValueBinding(inout bindings, "__z_native_executor_context", "thread.main");
        addBorrowedValueBinding(inout bindings, "this", aggregate.name, false);
        try inferStatementSequence(module, modules, moduleIndex, deinitializer.body,
          deinitializer.body.roots, inout bindings, inout evidence, "void");
      }
      none => {}
    }
  }
  return evidence;
}

function isNativeCExportScalarType(in name: String): boolean {
  return name == "i8"
    || name == "u8"
    || name == "i16"
    || name == "u16"
    || name == "i32"
    || name == "u32"
    || name == "i64"
    || name == "u64"
    || name == "isize"
    || name == "usize"
    || name == "f32"
    || name == "f64"
    || name == "boolean"
    || name == "void";
}

function nativeCExportError(
  in module: ParsedModule,
  in declaration: FunctionDeclaration,
  in message: String
): ModuleResolveError {
  return resolutionError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    message,
    declaration.line,
    declaration.column
  );
}

function isNativeCLayoutType(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): boolean {
  match (typeSymbolLocation(modules, moduleIndex, name)) {
    some(location) => {
      match (
        in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature
      ) {
        some(signature) => return signature.nativeCName.byteLength > 0;
        none => {}
      }
    }
    none => {}
  }
  return false;
}

function validateNativeCLayouts(
  in parsed: Array<ParsedModule>,
  in modules: Array<ResolvedModule>
): void throws ModuleResolveError {
  let moduleIndex: usize = 0;
  let publicNames = Array<String>();
  for (const module of parsed) {
    for (const aggregate of module.program.aggregates) {
      if (!aggregate.nativeCLayout) continue;
      if (isPublicCAbiReservedWord(aggregate.name)) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `C-layout type name "${aggregate.name}" is not a valid public C identifier`,
          aggregate.line,
          aggregate.column
        );
      }
      if (containsString(publicNames, aggregate.name)) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `duplicate public C type name "${aggregate.name}"`,
          aggregate.line,
          aggregate.column
        );
      }
      publicNames.push(aggregate.name.copyBytes(0, aggregate.name.byteLength));
      if (aggregate.kind != DeclarationKind.structDeclaration) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "`c class` is not supported",
          aggregate.line,
          aggregate.column
        );
      }
      if (aggregate.typeParameters.length > 0) {
        throw resolutionError(ModuleResolveErrorKind.typeMismatch, module.path, "a C-layout struct cannot be generic", aggregate.line, aggregate.column);
      }
      if (aggregate.executorAffinity.byteLength > 0) {
        throw resolutionError(ModuleResolveErrorKind.typeMismatch, module.path, "a C-layout struct cannot have executor affinity", aggregate.line, aggregate.column);
      }
      if (aggregate.implementedTraits.length > 0) {
        throw resolutionError(ModuleResolveErrorKind.typeMismatch, module.path, "a C-layout struct cannot implement traits in the first ABI tier", aggregate.line, aggregate.column);
      }
      match (in aggregate.constructorDeclaration) {
        some(_) => throw resolutionError(ModuleResolveErrorKind.typeMismatch, module.path, "a C-layout struct cannot declare a constructor in the first ABI tier", aggregate.line, aggregate.column);
        none => {}
      }
      match (in aggregate.deinitializer) {
        some(_) => throw resolutionError(ModuleResolveErrorKind.typeMismatch, module.path, "a C-layout struct cannot declare `deinit`", aggregate.line, aggregate.column);
        none => {}
      }
      if (aggregate.fields.length == 0) {
        throw resolutionError(ModuleResolveErrorKind.typeMismatch, module.path, "a C-layout struct must declare at least one field", aggregate.line, aggregate.column);
      }
      for (const field of aggregate.fields) {
        if (isPublicCAbiReservedWord(field.name)) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `C-layout field name "${field.name}" is not a valid public C identifier`,
            field.line,
            field.column
          );
        }
        if (field.visibility != Visibility.publicVisibility) {
          throw resolutionError(ModuleResolveErrorKind.typeMismatch, module.path, `C-layout field "${field.name}" cannot be private`, field.line, field.column);
        }
        if (field.readonlyField) {
          throw resolutionError(ModuleResolveErrorKind.typeMismatch, module.path, `C-layout field "${field.name}" cannot be readonly`, field.line, field.column);
        }
        if (field.executorAffinity.byteLength > 0) {
          throw resolutionError(ModuleResolveErrorKind.typeMismatch, module.path, `C-layout field "${field.name}" cannot have executor affinity`, field.line, field.column);
        }
        if (field.optionalField) {
          throw resolutionError(ModuleResolveErrorKind.typeMismatch, module.path, `C-layout field "${field.name}" cannot use Z optional-field storage`, field.line, field.column);
        }
        match (in field.defaultValue) {
          some(_) => throw resolutionError(ModuleResolveErrorKind.typeMismatch, module.path, `C-layout field "${field.name}" cannot declare a Z default value`, field.line, field.column);
          none => {}
        }
        if (
          field.type.name == "void"
          || (
            !isNativeCExportScalarType(field.type.name)
            && !isNativeCLayoutType(modules, moduleIndex, field.type.name)
          )
        ) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `C-layout field type "${field.type.name}" does not have a C representation`,
            field.line,
            field.column
          );
        }
      }
    }
    for (const enumDeclaration of module.program.enums) {
      if (!enumDeclaration.nativeCLayout) continue;
      if (isPublicCAbiReservedWord(enumDeclaration.name)) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `C enum name "${enumDeclaration.name}" is not a valid public C identifier`,
          enumDeclaration.line,
          enumDeclaration.column
        );
      }
      if (containsString(publicNames, enumDeclaration.name)) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `duplicate public C type name "${enumDeclaration.name}"`,
          enumDeclaration.line,
          enumDeclaration.column
        );
      }
      publicNames.push(enumDeclaration.name.copyBytes(
        0,
        enumDeclaration.name.byteLength
      ));
      let representation = "";
      match (in enumDeclaration.underlyingType) {
        some(type) => representation = type.name.copyBytes(0, type.name.byteLength);
        none => {}
      }
      if (
        representation != "i8"
        && representation != "u8"
        && representation != "i16"
        && representation != "u16"
        && representation != "i32"
        && representation != "u32"
        && representation != "i64"
        && representation != "u64"
        && representation != "isize"
        && representation != "usize"
      ) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `C enum "${enumDeclaration.name}" requires a fixed integer representation`,
          enumDeclaration.line,
          enumDeclaration.column
        );
      }
      if (enumDeclaration.variants.length == 0) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "a C enum must declare at least one variant",
          enumDeclaration.line,
          enumDeclaration.column
        );
      }
      for (const variant of enumDeclaration.variants) {
        if (isPublicCAbiReservedWord(variant.name)) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `C enum variant "${variant.name}" is not a valid public C identifier`,
            variant.line,
            variant.column
          );
        }
        match (in variant.payload) {
          some(_) => throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `C enum variant "${variant.name}" cannot carry a payload`,
            variant.line,
            variant.column
          );
          none => {}
        }
      }
    }
    moduleIndex = moduleIndex + 1;
  }
}

function validateNativeCExports(
  in parsed: Array<ParsedModule>,
  in modules: Array<ResolvedModule>
): void throws ModuleResolveError {
  let symbols = Array<String>();
  let moduleIndex: usize = 0;
  for (const module of parsed) {
    for (const declaration of module.program.functions) {
      if (!declaration.nativeCExport) continue;
      if (isPublicCAbiReservedWord(declaration.name)) {
        throw nativeCExportError(
          module,
          declaration,
          `C export name "${declaration.name}" is not a valid public C identifier`
        );
      }
      if (containsString(symbols, declaration.name)) {
        throw nativeCExportError(
          module,
          declaration,
          `duplicate C export symbol "${declaration.name}"`
        );
      }
      symbols.push(declaration.name.copyBytes(
        0,
        declaration.name.byteLength
      ));
      if (declaration.name == "main") {
        throw nativeCExportError(
          module,
          declaration,
          "`main` cannot also be published as a C export"
        );
      }
      if (declaration.asynchronous) {
        throw nativeCExportError(
          module,
          declaration,
          "a C-exported function cannot be async in the first ABI tier"
        );
      }
      match (in declaration.errorType) {
        some(_) => throw nativeCExportError(
          module,
          declaration,
          "a C-exported function cannot throw in the first ABI tier"
        );
        none => {}
      }
      if (declaration.typeParameters.length > 0) {
        throw nativeCExportError(
          module,
          declaration,
          "a C-exported function cannot be generic in the first ABI tier"
        );
      }
      if (declaration.executorAffinity.byteLength > 0) {
        throw nativeCExportError(
          module,
          declaration,
          "a C-exported function cannot have executor affinity in the first ABI tier"
        );
      }
      for (const parameter of declaration.parameters) {
        if (parameter.mode != ParameterMode.value) {
          throw nativeCExportError(
            module,
            declaration,
            `C export parameter "${parameter.name}" must be an ordinary by-value scalar`
          );
        }
        if (
          parameter.type.name == "void"
          || (
            !isNativeCExportScalarType(parameter.type.name)
            && parameter.type.name != "String"
            && !isNativeCLayoutType(modules, moduleIndex, parameter.type.name)
          )
        ) {
          throw nativeCExportError(
            module,
            declaration,
            `C export parameter "${parameter.name}" has unsupported boundary type "${parameter.type.name}"`
          );
        }
      }
      if (
        !isNativeCExportScalarType(declaration.returnType.name)
        && !isNativeCLayoutType(modules, moduleIndex, declaration.returnType.name)
      ) {
        throw nativeCExportError(
          module,
          declaration,
          `C export return type "${declaration.returnType.name}" is unsupported in the first ABI tier`
        );
      }
    }
    moduleIndex = moduleIndex + 1;
  }
}

export function resolveModules(
  in sources: Array<ModuleSource>,
  in entryPath: String
): ModuleGraph throws ModuleResolveError {
  const parsedBatch = try parseModuleSources(sources);
  return try resolveParsedModuleBatch(in parsedBatch, entryPath);
}

export function resolveParsedModuleBatch(
  in parsedBatch: ParsedModuleBatch,
  in entryPath: String
): ModuleGraph throws ModuleResolveError {
  const parsed = parsedBatch.modules;
  return try resolveParsedModules(in parsed, entryPath);
}

export function resolveParsedModules(
  in parsed: Array<ParsedModule>,
  in entryPath: String
): ModuleGraph throws ModuleResolveError {
  const foreignContracts = Array<NativeForeignModuleContract>();
  return try resolveParsedModulesWithForeignContracts(
    parsed,
    entryPath,
    foreignContracts
  );
}

export function resolveParsedModulesWithForeignContracts(
  in parsed: Array<ParsedModule>,
  in entryPath: String,
  in foreignContracts: Array<NativeForeignModuleContract>
): ModuleGraph throws ModuleResolveError {
  const entry = try findEntryModule(parsed, entryPath);
  let modules = try buildResolvedModules(parsed);
  // Foreign types participate in ordinary type validation, including
  // Objective-C protocol conformance. Attach their checked semantic contracts
  // before validating source declarations rather than relying on Stage 0
  // evidence to fill an unresolved namespace afterward.
  try attachForeignContracts(parsed, foreignContracts, inout modules);
  try validateNativeObjCSubclassDeclarations(parsed, modules);
  try prepareNativeObjCSubclassTypes(parsed, inout modules);
  // Checked native entries retain their body evidence through ordinary module
  // validation; dedicated lowering must not reinterpret them as Z ARC records.
  try validateNativeCLayouts(parsed, modules);
  try validateNativeCExports(parsed, modules);
  let index: usize = 0;
  while (index < parsed.length) {
    try validateModuleTypes(parsed[index], modules, index);
    try validateModuleNames(parsed[index], modules[index].symbols);
    index = index + 1;
  }
  index = 0;
  while (index < parsed.length) {
    modules[index].semanticEvidence = try validateExpressionTypesAndLocals(parsed[index], modules, index);
    index = index + 1;
  }

  try validateNativeObjCSubclassRawAccess(parsed, modules);
  const dependencyOrder = try resolveModuleOrder(parsed, modules, entry);
  return ModuleGraph({ modules, dependencyOrder, entry });
}
