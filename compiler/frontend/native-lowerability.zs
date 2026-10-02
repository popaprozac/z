import {
  AggregateDeclaration,
  DeclarationKind,
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  FunctionDeclaration,
  Parameter,
  ParameterMode,
  Program,
  ReceiverMode,
  StatementArena,
  StatementKind,
  TypeNameReference,
  TypeParameter,
  TypeReference,
} from "./parser.zs";
import { ParsedModule } from "./module-symbols.zs";
import { isNativeThreadBinding } from "./native-thread-shape.zs";
import { functionUsesReturnedMatchTailAwait } from "./native-tail-match-shape.zs";
import { functionUsesYieldFrame, isFrameSchedulerYield } from "./async-yield-shape.zs";
import {
  fixedArrayShape,
  genericTypeShape,
  isIntegerTypeName,
  nullableTargetType,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import { typeHasCleanup, typeIsThreadTransferable } from "./semantic-type-ownership.zs";
import { channelTypeKind } from "./channel-shapes.zs";
import { transparentTypeName, typeSymbolLocation } from "./semantic-type-identities.zs";
import { typeMentionsParameter } from "./semantic-generic-inference.zs";
import { aggregateFieldShape } from "./semantic-member-lookups.zs";
import { collectionHasLength } from "./semantic-intrinsics.zs";
import {
  ModuleGraph,
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSemanticEvidence,
  ModuleSymbolKind,
  codedModuleResolutionError,
} from "./semantic-model.zs";

function loweringBoundary(
  in path: String,
  in code: String,
  in message: String,
  line: usize,
  column: usize,
  length: usize
): ModuleResolveError {
  return codedModuleResolutionError(
    ModuleResolveErrorKind.unsupportedLowering,
    code,
    path,
    message,
    line,
    column,
    length
  );
}

function validateMainTimerExpression(
  in program: Program, in arena: StatementArena, in tree: ExpressionTree,
  index: usize, in path: String
): void throws ModuleResolveError {
  const node = view tree.nodes[index];
  if (node.kind == ExpressionKind.closureExpression) return;
  if (node.kind == ExpressionKind.awaitExpression && node.children.length == 1) {
    const call = node.children[0];
    if (tree.nodes[call].kind == ExpressionKind.callExpression && tree.nodes[call].children.length == 2) {
      const callee = tree.nodes[call].children[0];
      if (tree.nodes[callee].kind == ExpressionKind.identifierExpression) {
        for (const imported of program.imports) {
          if (imported.header != "std/time") continue;
          for (const binding of imported.bindings) {
            if (binding.importedName == "delay" && binding.localName == tree.nodes[callee].value) {
              throw loweringBoundary(path, "Z0700",
                "direct timer awaits in main require a resumable native entry frame, which is not implemented yet; z check and the Stage 0 runner support this shape",
                node.line, node.column, 5);
            }
          }
        }
      }
    }
  }
  for (const child of node.children) { try validateMainTimerExpression(program, arena, tree, child, path); }
  for (const child of node.statements) { try validateMainTimerStatement(program, arena, child, path); }
}

function validateMainTimerStatement(
  in program: Program, in arena: StatementArena, index: usize, in path: String
): void throws ModuleResolveError {
  match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        try validateMainTimerExpression(program, arena, tree, root, path);
      }
      none => {}
    }
    none => {}
  }
  for (const child of arena.nodes[index].children) { try validateMainTimerStatement(program, arena, child, path); }
}

function stringContains(in value: String, in candidate: String): boolean {
  if (candidate.byteLength == 0) return true;
  if (candidate.byteLength > value.byteLength) return false;
  let start: usize = 0;
  while (start + candidate.byteLength <= value.byteLength) {
    let offset: usize = 0;
    while (
      offset < candidate.byteLength
      && value.byteAt(start + offset) == candidate.byteAt(offset)
    ) {
      offset = offset + 1;
    }
    if (offset == candidate.byteLength) return true;
    start = start + 1;
  }
  return false;
}

function nativeFixedArrayTypeSupported(in name: String): boolean {
  return match (fixedArrayShape(name)) {
    some(_) => true;
    none => false;
  };
}

function typeUsesGeneric(in name: String, in base: String): boolean {
  return stringContains(name, `${base}<`);
}


function nativeOwnerExecutorAffinity(
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in owner: String
): String {
  if (owner.byteLength == 0 || moduleIndex >= modules.length) return "";
  for (const aggregate of modules[moduleIndex].program.aggregates) {
    if (aggregate.name != owner) continue;
    return aggregate.executorAffinity.copyBytes(
      0,
      aggregate.executorAffinity.byteLength
    );
  }
  return "";
}

function nativeTemplateInterpolationTypeSupported(in name: String): boolean {
  return name == "String"
    || name == "view String"
    || name == "boolean"
    || isIntegerTypeName(name)
    || name == "f64";
}

function nativeExplicitCopyTypeSupported(
  in graph: ModuleGraph,
  moduleIndex: usize,
  in name: String
): boolean {
  if (stringStartsWith(name, "readonly ")) {
    const target = name.copyBytes(9, name.byteLength);
    return nativeExplicitCopyTypeSupported(graph, moduleIndex, target);
  }
  const actual = transparentTypeName(graph.modules, moduleIndex, name);
  if (actual != name) return nativeExplicitCopyTypeSupported(graph, moduleIndex, actual);
  match (fixedArrayShape(name)) {
    some(shape) => return nativeExplicitCopyTypeSupported(
      graph,
      moduleIndex,
      shape.elementType
    );
    none => {}
  }
  if (
    name == "String"
    || name == "cstring"
    || name == "boolean"
    || name == "f32"
    || name == "f64"
    || isIntegerTypeName(name)
  ) return true;
  match (genericTypeShape(name)) {
    some(generic) => {
      if (
        (generic.base != "Array" && generic.base != "Option")
        || generic.arguments.length != 1
      ) {
        return false;
      }
      return nativeExplicitCopyTypeSupported(
        graph,
        moduleIndex,
        generic.arguments[0]
      );
    }
    none => {}
  }
  match (typeSymbolLocation(graph.modules, moduleIndex, name)) {
    some(location) => {
      const kind = graph.modules[location.moduleIndex].symbols[
        location.symbolIndex
      ].kind;
      return kind == ModuleSymbolKind.structSymbol
        || kind == ModuleSymbolKind.enumSymbol;
    }
    none => return false;
  }
}

function expressionIsStructSpreadCapability(
  in tree: ExpressionTree,
  index: usize
): boolean {
  for (const candidate of tree.nodes) {
    if (
      candidate.kind == ExpressionKind.objectExpression
      && candidate.labels.length > 0
      && candidate.labels[0] == "..."
      && candidate.children.length > 0
      && candidate.children[0] == index
    ) return true;
  }
  return false;
}

function validateNativeCollectionTypeName(
  in path: String,
  in name: String,
  line: usize,
  column: usize,
  length: usize
): void throws ModuleResolveError {
  match (genericTypeShape(name)) {
    some(generic) => {
      if (
        generic.base == "Map"
        && generic.arguments.length == 2
      ) {
        if (
          generic.arguments[1] == "String"
          || typeUsesGeneric(generic.arguments[1], "Array")
          || typeUsesGeneric(generic.arguments[1], "Map")
          || typeUsesGeneric(generic.arguments[1], "Set")
        ) {
          throw loweringBoundary(
            path,
            "Z1000",
            `Map value type "${generic.arguments[1]}" is not executable in the native compiler yet; only cleanup-free scalar values are supported`,
            line,
            column,
            length
          );
        }
      }
    }
    none => {}
  }
}

function validateNativeType(
  in path: String,
  in type: TypeReference
): void throws ModuleResolveError {
  const typeLength = type.name.byteLength;
  const typeLine = type.line;
  const typeColumn = type.column;
  try validateNativeCollectionTypeName(
    path,
    type.name,
    typeLine,
    typeColumn,
    typeLength
  );
  match (fixedArrayShape(type.name)) {
    some(shape) => {
      const elementType = TypeReference({
        name: shape.elementType.copyBytes(0, shape.elementType.byteLength),
        references: Array<TypeNameReference>(),
        offset: type.offset,
        line: type.line,
        column: type.column,
      });
      try validateNativeType(path, elementType);
      return;
    }
    none => {}
  }
  if (typeUsesGeneric(type.name, "AsyncGenerator")) {
    throw loweringBoundary(
      path,
      "Z0700",
      `async-generator type "${type.name}" is not executable in the native compiler yet`,
      type.line,
      type.column,
      type.name.byteLength
    );
  }
  if (typeUsesGeneric(type.name, "Generator")) {
    throw loweringBoundary(
      path,
      "Z1000",
      `generator type "${type.name}" is not executable in the native compiler yet`,
      type.line,
      type.column,
      type.name.byteLength
    );
  }
}

function stableOptionalChainSource(
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.identifierExpression
    || tree.nodes[index].kind == ExpressionKind.argumentBindingExpression
    || tree.nodes[index].kind == ExpressionKind.argumentReferenceExpression
  ) return true;
  if (
    tree.nodes[index].kind != ExpressionKind.memberExpression
    || tree.nodes[index].optionalAccess
    || tree.nodes[index].children.length != 1
  ) return false;
  const receiver = tree.nodes[index].children[0];
  return stableOptionalChainSource(tree, receiver);
}

function expressionSourceLength(
  in tree: ExpressionTree,
  index: usize
): usize {
  const node = view tree.nodes[index];
  if (node.kind == ExpressionKind.identifierExpression) {
    return node.value.byteLength;
  }
  if (
    node.kind == ExpressionKind.memberExpression
    && node.children.length == 1
  ) {
    return expressionSourceLength(tree, node.children[0])
      + 1
      + node.value.byteLength;
  }
  if (node.value.byteLength > 0) return node.value.byteLength;
  return 1;
}

function expressionTreeContainsSuspension(
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.awaitExpression
    || tree.nodes[index].kind == ExpressionKind.executorPlacementExpression
  ) return true;
  if (tree.nodes[index].kind == ExpressionKind.closureExpression) return false;
  for (const statement of tree.nodes[index].statements) {
    if (statementContainsSuspension(arena, statement)) return true;
  }
  for (const child of tree.nodes[index].children) {
    if (expressionTreeContainsSuspension(arena, tree, child)) return true;
  }
  return false;
}

function statementContainsSuspension(
  in arena: StatementArena,
  index: usize
): boolean {
  if (
    arena.nodes[index].kind == StatementKind.asyncScopeStatement
    || arena.nodes[index].kind == StatementKind.forAwaitStatement
    || arena.nodes[index].kind == StatementKind.forTryAwaitStatement
  ) return true;
  match (in arena.nodes[index].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        if (expressionTreeContainsSuspension(arena, tree, root)) return true;
      }
      none => {}
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        if (expressionTreeContainsSuspension(arena, tree, root)) return true;
      }
      none => {}
    }
    none => {}
  }
  for (const child of arena.nodes[index].children) {
    if (statementContainsSuspension(arena, child)) return true;
  }
  return false;
}

function functionContainsSuspension(in declaration: FunctionDeclaration): boolean {
  for (const root of declaration.body.roots) {
    if (statementContainsSuspension(declaration.body, root)) return true;
  }
  return false;
}

function importedStandardBinding(
  in program: Program,
  in header: String,
  in importedName: String,
  in localName: String
): boolean {
  for (const declaration of program.imports) {
    if (declaration.header != header) continue;
    for (const binding of declaration.bindings) {
      if (
        binding.importedName == importedName
        && binding.localName == localName
      ) return true;
    }
  }
  return false;
}

function expressionIsSchedulerYieldAwait(
  in program: Program,
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (
    tree.nodes[index].kind != ExpressionKind.awaitExpression
    || tree.nodes[index].children.length != 1
  ) return false;
  const operation = tree.nodes[index].children[0];
  if (
    tree.nodes[operation].kind != ExpressionKind.callExpression
    || tree.nodes[operation].children.length != 1
  ) return false;
  const callee = tree.nodes[operation].children[0];
  if (
    tree.nodes[callee].kind != ExpressionKind.memberExpression
    || tree.nodes[callee].value != "yield"
    || tree.nodes[callee].children.length != 1
  ) return false;
  const namespace = tree.nodes[callee].children[0];
  return tree.nodes[namespace].kind == ExpressionKind.identifierExpression
    && importedStandardBinding(
      program,
      "std/async",
      "scheduler",
      tree.nodes[namespace].value
    );
}

function statementIsSchedulerYieldAwait(
  in program: Program,
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.expressionStatement) {
    return false;
  }
  return match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        select expressionIsSchedulerYieldAwait(program, tree, root);
      }
      none => false;
    }
    none => false;
  };
}

function functionUsesFirstTierSchedulerYield(
  in program: Program,
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length < 2) return false;
  const firstRoot = declaration.body.roots[0];
  if (!statementIsSchedulerYieldAwait(
    program,
    declaration.body,
    firstRoot
  )) return false;
  let rootIndex: usize = 1;
  while (rootIndex < declaration.body.roots.length) {
    const root = declaration.body.roots[rootIndex];
    if (statementContainsSuspension(
      declaration.body,
      root
    )) return false;
    rootIndex = rootIndex + 1;
  }
  return true;
}

function statementIsFirstTierTailAwait(
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.returnStatement) {
    return false;
  }
  match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        let awaitRoot = tree.root;
        if (
          (
            tree.nodes[awaitRoot].kind == ExpressionKind.tryExpression
            || tree.nodes[awaitRoot].kind
              == ExpressionKind.attemptExpression
          )
          && tree.nodes[awaitRoot].children.length == 1
        ) awaitRoot = tree.nodes[awaitRoot].children[0];
        if (
          tree.nodes[awaitRoot].kind != ExpressionKind.awaitExpression
          || tree.nodes[awaitRoot].children.length != 1
        ) return false;
        const operation = tree.nodes[awaitRoot].children[0];
        if (
          tree.nodes[operation].kind != ExpressionKind.callExpression
          || tree.nodes[operation].children.length == 0
        ) return false;
        const callee = tree.nodes[operation].children[0];
        return tree.nodes[callee].kind
            == ExpressionKind.identifierExpression
          || tree.nodes[callee].kind
            == ExpressionKind.memberExpression;
      }
      none => return false;
    }
    none => return false;
  }
}

function functionUsesFirstTierTailAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length != 1) return false;
  const root = declaration.body.roots[0];
  return statementIsFirstTierTailAwait(
    declaration.body,
    root
  );
}

function functionUsesFirstTierPlacedAsyncMethodTailAwait(
  moduleIndex: usize,
  in graph: ModuleGraph,
  in declaration: FunctionDeclaration
): boolean {
  if (
    moduleIndex >= graph.modules.length
    || declaration.body.roots.length != 1
  ) return false;
  const root = declaration.body.roots[0];
  if (
    declaration.body.nodes[root].kind != StatementKind.returnStatement
  ) return false;
  return match (in declaration.body.nodes[root].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const placement = tree.root;
        if (
          tree.nodes[placement].kind
            != ExpressionKind.executorPlacementExpression
          || tree.nodes[placement].value != "await"
          || tree.nodes[placement].labels.length < 3
          || tree.nodes[placement].labels[2] != "call"
          || tree.nodes[placement].children.length != 3
        ) return false;
        const operation = tree.nodes[placement].children[2];
        if (
          tree.nodes[operation].kind != ExpressionKind.callExpression
          || tree.nodes[operation].children.length == 0
        ) return false;
        const callee = tree.nodes[operation].children[0];
        if (
          tree.nodes[callee].kind != ExpressionKind.memberExpression
        ) return false;
        for (const resolution of graph.modules[moduleIndex]
          .semanticEvidence.callResolutions) {
          if (
            resolution.offset == tree.nodes[operation].offset
            && resolution.line == tree.nodes[operation].line
            && resolution.column == tree.nodes[operation].column
          ) return resolution.asynchronous
              && resolution.kind == "method";
        }
        return false;
      }
      none => false;
    }
    none => false;
  };
}

function functionUsesFirstTierPlacedAsyncFunctionTailAwaitSyntax(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length != 1) return false;
  const root = declaration.body.roots[0];
  if (
    declaration.body.nodes[root].kind != StatementKind.returnStatement
  ) return false;
  return match (in declaration.body.nodes[root].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const placement = tree.root;
        if (
          tree.nodes[placement].kind
            != ExpressionKind.executorPlacementExpression
          || tree.nodes[placement].value != "await"
          || tree.nodes[placement].labels.length < 3
          || tree.nodes[placement].labels[2] != "call"
          || tree.nodes[placement].children.length != 3
        ) return false;
        const operation = tree.nodes[placement].children[2];
        if (
          tree.nodes[operation].kind != ExpressionKind.callExpression
          || tree.nodes[operation].children.length == 0
        ) return false;
        const callee = tree.nodes[operation].children[0];
        return tree.nodes[callee].kind
          == ExpressionKind.identifierExpression;
      }
      none => false;
    }
    none => false;
  };
}

function placedAsyncFunctionCallIsTaskifiable(
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in tree: ExpressionTree,
  callIndex: usize
): boolean {
  if (moduleIndex >= graph.modules.length) return false;
  for (const resolution of graph.modules[moduleIndex]
    .semanticEvidence.callResolutions) {
    if (
      resolution.offset != tree.nodes[callIndex].offset
      || resolution.line != tree.nodes[callIndex].line
      || resolution.column != tree.nodes[callIndex].column
    ) continue;
    if (
      !resolution.asynchronous
      || resolution.kind != "function"
    ) return false;
    const targetModule = parsedModuleIndexForGraphModule(
      modules,
      graph,
      resolution.targetModuleIndex
    );
    if (targetModule >= modules.length) return false;
    let targetName = resolution.targetName.copyBytes(
      0,
      resolution.targetName.byteLength
    );
    if (
      resolution.targetModuleIndex < graph.modules.length
      && resolution.targetSymbolIndex < graph.modules[
        resolution.targetModuleIndex
      ].symbols.length
    ) {
      targetName = graph.modules[resolution.targetModuleIndex]
        .symbols[resolution.targetSymbolIndex].name.copyBytes(
          0,
          graph.modules[resolution.targetModuleIndex]
            .symbols[resolution.targetSymbolIndex].name.byteLength
        );
    }
    for (const target of modules[targetModule].program.functions) {
      if (target.name != targetName) continue;
      for (const targetRoot of target.body.roots) {
        if (
          statementContainsSuspension(target.body, targetRoot)
          && target.body.nodes[targetRoot].kind
            != StatementKind.expressionStatement
        ) return false;
      }
      return true;
    }
    return false;
  }
  return false;
}

function placedAsyncCallIsTaskifiable(
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in tree: ExpressionTree,
  callIndex: usize
): boolean {
  if (
    moduleIndex >= graph.modules.length
    || tree.nodes[callIndex].kind != ExpressionKind.callExpression
    || tree.nodes[callIndex].children.length == 0
  ) return false;
  const callee = tree.nodes[callIndex].children[0];
  if (
    tree.nodes[callee].kind == ExpressionKind.identifierExpression
  ) return placedAsyncFunctionCallIsTaskifiable(
      moduleIndex,
      modules,
      graph,
      tree,
      callIndex
    );
  if (tree.nodes[callee].kind != ExpressionKind.memberExpression) {
    return false;
  }
  for (const resolution of graph.modules[moduleIndex]
    .semanticEvidence.callResolutions) {
    if (
      resolution.offset == tree.nodes[callIndex].offset
      && resolution.line == tree.nodes[callIndex].line
      && resolution.column == tree.nodes[callIndex].column
    ) return resolution.asynchronous && resolution.kind == "method";
  }
  return false;
}

function functionUsesFirstTierPlacedAsyncFunctionTailAwait(
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in declaration: FunctionDeclaration
): boolean {
  if (
    moduleIndex >= graph.modules.length
    || !functionUsesFirstTierPlacedAsyncFunctionTailAwaitSyntax(
      declaration
    )
  ) return false;
  const root = declaration.body.roots[0];
  if (
    declaration.body.nodes[root].kind != StatementKind.returnStatement
  ) return false;
  return match (in declaration.body.nodes[root].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const placement = tree.root;
        if (
          tree.nodes[placement].kind
            != ExpressionKind.executorPlacementExpression
          || tree.nodes[placement].value != "await"
          || tree.nodes[placement].labels.length < 3
          || tree.nodes[placement].labels[2] != "call"
          || tree.nodes[placement].children.length != 3
        ) return false;
        const operation = tree.nodes[placement].children[2];
        if (
          tree.nodes[operation].kind != ExpressionKind.callExpression
          || tree.nodes[operation].children.length == 0
        ) return false;
        const callee = tree.nodes[operation].children[0];
        if (
          tree.nodes[callee].kind != ExpressionKind.identifierExpression
        ) return false;
        return placedAsyncFunctionCallIsTaskifiable(
          moduleIndex,
          modules,
          graph,
          tree,
          operation
        );
      }
      none => false;
    }
    none => false;
  };
}

function statementIsFirstTierPlacedAsyncAwaitLocalSyntax(
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.variableStatement) {
    return false;
  }
  return match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        let placement = tree.root;
        if (
          (
            tree.nodes[placement].kind == ExpressionKind.tryExpression
            || tree.nodes[placement].kind
              == ExpressionKind.attemptExpression
          )
          && tree.nodes[placement].children.length == 1
        ) placement = tree.nodes[placement].children[0];
        if (
          tree.nodes[placement].kind
            != ExpressionKind.executorPlacementExpression
          || tree.nodes[placement].value != "await"
          || tree.nodes[placement].labels.length < 3
          || tree.nodes[placement].labels[2] != "call"
          || tree.nodes[placement].children.length != 3
        ) return false;
        const operation = tree.nodes[placement].children[2];
        if (
          tree.nodes[operation].kind != ExpressionKind.callExpression
          || tree.nodes[operation].children.length == 0
        ) return false;
        const callee = tree.nodes[operation].children[0];
        for (const child of tree.nodes[placement].children) {
          if (expressionTreeContainsSuspension(
            arena,
            tree,
            child
          )) return false;
        }
        return tree.nodes[callee].kind
            == ExpressionKind.identifierExpression
          || tree.nodes[callee].kind
            == ExpressionKind.memberExpression;
      }
      none => false;
    }
    none => false;
  };
}

function functionUsesFirstTierPlacedAsyncLinearAwaitSyntax(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length < 2) return false;
  let awaitCount: usize = 0;
  for (const root of declaration.body.roots) {
    if (statementIsFirstTierPlacedAsyncAwaitLocalSyntax(
      declaration.body,
      root
    )) {
      awaitCount = awaitCount + 1;
      continue;
    }
    if (statementContainsSuspension(declaration.body, root)) return false;
  }
  return awaitCount == 1;
}

function functionUsesFirstTierPlacedAsyncLinearAwait(
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in declaration: FunctionDeclaration
): boolean {
  if (
    !functionUsesFirstTierPlacedAsyncLinearAwaitSyntax(
      declaration
    )
  ) return false;
  for (const root of declaration.body.roots) {
    if (!statementIsFirstTierPlacedAsyncAwaitLocalSyntax(
      declaration.body,
      root
    )) continue;
    return match (in declaration.body.nodes[root].expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          let placement = tree.root;
          if (
            (
              tree.nodes[placement].kind == ExpressionKind.tryExpression
              || tree.nodes[placement].kind
                == ExpressionKind.attemptExpression
            )
            && tree.nodes[placement].children.length == 1
          ) placement = tree.nodes[placement].children[0];
          const operation = tree.nodes[placement].children[2];
          return placedAsyncCallIsTaskifiable(
            moduleIndex,
            modules,
            graph,
            tree,
            operation
          );
        }
        none => false;
      }
      none => false;
    };
  }
  return false;
}

function statementUsesOnlyFirstTierTailAwaitSuspension(
  in arena: StatementArena,
  index: usize
): boolean {
  if (!statementContainsSuspension(arena, index)) return true;
  if (statementIsFirstTierTailAwait(arena, index)) return true;
  if (
    arena.nodes[index].kind == StatementKind.asyncScopeStatement
    || arena.nodes[index].kind == StatementKind.forAwaitStatement
    || arena.nodes[index].kind == StatementKind.forTryAwaitStatement
  ) return false;
  match (in arena.nodes[index].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        if (!expressionTreeUsesOnlyFirstTierTailAwaitSuspension(
          arena,
          tree,
          root
        )) return false;
      }
      none => {}
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        if (!expressionTreeUsesOnlyFirstTierTailAwaitSuspension(
          arena,
          tree,
          root
        )) return false;
      }
      none => {}
    }
    none => {}
  }
  for (const child of arena.nodes[index].children) {
    if (!statementUsesOnlyFirstTierTailAwaitSuspension(
      arena,
      child
    )) return false;
  }
  return true;
}

function expressionTreeUsesOnlyFirstTierTailAwaitSuspension(
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.awaitExpression
    || tree.nodes[index].kind
      == ExpressionKind.executorPlacementExpression
  ) return false;
  if (tree.nodes[index].kind == ExpressionKind.closureExpression) return true;
  for (const statement of tree.nodes[index].statements) {
    if (!statementUsesOnlyFirstTierTailAwaitSuspension(
      arena,
      statement
    )) return false;
  }
  for (const child of tree.nodes[index].children) {
    if (!expressionTreeUsesOnlyFirstTierTailAwaitSuspension(
      arena,
      tree,
      child
    )) return false;
  }
  return true;
}

function expressionTreeFirstTierTailAwaitCount(
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize
): usize {
  if (tree.nodes[index].kind == ExpressionKind.closureExpression) return 0;
  let count: usize = 0;
  for (const statement of tree.nodes[index].statements) {
    count = count + statementFirstTierTailAwaitCount(arena, statement);
  }
  for (const child of tree.nodes[index].children) {
    count = count + expressionTreeFirstTierTailAwaitCount(
      arena,
      tree,
      child
    );
  }
  return count;
}

function statementFirstTierTailAwaitCount(
  in arena: StatementArena,
  index: usize
): usize {
  if (statementIsFirstTierTailAwait(arena, index)) return 1;
  let count: usize = 0;
  match (in arena.nodes[index].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        count = count + expressionTreeFirstTierTailAwaitCount(
          arena,
          tree,
          root
        );
      }
      none => {}
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        const root = tree.root;
        count = count + expressionTreeFirstTierTailAwaitCount(
          arena,
          tree,
          root
        );
      }
      none => {}
    }
    none => {}
  }
  for (const child of arena.nodes[index].children) {
    count = count + statementFirstTierTailAwaitCount(arena, child);
  }
  return count;
}

function functionUsesFirstTierMatchedTailAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (functionUsesReturnedMatchTailAwait(declaration)) return true;
  if (declaration.body.roots.length == 0) return false;
  let position: usize = 0;
  while (position + 1 < declaration.body.roots.length) {
    const root = declaration.body.roots[position];
    if (statementContainsSuspension(declaration.body, root)) return false;
    position = position + 1;
  }
  const tail = declaration.body.roots[
    declaration.body.roots.length - 1
  ];
  return declaration.body.nodes[tail].kind == StatementKind.matchStatement
    && statementFirstTierTailAwaitCount(declaration.body, tail) == 1
    && statementUsesOnlyFirstTierTailAwaitSuspension(
      declaration.body,
      tail
    );
}

function statementContainsNestedLoopOrMatch(
  in arena: StatementArena,
  index: usize
): boolean {
  if (
    arena.nodes[index].kind == StatementKind.whileStatement
    || arena.nodes[index].kind == StatementKind.forStatement
    || arena.nodes[index].kind == StatementKind.matchStatement
  ) return true;
  for (const child of arena.nodes[index].children) {
    if (statementContainsNestedLoopOrMatch(arena, child)) return true;
  }
  return false;
}

function functionUsesFirstTierBranchedTailAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length < 2) return false;
  let awaitCount: usize = 0;
  for (const root of declaration.body.roots) {
    if (!statementContainsSuspension(declaration.body, root)) continue;
    const kind = declaration.body.nodes[root].kind;
    if (
      kind != StatementKind.ifStatement
      && kind != StatementKind.returnStatement
    ) return false;
    if (statementContainsNestedLoopOrMatch(
      declaration.body,
      root
    )) return false;
    if (!statementUsesOnlyFirstTierTailAwaitSuspension(
      declaration.body,
      root
    )) return false;
    awaitCount = awaitCount + statementFirstTierTailAwaitCount(
      declaration.body,
      root
    );
  }
  return awaitCount > 1;
}

function statementIsFirstTierAwaitLocal(
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.variableStatement) {
    return false;
  }
  return match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        let root = tree.root;
        // `attempt` materializes the awaited Result in the local rather than
        // propagating it.  The native linear frame already stores that Result
        // verbatim, so this has the same suspension shape as a bare await.
        if (
          tree.nodes[root].kind == ExpressionKind.attemptExpression
          && tree.nodes[root].children.length == 1
        ) root = tree.nodes[root].children[0];
        if (
          tree.nodes[root].kind != ExpressionKind.awaitExpression
          || tree.nodes[root].children.length != 1
        ) return false;
        const operation = tree.nodes[root].children[0];
        if (
          tree.nodes[operation].kind != ExpressionKind.callExpression
          || tree.nodes[operation].children.length == 0
        ) return false;
        const callee = tree.nodes[operation].children[0];
        select tree.nodes[callee].kind
            == ExpressionKind.identifierExpression
          || tree.nodes[callee].kind == ExpressionKind.memberExpression;
      }
      none => false;
    }
    none => false;
  };
}

function statementContainsLexicalFrameLocal(in arena: StatementArena, index: usize): boolean {
  const kind = arena.nodes[index].kind;
  if (kind == StatementKind.variableStatement || kind == StatementKind.destructureStatement) return true;
  for (const child of arena.nodes[index].children) {
    if (statementContainsLexicalFrameLocal(arena, child)) return true;
  }
  return false;
}

function statementIsStructuredJoinAwait(
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.expressionStatement) return false;
  const parsedModule = parsedModuleIndexForGraphModule(modules, graph, moduleIndex);
  if (parsedModule >= modules.length) return false;
  return match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (tree.nodes[root].kind != ExpressionKind.awaitExpression
          || tree.nodes[root].children.length != 1) return false;
        const call = tree.nodes[root].children[0];
        if (tree.nodes[call].kind != ExpressionKind.callExpression
          || tree.nodes[call].children.length != 1) return false;
        const callee = tree.nodes[call].children[0];
        if (tree.nodes[callee].kind != ExpressionKind.memberExpression
          || tree.nodes[callee].children.length != 1
          || (tree.nodes[callee].value != "close" && tree.nodes[callee].value != "cancel")) return false;
        const receiver = tree.nodes[callee].children[0];
        const typeName = resolvedExpressionType(graph, moduleIndex, tree, receiver);
        if (tree.nodes[callee].value == "cancel"
          && isNativeThreadBinding(modules[parsedModule].program, arena, tree, receiver)) return true;
        // The intrinsic Task identity, not a method's spelling, authorizes a
        // worker cancellation join. Ordinary user-defined cancel methods do
        // not acquire continuation semantics here.
        if (tree.nodes[callee].value == "cancel") {
          match (genericTypeShape(typeName)) {
            some(shape) => if (shape.base == "Task") return true;
            none => {}
          }
        }
        for (const imported of modules[parsedModule].program.imports) {
          if (imported.header != "std/async") continue;
          for (const binding of imported.bindings) {
            if (binding.importedName == "TaskScope" && binding.localName == typeName) return true;
          }
        }
        return false;
      }
      none => false;
    }
    none => false;
  };
}

function functionUsesFirstTierLinearAwait(
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length < 2) return false;
  let awaitCount: usize = 0;
  for (const root of declaration.body.roots) {
    if (!statementContainsSuspension(declaration.body, root)) continue;
    if (awaitCount == 1 && statementIsStructuredJoinAwait(
      moduleIndex, modules, graph, declaration.body, root
    )) continue;
    if (awaitCount == 0) {
      const kind = declaration.body.nodes[root].kind;
      if (
        (kind == StatementKind.ifStatement || kind == StatementKind.returnStatement)
        && !statementContainsNestedLoopOrMatch(declaration.body, root)
        && !statementContainsLexicalFrameLocal(declaration.body, root)
        && statementUsesOnlyFirstTierTailAwaitSuspension(declaration.body, root)
      ) continue;
    }
    if (!statementIsFirstTierAwaitLocal(
      declaration.body,
      root
    )) return false;
    awaitCount = awaitCount + 1;
  }
  return awaitCount == 1;
}

function functionUsesFirstTierDoubleAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length < 3) return false;
  let awaitCount: usize = 0;
  for (const root of declaration.body.roots) {
    if (!statementContainsSuspension(declaration.body, root)) continue;
    if (
      !statementIsFirstTierAwaitLocal(declaration.body, root)
      && !statementIsFirstTierPlacedAsyncAwaitLocalSyntax(
        declaration.body,
        root
      )
    ) return false;
    awaitCount = awaitCount + 1;
  }
  return awaitCount == 2;
}

function functionUsesFirstTierDoubleAwaitWithTaskifiablePlacements(
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in declaration: FunctionDeclaration
): boolean {
  if (!functionUsesFirstTierDoubleAwait(declaration)) return false;
  for (const root of declaration.body.roots) {
    if (!statementIsFirstTierPlacedAsyncAwaitLocalSyntax(
      declaration.body,
      root
    )) continue;
    const taskifiable = match (in declaration.body.nodes[root].expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          let placement = tree.root;
          if (
            (
              tree.nodes[placement].kind == ExpressionKind.tryExpression
              || tree.nodes[placement].kind
                == ExpressionKind.attemptExpression
            )
            && tree.nodes[placement].children.length == 1
          ) placement = tree.nodes[placement].children[0];
          const operation = tree.nodes[placement].children[2];
          select placedAsyncCallIsTaskifiable(
            moduleIndex,
            modules,
            graph,
            tree,
            operation
          );
        }
        none => false;
      }
      none => false;
    };
    if (!taskifiable) return false;
  }
  return true;
}

function functionUsesFirstTierPrefixedTailAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length < 2) return false;
  let position: usize = 0;
  while (position + 1 < declaration.body.roots.length) {
    const root = declaration.body.roots[position];
    if (
      statementContainsSuspension(declaration.body, root)
    ) return false;
    const kind = declaration.body.nodes[root].kind;
    if (
      kind != StatementKind.variableStatement
      && kind != StatementKind.ifStatement
      && kind != StatementKind.whileStatement
      && kind != StatementKind.assignmentStatement
      && kind != StatementKind.expressionStatement
    ) return false;
    if (kind == StatementKind.variableStatement) {
      if (declaration.body.nodes[root].children.length > 0) return false;
      match (in declaration.body.nodes[root].expression) {
        some(_) => {}
        none => return false;
      }
    }
    position = position + 1;
  }
  const tail = declaration.body.roots[
    declaration.body.roots.length - 1
  ];
  return statementIsFirstTierTailAwait(declaration.body, tail);
}

function functionHasFirstTierTailAwaitStorage(
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in declaration: FunctionDeclaration,
  in owner: String
): boolean {
  if (
    moduleIndex >= modules.length
    || moduleIndex >= graph.modules.length
    || (
      !functionUsesFirstTierTailAwait(declaration)
      && !functionUsesFirstTierPlacedAsyncFunctionTailAwait(
        moduleIndex,
        modules,
        graph,
        declaration
      )
      && !functionUsesFirstTierPlacedAsyncLinearAwait(
        moduleIndex,
        modules,
        graph,
        declaration
      )
      && !functionUsesFirstTierPlacedAsyncMethodTailAwait(
        moduleIndex,
        graph,
        declaration
      )
      && !functionUsesFirstTierPrefixedTailAwait(declaration)
      && !functionUsesFirstTierMatchedTailAwait(declaration)
      && !(
        owner.byteLength == 0
        && functionUsesFirstTierBranchedTailAwait(declaration)
      )
      && !functionUsesFirstTierLinearAwait(moduleIndex, modules, graph, declaration)
      && !functionUsesFirstTierDoubleAwaitWithTaskifiablePlacements(
        moduleIndex,
        modules,
        graph,
        declaration
      )
    )
  ) return false;
  match (in declaration.errorType) {
    some(_) => if (
      !functionUsesReturnedMatchTailAwait(declaration)
      &&
      !functionUsesFirstTierLinearAwait(moduleIndex, modules, graph, declaration)
      && !functionUsesFirstTierPlacedAsyncLinearAwait(
        moduleIndex,
        modules,
        graph,
        declaration
      )
    ) return false;
    none => {}
  }
  if (owner.byteLength > 0) {
    let supportedOwner = false;
    for (const aggregate of modules[moduleIndex].program.aggregates) {
      if (aggregate.name != owner) continue;
      supportedOwner = aggregate.kind == DeclarationKind.classDeclaration
        && declaration.receiverMode == ReceiverMode.none;
    }
    if (!supportedOwner) return false;
  }
  for (const parameter of declaration.parameters) {
    if (parameter.mode == ParameterMode.input) continue;
    if (parameter.mode != ParameterMode.value) return false;
  }
  return true;
}

function functionHasFirstTierSchedulerYieldStorage(
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in declaration: FunctionDeclaration,
  in owner: String
): boolean {
  if (
    moduleIndex >= modules.length
    || moduleIndex >= graph.modules.length
    || !functionUsesFirstTierSchedulerYield(
      modules[moduleIndex].program,
      declaration
    )
  ) return false;
  match (in declaration.errorType) {
    some(_) => return false;
    none => {}
  }
  let visiting = Array<String>();
  if (owner.byteLength > 0) {
    let supportedOwner = false;
    for (const aggregate of modules[moduleIndex].program.aggregates) {
      if (aggregate.name != owner) continue;
      supportedOwner = aggregate.kind == DeclarationKind.classDeclaration
        && declaration.receiverMode == ReceiverMode.none;
    }
    if (!supportedOwner) return false;
  } else {
    if (typeHasCleanup(
      graph.modules,
      moduleIndex,
      declaration.returnType.name,
      visiting
    )) return false;
  }
  for (const parameter of declaration.parameters) {
    if (
      owner.byteLength > 0
      && parameter.mode == ParameterMode.input
    ) continue;
    if (parameter.mode != ParameterMode.value) return false;
    visiting = Array<String>();
    if (typeHasCleanup(
      graph.modules,
      moduleIndex,
      parameter.type.name,
      visiting
    )) return false;
  }
  return true;
}

function parsedModuleIndexForGraphModule(
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  graphModuleIndex: usize
): usize {
  if (graphModuleIndex >= graph.modules.length) return modules.length;
  const path = graph.modules[graphModuleIndex].path.copyBytes(
    0,
    graph.modules[graphModuleIndex].path.byteLength
  );
  let index: usize = 0;
  while (index < modules.length) {
    if (modules[index].path == path) return index;
    index = index + 1;
  }
  return modules.length;
}

// The type one instance's evidence recorded for an expression.
function instanceExpressionType(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): String {
  for (const resolution of evidence.expressionResolutions) {
    if (
      resolution.offset == tree.nodes[index].offset
      && resolution.line == tree.nodes[index].line
      && resolution.column == tree.nodes[index].column
    ) return copy resolution.typeName;
  }
  if (tree.nodes[index].kind != ExpressionKind.identifierExpression) return "";
  let selectedOffset: usize = 0;
  let selectedType = "";
  for (const binding of evidence.bindingResolutions) {
    if (
      binding.name == tree.nodes[index].value
      && binding.offset < tree.nodes[index].offset
      && (selectedType.byteLength == 0 || binding.offset >= selectedOffset)
    ) {
      selectedOffset = binding.offset;
      selectedType = copy binding.typeName;
    }
  }
  return selectedType;
}

function requireInstanceExpressionCopies(
  in path: String,
  in graph: ModuleGraph,
  moduleIndex: usize,
  in syntax: Option<ExpressionSyntax>,
  in evidence: ModuleSemanticEvidence
): void throws ModuleResolveError {
  match (in syntax) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        let index: usize = 0;
        while (index < tree.nodes.length) {
          const node = view tree.nodes[index];
          if (
            node.kind == ExpressionKind.unaryExpression
            && node.value == "copy"
            && node.children.length == 1
            && !expressionIsStructSpreadCapability(tree, index)
          ) {
            const operandType = instanceExpressionType(evidence, tree, node.children[0]);
            if (operandType.byteLength > 0 && !nativeExplicitCopyTypeSupported(graph, moduleIndex, operandType)) {
              throw loweringBoundary(path, "Z1000",
                `explicit copy of "${operandType}" is not executable in the native compiler yet`,
                node.line, node.column, 4);
            }
          }
          index = index + 1;
        }
      }
      none => {}
    }
    none => {}
  }
}

// The explicit copies in one instance of a generic body, held with the
// instance's own types to what the native compiler copies: at definition a
// type parameter waited for this.
export function requireNativeInstanceCopies(
  in path: String,
  in graph: ModuleGraph,
  moduleIndex: usize,
  in body: StatementArena,
  in evidence: ModuleSemanticEvidence
): void throws ModuleResolveError {
  for (const statement of body.nodes) {
    try requireInstanceExpressionCopies(path, graph, moduleIndex, statement.expression, evidence);
    try requireInstanceExpressionCopies(path, graph, moduleIndex, statement.secondExpression, evidence);
  }
}

function resolvedExpressionType(
  in graph: ModuleGraph,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize
): String {
  if (moduleIndex >= graph.modules.length) return "";
  for (const resolution of graph.modules[moduleIndex].semanticEvidence.expressionResolutions) {
    if (
      resolution.offset == tree.nodes[index].offset
      && resolution.line == tree.nodes[index].line
      && resolution.column == tree.nodes[index].column
    ) return resolution.typeName.copyBytes(0, resolution.typeName.byteLength);
  }
  const nodeKind = tree.nodes[index].kind;
  const nodeValue = tree.nodes[index].value.copyBytes(
    0,
    tree.nodes[index].value.byteLength
  );
  const nodeOffset = tree.nodes[index].offset;
  if (nodeKind == ExpressionKind.identifierExpression) {
    return resolvedLocalBindingType(
      graph,
      moduleIndex,
      nodeValue,
      nodeOffset
    );
  }
  if (
    nodeKind == ExpressionKind.arrayExpression
    && tree.nodes[index].children.length > 0
  ) {
    const first = tree.nodes[index].children[0];
    const elementType = resolvedExpressionType(
      graph,
      moduleIndex,
      tree,
      first
    );
    if (elementType.byteLength > 0) {
      return `${elementType}[${tree.nodes[index].children.length}]`;
    }
  }
  if (
    nodeKind == ExpressionKind.memberExpression
    && tree.nodes[index].children.length == 1
  ) {
    if (nodeValue == "byteLength") return "usize";
    if (nodeValue == "isEmpty") return "boolean";
    const receiver = tree.nodes[index].children[0];
    const receiverType = resolvedExpressionType(
      graph,
      moduleIndex,
      tree,
      receiver
    );
    match (aggregateFieldShape(
      graph.modules,
      moduleIndex,
      receiverType,
      nodeValue
    )) {
      some(field) => return field.typeName.copyBytes(
        0,
        field.typeName.byteLength
      );
      none => {}
    }
    if (nodeValue == "length") {
      const lengthOwnerType = transparentTypeName(graph.modules, moduleIndex, receiverType);
      if (collectionHasLength(lengthOwnerType)) return "usize";
    }
  }
  return "";
}

function resolvedLocalBindingType(
  in graph: ModuleGraph,
  moduleIndex: usize,
  in name: String,
  useOffset: usize
): String {
  if (moduleIndex >= graph.modules.length) return "";
  let selectedOffset: usize = 0;
  let selectedType = "";
  for (const binding of graph.modules[moduleIndex].semanticEvidence.bindingResolutions) {
    if (
      binding.name == name
      && binding.offset < useOffset
      && (selectedType.byteLength == 0 || binding.offset >= selectedOffset)
    ) {
      selectedOffset = binding.offset;
      selectedType = binding.typeName.copyBytes(0, binding.typeName.byteLength);
    }
  }
  return selectedType;
}

function closureParameterNamed(
  in tree: ExpressionTree,
  closureIndex: usize,
  in name: String
): boolean {
  for (const child of tree.nodes[closureIndex].children) {
    if (
      tree.nodes[child].kind == ExpressionKind.closureParameterExpression
      && tree.nodes[child].value == name
    ) return true;
  }
  return false;
}

// A value of `typeName` captured into a thread.spawn closure moves to the
// worker thread; native lowering transfers Strings, task scopes, endpoints
// and lifetimes it can share, and values without cleanup.
function requireNativeThreadCaptureType(
  in path: String,
  moduleIndex: usize,
  in graph: ModuleGraph,
  in captureName: String,
  in typeName: String,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  const actualType = transparentTypeName(graph.modules, moduleIndex, typeName);
  // An endpoint crosses only with a message type that can; an optional one
  // is an ownership-bearing Option.
  const optionalTarget = nullableTargetType(actualType);
  const channelEndpoint = optionalTarget.byteLength == 0 && (
    stringStartsWith(actualType, "Sender<")
    || stringStartsWith(actualType, "SyncSender<")
    || stringStartsWith(actualType, "Receiver<")
    || stringStartsWith(actualType, "SyncReceiver<")
  ) && typeIsThreadTransferable(graph.modules, moduleIndex, actualType);
  const sharedOnceLifetime = stringStartsWith(actualType, "OnceLifetime<")
    && typeIsThreadTransferable(graph.modules, moduleIndex, actualType);
  if (
    typeName.byteLength > 0
    && typeName != "String"
    && typeName != "TextBuffer"
    && typeName != "TaskScope"
    && !channelEndpoint
    && !sharedOnceLifetime
    && moduleIndex < graph.modules.length
  ) {
    let visiting = Array<String>();
    if (typeHasCleanup(
      graph.modules,
      moduleIndex,
      typeName,
      visiting
    )) {
      let sharedClassCandidate = false;
      match (typeSymbolLocation(graph.modules, moduleIndex, typeName)) {
        some(location) => sharedClassCandidate = graph.modules[location.moduleIndex]
          .symbols[location.symbolIndex].kind == ModuleSymbolKind.classSymbol;
        none => {}
      }
      if (!sharedClassCandidate) {
        let length = captureName.byteLength;
        if (length == 0) length = 1;
        throw loweringBoundary(
          path,
          "Z1000",
          `ownership-bearing thread.spawn capture "${captureName}" of type "${typeName}" is not executable in the native compiler yet`,
          line,
          column,
          length
        );
      }
    }
  }
}

function validateNativeThreadCaptureExpression(
  in path: String,
  moduleIndex: usize,
  in graph: ModuleGraph,
  in tree: ExpressionTree,
  closureIndex: usize,
  index: usize,
  directCallee: boolean
): void throws ModuleResolveError {
  const node = view tree.nodes[index];
  if (
    node.kind == ExpressionKind.identifierExpression
    && !directCallee
    && !closureParameterNamed(tree, closureIndex, node.value)
  ) {
    const typeName = resolvedLocalBindingType(graph, moduleIndex, node.value, node.offset);
    try requireNativeThreadCaptureType(path, moduleIndex, graph, node.value, typeName, node.line, node.column);
  }
  let childIndex: usize = 0;
  while (childIndex < node.children.length) {
    const child = node.children[childIndex];
    try validateNativeThreadCaptureExpression(
      path,
      moduleIndex,
      graph,
      tree,
      closureIndex,
      child,
      node.kind == ExpressionKind.callExpression && childIndex == 0
    );
    childIndex = childIndex + 1;
  }
}

// The enclosing declaration of a block-bodied thread closure: its first
// offset, its parameters, and the closure's own first offset.
struct ThreadBlockScope {
  start: usize;
  parameters: Array<Parameter>;
  closureOffset: usize;
}

// The type a name used inside a block-bodied thread closure carries across:
// that of the binding it names, a parameter, an annotated declaration, or an
// inferred one, when that binding comes before the closure; "" for the
// closure's own locals or for a name that binds nothing there.
function threadBlockCaptureType(
  in graph: ModuleGraph,
  moduleIndex: usize,
  in body: StatementArena,
  in enclosing: ThreadBlockScope,
  in name: String,
  useOffset: usize
): String {
  if (moduleIndex >= graph.modules.length) return "";
  let found = false;
  let selectedOffset: usize = 0;
  let selectedType = "";
  for (const parameter of enclosing.parameters) {
    if (parameter.name == name) {
      found = true;
      selectedOffset = parameter.offset;
      selectedType = copy parameter.type.name;
    }
  }
  for (const statement of body.nodes) {
    if (statement.name != name || statement.nameOffset < enclosing.start || statement.nameOffset >= useOffset) continue;
    if (found && statement.nameOffset < selectedOffset) continue;
    match (in statement.typeAnnotation) {
      some(annotation) => {
        found = true;
        selectedOffset = statement.nameOffset;
        selectedType = copy annotation.name;
      }
      none => {}
    }
  }
  for (const binding of graph.modules[moduleIndex].semanticEvidence.bindingResolutions) {
    if (
      binding.name == name
      && binding.offset >= enclosing.start
      && binding.offset < useOffset
      && (!found || binding.offset >= selectedOffset)
    ) {
      found = true;
      selectedOffset = binding.offset;
      selectedType = copy binding.typeName;
    }
  }
  if (!found || selectedOffset >= enclosing.closureOffset) return "";
  return selectedType;
}

// The block-bodied closure the call at `index` hands to `thread.spawn`, or
// past the end of the tree.
function threadSpawnBlockClosure(in tree: ExpressionTree, index: usize): usize {
  const none = tree.nodes.length;
  if (tree.nodes[index].kind != ExpressionKind.callExpression || tree.nodes[index].children.length != 2) return none;
  const callee = tree.nodes[index].children[0];
  if (
    tree.nodes[callee].kind != ExpressionKind.memberExpression
    || tree.nodes[callee].value != "spawn"
    || tree.nodes[callee].children.length != 1
  ) return none;
  const receiver = tree.nodes[callee].children[0];
  if (tree.nodes[receiver].kind != ExpressionKind.identifierExpression || tree.nodes[receiver].value != "thread") return none;
  const closure = tree.nodes[index].children[1];
  if (
    tree.nodes[closure].kind != ExpressionKind.closureExpression
    || tree.nodes[closure].labels.length < 3
    || tree.nodes[closure].labels[2] != "block"
  ) return none;
  return closure;
}

function validateThreadBlockSyntaxCaptures(
  in path: String,
  moduleIndex: usize,
  in graph: ModuleGraph,
  in body: StatementArena,
  in enclosing: ThreadBlockScope,
  in syntax: Option<ExpressionSyntax>
): void throws ModuleResolveError {
  match (in syntax) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        // A called name is a function, not a value that crosses.
        let callees = Array<boolean>();
        callees.appendRepeated(false, tree.nodes.length);
        for (const node of tree.nodes) {
          if (node.kind == ExpressionKind.callExpression && node.children.length > 0) {
            callees[node.children[0]] = true;
          }
        }
        let index: usize = 0;
        while (index < tree.nodes.length) {
          const node = view tree.nodes[index];
          if (node.kind == ExpressionKind.identifierExpression && !callees[index]) {
            const typeName = threadBlockCaptureType(graph, moduleIndex, body, enclosing, node.value, node.offset);
            if (typeName.byteLength > 0) {
              try requireNativeThreadCaptureType(path, moduleIndex, graph, node.value, typeName, node.line,
                node.column);
            }
          }
          for (const statement of node.statements) {
            try validateThreadBlockStatementCaptures(path, moduleIndex, graph, body, enclosing, statement);
          }
          index = index + 1;
        }
      }
      none => {}
    }
    none => {}
  }
}

function validateThreadBlockStatementCaptures(
  in path: String,
  moduleIndex: usize,
  in graph: ModuleGraph,
  in body: StatementArena,
  in enclosing: ThreadBlockScope,
  index: usize
): void throws ModuleResolveError {
  const statement = view body.nodes[index];
  try validateThreadBlockSyntaxCaptures(path, moduleIndex, graph, body, enclosing, statement.expression);
  try validateThreadBlockSyntaxCaptures(path, moduleIndex, graph, body, enclosing, statement.secondExpression);
  for (const child of statement.children) {
    try validateThreadBlockStatementCaptures(path, moduleIndex, graph, body, enclosing, child);
  }
}

// What a block-bodied thread.spawn closure uses from outside it crosses to
// the worker thread, held to what native lowering transfers, as an
// expression body's captures are.
function validateNativeThreadBlockCaptures(
  in path: String,
  moduleIndex: usize,
  in graph: ModuleGraph,
  in body: StatementArena,
  scopeStart: usize,
  in parameters: Array<Parameter>
): void throws ModuleResolveError {
  for (const statement of body.nodes) {
    try validateThreadSpawnBlocks(path, moduleIndex, graph, body, scopeStart, parameters, statement.expression);
    try validateThreadSpawnBlocks(path, moduleIndex, graph, body, scopeStart, parameters, statement.secondExpression);
  }
}

function validateThreadSpawnBlocks(
  in path: String,
  moduleIndex: usize,
  in graph: ModuleGraph,
  in body: StatementArena,
  scopeStart: usize,
  in parameters: Array<Parameter>,
  in syntax: Option<ExpressionSyntax>
): void throws ModuleResolveError {
  match (in syntax) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        let index: usize = 0;
        while (index < tree.nodes.length) {
          const closure = threadSpawnBlockClosure(tree, index);
          if (closure < tree.nodes.length) {
            const enclosing = ThreadBlockScope({
              start: scopeStart,
              parameters: copy parameters,
              closureOffset: tree.nodes[closure].offset,
            });
            for (const statement of tree.nodes[closure].statements) {
              try validateThreadBlockStatementCaptures(path, moduleIndex, graph, body, enclosing, statement);
            }
          }
          index = index + 1;
        }
      }
      none => {}
    }
    none => {}
  }
}

function timerSegmentExpressionCanComplete(
  in arena: StatementArena, in tree: ExpressionTree, index: usize
): boolean {
  const node = view tree.nodes[index];
  // A nested closure returns to its own function, not the timer frame.
  if (node.kind == ExpressionKind.closureExpression) return false;
  if (node.kind == ExpressionKind.tryExpression) return true;
  for (const child of node.children) {
    if (timerSegmentExpressionCanComplete(arena, tree, child)) return true;
  }
  for (const statement of node.statements) {
    if (timerSegmentStatementCanComplete(arena, statement)) return true;
  }
  return false;
}

function timerSegmentStatementCanComplete(in arena: StatementArena, index: usize): boolean {
  const statement = view arena.nodes[index];
  if (statement.kind == StatementKind.returnStatement
    || statement.kind == StatementKind.throwStatement) return true;
  match (in statement.expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (timerSegmentExpressionCanComplete(arena, tree, root)) return true;
      }
      none => {}
    }
    none => {}
  }
  for (const child of statement.children) {
    if (timerSegmentStatementCanComplete(arena, child)) return true;
  }
  return false;
}

function statementIsDirectTimer(
  in program: Program, in arena: StatementArena, index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.expressionStatement) return false;
  match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (tree.nodes[root].kind != ExpressionKind.awaitExpression
          || tree.nodes[root].children.length != 1) return false;
        const call = tree.nodes[root].children[0];
        if (tree.nodes[call].kind != ExpressionKind.callExpression
          || tree.nodes[call].children.length != 2) return false;
        const callee = tree.nodes[call].children[0];
        return tree.nodes[callee].kind == ExpressionKind.identifierExpression
          && importedStandardBinding(program, "std/time", "delay", tree.nodes[callee].value);
      }
      none => {}
    }
    none => {}
  }
  return false;
}

function linearTimerNeedsCompletionForwarding(
  in program: Program, in declaration: FunctionDeclaration
): boolean {
  // Structured suspending branches/loops have their own completion protocol.
  for (const root of declaration.body.roots) {
    if (declaration.body.nodes[root].kind != StatementKind.expressionStatement
      && statementContainsSuspension(declaration.body, root)) return false;
  }
  let canComplete = false;
  for (const root of declaration.body.roots) {
    if (statementIsDirectTimer(program, declaration.body, root) && canComplete) return true;
    if (timerSegmentStatementCanComplete(declaration.body, root)) canComplete = true;
  }
  return false;
}

function placedCallTargetSuspends(
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  moduleIndex: usize,
  in tree: ExpressionTree,
  callIndex: usize,
  requireUnforwardedCompletion: boolean
): boolean {
  if (moduleIndex >= graph.modules.length) return false;
  for (const resolution of graph.modules[moduleIndex].semanticEvidence.callResolutions) {
    if (
      resolution.offset != tree.nodes[callIndex].offset
      || resolution.line != tree.nodes[callIndex].line
      || resolution.column != tree.nodes[callIndex].column
    ) continue;
    const targetModule = parsedModuleIndexForGraphModule(
      modules,
      graph,
      resolution.targetModuleIndex
    );
    if (targetModule >= modules.length) return false;
    let targetName = resolution.targetName.copyBytes(
      0,
      resolution.targetName.byteLength
    );
    if (
      resolution.targetModuleIndex < graph.modules.length
      && resolution.targetSymbolIndex
        < graph.modules[resolution.targetModuleIndex].symbols.length
    ) {
      targetName = graph.modules[resolution.targetModuleIndex]
        .symbols[resolution.targetSymbolIndex]
        .name.copyBytes(
          0,
          graph.modules[resolution.targetModuleIndex]
            .symbols[resolution.targetSymbolIndex].name.byteLength
        );
    }
    for (const declaration of modules[targetModule].program.functions) {
      if (declaration.name == targetName) {
        if (requireUnforwardedCompletion) {
          return linearTimerNeedsCompletionForwarding(modules[targetModule].program, declaration);
        }
        return functionContainsSuspension(declaration);
      }
    }
    return false;
  }
  return false;
}

function expressionIsTailPlacement(
  in tree: ExpressionTree,
  current: usize,
  placement: usize
): boolean {
  if (current == placement) return true;
  if (
    tree.nodes[current].kind == ExpressionKind.tryExpression
    && tree.nodes[current].children.length == 1
  ) {
    const child = tree.nodes[current].children[0];
    return expressionIsTailPlacement(
      tree,
      child,
      placement
    );
  }
  return false;
}

// The type parameters of the declarations a body belongs to.
function declaredTypeParameterNames(
  in outer: Array<String>,
  in declared: Array<TypeParameter>
): Array<String> {
  let names = copy outer;
  for (const parameter of declared) {
    names.push(copy parameter.name);
  }
  return names;
}

function typeMentionsAnyParameter(in typeName: String, in typeParameters: Array<String>): boolean {
  for (const parameter of typeParameters) {
    if (typeMentionsParameter(typeName, parameter)) return true;
  }
  return false;
}

function validateNativeExpressionTree(
  in path: String,
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in tree: ExpressionTree,
  tailPosition: boolean,
  allowNonTailPlacedAsyncCall: boolean,
  in typeParameters: Array<String>
): void throws ModuleResolveError {
  const treeRoot = tree.root;
  let index: usize = 0;
  while (index < tree.nodes.length) {
    const node = view tree.nodes[index];
    for (const type of node.typeReferences) {
      try validateNativeType(path, type);
    }
    if (node.kind == ExpressionKind.arrayExpression) {
      const typeName = resolvedExpressionType(
        graph,
        moduleIndex,
        tree,
        index
      );
      if (
        typeName.byteLength > 0
        && !nativeFixedArrayTypeSupported(typeName)
      ) {
        throw loweringBoundary(
          path,
          "Z1000",
          `native array literal resolved to unsupported storage "${typeName}"`,
          node.line,
          node.column,
          1
        );
      }
    }
    if (
      node.kind == ExpressionKind.unsafeExpression
      && index != treeRoot
    ) {
      throw loweringBoundary(
        path,
        "Z1000",
        "nested unsafe expressions are not executable in the native compiler yet; bind the selected value first",
        node.line,
        node.column,
        6
      );
    }
    if (node.kind == ExpressionKind.templateExpression) {
      for (const child of node.children) {
        if (tree.nodes[child].kind == ExpressionKind.templateTextExpression) {
          continue;
        }
        const interpolationType = resolvedExpressionType(
          graph,
          moduleIndex,
          tree,
          child
        );
        if (interpolationType.byteLength == 0) {
          let length = tree.nodes[child].value.byteLength;
          if (length == 0) length = 1;
          throw loweringBoundary(
            path,
            "Z1000",
            "the native compiler cannot yet prove this template interpolation's type",
            tree.nodes[child].line,
            tree.nodes[child].column,
            length
          );
        }
        const actualType = transparentTypeName(graph.modules, moduleIndex, interpolationType);
        if (!nativeTemplateInterpolationTypeSupported(actualType)) {
          let length = tree.nodes[child].value.byteLength;
          if (length == 0) length = 1;
          throw loweringBoundary(
            path,
            "Z1000",
            `template interpolation of "${interpolationType}" is not executable in the native compiler yet; supported native interpolation types are String (owned or viewed), boolean, all integer types, and f64`,
            tree.nodes[child].line,
            tree.nodes[child].column,
            length
          );
        }
      }
    }
    if (
      node.kind == ExpressionKind.unaryExpression
      && node.value == "copy"
      && node.children.length == 1
      && !expressionIsStructSpreadCapability(tree, index)
    ) {
      const operand = node.children[0];
      const operandType = resolvedExpressionType(
        graph,
        moduleIndex,
        tree,
        operand
      );
      // A type naming a type parameter waits for each instance, checked
      // with its own type.
      if (
        operandType.byteLength > 0
        && !typeMentionsAnyParameter(operandType, typeParameters)
        && !nativeExplicitCopyTypeSupported(
          graph,
          moduleIndex,
          operandType
        )
      ) {
        throw loweringBoundary(
          path,
          "Z1000",
          `explicit copy of "${operandType}" is not executable in the native compiler yet`,
          node.line,
          node.column,
          4
        );
      }
    }
    if (
      node.kind == ExpressionKind.executorPlacementExpression
      && node.value != "spawn"
      && node.labels.length > 2
      && node.labels[2] == "call"
      && node.children.length > 0
    ) {
      const callIndex = node.children[node.children.length - 1];
      if (!allowNonTailPlacedAsyncCall && placedCallTargetSuspends(
        modules, graph, moduleIndex, tree, callIndex, true
      )) {
        throw loweringBoundary(path, "Z0700",
          "native worker-to-main timer segments with early return or error propagation require completion forwarding; use a main-executor task until this worker bridge tier is expanded",
          node.line, node.column, 5);
      }
      if (
        placedCallTargetSuspends(
          modules,
          graph,
          moduleIndex,
          tree,
          callIndex,
          false
        )
        && (
          !tailPosition
          || !expressionIsTailPlacement(tree, treeRoot, index)
        )
        && !allowNonTailPlacedAsyncCall
      ) {
        throw loweringBoundary(
          path,
          "Z0700",
          "a suspending thread.main call must be the worker closure's tail return in the current native compiler tier",
          node.line,
          node.column,
          5
        );
      }
    }
    if (
      node.kind == ExpressionKind.forExpression
      || node.kind == ExpressionKind.whileExpression
    ) {
      const subject = node.kind == ExpressionKind.forExpression ? "for" : "while";
      throw loweringBoundary(
        path,
        "Z1000",
        `value-producing ${subject} expressions are not executable in the native compiler yet`,
        node.line,
        node.column,
        subject.byteLength
      );
    }
    if (node.kind == ExpressionKind.ifExpression) {
      let boundaryIndex = index;
      if (tree.nodes[treeRoot].kind == ExpressionKind.ifExpression) {
        boundaryIndex = treeRoot;
      }
      throw loweringBoundary(
        path,
        "Z1000",
        "value-producing if expressions are not executable in the native compiler yet",
        tree.nodes[boundaryIndex].line,
        tree.nodes[boundaryIndex].column,
        2
      );
    }
    if (node.kind == ExpressionKind.matchObjectFieldExpression) {
      let length = node.value.byteLength;
      if (length == 0) length = 1;
      throw loweringBoundary(
        path,
        "Z1000",
        "object-destructuring match patterns are not executable in the native compiler yet",
        node.line,
        node.column,
        length
      );
    }
    if (
      node.kind == ExpressionKind.memberExpression
      && node.optionalAccess
      && node.children.length == 1
      && !stableOptionalChainSource(tree, node.children[0])
    ) {
      let length = node.value.byteLength;
      if (length == 0) length = 1;
      throw loweringBoundary(
        path,
        "Z1000",
        "temporary optional-chain receivers are not executable in the native compiler yet",
        node.line,
        node.column,
        length
      );
    }
    let optionalMemberType = "";
    if (
      node.kind == ExpressionKind.memberExpression
      && node.optionalAccess
    ) {
      optionalMemberType = resolvedExpressionType(
        graph,
        moduleIndex,
        tree,
        index
      );
    }
    if (stringContains(optionalMemberType, "view ")) {
      let length = node.value.byteLength;
      if (length == 0) length = 1;
      throw loweringBoundary(
        path,
        "Z1000",
        "cleanup-bearing optional-chain view projections are not executable in the native compiler yet",
        node.line,
        node.column,
        length
      );
    }
    if (
      node.kind == ExpressionKind.callExpression
      && node.children.length > 0
    ) {
      const callee = view tree.nodes[node.children[0]];
      if (
        callee.kind == ExpressionKind.identifierExpression
        && (
          isIntegerTypeName(callee.value)
          || callee.value == "f32"
          || callee.value == "f64"
        )
        && node.children.length == 2
      ) {
        const source = node.children[1];
        const sourceType = resolvedExpressionType(
          graph,
          moduleIndex,
          tree,
          source
        );
        if (sourceType.byteLength == 0) {
          let sourceStart = source;
          while (
            tree.nodes[sourceStart].kind == ExpressionKind.memberExpression
            && tree.nodes[sourceStart].children.length == 1
          ) {
            sourceStart = tree.nodes[sourceStart].children[0];
          }
          const sourceLine = tree.nodes[sourceStart].line;
          const sourceColumn = tree.nodes[sourceStart].column;
          const sourceLength = expressionSourceLength(tree, source);
          throw loweringBoundary(
            path,
            "Z1000",
            "the native compiler cannot yet prove this numeric conversion operand's type",
            sourceLine,
            sourceColumn,
            sourceLength
          );
        }
      }
      if (
        callee.kind == ExpressionKind.memberExpression
        && callee.children.length == 1
        && (
          callee.value == "saturatingAdd"
          || callee.value == "saturatingSubtract"
          || callee.value == "saturatingMultiply"
        )
      ) {
        const receiver = callee.children[0];
        let receiverType = resolvedExpressionType(
          graph,
          moduleIndex,
          tree,
          receiver
        );
        if (
          receiverType.byteLength == 0
          && tree.nodes[receiver].kind == ExpressionKind.identifierExpression
        ) {
          const receiverName = tree.nodes[receiver].value.copyBytes(
            0,
            tree.nodes[receiver].value.byteLength
          );
          const receiverOffset = tree.nodes[receiver].offset;
          receiverType = resolvedLocalBindingType(
            graph,
            moduleIndex,
            receiverName,
            receiverOffset
          );
        }
        if (isIntegerTypeName(receiverType)) {
          throw loweringBoundary(
            path,
            "Z1000",
            `saturating integer method "${callee.value}" is not executable in the native compiler yet; wrappingAdd, wrappingSubtract, and wrappingMultiply are supported`,
            callee.line,
            callee.column,
            callee.value.byteLength
          );
        }
      }
      if (
        callee.kind == ExpressionKind.memberExpression
        && callee.value == "spawn"
        && callee.children.length == 1
        && tree.nodes[callee.children[0]].kind == ExpressionKind.identifierExpression
        && tree.nodes[callee.children[0]].value == "thread"
        && node.children.length == 2
      ) {
        const closureIndex = node.children[1];
        if (
          tree.nodes[closureIndex].kind == ExpressionKind.closureExpression
          && tree.nodes[closureIndex].labels.length > 2
          && tree.nodes[closureIndex].labels[2] == "expression"
          && tree.nodes[closureIndex].children.length > 0
        ) {
          const bodyIndex = tree.nodes[closureIndex].children[
            tree.nodes[closureIndex].children.length - 1
          ];
          try validateNativeThreadCaptureExpression(
            path,
            moduleIndex,
            graph,
            tree,
            closureIndex,
            bodyIndex,
            false
          );
        }
      }
      if (
        callee.kind == ExpressionKind.memberExpression
        && callee.optionalAccess
        && callee.value != "byteAt"
      ) {
        let length = callee.value.byteLength;
        if (length == 0) length = 1;
        throw loweringBoundary(
          path,
          "Z1000",
          `optional-chain method "${callee.value}" is not executable in the native compiler yet`,
          callee.line,
          callee.column,
          length
        );
      }
    }
    index = index + 1;
  }
}

function validateNativeExpression(
  in path: String,
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in expression: ExpressionSyntax,
  tailPosition: boolean,
  allowNonTailPlacedAsyncCall: boolean,
  in typeParameters: Array<String>
): void throws ModuleResolveError {
  match (in expression.tree) {
    some(tree) => try validateNativeExpressionTree(
      path,
      moduleIndex,
      modules,
      graph,
      tree,
      tailPosition,
      allowNonTailPlacedAsyncCall,
      typeParameters
    );
    none => throw loweringBoundary(
      path,
      "Z1000",
      "expression is outside the current native expression-tree tier",
      expression.line,
      expression.column,
      1
    );
  }
}

// An unsafe statement whose body is only `values.uncheckedSet(index, value)`
// calls: a store native lowering executes as an ordinary block, since it
// needs none of the native-pointer operations other unsafe bodies may use.
function nativeUncheckedStoreBlock(
  in body: StatementArena,
  index: usize
): boolean {
  if (body.nodes[index].children.length != 1) return false;
  const block = body.nodes[index].children[0];
  if (
    body.nodes[block].kind != StatementKind.blockStatement
    || body.nodes[block].children.length == 0
  ) return false;
  for (const child of body.nodes[block].children) {
    if (body.nodes[child].kind != StatementKind.expressionStatement) return false;
    let store = false;
    match (in body.nodes[child].expression) {
      some(expression) => match (in expression.tree) {
        some(tree) => {
          const root = tree.root;
          if (
            tree.nodes[root].kind == ExpressionKind.callExpression
            && tree.nodes[root].children.length == 3
          ) {
            const callee = tree.nodes[root].children[0];
            store = tree.nodes[callee].kind == ExpressionKind.memberExpression
              && tree.nodes[callee].value == "uncheckedSet";
          }
        }
        none => {}
      }
      none => {}
    }
    if (!store) return false;
  }
  return true;
}

function nativeCallableTaskScopeCandidate(
  in body: StatementArena,
  index: usize
): boolean {
  if (
    body.nodes[index].kind != StatementKind.asyncScopeStatement
    || body.nodes[index].name.byteLength > 0
    || body.nodes[index].children.length != 1
  ) return false;
  const block = body.nodes[index].children[0];
  if (
    body.nodes[block].kind != StatementKind.blockStatement
    || (
      body.nodes[block].children.length != 4
      && body.nodes[block].children.length != 5
    )
  ) return false;
  const statements = view body.nodes[block].children;
  let rootOffset: usize = 0;
  if (statements.length == 5) {
    if (body.nodes[statements[0]].kind != StatementKind.variableStatement) {
      return false;
    }
    rootOffset = 1;
  }
  const callable = statements[rootOffset];
  const task = statements[rootOffset + 1];
  const join = statements[rootOffset + 2];
  const finish = statements[rootOffset + 3];
  if (
    body.nodes[callable].kind != StatementKind.variableStatement
    || body.nodes[task].kind != StatementKind.variableStatement
    || body.nodes[join].kind != StatementKind.expressionStatement
    || body.nodes[finish].kind != StatementKind.returnStatement
  ) return false;
  let startsTask = false;
  match (in body.nodes[task].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => startsTask = tree.nodes[tree.root].kind
        == ExpressionKind.spawnExpression;
      none => {}
    }
    none => {}
  }
  let joinsTask = false;
  match (in body.nodes[join].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => joinsTask = tree.nodes[tree.root].kind
        == ExpressionKind.awaitExpression;
      none => {}
    }
    none => {}
  }
  return startsTask && joinsTask;
}

function validateNativeBody(
  in path: String,
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in body: StatementArena,
  asynchronous: boolean,
  allowNonTailPlacedAsyncCall: boolean,
  in typeParameters: Array<String>,
  scopeStart: usize,
  in parameters: Array<Parameter>
): void throws ModuleResolveError {
  try validateNativeThreadBlockCaptures(path, moduleIndex, graph, body, scopeStart, parameters);
  let statementIndex: usize = 0;
  while (statementIndex < body.nodes.length) {
    const statement = view body.nodes[statementIndex];
    match (in statement.typeAnnotation) {
      some(type) => try validateNativeType(path, type);
      none => {}
    }
    match (in statement.expression) {
      some(expression) => try validateNativeExpression(
        path,
        moduleIndex,
        modules,
        graph,
        expression,
        statement.kind == StatementKind.returnStatement,
        allowNonTailPlacedAsyncCall,
        typeParameters
      );
      none => {}
    }
    match (in statement.secondExpression) {
      some(expression) => try validateNativeExpression(
        path,
        moduleIndex,
        modules,
        graph,
        expression,
        false,
        allowNonTailPlacedAsyncCall,
        typeParameters
      );
      none => {}
    }
    if (statement.kind == StatementKind.yieldStatement) {
      const code = asynchronous ? "Z0700" : "Z1000";
      const summary = asynchronous
        ? "async-generator yield is not executable in the native compiler yet"
        : "generator yield is not executable in the native compiler yet";
      throw loweringBoundary(
        path,
        code,
        summary,
        statement.line,
        statement.column,
        5
      );
    }
    if (statement.kind == StatementKind.asyncScopeStatement) {
      if (!nativeCallableTaskScopeCandidate(body, statementIndex)) {
        throw loweringBoundary(
          path,
          "Z0700",
          "async scope is not executable in the native compiler yet",
          statement.line,
          statement.column,
          5
        );
      }
    }
    if (
      statement.kind == StatementKind.unsafeStatement
      && !nativeUncheckedStoreBlock(body, statementIndex)
    ) {
      throw loweringBoundary(
        path,
        "Z1000",
        "unsafe statements are not executable in the native compiler yet",
        statement.line,
        statement.column,
        6
      );
    }
    if (statement.kind == StatementKind.destructureStatement) {
      if (statement.arrayBindings.length > 0) {
        let sourceType = "";
        let viewed = false;
        match (in statement.expression) {
          some(expression) => match (in expression.tree) {
            some(tree) => {
              const root = tree.root;
              sourceType = resolvedExpressionType(
                graph,
                moduleIndex,
                tree,
                root
              );
              viewed = stringStartsWith(sourceType, "view ");
              if (viewed && sourceType.byteLength > 5) {
                sourceType = sourceType.copyBytes(5, sourceType.byteLength);
              }
            }
            none => {}
          }
          none => {}
        }
        let positionalStorage = false;
        match (genericTypeShape(sourceType)) {
          some(generic) => positionalStorage = (
              generic.base == "Array"
              || generic.base == "Slice"
            )
            && generic.arguments.length == 1;
          none => {}
        }
        if (nativeFixedArrayTypeSupported(sourceType)) {
          positionalStorage = true;
        }
        if (!positionalStorage) throw loweringBoundary(
            path,
            "Z1000",
            `native array destructuring currently requires fixed-array, Array<T>, or Slice<T> storage, found ${sourceType}`,
            statement.line,
            statement.column,
            5
          );
      }
    }
    if (
      statement.kind == StatementKind.forAwaitStatement
      || statement.kind == StatementKind.forTryAwaitStatement
    ) {
      throw loweringBoundary(
        path,
        "Z0700",
        "asynchronous iteration is not executable in the native compiler yet",
        statement.line,
        statement.column,
        3
      );
    }
    if (statement.kind == StatementKind.forStatement) {
      if (statement.mutableBinding) {
        throw loweringBoundary(
          path,
          "Z1000",
          "inout iteration is not executable in the native compiler yet",
          statement.line,
          statement.column,
          3
        );
      }
      if (
        statement.objectBindings.length > 0
        || statement.arrayBindings.length > 0
      ) {
        throw loweringBoundary(
          path,
          "Z1000",
          "destructuring for bindings are not executable in the native compiler yet",
          statement.line,
          statement.column,
          3
        );
      }
      match (in statement.expression) {
        some(iterable) => match (in iterable.tree) {
          some(tree) => {
            const root = tree.root;
            const iterableType = resolvedExpressionType(
              graph,
              moduleIndex,
              tree,
              root
            );
            if (
              iterableType.byteLength > 0
              && !typeUsesGeneric(iterableType, "Array")
              && !typeUsesGeneric(iterableType, "Map")
              && iterableType != "Slice<u8>"
              && !nativeFixedArrayTypeSupported(iterableType)
            ) {
              throw loweringBoundary(
                path,
                "Z1000",
                `iteration over "${iterableType}" is not executable in the native compiler yet; Array, fixed arrays, Map, and Slice<u8> are supported`,
                statement.line,
                statement.column,
                3
              );
            }
          }
          none => {}
        }
        none => {}
      }
    }
    statementIndex = statementIndex + 1;
  }
}

function nativeYieldFrameStorageSupported(
  in modules: Array<ParsedModule>, in graph: ModuleGraph, moduleIndex: usize, in name: String,
  in visiting: Array<String>
): boolean {
  if (name == "String" || name == "cstring" || name == "boolean"
    || name == "f32" || name == "f64" || isIntegerTypeName(name)
    || name == "__z_std_text_Utf8Error"
    || name == "TaskScope" || name == "TaskControl") return true;
  const parsedModule = parsedModuleIndexForGraphModule(modules, graph, moduleIndex);
  if (parsedModule < modules.length) {
    for (const declaration of modules[parsedModule].program.imports) {
      if (declaration.header != "std/async") continue;
      for (const binding of declaration.bindings) {
        if (binding.localName == name
          && (binding.importedName == "TaskScope" || binding.importedName == "TaskControl")) return true;
      }
    }
  }
  if (stringStartsWith(name, "readonly ")) {
    const target = name.copyBytes(9, name.byteLength);
    return nativeYieldFrameStorageSupported(modules, graph, moduleIndex, target, visiting);
  }
  const actual = transparentTypeName(graph.modules, moduleIndex, name);
  if (actual != name) {
    return nativeYieldFrameStorageSupported(modules, graph, moduleIndex, actual, visiting);
  }
  const nullable = nullableTargetType(name);
  if (nullable.byteLength > 0) {
    return nativeYieldFrameStorageSupported(modules, graph, moduleIndex, nullable, visiting);
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base != "Array" && generic.base != "Option"
        && generic.base != "Result" && generic.base != "Mutex"
        && generic.base != "Map") {
        if (parsedModule >= modules.length) return false;
        const channelKind = channelTypeKind(modules[parsedModule].program, generic.base);
        if (channelKind.byteLength == 0) return false;
      }
      let argumentIndex: usize = 0;
      for (const argument of generic.arguments) {
        // Result<void, E> has a payload-free success variant, not a void slot.
        if (generic.base == "Result" && argumentIndex == 0 && argument == "void") {
          argumentIndex = argumentIndex + 1;
          continue;
        }
        if (!nativeYieldFrameStorageSupported(modules, graph, moduleIndex, argument, visiting)) return false;
        argumentIndex = argumentIndex + 1;
      }
      return true;
    }
    none => {}
  }
  const location = match (typeSymbolLocation(graph.modules, moduleIndex, name)) {
    some(found) => found;
    none => return false;
  };
  const identity = `${location.moduleIndex}:${location.symbolIndex}`;
  for (const seen of visiting) { if (seen == identity) return true; }
  const symbol = view graph.modules[location.moduleIndex].symbols[location.symbolIndex];
  match (in symbol.typeSignature) {
    some(signature) => {
      if (signature.foreignKind == "objcInterface"
        || signature.foreignKind == "objcProtocol") return true;
    }
    none => {}
  }
  if (symbol.kind != ModuleSymbolKind.structSymbol
    && symbol.kind != ModuleSymbolKind.classSymbol
    && symbol.kind != ModuleSymbolKind.enumSymbol) return false;
  return match (in symbol.typeSignature) {
    some(signature) => {
      if (signature.foreignKind.byteLength != 0) return false;
      let next = copy visiting;
      next.push(identity);
      for (const field of signature.fields) {
        if (!nativeYieldFrameStorageSupported(modules, graph, location.moduleIndex, field.typeName, next)) return false;
      }
      for (const variant of signature.variants) {
        if (variant.payloadType.byteLength > 0
          && !nativeYieldFrameStorageSupported(modules, graph, location.moduleIndex, variant.payloadType, next)) return false;
      }
      select true;
    }
    none => false;
  };
}

function validateNativeChannelExpression(
  in path: String, moduleIndex: usize, in program: Program,
  in graph: ModuleGraph, in syntax: ExpressionSyntax
): void throws ModuleResolveError {
  match (in syntax.tree) {
    some(tree) => {
      for (const call of tree.nodes) {
        if (call.kind != ExpressionKind.callExpression || call.children.length == 0) continue;
        const callee = view tree.nodes[call.children[0]];
        if (callee.kind != ExpressionKind.memberExpression || callee.children.length != 1) continue;
        if (callee.value != "send" && callee.value != "receive") continue;
        const receiver = resolvedExpressionType(graph, moduleIndex, tree, callee.children[0]);
        const actual = transparentTypeName(graph.modules, moduleIndex, receiver);
        match (genericTypeShape(actual)) {
          some(shape) => {
            const kind = channelTypeKind(program, shape.base);
            if ((kind == "Sender" && callee.value == "send")
              || (kind == "Receiver" && callee.value == "receive")) {
              throw loweringBoundary(path, "Z0700",
                "native asynchronous channel send/receive requires waiter lowering; use explicit .sync() endpoints for blocking operations on a dedicated thread",
                call.line, call.column, 1);
            }
          }
          none => {}
        }
      }
    }
    none => {}
  }
}

function validateNativeFunction(
  in path: String,
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in declaration: FunctionDeclaration,
  in owner: String,
  in ownerTypeParameters: Array<String>
): void throws ModuleResolveError {
  const firstTierSchedulerYield = functionHasFirstTierSchedulerYieldStorage(
    moduleIndex,
    modules,
    graph,
    declaration,
    owner
  );
  const parsedModule = parsedModuleIndexForGraphModule(modules, graph, moduleIndex);
  if (parsedModule < modules.length) {
    let usesChannels = false;
    for (const imported of modules[parsedModule].program.imports) {
      if (imported.header == "std/channel") usesChannels = true;
    }
    if (usesChannels) {
      for (const statement of declaration.body.nodes) {
        match (in statement.expression) {
          some(syntax) => try validateNativeChannelExpression(path, moduleIndex, modules[parsedModule].program, graph, syntax);
          none => {}
        }
        match (in statement.secondExpression) {
          some(syntax) => try validateNativeChannelExpression(path, moduleIndex, modules[parsedModule].program, graph, syntax);
          none => {}
        }
      }
    }
  }
  const yieldFrame = owner.byteLength == 0 && parsedModule < modules.length
    && !(declaration.name != "main" && firstTierSchedulerYield)
    && functionUsesYieldFrame(modules[parsedModule].program, declaration);
  if (owner.byteLength == 0 && declaration.name == "main" && parsedModule < modules.length) {
    // main has a synchronous host entry in the current native driver. Do not
    // misclassify an unsupported timer await as a join of an unnamed Task.
    for (const root of declaration.body.roots) {
      try validateMainTimerStatement(modules[parsedModule].program, declaration.body, root, path);
    }
  }
  if (yieldFrame) {
    match (in declaration.errorType) {
      some(error) => {
        const visiting = Array<String>();
        if (!nativeYieldFrameStorageSupported(modules, graph, moduleIndex, error.name, visiting)) {
          throw loweringBoundary(path, "Z0700", "native yield-frame error requires supported owned frame storage",
            declaration.line, declaration.column, 5);
        }
      }
      none => {}
    }
    for (const parameter of declaration.parameters) {
      const visiting = Array<String>();
      if (!nativeYieldFrameStorageSupported(modules, graph, moduleIndex, parameter.type.name, visiting)) {
        throw loweringBoundary(path, "Z0700",
          `native yield-frame parameter "${parameter.name}" requires supported owned frame storage; borrowed views and other native storage remain outside this tier`,
          parameter.line, parameter.column, parameter.name.byteLength);
      }
    }
    for (const statement of declaration.body.nodes) {
      // The compiler-created owner must be supported too, even when none of
      // its unsupported fields are selected into user-visible bindings.
      if (statement.kind == StatementKind.destructureStatement) {
        match (in statement.expression) {
          some(syntax) => match (in syntax.tree) {
            some(tree) => {
              const root = tree.root;
              const sourceType = resolvedExpressionType(graph, moduleIndex, tree, root);
              const visiting = Array<String>();
              if (!nativeYieldFrameStorageSupported(modules, graph, moduleIndex, sourceType, visiting)) {
                throw loweringBoundary(path, "Z0700",
                  "native yield-frame destructuring source requires supported owned frame storage; borrowed views and other native storage remain outside this tier",
                  statement.line, statement.column, 5);
              }
            }
            none => {}
          }
          none => {}
        }
      }
      for (const binding of graph.modules[moduleIndex].semanticEvidence.bindingResolutions) {
        let matches = statement.kind == StatementKind.variableStatement
          && binding.offset == statement.nameOffset;
        for (const field of statement.objectBindings) {
          if (binding.offset == field.bindingOffset) matches = true;
        }
        if (!matches) continue;
        const visiting = Array<String>();
        if (!nativeYieldFrameStorageSupported(modules, graph, moduleIndex, binding.typeName, visiting)) {
          throw loweringBoundary(path, "Z0700",
            `native yield-frame local "${binding.name}" requires supported owned frame storage; borrowed views and other native storage remain outside this tier`,
            binding.line, binding.column, binding.name.byteLength);
        }
      }
    }
  }
  const firstTierTailAwait = functionHasFirstTierTailAwaitStorage(
    moduleIndex,
    modules,
    graph,
    declaration,
    owner
  );
  if (declaration.asynchronous && declaration.name != "main"
    && functionUsesFirstTierLinearAwait(moduleIndex, modules, graph, declaration)
    && parsedModule < modules.length) {
    // Root-local scope constructors have implicit unwind states. Nested or
    // embedded constructors still need lexical ownership tracking.
    for (const statement of declaration.body.nodes) {
      match (in statement.expression) {
        some(syntax) => match (in syntax.tree) {
          some(tree) => for (const node of tree.nodes) {
            if (node.kind != ExpressionKind.newExpression) continue;
            for (const imported of modules[parsedModule].program.imports) {
              if (imported.header != "std/async") continue;
              for (const binding of imported.bindings) {
                if (binding.importedName == "TaskScope" && binding.localName == node.value) {
                  let rootLocal = false;
                  for (const root of declaration.body.roots) {
                    if (declaration.body.nodes[root].kind == StatementKind.variableStatement
                      && declaration.body.nodes[root].nameOffset == statement.nameOffset
                      && node.offset == tree.nodes[tree.root].offset) rootLocal = true;
                  }
                  if (rootLocal) continue;
                  throw loweringBoundary(path, "Z0700",
                    "a nested TaskScope constructor requires lexical scope-unwind states; this native continuation tier supports direct root-local TaskScope constructors",
                    node.line, node.column, 3);
                }
              }
            }
          }
          none => {}
        }
        none => {}
      }
    }
  }
  if (declaration.asynchronous && declaration.name != "main"
    && !yieldFrame && !firstTierSchedulerYield && !firstTierTailAwait) {
    let earlierTerminalAwait = false;
    for (const root of declaration.body.roots) {
      if (earlierTerminalAwait && statementIsFirstTierAwaitLocal(declaration.body, root)) {
        const statement = view declaration.body.nodes[root];
        throw loweringBoundary(path, "Z0700",
          "native async frame composition supports early terminal awaits followed by one awaited local; this combination requires a broader continuation frame",
          statement.line, statement.column, 5);
      }
      const kind = declaration.body.nodes[root].kind;
      if ((kind == StatementKind.ifStatement || kind == StatementKind.returnStatement)
        && statementFirstTierTailAwaitCount(declaration.body, root) > 0) {
        earlierTerminalAwait = true;
      }
    }
  }
  if (!yieldFrame && !firstTierSchedulerYield && !firstTierTailAwait
    && parsedModule < modules.length) {
    let index: usize = 0;
    while (index < declaration.body.nodes.length) {
      if (isFrameSchedulerYield(modules[parsedModule].program, declaration.body, index)) {
        const statement = view declaration.body.nodes[index];
        throw loweringBoundary(path, "Z0700",
          "scheduler.yield() in this function requires unsupported native frame composition; use root owned locals and standalone direct child awaits in the current tier",
          statement.line, statement.column, 5);
      }
      index = index + 1;
    }
  }
  if (
    functionUsesFirstTierPlacedAsyncFunctionTailAwaitSyntax(declaration)
    && !functionUsesFirstTierPlacedAsyncFunctionTailAwait(
      moduleIndex,
      modules,
      graph,
      declaration
    )
  ) {
    throw loweringBoundary(
      path,
      "Z0700",
      "a placed async function tail requires a directly taskifiable callee in the current native compiler tier",
      declaration.line,
      declaration.column,
      5
    );
  }
  if (
    functionUsesFirstTierPlacedAsyncLinearAwaitSyntax(declaration)
    && !functionUsesFirstTierPlacedAsyncLinearAwait(
      moduleIndex,
      modules,
      graph,
      declaration
    )
  ) {
    throw loweringBoundary(
      path,
      "Z0700",
      "a placed async function local requires a directly taskifiable callee in the current native compiler tier",
      declaration.line,
      declaration.column,
      5
    );
  }
  if (
    functionUsesFirstTierDoubleAwait(declaration)
    && !functionUsesFirstTierDoubleAwaitWithTaskifiablePlacements(
      moduleIndex,
      modules,
      graph,
      declaration
    )
  ) {
    throw loweringBoundary(
      path,
      "Z0700",
      "a placed async function local in a two-await function requires a directly taskifiable callee in the current native compiler tier",
      declaration.line,
      declaration.column,
      5
    );
  }
  if (
    declaration.asynchronous
    && declaration.name != "main"
    && declaration.executorAffinity != "thread.main"
    && nativeOwnerExecutorAffinity(moduleIndex, modules, owner)
      != "thread.main"
    && functionContainsSuspension(declaration)
    && !firstTierSchedulerYield
    && !firstTierTailAwait
    && !yieldFrame
  ) {
    throw loweringBoundary(
      path,
      "Z0700",
      `suspending async function "${declaration.name}" is not executable in the native compiler yet`,
      declaration.line,
      declaration.column,
      5
    );
  }
  for (const parameter of declaration.parameters) {
    try validateNativeType(path, parameter.type);
  }
  try validateNativeType(path, declaration.returnType);
  match (in declaration.errorType) {
    some(error) => try validateNativeType(path, error);
    none => {}
  }
  const asynchronous = declaration.asynchronous;
  const allowNonTailPlacedAsyncCall =
    functionUsesFirstTierPlacedAsyncLinearAwait(
      moduleIndex,
      modules,
      graph,
      declaration
    ) || functionUsesFirstTierDoubleAwaitWithTaskifiablePlacements(
      moduleIndex,
      modules,
      graph,
      declaration
    );
  const typeParameters = declaredTypeParameterNames(ownerTypeParameters, declaration.typeParameters);
  try validateNativeBody(
    path,
    moduleIndex,
    modules,
    graph,
    declaration.body,
    asynchronous,
    allowNonTailPlacedAsyncCall,
    typeParameters,
    declaration.offset,
    declaration.parameters
  );
}

function validateNativeAggregate(
  in path: String,
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in aggregate: AggregateDeclaration
): void throws ModuleResolveError {
  const typeParameters = declaredTypeParameterNames(Array<String>(), aggregate.typeParameters);
  let nativeSubclass = false;
  for (const plan of graph.modules[moduleIndex].semanticEvidence.objectiveCSubclasses) {
    if (plan.sourceName == aggregate.name) nativeSubclass = true;
  }
  match (in aggregate.constructorDeclaration) {
    some(initializer) => {
      if (aggregate.kind != DeclarationKind.classDeclaration) {
        throw loweringBoundary(
          path,
          "Z1000",
          `constructor for struct "${aggregate.name}" is not executable in the native compiler yet`,
          initializer.line,
          initializer.column,
          11
        );
      }
      match (in initializer.errorType) {
        some(_) => throw loweringBoundary(
          path,
          "Z1000",
          `throwing constructor for class "${aggregate.name}" is not executable in the native compiler yet`,
          initializer.line,
          initializer.column,
          11
        );
        none => {}
      }
      for (const statement of initializer.body.nodes) {
        // Native subclass validation walks lexical scopes and rejects returns
        // from the initializer itself, while allowing nested closure returns.
        if (nativeSubclass) break;
        if (statement.kind != StatementKind.returnStatement) continue;
        throw loweringBoundary(
          path,
          "Z1000",
          `explicit return from constructor for class "${aggregate.name}" is not executable in the first native constructor tier`,
          statement.line,
          statement.column,
          6
        );
      }
      try validateNativeBody(
        path,
        moduleIndex,
        modules,
        graph,
        initializer.body,
        false,
        false,
        typeParameters,
        initializer.offset,
        initializer.parameters
      );
    }
    none => {}
  }
  for (const field of aggregate.fields) {
    try validateNativeType(path, field.type);
    try validateNativeBody(
      path,
      moduleIndex,
      modules,
      graph,
      field.defaultStatements,
      false,
      false,
      typeParameters,
      0,
      Array<Parameter>()
    );
  }
  for (const method of aggregate.methods) {
    try validateNativeFunction(
      path,
      moduleIndex,
      modules,
      graph,
      method,
      aggregate.name,
      typeParameters
    );
  }
  match (in aggregate.deinitializer) {
    some(deinitializer) => try validateNativeBody(
      path,
      moduleIndex,
      modules,
      graph,
      deinitializer.body,
      false,
      false,
      typeParameters,
      deinitializer.offset,
      Array<Parameter>()
    );
    none => {}
  }
}

export function validateNativeLowerability(
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph
): void throws ModuleResolveError {
  let graphModuleIndex: usize = 0;
  while (graphModuleIndex < graph.modules.length) {
    const parsedModuleIndex = parsedModuleIndexForGraphModule(
      modules,
      graph,
      graphModuleIndex
    );
    if (parsedModuleIndex >= modules.length) {
      graphModuleIndex = graphModuleIndex + 1;
      continue;
    }
    const module = view modules[parsedModuleIndex];
    for (const binding of graph.modules[graphModuleIndex]
      .semanticEvidence.bindingResolutions) {
      const bindingLength = binding.name.byteLength;
      const bindingLine = binding.line;
      const bindingColumn = binding.column;
      try validateNativeCollectionTypeName(
        module.path,
        binding.typeName,
        bindingLine,
        bindingColumn,
        bindingLength
      );
    }
    for (const expression of graph.modules[graphModuleIndex]
      .semanticEvidence.expressionResolutions) {
      const expressionLine = expression.line;
      const expressionColumn = expression.column;
      try validateNativeCollectionTypeName(
        module.path,
        expression.typeName,
        expressionLine,
        expressionColumn,
        1
      );
    }
    for (const aggregate of module.program.aggregates) {
      try validateNativeAggregate(
        module.path,
        graphModuleIndex,
        modules,
        graph,
        aggregate
      );
    }
    for (const declaration of module.program.constants) {
      match (in declaration.typeAnnotation) {
        some(type) => try validateNativeType(
          module.path,
          type
        );
        none => {}
      }
      try validateNativeExpression(
        module.path,
        graphModuleIndex,
        modules,
        graph,
        declaration.initializer,
        false,
        false,
        Array<String>()
      );
    }
    for (const declaration of module.program.enums) {
      for (const variant of declaration.variants) {
        match (in variant.payload) {
          some(payload) => try validateNativeType(
            module.path,
            payload
          );
          none => {}
        }
      }
    }
    for (const declaration of module.program.functions) {
      try validateNativeFunction(
        module.path,
        graphModuleIndex,
        modules,
        graph,
        declaration,
        "",
        Array<String>()
      );
    }
    graphModuleIndex = graphModuleIndex + 1;
  }
}
