import {
  AggregateDeclaration,
  ConstructorDeclaration,
  DeinitDeclaration,
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  FunctionDeclaration,
  Parameter,
  StatementArena,
  StatementKind,
} from "./parser.zs";
import { ParsedModule } from "./module-symbols.zs";
import {
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSymbol,
  moduleResolutionError,
} from "./semantic-model.zs";

export function isPublicCAbiReservedWord(in name: String): boolean {
  return name == "alignas"
    || name == "alignof"
    || name == "and"
    || name == "and_eq"
    || name == "asm"
    || name == "atomic_cancel"
    || name == "atomic_commit"
    || name == "atomic_noexcept"
    || name == "auto"
    || name == "bitand"
    || name == "bitor"
    || name == "bool"
    || name == "break"
    || name == "case"
    || name == "catch"
    || name == "char"
    || name == "char8_t"
    || name == "char16_t"
    || name == "char32_t"
    || name == "class"
    || name == "compl"
    || name == "concept"
    || name == "const"
    || name == "consteval"
    || name == "constexpr"
    || name == "constinit"
    || name == "const_cast"
    || name == "continue"
    || name == "co_await"
    || name == "co_return"
    || name == "co_yield"
    || name == "decltype"
    || name == "default"
    || name == "delete"
    || name == "do"
    || name == "double"
    || name == "dynamic_cast"
    || name == "else"
    || name == "enum"
    || name == "explicit"
    || name == "export"
    || name == "extern"
    || name == "false"
    || name == "final"
    || name == "float"
    || name == "for"
    || name == "friend"
    || name == "goto"
    || name == "if"
    || name == "import"
    || name == "inline"
    || name == "int"
    || name == "long"
    || name == "module"
    || name == "mutable"
    || name == "namespace"
    || name == "new"
    || name == "noexcept"
    || name == "not"
    || name == "not_eq"
    || name == "nullptr"
    || name == "operator"
    || name == "or"
    || name == "or_eq"
    || name == "override"
    || name == "private"
    || name == "protected"
    || name == "public"
    || name == "reflexpr"
    || name == "register"
    || name == "reinterpret_cast"
    || name == "requires"
    || name == "restrict"
    || name == "return"
    || name == "short"
    || name == "signed"
    || name == "sizeof"
    || name == "static"
    || name == "static_assert"
    || name == "static_cast"
    || name == "struct"
    || name == "switch"
    || name == "synchronized"
    || name == "template"
    || name == "this"
    || name == "thread_local"
    || name == "throw"
    || name == "true"
    || name == "try"
    || name == "typedef"
    || name == "typeid"
    || name == "typename"
    || name == "typeof"
    || name == "typeof_unqual"
    || name == "union"
    || name == "unsigned"
    || name == "using"
    || name == "virtual"
    || name == "void"
    || name == "volatile"
    || name == "wchar_t"
    || name == "while"
    || name == "xor"
    || name == "xor_eq"
    || name == "_Alignas"
    || name == "_Alignof"
    || name == "_Atomic"
    || name == "_BitInt"
    || name == "_Bool"
    || name == "_Complex"
    || name == "_Decimal32"
    || name == "_Decimal64"
    || name == "_Decimal128"
    || name == "_Generic"
    || name == "_Imaginary"
    || name == "_Noreturn"
    || name == "_Static_assert"
    || name == "_Thread_local";
}

function copyBindings(in bindings: Array<String>): Array<String> {
  let copied = Array<String>();
  for (const binding of bindings) {
    copied.push(binding.copyBytes(0, binding.byteLength));
  }
  return copied;
}

function copyIndices(in indices: Array<usize>): Array<usize> {
  let copied = Array<usize>();
  for (const index of indices) {
    copied.push(index);
  }
  return copied;
}

function identifierLookupName(in name: String): String {
  let index: usize = 0;
  while (index < name.byteLength) {
    if (name.byteAt(index) == 60) return name.copyBytes(0, index);
    index = index + 1;
  }
  return name.copyBytes(0, name.byteLength);
}

function qualifiedTypeBase(in name: String): String {
  let index: usize = 0;
  while (index < name.byteLength) {
    if (name.byteAt(index) == 46) return name.copyBytes(0, index);
    index = index + 1;
  }
  return name.copyBytes(0, name.byteLength);
}

function isNumericTypeName(in name: String): boolean {
  return name == "i8"
    || name == "i16"
    || name == "i32"
    || name == "i64"
    || name == "u8"
    || name == "u16"
    || name == "u32"
    || name == "u64"
    || name == "isize"
    || name == "usize"
    || name == "f32"
    || name == "f64";
}

function isIntrinsicName(in name: String): boolean {
  return name == "Array"
    || name == "Option"
    || name == "Result"
    || name == "Weak"
    || name == "String"
    || isNumericTypeName(name);
}

function hasName(
  in bindings: Array<String>,
  in symbols: Array<ModuleSymbol>,
  in name: String
): boolean {
  const lookup = identifierLookupName(name);
  if (isIntrinsicName(lookup)) return true;
  for (const binding of bindings) {
    if (binding == lookup) return true;
  }
  for (const symbol of symbols) {
    if (symbol.name == lookup) return true;
  }
  return false;
}

function requireKnownName(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in bindings: Array<String>,
  in name: String,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  if (hasName(bindings, symbols, name)) return;
  const lookup = identifierLookupName(name);
  throw moduleResolutionError(
    ModuleResolveErrorKind.unknownName,
    module.path,
    `unknown name ${lookup}`,
    line,
    column
  );
}

function addMatchBindings(
  in tree: ExpressionTree,
  index: usize,
  inout bindings: Array<String>
): void {
  const kind = tree.nodes[index].kind;
  const value = tree.nodes[index].value.copyBytes(0, tree.nodes[index].value.byteLength);
  const children = copyIndices(tree.nodes[index].children);
  if (kind == ExpressionKind.matchBindingExpression) {
    bindings.push(value);
    return;
  }
  for (const child of children) {
    addMatchBindings(tree, child, inout bindings);
  }
}

function resolveExpressionNode(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize,
  in bindings: Array<String>
): void throws ModuleResolveError {
  const kind = tree.nodes[index].kind;
  const value = tree.nodes[index].value.copyBytes(0, tree.nodes[index].value.byteLength);
  const line = tree.nodes[index].line;
  const column = tree.nodes[index].column;
  const children = copyIndices(tree.nodes[index].children);
  const statements = copyIndices(tree.nodes[index].statements);
  if (
    kind == ExpressionKind.identifierExpression
    || kind == ExpressionKind.argumentBindingExpression
  ) {
    try requireKnownName(module, symbols, bindings, value, line, column);
    return;
  }
  if (
    kind == ExpressionKind.newExpression
    || kind == ExpressionKind.variantExpression
  ) {
    const typeName = identifierLookupName(value);
    const typeRoot = qualifiedTypeBase(typeName);
    try requireKnownName(module, symbols, bindings, typeRoot, line, column);
  }
  if (kind == ExpressionKind.closureExpression) {
    let closureBindings = copyBindings(bindings);
    for (const child of children) {
      if (tree.nodes[child].kind == ExpressionKind.closureParameterExpression) {
        closureBindings.push(
          tree.nodes[child].value.copyBytes(0, tree.nodes[child].value.byteLength)
        );
      }
    }
    for (const child of children) {
      if (tree.nodes[child].kind == ExpressionKind.closureParameterExpression) continue;
      try resolveExpressionNode(module, symbols, arena, tree, child, closureBindings);
    }
    try resolveStatementSequence(module, symbols, arena, statements, closureBindings);
    return;
  }
  if (kind == ExpressionKind.asyncScopeExpression) {
    // The handle of a named scope is a name inside its block only.
    let scopeBindings = copyBindings(bindings);
    if (value.byteLength > 0) scopeBindings.push(value.copyBytes(0, value.byteLength));
    try resolveStatementSequence(module, symbols, arena, statements, scopeBindings);
    return;
  }
  if (kind == ExpressionKind.matchExpression) {
    if (children.length > 0) {
      try resolveExpressionNode(module, symbols, arena, tree, children[0], bindings);
    }
    let childIndex: usize = 1;
    while (childIndex < children.length) {
      const armIndex = children[childIndex];
      const patterns = copyIndices(tree.nodes[armIndex].children);
      const armStatements = copyIndices(tree.nodes[armIndex].statements);
      let armBindings = copyBindings(bindings);
      for (const pattern of patterns) {
        addMatchBindings(tree, pattern, inout armBindings);
      }
      try resolveStatementSequence(module, symbols, arena, armStatements, armBindings);
      childIndex = childIndex + 1;
    }
    return;
  }
  if (kind == ExpressionKind.whileExpression && children.length == 3) {
    try resolveExpressionNode(module, symbols, arena, tree, children[0], bindings);
    try resolveStatementSequence(
      module,
      symbols,
      arena,
      tree.nodes[children[1]].statements,
      bindings
    );
    try resolveStatementSequence(
      module,
      symbols,
      arena,
      tree.nodes[children[2]].statements,
      bindings
    );
    return;
  }
  if (kind == ExpressionKind.forExpression && children.length == 4) {
    try resolveExpressionNode(module, symbols, arena, tree, children[1], bindings);
    let loopBindings = copyBindings(bindings);
    addMatchBindings(tree, children[0], inout loopBindings);
    try resolveStatementSequence(
      module,
      symbols,
      arena,
      tree.nodes[children[2]].statements,
      loopBindings
    );
    try resolveStatementSequence(
      module,
      symbols,
      arena,
      tree.nodes[children[3]].statements,
      bindings
    );
    return;
  }
  if (
    kind == ExpressionKind.matchArmExpression
    || kind == ExpressionKind.matchBindingExpression
    || kind == ExpressionKind.matchObjectFieldExpression
    || kind == ExpressionKind.forBindingExpression
    || kind == ExpressionKind.closureParameterExpression
    || kind == ExpressionKind.variantMarkerExpression
  ) return;
  for (const child of children) {
    try resolveExpressionNode(module, symbols, arena, tree, child, bindings);
  }
  try resolveStatementSequence(module, symbols, arena, statements, bindings);
}

function resolveExpression(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in arena: StatementArena,
  in expression: ExpressionSyntax,
  in bindings: Array<String>
): void throws ModuleResolveError {
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      try resolveExpressionNode(module, symbols, arena, tree, root, bindings);
    }
    none => {}
  }
}

function resolveOptionalExpression(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in arena: StatementArena,
  in expression: Option<ExpressionSyntax>,
  in bindings: Array<String>
): void throws ModuleResolveError {
  match (in expression) {
    some(value) => try resolveExpression(module, symbols, arena, value, bindings);
    none => {}
  }
}

function resolveStatement(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in arena: StatementArena,
  index: usize,
  inout bindings: Array<String>
): void throws ModuleResolveError {
  try resolveOptionalExpression(module, symbols, arena, arena.nodes[index].expression, bindings);
  try resolveOptionalExpression(module, symbols, arena, arena.nodes[index].secondExpression, bindings);

  if (arena.nodes[index].kind == StatementKind.variableStatement) {
    bindings.push(arena.nodes[index].name.copyBytes(0, arena.nodes[index].name.byteLength));
    return;
  }
  if (arena.nodes[index].kind == StatementKind.destructureStatement) {
    for (const binding of arena.nodes[index].objectBindings) {
      bindings.push(binding.bindingName.copyBytes(0, binding.bindingName.byteLength));
    }
    for (const binding of arena.nodes[index].arrayBindings) {
      if (binding.bindingName.byteLength > 0) {
        bindings.push(binding.bindingName.copyBytes(0, binding.bindingName.byteLength));
      }
    }
    return;
  }
  if (
    arena.nodes[index].kind == StatementKind.forStatement
    || arena.nodes[index].kind == StatementKind.forAwaitStatement
    || arena.nodes[index].kind == StatementKind.forTryAwaitStatement
  ) {
    let loopBindings = copyBindings(bindings);
    if (arena.nodes[index].name.byteLength > 0) {
      loopBindings.push(arena.nodes[index].name.copyBytes(0, arena.nodes[index].name.byteLength));
    }
    for (const binding of arena.nodes[index].objectBindings) {
      loopBindings.push(binding.bindingName.copyBytes(0, binding.bindingName.byteLength));
    }
    try resolveStatementSequence(module, symbols, arena, arena.nodes[index].children, loopBindings);
    return;
  }
  if (arena.nodes[index].kind == StatementKind.asyncScopeStatement) {
    let scopeBindings = copyBindings(bindings);
    if (arena.nodes[index].name.byteLength > 0) {
      scopeBindings.push(arena.nodes[index].name.copyBytes(0, arena.nodes[index].name.byteLength));
    }
    try resolveStatementSequence(module, symbols, arena, arena.nodes[index].children, scopeBindings);
    return;
  }
  if (arena.nodes[index].kind == StatementKind.unsafeStatement) {
    let unsafeBindings = copyBindings(bindings);
    try resolveStatementSequence(module, symbols, arena, arena.nodes[index].children, unsafeBindings);
    return;
  }
  try resolveStatementSequence(module, symbols, arena, arena.nodes[index].children, bindings);
}

function resolveStatementSequence(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in arena: StatementArena,
  in indices: Array<usize>,
  in inherited: Array<String>
): void throws ModuleResolveError {
  let bindings = copyBindings(inherited);
  for (const index of indices) {
    try resolveStatement(module, symbols, arena, index, inout bindings);
  }
}

function parameterBindings(in parameters: Array<Parameter>): Array<String> {
  let bindings = Array<String>();
  for (const parameter of parameters) {
    bindings.push(parameter.name.copyBytes(0, parameter.name.byteLength));
  }
  return bindings;
}

function resolveFunctionNames(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in declaration: FunctionDeclaration,
  includeThis: boolean,
  includeSuper: boolean
): void throws ModuleResolveError {
  let bindings = parameterBindings(declaration.parameters);
  if (includeThis && !declaration.staticMethod) bindings.push("this");
  if (includeSuper && !declaration.staticMethod) bindings.push("super");
  try resolveStatementSequence(module, symbols, declaration.body, declaration.body.roots, bindings);
}

function resolveConstructorNames(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in declaration: ConstructorDeclaration,
  includeSuper: boolean
): void throws ModuleResolveError {
  let bindings = parameterBindings(declaration.parameters);
  bindings.push("this");
  if (includeSuper) bindings.push("super");
  try resolveStatementSequence(module, symbols, declaration.body, declaration.body.roots, bindings);
}

function resolveDeinitNames(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in declaration: DeinitDeclaration
): void throws ModuleResolveError {
  // The arena includes nested statement/expression blocks, including
  // unreachable ones. A deinitializer must always finish its cleanup body.
  for (const statement of declaration.body.nodes) {
    let forbidden = "";
    if (statement.kind == StatementKind.returnStatement) forbidden = "return";
    else if (statement.kind == StatementKind.throwStatement) forbidden = "throw";
    else if (statement.kind == StatementKind.yieldStatement) forbidden = "yield";
    else if (statement.kind == StatementKind.selectStatement) forbidden = "select";
    if (forbidden.byteLength > 0) throw moduleResolutionError(
      ModuleResolveErrorKind.typeMismatch, module.path,
      `deinit cannot contain "${forbidden}"`, statement.line, statement.column
    );
  }
  let bindings = Array<String>();
  bindings.push("this");
  try resolveStatementSequence(module, symbols, declaration.body, declaration.body.roots, bindings);
}

export function resolveAggregateNames(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in declaration: AggregateDeclaration
): void throws ModuleResolveError {
  const nativeSubclass = match (in declaration.nativeBase) { some(_) => true; none => false; };
  match (in declaration.constructorDeclaration) {
    some(initializer) => try resolveConstructorNames(module, symbols, initializer, nativeSubclass);
    none => {}
  }
  for (const method of declaration.methods) {
    try resolveFunctionNames(module, symbols, method, true, nativeSubclass);
  }
  match (in declaration.deinitializer) {
    some(deinitializer) => try resolveDeinitNames(module, symbols, deinitializer);
    none => {}
  }
}

export function validateModuleNames(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>
): void throws ModuleResolveError {
  for (const declaration of module.program.functions) {
    try resolveFunctionNames(module, symbols, declaration, false, false);
  }
  for (const declaration of module.program.aggregates) {
    try resolveAggregateNames(module, symbols, declaration);
  }
}
