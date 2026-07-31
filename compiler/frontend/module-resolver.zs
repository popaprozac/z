import { TextBuffer } from "std/text";
import {
  buildResolvedModules,
  findEntryModule,
  parseModuleSources,
  resolveModuleOrder,
} from "./module-graph.zs";
import {
  ParsedModule,
  moduleSymbolIndex,
  moduleBindingName as bindingName,
} from "./module-symbols.zs";
import {
  isPublicCAbiReservedWord,
  validateModuleNames,
} from "./semantic-names.zs";
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
  recordCallResolution,
} from "./semantic-evidence.zs";
import {
  collectionMethodMutates,
  collectionMethodSignature,
  iterationElementType,
  iterationObjectFieldType,
  numberLiteralType,
  throwingGeneratorHandleType,
} from "./semantic-intrinsics.zs";
import { nativeStandardCall } from "./semantic-standard-library.zs";
import {
  NativeInitializationState,
  NativeOwnershipState,
  NativeValueBinding,
  addBorrowedValueBinding,
  addMatchBorrowedValueBinding,
  addMutableValueBinding,
  addUninitializedMutableValueBinding,
  addValueBinding,
  borrowClosureBindingInPlace,
  borrowValueBindingInPlace,
  copyBindingFlowStates,
  copyValueBindings,
  mergeBindingFlowStates,
  setValueBindingInitialization,
  setValueBindingOwnership,
  valueBindingInitialization,
  valueBindingIsBorrowed,
  valueBindingIsMatchBorrowed,
  valueBindingIsMutable,
  valueBindingOwnership,
  valueBindingType,
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
} from "./semantic-expression-ownership.zs";
import {
  isContextualNumericLiteral,
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
  isActiveTypeParameter,
  isKnownMatchVariant,
  matchShape,
  matchVariantIndex,
  methodCallableSignature,
  rebaseModuleFunctionSignature,
  typeExpressionName,
} from "./semantic-member-lookups.zs";
import {
  addMatchArmValueBindings,
  isDefinitelyNonMatchable,
  matchError,
  requireVisibleField,
} from "./semantic-pattern-validation.zs";
import {
  binaryOperatorType,
  unaryOperatorType,
} from "./semantic-operators.zs";
import {
  equivalentTypes,
  rebaseTypeName,
  semanticTypeIdentity,
  transparentTypeName,
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
  qualifiedTypeBase,
  qualifiedTypeMember,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import { validateModuleTypes } from "./semantic-type-validation.zs";
import {
  substituteGenericType,
  typeContainsForeignValueStorage,
  typeHasCleanup,
  typeHasCustomConstructor,
  typeMovesOnOwnedUse,
  typeSupportsExplicitCopy,
} from "./semantic-type-ownership.zs";
import {
  ModuleFunctionSignature,
  ModuleGraph,
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSemanticEvidence,
  ModuleSource,
  ModuleSymbol,
  ModuleSymbolKind,
  ModuleTypeParameterConstraint,
  ModuleTypeSignature,
  ResolvedModule,
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

function copyIndices(in indices: Array<usize>): Array<usize> {
  let copied = Array<usize>();
  for (const index of indices) {
    copied.push(index);
  }
  return copied;
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
    constraintSubstitutions
  );
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

function callArgumentNodes(in children: Array<usize>): Array<usize> {
  let arguments = Array<usize>();
  let index: usize = 1;
  while (index < children.length) {
    arguments.push(children[index]);
    index = index + 1;
  }
  return arguments;
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
      const inferredNode = access == "in" ? bindingIndex : nodeIndex;
      let inferenceExpectedType = expectedArgumentType.copyBytes(
        0,
        expectedArgumentType.byteLength
      );
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
    substitutions
  );
  let parameterIndex: usize = 0;
  while (parameterIndex < argumentTypes.length) {
    const expected = substituteGenericType(
      signature.parameterTypes[parameterIndex],
      substitutions
    );
    let requiredExpected = expected.copyBytes(0, expected.byteLength);
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
  if (callKind != "value") {
    recordCallResolution(
      tree,
      callIndex,
      targetModuleIndex,
      targetSymbolIndex,
      callKind,
      functionName,
      signature,
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
  if (isIntegerTypeName(typeName)) return true;
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
    let declaredReturn = "void";
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
      const outcome = try inferExpressionNodeType(
        module,
        modules,
        moduleIndex,
        arena,
        tree,
        callIndex,
        inout bindings,
        inout evidence
      );
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
      tree,
      children,
      bindings,
      inout blockBindings,
      inout movedCaptures
    );
    if (!capturesReady) return "";
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
            node.line,
            node.column
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
    if (stringStartsWith(receiverValueType, "view ")) {
      receiverValueType = receiverValueType.copyBytes(5, receiverValueType.byteLength);
    }
    match (genericTypeShape(receiverValueType)) {
      some(generic) => {
        if (
          memberName == "length"
          && (
            generic.base == "Array"
            || generic.base == "Map"
            || generic.base == "Set"
          )
        ) return "usize";
      }
      none => {}
    }
    if (receiverValueType == "String") {
      if (memberName == "byteLength") return "usize";
      if (memberName == "isEmpty") return "boolean";
    }
    match (aggregateFieldShape(modules, moduleIndex, receiverValueType, memberName)) {
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
        let fieldType = field.typeName.copyBytes(
          0,
          field.typeName.byteLength
        );
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
      operand
    );
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
    return arrayElementType(owner);
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
    const localNames = copyBindings(closureSignature.parameterNames);
    let captures = Array<String>();
    if (bodyKind == "block") {
      let bodyNames = copyBindings(localNames);
      const statements = copyIndices(node.statements);
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
          node.line,
          node.column
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
      if (value == "move") {
        if (typeMovesOnOwnedUse(modules, moduleIndex, captureType)) {
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
    return nativeClosureFunctionType(
      tree,
      index,
      closureSignature.parameterModes,
      closureSignature.parameterTypes,
      returnType,
      closureSignature.errorType
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
      if (isIntegerTypeName(base)) {
        if (children.length != 2) {
          throw resolutionError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `${base} numeric construction expects exactly one integer value`,
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
            `${base} numeric construction requires an integer value, found ${actual}`,
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
      if (isFloatTypeName(base)) {
        throw resolutionError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `${base}(value) numeric conversion is not available in the integer-only conversion tier`,
          node.line,
          node.column
        );
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
      if (
        base == "Map"
        || base == "Set"
        || base == "TextBuffer"
      ) {
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
        match (nativeStandardCall(
          module.program,
          namespaceName,
          memberName,
          children.length - 1
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
                errorType
              );
              const closureType = try inferExpressionNodeTypeExpected(
                module,
                modules,
                moduleIndex,
                arena,
                tree,
                closureIndex,
                contextualType,
                inout bindings,
                inout evidence
              );
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
        match (collectionMethodSignature(ownerType, methodName)) {
          some(signature) => {
            let receiverRoot = "";
            let receiverAccess = "";
            if (collectionMethodMutates(ownerType, methodName)) {
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
              signature,
              substitutions,
              0,
              0,
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
        if (inferred.byteLength > 0) {
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
        if (arena.nodes[index].arrayBindings.length == 0) {
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
      for (const binding of arena.nodes[index].arrayBindings) {
        if (binding.kind == ArrayBindingKind.discard) continue;
        const bindingType = binding.kind == ArrayBindingKind.rest
          ? `Slice<${elementType}>`
          : elementType.copyBytes(0, elementType.byteLength);
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
        addValueBinding(inout bindings, bindingName, bindingType);
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
      if (mutableBinding) {
        addMutableValueBinding(inout bindings, bindingName, fieldType);
      } else {
        addValueBinding(inout bindings, bindingName, fieldType);
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
          let acceptsBorrowedView = false;
          if (
            kind == StatementKind.returnStatement
            && stringStartsWith(contextualExpected, "view ")
          ) {
            const target = contextualExpected.copyBytes(
              5,
              contextualExpected.byteLength
            );
            if (equivalentTypes(modules, moduleIndex, target, actual)) {
              match (in expression.tree) {
                some(tree) => {
                  const root = tree.root;
                  const expressionKind = tree.nodes[root].kind;
                  const owner = expressionStorageRootName(tree, root);
                  if (
                    (
                      expressionKind == ExpressionKind.identifierExpression
                      || expressionKind == ExpressionKind.memberExpression
                      || expressionKind == ExpressionKind.indexExpression
                    )
                    && valueBindingIsBorrowed(bindings, owner)
                    && !valueBindingIsMatchBorrowed(bindings, owner)
                  ) acceptsBorrowedView = true;
                }
                none => {}
              }
            }
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
  const bodyReturnType = prepareFunctionBindings(
    declaration,
    ownerType,
    inheritedTypeParameters,
    inout bindings
  );
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
  let evidence = emptySemanticEvidence();
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
  const parsed = try parseModuleSources(sources);
  return try resolveParsedModules(parsed, entryPath);
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
  try validateNativeCLayouts(parsed, modules);
  try validateNativeCExports(parsed, modules);
  let index: usize = 0;
  while (index < parsed.length) {
    try validateModuleTypes(parsed[index], modules, index);
    try validateModuleNames(parsed[index], modules[index].symbols);
    index = index + 1;
  }
  try attachForeignContracts(parsed, foreignContracts, inout modules);
  index = 0;
  while (index < parsed.length) {
    modules[index].semanticEvidence = try validateExpressionTypesAndLocals(parsed[index], modules, index);
    index = index + 1;
  }

  const dependencyOrder = try resolveModuleOrder(modules, entry);
  return ModuleGraph({ modules, dependencyOrder, entry });
}
