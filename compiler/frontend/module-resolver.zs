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
  ParameterMode,
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
  typeMismatch,
  invalidOperator,
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

struct NativeValueBinding {
  name: String;
  typeName: String;
}

struct ModuleSymbolLocation {
  moduleIndex: usize;
  symbolIndex: usize;
}

struct NativeGenericTypeShape {
  base: String;
  arguments: Array<String>;
}

struct NativeFixedArrayShape {
  elementType: String;
  length: String;
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
  functionSignature: Option<ModuleFunctionSignature>;
  offset: usize;
  line: usize;
  column: usize;
}

export struct ModuleFunctionSignature {
  asynchronous: boolean;
  typeParameters: Array<String>;
  parameterModes: Array<String>;
  parameterTypes: Array<String>;
  returnType: String;
  errorType: String;
}

function moduleParameterModeName(mode: ParameterMode): String {
  return match (mode) {
    value => "value";
    input => "in";
    inputOutput => "inout";
    output => "out";
  };
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

function moduleFunctionSignature(
  in module: ParsedModule,
  in declaration: Declaration
): Option<ModuleFunctionSignature> {
  if (declaration.kind != DeclarationKind.functionDeclaration) {
    return Option<ModuleFunctionSignature>.none;
  }
  for (const functionDeclaration of module.program.functions) {
    if (functionDeclaration.name != declaration.name) continue;
    let typeParameters = Array<String>();
    for (const parameter of functionDeclaration.typeParameters) {
      typeParameters.push(parameter.name.copyBytes(0, parameter.name.byteLength));
    }
    let parameterTypes = Array<String>();
    let parameterModes = Array<String>();
    for (const parameter of functionDeclaration.parameters) {
      parameterModes.push(moduleParameterModeName(parameter.mode));
      parameterTypes.push(parameter.type.name.copyBytes(0, parameter.type.name.byteLength));
    }
    let errorType = "";
    match (in functionDeclaration.errorType) {
      some(error) => errorType = error.name.copyBytes(0, error.name.byteLength);
      none => {}
    }
    return Option.some(ModuleFunctionSignature({
      asynchronous: functionDeclaration.asynchronous,
      typeParameters,
      parameterModes,
      parameterTypes,
      returnType: functionDeclaration.returnType.name.copyBytes(
        0,
        functionDeclaration.returnType.name.byteLength
      ),
      errorType,
    }));
  }
  return Option<ModuleFunctionSignature>.none;
}

function ownSymbol(in module: ParsedModule, in declaration: Declaration): ModuleSymbol {
  return ModuleSymbol({
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
    kind: declarationSymbolKind(declaration.kind),
    exported: declaration.exported,
    targetModule: Option<usize>.none,
    importedName: declaration.name.copyBytes(0, declaration.name.byteLength),
    functionSignature: moduleFunctionSignature(module, declaration),
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
    functionSignature: Option<ModuleFunctionSignature>.none,
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
    symbols.push(ownSymbol(module, declaration));
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

function copyValueBindings(in bindings: Array<NativeValueBinding>): Array<NativeValueBinding> {
  let copied = Array<NativeValueBinding>();
  for (const binding of bindings) {
    copied.push(NativeValueBinding({
      name: binding.name.copyBytes(0, binding.name.byteLength),
      typeName: binding.typeName.copyBytes(0, binding.typeName.byteLength),
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

function isIntegerTypeName(in name: String): boolean {
  return name == "i8"
    || name == "i16"
    || name == "i32"
    || name == "i64"
    || name == "u8"
    || name == "u16"
    || name == "u32"
    || name == "u64"
    || name == "isize"
    || name == "usize";
}

function isFloatTypeName(in name: String): boolean {
  return name == "f32" || name == "f64";
}

function isNumericTypeName(in name: String): boolean {
  return isIntegerTypeName(name) || isFloatTypeName(name);
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

function stringStartsWith(in value: String, in prefix: String): boolean {
  if (prefix.byteLength > value.byteLength) return false;
  let index: usize = 0;
  while (index < prefix.byteLength) {
    if (value.byteAt(index) != prefix.byteAt(index)) return false;
    index = index + 1;
  }
  return true;
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

function isNullableTypeName(in name: String): boolean {
  if (name.byteLength < 7) return false;
  return name.copyBytes(name.byteLength - 7, name.byteLength) == " | null";
}

function requireExpressionType(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in expected: String,
  in actual: String
): void throws ModuleResolveError {
  if (actual.byteLength == 0 || expected == actual) return;
  if (isNumericTypeName(expected) && isNumericTypeName(actual) && isContextualNumericLiteral(tree, index)) return;
  if (expected == "cstring" && actual == "String" && tree.nodes[index].kind == ExpressionKind.stringExpression) return;
  if (actual == "null" && isNullableTypeName(expected)) return;
  match (genericTypeShape(expected)) {
    some(generic) => {
      if (generic.base == "Slice" && generic.arguments.length == 1) {
        const actualElement = arrayElementType(actual);
        if (actualElement == generic.arguments[0]) return;
      }
    }
    none => {}
  }
  throw resolutionError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    `expected ${expected}, found ${actual}`,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
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

function trimmedTypeSlice(in name: String, start: usize, end: usize): String {
  let first = start;
  let last = end;
  while (first < last && name.byteAt(first) == 32) {
    first = first + 1;
  }
  while (last > first && name.byteAt(last - 1) == 32) {
    last = last - 1;
  }
  return name.copyBytes(first, last);
}

function genericTypeShape(in name: String): Option<NativeGenericTypeShape> {
  let open = name.byteLength;
  let index: usize = 0;
  while (index < name.byteLength) {
    if (name.byteAt(index) == 60) {
      open = index;
      break;
    }
    index = index + 1;
  }
  if (open == name.byteLength || name.byteAt(name.byteLength - 1) != 62) {
    return Option<NativeGenericTypeShape>.none;
  }
  let arguments = Array<String>();
  let angleDepth: usize = 1;
  let parenthesisDepth: usize = 0;
  let bracketDepth: usize = 0;
  let argumentStart = open + 1;
  index = argumentStart;
  while (index < name.byteLength) {
    const byte = name.byteAt(index);
    if (byte == 40) parenthesisDepth = parenthesisDepth + 1;
    else if (byte == 41 && parenthesisDepth > 0) parenthesisDepth = parenthesisDepth - 1;
    else if (byte == 91) bracketDepth = bracketDepth + 1;
    else if (byte == 93 && bracketDepth > 0) bracketDepth = bracketDepth - 1;
    else if (byte == 60) angleDepth = angleDepth + 1;
    else if (byte == 62 && (index == 0 || name.byteAt(index - 1) != 61)) {
      angleDepth = angleDepth - 1;
      if (angleDepth == 0) {
        if (index != name.byteLength - 1 || index == argumentStart) {
          return Option<NativeGenericTypeShape>.none;
        }
        arguments.push(trimmedTypeSlice(name, argumentStart, index));
        return Option.some(NativeGenericTypeShape({
          base: trimmedTypeSlice(name, 0, open),
          arguments,
        }));
      }
    } else if (
      byte == 44
      && angleDepth == 1
      && parenthesisDepth == 0
      && bracketDepth == 0
    ) {
      if (index == argumentStart) return Option<NativeGenericTypeShape>.none;
      arguments.push(trimmedTypeSlice(name, argumentStart, index));
      argumentStart = index + 1;
    }
    index = index + 1;
  }
  return Option<NativeGenericTypeShape>.none;
}

function fixedArrayShape(in name: String): Option<NativeFixedArrayShape> {
  if (name.byteLength < 4 || name.byteAt(name.byteLength - 1) != 93) {
    return Option<NativeFixedArrayShape>.none;
  }
  let index = name.byteLength - 1;
  while (index > 0) {
    index = index - 1;
    if (name.byteAt(index) == 91) {
      if (index == 0 || index + 1 == name.byteLength - 1) {
        return Option<NativeFixedArrayShape>.none;
      }
      return Option.some(NativeFixedArrayShape({
        elementType: name.copyBytes(0, index),
        length: name.copyBytes(index + 1, name.byteLength - 1),
      }));
    }
  }
  return Option<NativeFixedArrayShape>.none;
}

function nullableTargetType(in name: String): String {
  if (!isNullableTypeName(name)) return "";
  return name.copyBytes(0, name.byteLength - 7);
}

function substituteGenericType(
  in name: String,
  in substitutions: Array<NativeValueBinding>
): String {
  const direct = valueBindingType(substitutions, name);
  if (direct.byteLength > 0) return direct;
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
    if (previous.byteLength > 0 && previous != actual) {
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

function exportedFunctionLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): Option<ModuleSymbolLocation> {
  let symbolIndex: usize = 0;
  while (symbolIndex < modules[moduleIndex].symbols.length) {
    if (
      modules[moduleIndex].symbols[symbolIndex].name == name
      && modules[moduleIndex].symbols[symbolIndex].exported
      && modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.functionSymbol
    ) return Option.some(ModuleSymbolLocation({ moduleIndex, symbolIndex }));
    symbolIndex = symbolIndex + 1;
  }
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
    let symbolIndex: usize = 0;
    while (symbolIndex < modules[moduleIndex].symbols.length) {
      if (modules[moduleIndex].symbols[symbolIndex].name == name) {
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
      symbolIndex = symbolIndex + 1;
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
    let symbolIndex: usize = 0;
    while (symbolIndex < modules[moduleIndex].symbols.length) {
      if (
        modules[moduleIndex].symbols[symbolIndex].name == namespace
        && modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.namespaceSymbol
      ) {
        return match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
          some(target) => exportedFunctionLocation(modules, target, memberName);
          none => Option<ModuleSymbolLocation>.none;
        };
      }
      symbolIndex = symbolIndex + 1;
    }
  }
  return Option<ModuleSymbolLocation>.none;
}

function inferExpressionNodeType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in bindings: Array<NativeValueBinding>
): String throws ModuleResolveError {
  const kind = tree.nodes[index].kind;
  const value = tree.nodes[index].value.copyBytes(0, tree.nodes[index].value.byteLength);
  const children = copyIndices(tree.nodes[index].children);
  if (kind == ExpressionKind.numberExpression) return numberLiteralType(value);
  if (kind == ExpressionKind.stringExpression || kind == ExpressionKind.templateExpression) return "String";
  if (kind == ExpressionKind.booleanExpression) return "boolean";
  if (kind == ExpressionKind.nullExpression) return "null";
  if (
    kind == ExpressionKind.identifierExpression
    || kind == ExpressionKind.argumentBindingExpression
  ) {
    const lookup = identifierLookupName(value);
    return valueBindingType(bindings, lookup);
  }
  if (kind == ExpressionKind.newExpression) return value;
  if (kind == ExpressionKind.variantExpression) return value;
  if (kind == ExpressionKind.argumentReferenceExpression && children.length == 1) {
    return try inferExpressionNodeType(module, modules, moduleIndex, tree, children[0], bindings);
  }
  if (kind == ExpressionKind.unaryExpression && children.length == 1) {
    const operand = try inferExpressionNodeType(module, modules, moduleIndex, tree, children[0], bindings);
    if (operand.byteLength == 0) return "";
    if (value == "!" && operand == "boolean") return "boolean";
    if ((value == "+" || value == "-") && isNumericTypeName(operand)) return operand;
    if (value == "~" && isIntegerTypeName(operand)) return operand;
    const requirement = value == "!"
      ? "a boolean operand"
      : value == "~" ? "an integer operand" : "a numeric operand";
    throw invalidOperator(module, tree, index, `operator ${value} requires ${requirement}`);
  }
  if (kind == ExpressionKind.binaryExpression && children.length == 2) {
    let left = try inferExpressionNodeType(module, modules, moduleIndex, tree, children[0], bindings);
    let right = try inferExpressionNodeType(module, modules, moduleIndex, tree, children[1], bindings);
    if (left.byteLength == 0 || right.byteLength == 0) return "";
    if (isContextualNumericLiteral(tree, children[1]) && isNumericTypeName(left)) right = left.copyBytes(0, left.byteLength);
    else if (isContextualNumericLiteral(tree, children[0]) && isNumericTypeName(right)) left = right.copyBytes(0, right.byteLength);
    if (value == "+" || value == "-" || value == "*" || value == "/" || value == "%") {
      if (left == right && isNumericTypeName(left)) return left;
      throw invalidOperator(module, tree, index, `operator ${value} requires matching numeric operands`);
    }
    if (value == "&" || value == "|" || value == "^" || value == "<<" || value == ">>") {
      if (left == right && isIntegerTypeName(left)) return left;
      throw invalidOperator(module, tree, index, `operator ${value} requires matching integer operands`);
    }
    if (value == "<" || value == "<=" || value == ">" || value == ">=") {
      if (left == right && isNumericTypeName(left)) return "boolean";
      throw invalidOperator(module, tree, index, `operator ${value} requires matching numeric operands`);
    }
    if (value == "==" || value == "!=") {
      if (left == right && (isNumericTypeName(left) || left == "boolean" || left == "String")) return "boolean";
      if ((left == "null" && isNullableTypeName(right)) || (right == "null" && isNullableTypeName(left))) return "boolean";
      throw invalidOperator(module, tree, index, `operator ${value} requires matching comparable operands`);
    }
    if (value == "&&" || value == "||") {
      if (left == "boolean" && right == "boolean") return "boolean";
      throw invalidOperator(module, tree, index, `operator ${value} requires boolean operands`);
    }
    return "";
  }
  if (kind == ExpressionKind.conditionalExpression && children.length == 3) {
    const condition = try inferExpressionNodeType(module, modules, moduleIndex, tree, children[0], bindings);
    if (condition.byteLength > 0) {
      try requireExpressionType(module, tree, children[0], "boolean", condition);
    }
    const thenType = try inferExpressionNodeType(module, modules, moduleIndex, tree, children[1], bindings);
    const elseType = try inferExpressionNodeType(module, modules, moduleIndex, tree, children[2], bindings);
    if (thenType.byteLength == 0 || elseType.byteLength == 0) return "";
    if (thenType == elseType) return thenType;
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
    let elementType = try inferExpressionNodeType(module, modules, moduleIndex, tree, children[0], bindings);
    if (elementType.byteLength == 0) return "";
    let childIndex: usize = 1;
    while (childIndex < children.length) {
      const candidate = try inferExpressionNodeType(module, modules, moduleIndex, tree, children[childIndex], bindings);
      if (candidate.byteLength == 0) return "";
      try requireExpressionType(module, tree, children[childIndex], elementType, candidate);
      childIndex = childIndex + 1;
    }
    return `${elementType}[${children.length}]`;
  }
  if (kind == ExpressionKind.indexExpression && children.length == 2) {
    const owner = try inferExpressionNodeType(module, modules, moduleIndex, tree, children[0], bindings);
    const offset = try inferExpressionNodeType(module, modules, moduleIndex, tree, children[1], bindings);
    if (offset.byteLength > 0 && !isIntegerTypeName(offset)) {
      throw invalidOperator(module, tree, children[1], `index requires an integer, found ${offset}`);
    }
    return arrayElementType(owner);
  }
  if (kind == ExpressionKind.closureExpression) {
    if (tree.nodes[index].labels.length > 0 && tree.nodes[index].labels[0].byteLength > 0) {
      return `__z_native_function:${tree.nodes[index].labels[0]}`;
    }
    return "";
  }
  if (kind == ExpressionKind.callExpression && children.length > 0) {
    let argumentTypes = Array<String>();
    let argumentIndex: usize = 1;
    while (argumentIndex < children.length) {
      const argumentType = try inferExpressionNodeType(
        module,
        modules,
        moduleIndex,
        tree,
        children[argumentIndex],
        bindings
      );
      argumentTypes.push(argumentType);
      argumentIndex = argumentIndex + 1;
    }
    const calleeIndex = children[0];
    if (tree.nodes[calleeIndex].kind == ExpressionKind.identifierExpression) {
      const callee = tree.nodes[calleeIndex].value.copyBytes(
        0,
        tree.nodes[calleeIndex].value.byteLength
      );
      const lookup = identifierLookupName(callee);
      const localType = valueBindingType(bindings, lookup);
      const functionPrefix = "__z_native_function:";
      if (stringStartsWith(localType, functionPrefix)) {
        return localType.copyBytes(functionPrefix.byteLength, localType.byteLength);
      }
      // A lexical value shadows a same-named module function. Its callability
      // remains unresolved until native value/function-type checking is complete.
      if (localType.byteLength > 0) return "";
      const base = identifierLookupName(callee);
      if (base == "Array") return callee;
      for (const declaration of module.program.aggregates) {
        if (declaration.name == base) return callee;
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
            if (signature.parameterTypes.length != argumentTypes.length) {
              throw genericCallError(
                module,
                tree,
                calleeIndex,
                `${functionName} expects ${signature.parameterTypes.length} argument(s), received ${argumentTypes.length}`
              );
            }
            let substitutions = Array<NativeValueBinding>();
            match (explicitCallTypeArguments(tree, calleeIndex)) {
              some(explicit) => {
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
                let parameterIndex: usize = 0;
                while (parameterIndex < argumentTypes.length) {
                  try bindGenericType(
                    module,
                    tree,
                    children[parameterIndex + 1],
                    functionName,
                    signature.parameterTypes[parameterIndex],
                    argumentTypes[parameterIndex],
                    signature.typeParameters,
                    inout substitutions
                  );
                  parameterIndex = parameterIndex + 1;
                }
              }
            }
            for (const typeParameter of signature.typeParameters) {
              const substituted = valueBindingType(substitutions, typeParameter);
              if (substituted.byteLength == 0) return "";
            }
            let parameterIndex: usize = 0;
            while (parameterIndex < argumentTypes.length) {
              const expected = substituteGenericType(
                signature.parameterTypes[parameterIndex],
                substitutions
              );
              try requireExpressionType(
                module,
                tree,
                children[parameterIndex + 1],
                expected,
                argumentTypes[parameterIndex]
              );
              parameterIndex = parameterIndex + 1;
            }
            return substituteGenericType(signature.returnType, substitutions);
          }
          none => {}
        }
      }
      none => {}
    }
    return "";
  }
  return "";
}

function inferExpressionType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in expression: ExpressionSyntax,
  in bindings: Array<NativeValueBinding>
): String throws ModuleResolveError {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      select try inferExpressionNodeType(module, modules, moduleIndex, tree, root, bindings);
    }
    none => "";
  };
}

function requireExpressionSyntaxType(
  in module: ParsedModule,
  in expression: ExpressionSyntax,
  in expected: String,
  in actual: String
): void throws ModuleResolveError {
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      try requireExpressionType(module, tree, root, expected, actual);
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
  in expectedReturn: String
): void throws ModuleResolveError {
  const kind = arena.nodes[index].kind;
  if (kind == StatementKind.variableStatement) {
    let inferred = "";
    match (in arena.nodes[index].expression) {
      some(expression) => inferred = try inferExpressionType(
        module,
        modules,
        moduleIndex,
        expression,
        bindings
      );
      none => {}
    }
    let stored = inferred.copyBytes(0, inferred.byteLength);
    match (in arena.nodes[index].typeAnnotation) {
      some(type) => {
        match (in arena.nodes[index].expression) {
          some(expression) => try requireExpressionSyntaxType(
            module,
            expression,
            type.name,
            inferred
          );
          none => {}
        }
        stored = type.name.copyBytes(0, type.name.byteLength);
      }
      none => {}
    }
    addValueBinding(inout bindings, arena.nodes[index].name, stored);
    return;
  }
  if (kind == StatementKind.assignmentStatement) {
    let expected = "";
    match (in arena.nodes[index].expression) {
      some(target) => {
        match (in target.tree) {
          some(tree) => {
            if (tree.nodes[tree.root].kind == ExpressionKind.identifierExpression) {
              expected = valueBindingType(bindings, tree.nodes[tree.root].value);
            }
          }
          none => {}
        }
      }
      none => {}
    }
    match (in arena.nodes[index].secondExpression) {
      some(value) => {
        const actual = try inferExpressionType(module, modules, moduleIndex, value, bindings);
        if (expected.byteLength > 0) {
          try requireExpressionSyntaxType(module, value, expected, actual);
        }
      }
      none => {}
    }
    return;
  }
  if (kind == StatementKind.returnStatement || kind == StatementKind.selectStatement) {
    match (in arena.nodes[index].expression) {
      some(expression) => {
        const actual = try inferExpressionType(module, modules, moduleIndex, expression, bindings);
        if (expectedReturn.byteLength > 0) {
          try requireExpressionSyntaxType(module, expression, expectedReturn, actual);
        }
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
  }
  if (kind == StatementKind.ifStatement || kind == StatementKind.whileStatement) {
    match (in arena.nodes[index].expression) {
      some(condition) => {
        const actual = try inferExpressionType(module, modules, moduleIndex, condition, bindings);
        if (actual.byteLength > 0) {
          try requireExpressionSyntaxType(module, condition, "boolean", actual);
        }
      }
      none => {}
    }
  }
  if (kind == StatementKind.forStatement) {
    let loopBindings = copyValueBindings(bindings);
    let elementType = "";
    match (in arena.nodes[index].expression) {
      some(iterable) => {
        const iterableType = try inferExpressionType(module, modules, moduleIndex, iterable, bindings);
        elementType = arrayElementType(iterableType);
      }
      none => {}
    }
    addValueBinding(inout loopBindings, arena.nodes[index].name, elementType);
    try inferStatementSequence(
      module,
      modules,
      moduleIndex,
      arena,
      arena.nodes[index].children,
      loopBindings,
      expectedReturn
    );
    return;
  }
  try inferStatementSequence(
    module,
    modules,
    moduleIndex,
    arena,
    arena.nodes[index].children,
    bindings,
    expectedReturn
  );
}

function inferStatementSequence(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in indices: Array<usize>,
  in inherited: Array<NativeValueBinding>,
  in expectedReturn: String
): void throws ModuleResolveError {
  let bindings = copyValueBindings(inherited);
  for (const index of indices) {
    try inferStatement(
      module,
      modules,
      moduleIndex,
      arena,
      index,
      inout bindings,
      expectedReturn
    );
  }
}

function functionValueBindings(in parameters: Array<Parameter>): Array<NativeValueBinding> {
  let bindings = Array<NativeValueBinding>();
  for (const parameter of parameters) {
    addValueBinding(inout bindings, parameter.name, parameter.type.name);
  }
  return bindings;
}

function inferFunctionExpressions(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in declaration: FunctionDeclaration,
  in ownerType: String
): void throws ModuleResolveError {
  let bindings = functionValueBindings(declaration.parameters);
  if (!declaration.staticMethod && ownerType.byteLength > 0) {
    addValueBinding(inout bindings, "this", ownerType);
  }
  try inferStatementSequence(
    module,
    modules,
    moduleIndex,
    declaration.body,
    declaration.body.roots,
    bindings,
    declaration.returnType.name
  );
}

function validateExpressionTypesAndLocals(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize
): void throws ModuleResolveError {
  for (const declaration of module.program.functions) {
    try inferFunctionExpressions(module, modules, moduleIndex, declaration, "");
  }
  for (const aggregate of module.program.aggregates) {
    match (in aggregate.constructorDeclaration) {
      some(initializer) => {
        let bindings = functionValueBindings(initializer.parameters);
        addValueBinding(inout bindings, "this", aggregate.name);
        try inferStatementSequence(
          module,
          modules,
          moduleIndex,
          initializer.body,
          initializer.body.roots,
          bindings,
          "void"
        );
      }
      none => {}
    }
    for (const method of aggregate.methods) {
      try inferFunctionExpressions(module, modules, moduleIndex, method, aggregate.name);
    }
    match (in aggregate.deinitializer) {
      some(deinitializer) => {
        let bindings = Array<NativeValueBinding>();
        addValueBinding(inout bindings, "this", aggregate.name);
        try inferStatementSequence(
          module,
          modules,
          moduleIndex,
          deinitializer.body,
          deinitializer.body.roots,
          bindings,
          "void"
        );
      }
      none => {}
    }
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
    try validateExpressionTypesAndLocals(parsed[index], modules, index);
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
