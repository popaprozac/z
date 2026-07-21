import { TextBuffer } from "std/text";
import { tokenize } from "./lexer.zs";
import {
  AggregateDeclaration,
  ConstructorDeclaration,
  Declaration,
  DeclarationKind,
  DeinitDeclaration,
  EnumDeclaration,
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  FunctionDeclaration,
  ImportDeclaration,
  Parameter,
  Program,
  StatementArena,
  StatementKind,
  TraitDeclaration,
  TypeParameter,
  TypeReference,
  parseProgram,
} from "./parser.zs";

export struct ModuleSource {
  path: String;
  source: String;
}

export enum ModuleResolveErrorKind {
  lexer,
  parser,
  missingModule,
  circularImport,
  missingExport,
  duplicateBinding,
  unknownName,
  unknownType,
}

export struct ModuleResolveError {
  kind: ModuleResolveErrorKind;
  path: String;
  message: String;
  line: usize;
  column: usize;
}

struct ParsedModule {
  path: String;
  program: Program;
}

export struct ResolvedModule {
  path: String;
  dependencies: Array<usize>;
  symbols: Array<ModuleSymbol>;
}

export enum ModuleSymbolKind {
  functionSymbol,
  structSymbol,
  classSymbol,
  traitSymbol,
  enumSymbol,
  namespaceSymbol,
  importedSymbol,
}

export struct ModuleSymbol {
  name: String;
  kind: ModuleSymbolKind;
  exported: boolean;
  targetModule: Option<usize>;
  importedName: String;
  offset: usize;
  line: usize;
  column: usize;
}

export struct ModuleGraph {
  modules: Array<ResolvedModule>;
  dependencyOrder: Array<usize>;
  entry: usize;
}

function resolutionError(
  kind: ModuleResolveErrorKind,
  in path: String,
  in message: String,
  line: usize,
  column: usize
): ModuleResolveError {
  return ModuleResolveError({
    kind,
    path: path.copyBytes(0, path.byteLength),
    message: message.copyBytes(0, message.byteLength),
    line,
    column,
  });
}

function parseModule(in source: ModuleSource): ParsedModule throws ModuleResolveError {
  const tokenOutcome = attempt tokenize(source.source);
  const tokens = match (tokenOutcome) {
    success(tokens) => tokens;
    failure(error) => {
      const line = error.line;
      const column = error.column;
      throw resolutionError(
        ModuleResolveErrorKind.lexer,
        source.path,
        error.message,
        line,
        column
      );
    }
  };
  const programOutcome = attempt parseProgram(tokens);
  const program = match (programOutcome) {
    success(program) => program;
    failure(error) => {
      const line = error.line;
      const column = error.column;
      throw resolutionError(
        ModuleResolveErrorKind.parser,
        source.path,
        error.message,
        line,
        column
      );
    }
  };
  return ParsedModule({
    path: source.path.copyBytes(0, source.path.byteLength),
    program,
  });
}

function isSlash(byte: u8): boolean {
  return byte == 47 || byte == 92;
}

function isLocalHeader(in header: String): boolean {
  const relative = header.byteLength >= 2
    && header.byteAt(0) == 46
    && (
      isSlash(header.byteAt(1))
      || (
        header.byteLength >= 3
        && header.byteAt(1) == 46
        && isSlash(header.byteAt(2))
      )
    );
  if (!relative || header.byteLength < 3) return false;
  return header.byteAt(header.byteLength - 3) == 46
    && header.byteAt(header.byteLength - 2) == 122
    && header.byteAt(header.byteLength - 1) == 115;
}

function directoryName(in path: String): String {
  let index = path.byteLength;
  while (index > 0) {
    index = index - 1;
    if (!isSlash(path.byteAt(index))) continue;
    if (index == 0) return "/";
    return path.copyBytes(0, index);
  }
  return ".";
}

function storeSegment(
  inout segments: Array<String>,
  count: usize,
  segment: String
): void {
  if (count < segments.length) segments[count] = segment;
  else segments.push(segment);
}

function normalizedPath(in path: String): String {
  let segments = Array<String>();
  let count: usize = 0;
  const absolute = path.byteLength > 0 && isSlash(path.byteAt(0));
  let start: usize = 0;
  let current: usize = 0;
  while (current <= path.byteLength) {
    const boundary = current == path.byteLength || isSlash(path.byteAt(current));
    if (!boundary) {
      current = current + 1;
      continue;
    }
    if (current > start) {
      const segment = path.copyBytes(start, current);
      if (segment == ".") {
      } else if (segment == "..") {
        let floor: usize = 0;
        if (
          count > 0
          && segments[0].byteLength == 2
          && segments[0].byteAt(1) == 58
        ) floor = 1;
        if (count > floor) count = count - 1;
        else if (!absolute) {
          storeSegment(inout segments, count, segment);
          count = count + 1;
        }
      } else {
        storeSegment(inout segments, count, segment);
        count = count + 1;
      }
    }
    start = current + 1;
    current = current + 1;
  }

  let output = TextBuffer();
  if (absolute) output.append("/");
  let index: usize = 0;
  while (index < count) {
    if (index > 0) output.append("/");
    output.append(segments[index]);
    index = index + 1;
  }
  return output.finish();
}

function importedPath(in importer: String, in header: String): String {
  const directory = directoryName(importer);
  return normalizedPath(`${directory}/${header}`);
}

function findModule(in modules: Array<ParsedModule>, in path: String): Option<usize> {
  let index: usize = 0;
  while (index < modules.length) {
    if (modules[index].path == path) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function hasExport(in declaration: Declaration, in name: String): boolean {
  return declaration.exported && declaration.name == name;
}

function moduleExports(in module: ParsedModule, in name: String): boolean {
  for (const declaration of module.program.declarations) {
    if (hasExport(declaration, name)) return true;
  }
  return false;
}

function declarationSymbolKind(kind: DeclarationKind): ModuleSymbolKind {
  if (kind == DeclarationKind.functionDeclaration) return ModuleSymbolKind.functionSymbol;
  if (kind == DeclarationKind.structDeclaration) return ModuleSymbolKind.structSymbol;
  if (kind == DeclarationKind.classDeclaration) return ModuleSymbolKind.classSymbol;
  if (kind == DeclarationKind.traitDeclaration) return ModuleSymbolKind.traitSymbol;
  return ModuleSymbolKind.enumSymbol;
}

function ownSymbol(in declaration: Declaration): ModuleSymbol {
  return ModuleSymbol({
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
    kind: declarationSymbolKind(declaration.kind),
    exported: declaration.exported,
    targetModule: Option<usize>.none,
    importedName: declaration.name.copyBytes(0, declaration.name.byteLength),
    offset: declaration.offset,
    line: declaration.line,
    column: declaration.column,
  });
}

function importedSymbol(
  in name: String,
  in importedName: String,
  kind: ModuleSymbolKind,
  targetModule: Option<usize>,
  offset: usize,
  line: usize,
  column: usize
): ModuleSymbol {
  return ModuleSymbol({
    name: name.copyBytes(0, name.byteLength),
    kind,
    exported: false,
    targetModule,
    importedName: importedName.copyBytes(0, importedName.byteLength),
    offset,
    line,
    column,
  });
}

function importTarget(
  in modules: Array<ParsedModule>,
  in module: ParsedModule,
  in declaration: ImportDeclaration
): Option<usize> {
  if (!isLocalHeader(declaration.header)) return Option<usize>.none;
  const targetPath = importedPath(module.path, declaration.header);
  return findModule(modules, targetPath);
}

function buildSymbols(
  in modules: Array<ParsedModule>,
  in module: ParsedModule
): Array<ModuleSymbol> {
  let symbols = Array<ModuleSymbol>();
  for (const declaration of module.program.declarations) {
    if (declaration.kind == DeclarationKind.importDeclaration) continue;
    symbols.push(ownSymbol(declaration));
  }
  for (const declaration of module.program.imports) {
    const target = importTarget(modules, module, declaration);
    if (declaration.selective) {
      for (const binding of declaration.bindings) {
        const offset = binding.offset;
        const line = binding.line;
        const column = binding.column;
        symbols.push(importedSymbol(
          binding.localName,
          binding.importedName,
          ModuleSymbolKind.importedSymbol,
          target,
          offset,
          line,
          column
        ));
      }
    } else {
      const name = bindingName(declaration);
      const offset = declaration.offset;
      const line = declaration.line;
      const column = declaration.column;
      symbols.push(importedSymbol(
        name,
        declaration.header,
        ModuleSymbolKind.namespaceSymbol,
        target,
        offset,
        line,
        column
      ));
    }
  }
  return symbols;
}

export function moduleSymbolKindName(kind: ModuleSymbolKind): String {
  if (kind == ModuleSymbolKind.functionSymbol) return "function";
  if (kind == ModuleSymbolKind.structSymbol) return "struct";
  if (kind == ModuleSymbolKind.classSymbol) return "class";
  if (kind == ModuleSymbolKind.traitSymbol) return "trait";
  if (kind == ModuleSymbolKind.enumSymbol) return "enum";
  if (kind == ModuleSymbolKind.namespaceSymbol) return "namespace";
  return "imported";
}

function bindingName(in declaration: ImportDeclaration): String {
  return declaration.moduleName.copyBytes(0, declaration.moduleName.byteLength);
}

function requireAvailableBinding(
  inout occupied: Array<String>,
  in path: String,
  in name: String,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  for (const candidate of occupied) {
    if (candidate == name) throw resolutionError(
      ModuleResolveErrorKind.duplicateBinding,
      path,
      `duplicate module binding ${name}`,
      line,
      column
    );
  }
  occupied.push(name.copyBytes(0, name.byteLength));
}

function validateBindings(in module: ParsedModule): void throws ModuleResolveError {
  let occupied = Array<String>();
  for (const declaration of module.program.declarations) {
    if (declaration.kind == DeclarationKind.importDeclaration) continue;
    const line = declaration.line;
    const column = declaration.column;
    try requireAvailableBinding(
      inout occupied,
      module.path,
      declaration.name,
      line,
      column
    );
  }
  for (const declaration of module.program.imports) {
    if (declaration.selective) {
      for (const binding of declaration.bindings) {
        const line = binding.line;
        const column = binding.column;
        try requireAvailableBinding(
          inout occupied,
          module.path,
          binding.localName,
          line,
          column
        );
      }
    } else {
      const name = bindingName(declaration);
      const line = declaration.line;
      const column = declaration.column;
      try requireAvailableBinding(
        inout occupied,
        module.path,
        name,
        line,
        column
      );
    }
  }
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

function isIntrinsicName(in name: String): boolean {
  return name == "Array"
    || name == "Option"
    || name == "Result"
    || name == "Weak"
    || name == "String";
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
  throw resolutionError(
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
    try requireKnownName(module, symbols, bindings, value, line, column);
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
  if (
    kind == ExpressionKind.matchArmExpression
    || kind == ExpressionKind.matchBindingExpression
    || kind == ExpressionKind.matchObjectFieldExpression
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
  if (arena.nodes[index].kind == StatementKind.forStatement) {
    let loopBindings = copyBindings(bindings);
    loopBindings.push(arena.nodes[index].name.copyBytes(0, arena.nodes[index].name.byteLength));
    try resolveStatementSequence(module, symbols, arena, arena.nodes[index].children, loopBindings);
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
  includeThis: boolean
): void throws ModuleResolveError {
  let bindings = parameterBindings(declaration.parameters);
  if (includeThis && !declaration.staticMethod) bindings.push("this");
  try resolveStatementSequence(module, symbols, declaration.body, declaration.body.roots, bindings);
}

function resolveConstructorNames(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in declaration: ConstructorDeclaration
): void throws ModuleResolveError {
  let bindings = parameterBindings(declaration.parameters);
  bindings.push("this");
  try resolveStatementSequence(module, symbols, declaration.body, declaration.body.roots, bindings);
}

function resolveDeinitNames(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in declaration: DeinitDeclaration
): void throws ModuleResolveError {
  let bindings = Array<String>();
  bindings.push("this");
  try resolveStatementSequence(module, symbols, declaration.body, declaration.body.roots, bindings);
}

function resolveAggregateNames(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>,
  in declaration: AggregateDeclaration
): void throws ModuleResolveError {
  match (in declaration.constructorDeclaration) {
    some(initializer) => try resolveConstructorNames(module, symbols, initializer);
    none => {}
  }
  for (const method of declaration.methods) {
    try resolveFunctionNames(module, symbols, method, true);
  }
  match (in declaration.deinitializer) {
    some(deinitializer) => try resolveDeinitNames(module, symbols, deinitializer);
    none => {}
  }
}

function validateNames(
  in module: ParsedModule,
  in symbols: Array<ModuleSymbol>
): void throws ModuleResolveError {
  for (const declaration of module.program.functions) {
    try resolveFunctionNames(module, symbols, declaration, false);
  }
  for (const declaration of module.program.aggregates) {
    try resolveAggregateNames(module, symbols, declaration);
  }
}

function isTypeSymbolKind(kind: ModuleSymbolKind): boolean {
  return kind == ModuleSymbolKind.structSymbol
    || kind == ModuleSymbolKind.classSymbol
    || kind == ModuleSymbolKind.traitSymbol
    || kind == ModuleSymbolKind.enumSymbol;
}

function isIntrinsicTypeName(in name: String): boolean {
  return name == "void"
    || name == "boolean"
    || name == "i8"
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
    || name == "f64"
    || name == "cstring"
    || name == "String"
    || name == "TextBuffer"
    || name == "Arena"
    || name == "Array"
    || name == "Slice"
    || name == "Option"
    || name == "Result"
    || name == "Task"
    || name == "Weak";
}

function qualifiedTypeBase(in name: String): String {
  let index: usize = 0;
  while (index < name.byteLength) {
    if (name.byteAt(index) == 46) return name.copyBytes(0, index);
    index = index + 1;
  }
  return name.copyBytes(0, name.byteLength);
}

function qualifiedTypeMember(in name: String): String {
  let index: usize = 0;
  while (index < name.byteLength) {
    if (name.byteAt(index) == 46) return name.copyBytes(index + 1, name.byteLength);
    index = index + 1;
  }
  return "";
}

function moduleHasExportedType(
  in module: ResolvedModule,
  in name: String
): boolean {
  for (const symbol of module.symbols) {
    if (symbol.name == name && symbol.exported && isTypeSymbolKind(symbol.kind)) return true;
  }
  return false;
}

function hasTypeName(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<String>,
  in name: String
): boolean {
  const base = qualifiedTypeBase(name);
  const member = qualifiedTypeMember(name);
  if (member.byteLength == 0 && isIntrinsicTypeName(base)) return true;
  if (member.byteLength == 0) {
    for (const binding of typeBindings) {
      if (binding == base) return true;
    }
  }
  for (const symbol of modules[moduleIndex].symbols) {
    if (symbol.name != base) continue;
    if (member.byteLength > 0) {
      if (symbol.kind != ModuleSymbolKind.namespaceSymbol) return false;
      return match (in symbol.targetModule) {
        some(target) => moduleHasExportedType(modules[target], member);
        none => true;
      };
    }
    if (isTypeSymbolKind(symbol.kind)) return true;
    if (symbol.kind != ModuleSymbolKind.importedSymbol) return false;
    return match (in symbol.targetModule) {
      some(target) => moduleHasExportedType(modules[target], symbol.importedName);
      none => true;
    };
  }
  return false;
}

function validateTypeReference(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<String>,
  in type: TypeReference
): void throws ModuleResolveError {
  for (const reference of type.references) {
    if (hasTypeName(modules, moduleIndex, typeBindings, reference.name)) continue;
    throw resolutionError(
      ModuleResolveErrorKind.unknownType,
      module.path,
      `unknown type ${reference.name}`,
      reference.line,
      reference.column
    );
  }
}

function typeParameterBindings(
  in inherited: Array<String>,
  in parameters: Array<TypeParameter>
): Array<String> {
  let bindings = copyBindings(inherited);
  for (const parameter of parameters) {
    bindings.push(parameter.name.copyBytes(0, parameter.name.byteLength));
  }
  return bindings;
}

function validateTypeParameters(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in inherited: Array<String>,
  in parameters: Array<TypeParameter>
): Array<String> throws ModuleResolveError {
  const bindings = typeParameterBindings(inherited, parameters);
  for (const parameter of parameters) {
    for (const constraint of parameter.constraints) {
      try validateTypeReference(module, modules, moduleIndex, bindings, constraint);
    }
  }
  return bindings;
}

function validateExpressionTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<String>,
  in expression: ExpressionSyntax
): void throws ModuleResolveError {
  match (in expression.tree) {
    some(tree) => {
      let nodeIndex: usize = 0;
      while (nodeIndex < tree.nodes.length) {
        for (const type of tree.nodes[nodeIndex].typeReferences) {
          try validateTypeReference(module, modules, moduleIndex, typeBindings, type);
        }
        nodeIndex = nodeIndex + 1;
      }
    }
    none => {}
  }
}

function validateArenaTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<String>,
  in arena: StatementArena
): void throws ModuleResolveError {
  let index: usize = 0;
  while (index < arena.nodes.length) {
    match (in arena.nodes[index].typeAnnotation) {
      some(type) => try validateTypeReference(module, modules, moduleIndex, typeBindings, type);
      none => {}
    }
    match (in arena.nodes[index].expression) {
      some(expression) => try validateExpressionTypes(
        module,
        modules,
        moduleIndex,
        typeBindings,
        expression
      );
      none => {}
    }
    match (in arena.nodes[index].secondExpression) {
      some(expression) => try validateExpressionTypes(
        module,
        modules,
        moduleIndex,
        typeBindings,
        expression
      );
      none => {}
    }
    index = index + 1;
  }
}

function validateFunctionTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in inherited: Array<String>,
  in declaration: FunctionDeclaration
): void throws ModuleResolveError {
  const bindings = try validateTypeParameters(
    module,
    modules,
    moduleIndex,
    inherited,
    declaration.typeParameters
  );
  for (const parameter of declaration.parameters) {
    try validateTypeReference(module, modules, moduleIndex, bindings, parameter.type);
  }
  try validateTypeReference(module, modules, moduleIndex, bindings, declaration.returnType);
  match (in declaration.errorType) {
    some(error) => try validateTypeReference(module, modules, moduleIndex, bindings, error);
    none => {}
  }
  try validateArenaTypes(module, modules, moduleIndex, bindings, declaration.body);
}

function validateConstructorTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<String>,
  in declaration: ConstructorDeclaration
): void throws ModuleResolveError {
  for (const parameter of declaration.parameters) {
    try validateTypeReference(module, modules, moduleIndex, typeBindings, parameter.type);
  }
  match (in declaration.errorType) {
    some(error) => try validateTypeReference(module, modules, moduleIndex, typeBindings, error);
    none => {}
  }
  try validateArenaTypes(module, modules, moduleIndex, typeBindings, declaration.body);
}

function validateAggregateTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in declaration: AggregateDeclaration
): void throws ModuleResolveError {
  let empty = Array<String>();
  const bindings = try validateTypeParameters(
    module,
    modules,
    moduleIndex,
    empty,
    declaration.typeParameters
  );
  for (const implemented of declaration.implementedTraits) {
    try validateTypeReference(module, modules, moduleIndex, bindings, implemented);
  }
  for (const field of declaration.fields) {
    try validateTypeReference(module, modules, moduleIndex, bindings, field.type);
  }
  match (in declaration.constructorDeclaration) {
    some(initializer) => try validateConstructorTypes(
      module,
      modules,
      moduleIndex,
      bindings,
      initializer
    );
    none => {}
  }
  for (const method of declaration.methods) {
    try validateFunctionTypes(module, modules, moduleIndex, bindings, method);
  }
  match (in declaration.deinitializer) {
    some(deinitializer) => try validateArenaTypes(
      module,
      modules,
      moduleIndex,
      bindings,
      deinitializer.body
    );
    none => {}
  }
}

function validateTraitTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in declaration: TraitDeclaration
): void throws ModuleResolveError {
  let empty = Array<String>();
  for (const method of declaration.methods) {
    try validateFunctionTypes(module, modules, moduleIndex, empty, method);
  }
}

function validateEnumTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in declaration: EnumDeclaration
): void throws ModuleResolveError {
  let empty = Array<String>();
  for (const variant of declaration.variants) {
    match (in variant.payload) {
      some(payload) => try validateTypeReference(module, modules, moduleIndex, empty, payload);
      none => {}
    }
  }
}

function validateTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize
): void throws ModuleResolveError {
  let empty = Array<String>();
  for (const declaration of module.program.functions) {
    try validateFunctionTypes(module, modules, moduleIndex, empty, declaration);
  }
  for (const declaration of module.program.aggregates) {
    try validateAggregateTypes(module, modules, moduleIndex, declaration);
  }
  for (const declaration of module.program.traits) {
    try validateTraitTypes(module, modules, moduleIndex, declaration);
  }
  for (const declaration of module.program.enums) {
    try validateEnumTypes(module, modules, moduleIndex, declaration);
  }
}

function resolveDependencies(
  in modules: Array<ParsedModule>,
  in module: ParsedModule
): Array<usize> throws ModuleResolveError {
  let dependencies = Array<usize>();
  for (const declaration of module.program.imports) {
    if (!isLocalHeader(declaration.header)) continue;
    const targetPath = importedPath(module.path, declaration.header);
    const target = findModule(modules, targetPath);
    const dependency = match (target) {
      some(dependency) => dependency;
      none => {
        const line = declaration.line;
        const column = declaration.column;
        throw resolutionError(
          ModuleResolveErrorKind.missingModule,
          module.path,
          `could not find Z module ${declaration.header}`,
          line,
          column
        );
      }
    };
    if (declaration.selective) {
      for (const binding of declaration.bindings) {
        if (!moduleExports(modules[dependency], binding.importedName)) {
          const line = binding.line;
          const column = binding.column;
          throw resolutionError(
            ModuleResolveErrorKind.missingExport,
            module.path,
            `module ${declaration.header} has no export ${binding.importedName}`,
            line,
            column
          );
        }
      }
    }
    dependencies.push(dependency);
  }
  return dependencies;
}

function visitModule(
  index: usize,
  in modules: Array<ResolvedModule>,
  inout states: Array<u8>,
  inout order: Array<usize>
): void throws ModuleResolveError {
  if (states[index] == 2) return;
  if (states[index] == 1) throw resolutionError(
    ModuleResolveErrorKind.circularImport,
    modules[index].path,
    `circular Z module import through ${modules[index].path}`,
    1,
    1
  );
  states[index] = 1;
  for (const dependency of modules[index].dependencies) {
    try visitModule(dependency, modules, inout states, inout order);
  }
  states[index] = 2;
  order.push(index);
}

export function resolveModules(
  in sources: Array<ModuleSource>,
  in entryPath: String
): ModuleGraph throws ModuleResolveError {
  let parsed = Array<ParsedModule>();
  for (const source of sources) {
    const module = try parseModule(source);
    try validateBindings(module);
    parsed.push(module);
  }
  const normalizedEntry = normalizedPath(entryPath);
  const entryOption = findModule(parsed, normalizedEntry);
  const entry = match (entryOption) {
    some(entry) => entry;
    none => throw resolutionError(
      ModuleResolveErrorKind.missingModule,
      normalizedEntry,
      `could not find entry Z module ${normalizedEntry}`,
      1,
      1
    );
  };

  let modules = Array<ResolvedModule>();
  let index: usize = 0;
  while (index < parsed.length) {
    const dependencies = try resolveDependencies(parsed, parsed[index]);
    const symbols = buildSymbols(parsed, parsed[index]);
    modules.push(ResolvedModule({
      path: parsed[index].path.copyBytes(0, parsed[index].path.byteLength),
      dependencies,
      symbols,
    }));
    index = index + 1;
  }

  index = 0;
  while (index < parsed.length) {
    try validateTypes(parsed[index], modules, index);
    try validateNames(parsed[index], modules[index].symbols);
    index = index + 1;
  }

  let states = Array<u8>();
  index = 0;
  while (index < modules.length) {
    states.push(0);
    index = index + 1;
  }
  let dependencyOrder = Array<usize>();
  try visitModule(entry, modules, inout states, inout dependencyOrder);
  return ModuleGraph({ modules, dependencyOrder, entry });
}
