import {
  AggregateDeclaration,
  DeclarationKind,
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  FunctionDeclaration,
  ParameterMode,
  Program,
  ReceiverMode,
  StatementArena,
  StatementKind,
  TypeNameReference,
  TypeReference,
} from "./parser.zs";
import { ParsedModule } from "./module-symbols.zs";
import {
  fixedArrayShape,
  genericTypeShape,
  isIntegerTypeName,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import { typeHasCleanup } from "./semantic-type-ownership.zs";
import { typeSymbolLocation } from "./semantic-type-identities.zs";
import {
  ModuleGraph,
  ModuleResolveError,
  ModuleResolveErrorKind,
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

function nativeTemplateInterpolationTypeSupported(in name: String): boolean {
  return name == "String"
    || name == "view String"
    || name == "boolean"
    || name == "i32"
    || name == "i64"
    || name == "u8"
    || name == "u64"
    || name == "usize"
    || name == "f64";
}

function nativeExplicitCopyTypeSupported(
  in graph: ModuleGraph,
  moduleIndex: usize,
  in name: String
): boolean {
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
      if (generic.base != "Array" || generic.arguments.length != 1) {
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

function functionUsesFirstTierTailAwait(
  in declaration: FunctionDeclaration
): boolean {
  if (declaration.body.roots.length != 1) return false;
  const root = declaration.body.roots[0];
  if (
    declaration.body.nodes[root].kind != StatementKind.returnStatement
  ) return false;
  match (in declaration.body.nodes[root].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const awaitRoot = tree.root;
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
          == ExpressionKind.identifierExpression;
      }
      none => return false;
    }
    none => return false;
  }
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
  if (
    declaration.body.nodes[tail].kind
      != StatementKind.returnStatement
  ) return false;
  match (in declaration.body.nodes[tail].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const awaitRoot = tree.root;
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
          == ExpressionKind.identifierExpression;
      }
      none => return false;
    }
    none => return false;
  }
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
      && (
        owner.byteLength == 0
        || !functionUsesFirstTierPrefixedTailAwait(declaration)
      )
    )
  ) return false;
  match (in declaration.errorType) {
    some(_) => return false;
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
    match (genericTypeShape(receiverType)) {
      some(generic) => {
        if (
          nodeValue == "length"
          && (
            generic.base == "Array"
            || generic.base == "Map"
            || generic.base == "Set"
          )
        ) return "usize";
      }
      none => {}
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
    const captureName = node.value.copyBytes(0, node.value.byteLength);
    const useOffset = node.offset;
    const typeName = resolvedLocalBindingType(
      graph,
      moduleIndex,
      captureName,
      useOffset
    );
    if (
      typeName.byteLength > 0
      && typeName != "String"
      && typeName != "TextBuffer"
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
            node.line,
            node.column,
            length
          );
        }
      }
    }
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

function placedCallTargetSuspends(
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  moduleIndex: usize,
  in tree: ExpressionTree,
  callIndex: usize
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

function validateNativeExpressionTree(
  in path: String,
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in tree: ExpressionTree,
  tailPosition: boolean
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
        if (
          !nativeTemplateInterpolationTypeSupported(interpolationType)
        ) {
          let length = tree.nodes[child].value.byteLength;
          if (length == 0) length = 1;
          throw loweringBoundary(
            path,
            "Z1000",
            `template interpolation of "${interpolationType}" is not executable in the native compiler yet; supported native interpolation types are String (owned or viewed), boolean, i32, i64, u8, u64, usize, and f64`,
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
      if (
        operandType.byteLength > 0
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
      if (
        placedCallTargetSuspends(
          modules,
          graph,
          moduleIndex,
          tree,
          callIndex
        )
        && (
          !tailPosition
          || !expressionIsTailPlacement(tree, treeRoot, index)
        )
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
        && isIntegerTypeName(callee.value)
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
            "the native compiler cannot yet prove this integer conversion operand's type",
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
        && callee.value == "withLock"
      ) {
        const resultType = resolvedExpressionType(
          graph,
          moduleIndex,
          tree,
          index
        );
        if (resultType.byteLength > 0 && moduleIndex < graph.modules.length) {
          let visiting = Array<String>();
          if (typeHasCleanup(
            graph.modules,
            moduleIndex,
            resultType,
            visiting
          )) {
            throw loweringBoundary(
              path,
              "Z1000",
              `Mutex.withLock result type "${resultType}" is not executable in the native compiler yet; only cleanup-free results are supported`,
              callee.line,
              callee.column,
              8
            );
          }
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
  tailPosition: boolean
): void throws ModuleResolveError {
  match (in expression.tree) {
    some(tree) => try validateNativeExpressionTree(
      path,
      moduleIndex,
      modules,
      graph,
      tree,
      tailPosition
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
  asynchronous: boolean
): void throws ModuleResolveError {
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
        statement.kind == StatementKind.returnStatement
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
        false
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
    if (statement.kind == StatementKind.unsafeStatement) {
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
              && !nativeFixedArrayTypeSupported(iterableType)
            ) {
              throw loweringBoundary(
                path,
                "Z1000",
                `iteration over "${iterableType}" is not executable in the native compiler yet; only Array and fixed arrays are supported`,
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

function validateNativeFunction(
  in path: String,
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in declaration: FunctionDeclaration,
  in owner: String
): void throws ModuleResolveError {
  const firstTierSchedulerYield = functionHasFirstTierSchedulerYieldStorage(
    moduleIndex,
    modules,
    graph,
    declaration,
    owner
  );
  const firstTierTailAwait = functionHasFirstTierTailAwaitStorage(
    moduleIndex,
    modules,
    graph,
    declaration,
    owner
  );
  if (
    declaration.asynchronous
    && declaration.name != "main"
    && declaration.executorAffinity != "thread.main"
    && functionContainsSuspension(declaration)
    && !firstTierSchedulerYield
    && !firstTierTailAwait
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
  if (owner.byteLength > 0 && declaration.asynchronous) {
    match (in declaration.errorType) {
      some(_) => throw loweringBoundary(
        path,
        "Z1000",
        `async throwing method "${owner}.${declaration.name}" is not executable in the native compiler yet`,
        declaration.line,
        declaration.column,
        8
      );
      none => {}
    }
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
  try validateNativeBody(
    path,
    moduleIndex,
    modules,
    graph,
    declaration.body,
    asynchronous
  );
}

function aggregateKindName(in aggregate: AggregateDeclaration): String {
  return aggregate.kind == DeclarationKind.classDeclaration
    ? "class"
    : "struct";
}

function validateNativeAggregate(
  in path: String,
  moduleIndex: usize,
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in aggregate: AggregateDeclaration
): void throws ModuleResolveError {
  if (aggregate.typeParameters.length > 0) {
    const kind = aggregateKindName(aggregate);
    match (in aggregate.constructorDeclaration) {
      some(initializer) => throw loweringBoundary(
        path,
        "Z1000",
        `constructor for generic ${kind} "${aggregate.name}" is not executable in the native compiler yet`,
        initializer.line,
        initializer.column,
        11
      );
      none => {}
    }
    match (in aggregate.deinitializer) {
      some(deinitializer) => try validateNativeBody(
        path,
        moduleIndex,
        modules,
        graph,
        deinitializer.body,
        false
      );
      none => {}
    }
    for (const field of aggregate.fields) {
      match (in field.defaultValue) {
        some(expression) => try validateNativeExpression(
          path,
          moduleIndex,
          modules,
          graph,
          expression,
          true
        );
        none => {}
      }
      try validateNativeType(path, field.type);
    }
    for (const method of aggregate.methods) {
      try validateNativeFunction(
        path,
        moduleIndex,
        modules,
        graph,
        method,
        aggregate.name
      );
    }
    return;
  }
  match (in aggregate.constructorDeclaration) {
    some(initializer) => throw loweringBoundary(
      path,
      "Z1000",
      `constructor for "${aggregate.name}" is not executable in the native compiler yet`,
      initializer.line,
      initializer.column,
      11
    );
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
      false
    );
  }
  for (const method of aggregate.methods) {
    try validateNativeFunction(
      path,
      moduleIndex,
      modules,
      graph,
      method,
      aggregate.name
    );
  }
  match (in aggregate.deinitializer) {
    some(deinitializer) => try validateNativeBody(
      path,
      moduleIndex,
      modules,
      graph,
      deinitializer.body,
      false
    );
    none => {}
  }
}

export function validateNativeLowerability(
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph
): void throws ModuleResolveError {
  let moduleIndex: usize = 0;
  while (moduleIndex < modules.length) {
    const module = view modules[moduleIndex];
    if (moduleIndex < graph.modules.length) {
      for (const binding of graph.modules[moduleIndex].semanticEvidence.bindingResolutions) {
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
      for (const expression of graph.modules[moduleIndex].semanticEvidence.expressionResolutions) {
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
    }
    for (const aggregate of module.program.aggregates) {
      try validateNativeAggregate(
        module.path,
        moduleIndex,
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
        moduleIndex,
        modules,
        graph,
        declaration.initializer,
        false
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
        moduleIndex,
        modules,
        graph,
        declaration,
        ""
      );
    }
    moduleIndex = moduleIndex + 1;
  }
}
