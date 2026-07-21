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
  ReceiverMode,
  StatementArena,
  StatementKind,
  TraitDeclaration,
  TypeParameter,
  TypeReference,
  Visibility,
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
  unknownMember,
  typeMismatch,
  invalidOperator,
  invalidMatch,
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
  signature: ModuleFunctionSignature;
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
  typeSignature: Option<ModuleTypeSignature>;
  offset: usize;
  line: usize;
  column: usize;
}

export struct ModuleFieldSignature {
  name: String;
  typeName: String;
  visibility: String;
  readonlyField: boolean;
}

export struct ModuleVariantSignature {
  name: String;
  payloadType: String;
}

export struct ModuleMethodSignature {
  name: String;
  staticMethod: boolean;
  visibility: String;
  receiverMode: String;
  signature: ModuleFunctionSignature;
}

export struct ModuleTypeSignature {
  typeParameters: Array<String>;
  fields: Array<ModuleFieldSignature>;
  methods: Array<ModuleMethodSignature>;
  variants: Array<ModuleVariantSignature>;
  customDeinit: boolean;
  customConstructor: boolean;
  constructorSignature: Option<ModuleFunctionSignature>;
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
    return Option.some(functionDeclarationSignature(functionDeclaration));
  }
  return Option<ModuleFunctionSignature>.none;
}

function functionDeclarationSignature(
  in declaration: FunctionDeclaration
): ModuleFunctionSignature {
  let typeParameters = Array<String>();
  for (const parameter of declaration.typeParameters) {
    typeParameters.push(parameter.name.copyBytes(0, parameter.name.byteLength));
  }
  let parameterTypes = Array<String>();
  let parameterModes = Array<String>();
  for (const parameter of declaration.parameters) {
    parameterModes.push(moduleParameterModeName(parameter.mode));
    parameterTypes.push(parameter.type.name.copyBytes(0, parameter.type.name.byteLength));
  }
  let errorType = "";
  match (in declaration.errorType) {
    some(error) => errorType = error.name.copyBytes(0, error.name.byteLength);
    none => {}
  }
  return ModuleFunctionSignature({
    asynchronous: declaration.asynchronous,
    typeParameters,
    parameterModes,
    parameterTypes,
    returnType: declaration.returnType.name.copyBytes(
      0,
      declaration.returnType.name.byteLength
    ),
    errorType,
  });
}

function constructorDeclarationSignature(
  in ownerName: String,
  in declaration: ConstructorDeclaration
): ModuleFunctionSignature {
  let parameterTypes = Array<String>();
  let parameterModes = Array<String>();
  for (const parameter of declaration.parameters) {
    parameterModes.push(moduleParameterModeName(parameter.mode));
    parameterTypes.push(parameter.type.name.copyBytes(0, parameter.type.name.byteLength));
  }
  let errorType = "";
  match (in declaration.errorType) {
    some(error) => errorType = error.name.copyBytes(0, error.name.byteLength);
    none => {}
  }
  return ModuleFunctionSignature({
    asynchronous: false,
    typeParameters: Array<String>(),
    parameterModes,
    parameterTypes,
    returnType: ownerName.copyBytes(0, ownerName.byteLength),
    errorType,
  });
}

function moduleReceiverModeName(mode: ReceiverMode): String {
  if (mode == ReceiverMode.inputOutput) return "inout";
  if (mode == ReceiverMode.move) return "move";
  return "in";
}

function moduleVisibilityName(visibility: Visibility): String {
  if (visibility == Visibility.privateVisibility) return "private";
  return "public";
}

function moduleTypeSignature(
  in module: ParsedModule,
  in declaration: Declaration
): Option<ModuleTypeSignature> {
  if (
    declaration.kind == DeclarationKind.structDeclaration
    || declaration.kind == DeclarationKind.classDeclaration
  ) {
    for (const aggregate of module.program.aggregates) {
      if (aggregate.name != declaration.name) continue;
      let typeParameters = Array<String>();
      for (const parameter of aggregate.typeParameters) {
        typeParameters.push(parameter.name.copyBytes(0, parameter.name.byteLength));
      }
      let fields = Array<ModuleFieldSignature>();
      for (const field of aggregate.fields) {
        fields.push(ModuleFieldSignature({
          name: field.name.copyBytes(0, field.name.byteLength),
          typeName: field.type.name.copyBytes(0, field.type.name.byteLength),
          visibility: moduleVisibilityName(field.visibility),
          readonlyField: field.readonlyField,
        }));
      }
      let methods = Array<ModuleMethodSignature>();
      for (const method of aggregate.methods) {
        methods.push(ModuleMethodSignature({
          name: method.name.copyBytes(0, method.name.byteLength),
          staticMethod: method.staticMethod,
          visibility: moduleVisibilityName(method.visibility),
          receiverMode: moduleReceiverModeName(method.receiverMode),
          signature: functionDeclarationSignature(method),
        }));
      }
      let customDeinit = false;
      match (in aggregate.deinitializer) {
        some(deinitializer) => customDeinit = true;
        none => {}
      }
      let customConstructor = false;
      let constructorSignature = Option<ModuleFunctionSignature>.none;
      match (in aggregate.constructorDeclaration) {
        some(initializer) => {
          customConstructor = true;
          constructorSignature = Option.some(constructorDeclarationSignature(
            aggregate.name,
            initializer
          ));
        }
        none => {}
      }
      return Option.some(ModuleTypeSignature({
        typeParameters,
        fields,
        methods,
        variants: Array<ModuleVariantSignature>(),
        customDeinit,
        customConstructor,
        constructorSignature,
      }));
    }
  }
  if (declaration.kind == DeclarationKind.enumDeclaration) {
    for (const enumDeclaration of module.program.enums) {
      if (enumDeclaration.name != declaration.name) continue;
      let variants = Array<ModuleVariantSignature>();
      for (const variant of enumDeclaration.variants) {
        let payloadType = "";
        match (in variant.payload) {
          some(payload) => payloadType = payload.name.copyBytes(0, payload.name.byteLength);
          none => {}
        }
        variants.push(ModuleVariantSignature({
          name: variant.name.copyBytes(0, variant.name.byteLength),
          payloadType,
        }));
      }
      return Option.some(ModuleTypeSignature({
        typeParameters: Array<String>(),
        fields: Array<ModuleFieldSignature>(),
        methods: Array<ModuleMethodSignature>(),
        variants,
        customDeinit: false,
        customConstructor: false,
        constructorSignature: Option<ModuleFunctionSignature>.none,
      }));
    }
  }
  return Option<ModuleTypeSignature>.none;
}

function ownSymbol(in module: ParsedModule, in declaration: Declaration): ModuleSymbol {
  return ModuleSymbol({
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
    kind: declarationSymbolKind(declaration.kind),
    exported: declaration.exported,
    targetModule: Option<usize>.none,
    importedName: declaration.name.copyBytes(0, declaration.name.byteLength),
    functionSignature: moduleFunctionSignature(module, declaration),
    typeSignature: moduleTypeSignature(module, declaration),
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
    typeSignature: Option<ModuleTypeSignature>.none,
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
  inout bindings: Array<NativeValueBinding>
): void throws ModuleResolveError {
  if (!typeMovesOnOwnedUse(modules, moduleIndex, typeName)) return;
  const kind = tree.nodes[index].kind;
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
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in expected: String,
  in actual: String
): void throws ModuleResolveError {
  if (
    actual.byteLength == 0
    || actual == "__z_never"
    || equivalentTypes(modules, moduleIndex, expected, actual)
  ) return;
  if (isNumericTypeName(expected) && isNumericTypeName(actual) && isContextualNumericLiteral(tree, index)) return;
  if (expected == "cstring" && actual == "String" && tree.nodes[index].kind == ExpressionKind.stringExpression) return;
  if (actual == "null" && isNullableTypeName(expected)) return;
  match (genericTypeShape(expected)) {
    some(generic) => {
      if (generic.base == "Slice" && generic.arguments.length == 1) {
        const actualElement = arrayElementType(actual);
        if (equivalentTypes(modules, moduleIndex, actualElement, generic.arguments[0])) return;
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

function exportedTypeLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): Option<ModuleSymbolLocation> {
  let symbolIndex: usize = 0;
  while (symbolIndex < modules[moduleIndex].symbols.length) {
    if (
      modules[moduleIndex].symbols[symbolIndex].name == name
      && modules[moduleIndex].symbols[symbolIndex].exported
      && isTypeSymbolKind(modules[moduleIndex].symbols[symbolIndex].kind)
    ) return Option.some(ModuleSymbolLocation({ moduleIndex, symbolIndex }));
    symbolIndex = symbolIndex + 1;
  }
  return Option<ModuleSymbolLocation>.none;
}

function typeSymbolLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in sourceType: String
): Option<ModuleSymbolLocation> {
  let typeName = sourceType.copyBytes(0, sourceType.byteLength);
  match (genericTypeShape(sourceType)) {
    some(generic) => typeName = generic.base.copyBytes(0, generic.base.byteLength);
    none => {}
  }
  const base = qualifiedTypeBase(typeName);
  const member = qualifiedTypeMember(typeName);
  let symbolIndex: usize = 0;
  while (symbolIndex < modules[moduleIndex].symbols.length) {
    if (modules[moduleIndex].symbols[symbolIndex].name != base) {
      symbolIndex = symbolIndex + 1;
      continue;
    }
    if (member.byteLength > 0) {
      if (modules[moduleIndex].symbols[symbolIndex].kind != ModuleSymbolKind.namespaceSymbol) {
        return Option<ModuleSymbolLocation>.none;
      }
      return match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
        some(target) => exportedTypeLocation(modules, target, member);
        none => Option<ModuleSymbolLocation>.none;
      };
    }
    if (isTypeSymbolKind(modules[moduleIndex].symbols[symbolIndex].kind)) {
      return Option.some(ModuleSymbolLocation({ moduleIndex, symbolIndex }));
    }
    if (modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.importedSymbol) {
      const importedName = modules[moduleIndex].symbols[symbolIndex].importedName.copyBytes(
        0,
        modules[moduleIndex].symbols[symbolIndex].importedName.byteLength
      );
      return match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
        some(target) => exportedTypeLocation(modules, target, importedName);
        none => Option<ModuleSymbolLocation>.none;
      };
    }
    return Option<ModuleSymbolLocation>.none;
  }
  return Option<ModuleSymbolLocation>.none;
}

function localTypeSpelling(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in location: ModuleSymbolLocation
): String {
  const targetName = modules[location.moduleIndex].symbols[location.symbolIndex].name.copyBytes(
    0,
    modules[location.moduleIndex].symbols[location.symbolIndex].name.byteLength
  );
  let symbolIndex: usize = 0;
  while (symbolIndex < modules[moduleIndex].symbols.length) {
    if (
      moduleIndex == location.moduleIndex
      && symbolIndex == location.symbolIndex
    ) return targetName;
    if (modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.importedSymbol) {
      match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
        some(target) => {
          if (
            target == location.moduleIndex
            && modules[moduleIndex].symbols[symbolIndex].importedName == targetName
          ) return modules[moduleIndex].symbols[symbolIndex].name.copyBytes(
            0,
            modules[moduleIndex].symbols[symbolIndex].name.byteLength
          );
        }
        none => {}
      }
    }
    symbolIndex = symbolIndex + 1;
  }
  symbolIndex = 0;
  while (symbolIndex < modules[moduleIndex].symbols.length) {
    if (modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.namespaceSymbol) {
      match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
        some(target) => {
          if (target == location.moduleIndex) {
            return `${modules[moduleIndex].symbols[symbolIndex].name}.${targetName}`;
          }
        }
        none => {}
      }
    }
    symbolIndex = symbolIndex + 1;
  }
  return targetName;
}

function rebaseTypeName(
  in modules: Array<ResolvedModule>,
  fromModuleIndex: usize,
  toModuleIndex: usize,
  in name: String
): String {
  const nullableTarget = nullableTargetType(name);
  if (nullableTarget.byteLength > 0) {
    const rebased = rebaseTypeName(modules, fromModuleIndex, toModuleIndex, nullableTarget);
    return `${rebased} | null`;
  }
  if (stringStartsWith(name, "view ")) {
    const target = name.copyBytes(5, name.byteLength);
    const rebased = rebaseTypeName(modules, fromModuleIndex, toModuleIndex, target);
    return `view ${rebased}`;
  }
  match (fixedArrayShape(name)) {
    some(array) => {
      const element = rebaseTypeName(modules, fromModuleIndex, toModuleIndex, array.elementType);
      return `${element}[${array.length}]`;
    }
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      let base = generic.base.copyBytes(0, generic.base.byteLength);
      match (typeSymbolLocation(modules, fromModuleIndex, generic.base)) {
        some(location) => base = localTypeSpelling(modules, toModuleIndex, location);
        none => {}
      }
      let output = TextBuffer();
      output.append(base);
      output.append("<");
      let index: usize = 0;
      while (index < generic.arguments.length) {
        if (index > 0) output.append(", ");
        const argument = rebaseTypeName(
          modules,
          fromModuleIndex,
          toModuleIndex,
          generic.arguments[index]
        );
        output.append(argument);
        index = index + 1;
      }
      output.append(">");
      return output.finish();
    }
    none => {}
  }
  return match (typeSymbolLocation(modules, fromModuleIndex, name)) {
    some(location) => localTypeSpelling(modules, toModuleIndex, location);
    none => name.copyBytes(0, name.byteLength);
  };
}

function semanticTypeIdentity(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): String {
  const nullableTarget = nullableTargetType(name);
  if (nullableTarget.byteLength > 0) {
    const identity = semanticTypeIdentity(modules, moduleIndex, nullableTarget);
    return `${identity} | null`;
  }
  if (stringStartsWith(name, "view ")) {
    const target = name.copyBytes(5, name.byteLength);
    const identity = semanticTypeIdentity(modules, moduleIndex, target);
    return `view ${identity}`;
  }
  match (fixedArrayShape(name)) {
    some(array) => {
      const identity = semanticTypeIdentity(modules, moduleIndex, array.elementType);
      return `${identity}[${array.length}]`;
    }
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      let base = generic.base.copyBytes(0, generic.base.byteLength);
      match (typeSymbolLocation(modules, moduleIndex, generic.base)) {
        some(location) => base = `@${location.moduleIndex}:${location.symbolIndex}`;
        none => {}
      }
      let output = TextBuffer();
      output.append(base);
      output.append("<");
      let index: usize = 0;
      while (index < generic.arguments.length) {
        if (index > 0) output.append(",");
        const argument = semanticTypeIdentity(modules, moduleIndex, generic.arguments[index]);
        output.append(argument);
        index = index + 1;
      }
      output.append(">");
      return output.finish();
    }
    none => {}
  }
  return match (typeSymbolLocation(modules, moduleIndex, name)) {
    some(location) => `@${location.moduleIndex}:${location.symbolIndex}`;
    none => name.copyBytes(0, name.byteLength);
  };
}

function equivalentTypes(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in left: String,
  in right: String
): boolean {
  if (left == right) return true;
  return semanticTypeIdentity(modules, moduleIndex, left)
    == semanticTypeIdentity(modules, moduleIndex, right);
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
      if (generic.base == "Array" || generic.base == "Task" || generic.base == "Weak") {
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

function containsString(in values: Array<String>, in value: String): boolean {
  for (const candidate of values) {
    if (candidate == value) return true;
  }
  return false;
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
    typeParameters,
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
    typeParameters,
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
  if (method.staticMethod && method.ownerTypeArguments.length == 0) {
    for (const parameter of method.ownerTypeParameters) {
      typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
    }
  }
  for (const parameter of method.signature.typeParameters) {
    typeParameters.push(parameter.copyBytes(0, parameter.byteLength));
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
    typeParameters,
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
  inout bindings: Array<NativeValueBinding>
): String throws ModuleResolveError {
  const kind = arena.nodes[statementIndex].kind;
  if (
    kind == StatementKind.expressionStatement
    || kind == StatementKind.selectStatement
    || kind == StatementKind.matchStatement
  ) {
    return match (in arena.nodes[statementIndex].expression) {
      some(expression) => {
        const typeName = try inferExpressionType(
          module,
          modules,
          moduleIndex,
          arena,
          expression,
          inout bindings
        );
        try consumeOwnedExpressionSyntax(
          module,
          modules,
          moduleIndex,
          expression,
          typeName,
          inout bindings
        );
        return typeName;
      }
      none => "";
    };
  }
  if (kind == StatementKind.returnStatement || kind == StatementKind.throwStatement) {
    try inferStatement(
      module,
      modules,
      moduleIndex,
      arena,
      statementIndex,
      inout bindings,
      ""
    );
    return "__z_never";
  }
  if (kind == StatementKind.blockStatement) {
    const children = copyIndices(arena.nodes[statementIndex].children);
    if (children.length == 0) return "";
    let index: usize = 0;
    while (index + 1 < children.length) {
      try inferStatement(
        module,
        modules,
        moduleIndex,
        arena,
        children[index],
        inout bindings,
        ""
      );
      index = index + 1;
    }
    return try inferMatchArmStatementType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[children.length - 1],
      inout bindings
    );
  }
  try inferStatement(
    module,
    modules,
    moduleIndex,
    arena,
    statementIndex,
    inout bindings,
    ""
  );
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
  inout bindings: Array<NativeValueBinding>
): String throws ModuleResolveError {
  if (tree.nodes[index].kind != ExpressionKind.objectExpression) return "";
  let known = false;
  match (typeSymbolLocation(modules, moduleIndex, expectedType)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => known = true;
        none => {}
      }
    }
    none => {}
  }
  if (!known) return "";
  const children = copyIndices(tree.nodes[index].children);
  let covered = Array<String>();
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
        const actual = try inferExpressionNodeType(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          children[childIndex],
          inout bindings
        );
        try requireExpressionType(
          module,
          modules,
          moduleIndex,
          tree,
          children[childIndex],
          field.typeName,
          actual
        );
        try consumeOwnedExpressionNode(
          module,
          modules,
          moduleIndex,
          tree,
          children[childIndex],
          field.typeName,
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
  return expectedType.copyBytes(0, expectedType.byteLength);
}

function inferMatchExpressionNodeType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize,
  inout bindings: Array<NativeValueBinding>
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
    inout bindings
  );
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
        inout armBindings
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

function callArgumentNodes(in children: Array<usize>): Array<usize> {
  let arguments = Array<usize>();
  let index: usize = 1;
  while (index < children.length) {
    arguments.push(children[index]);
    index = index + 1;
  }
  return arguments;
}

function inferSignatureCallType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  calleeIndex: usize,
  in argumentNodes: Array<usize>,
  inout bindings: Array<NativeValueBinding>,
  in receiverRoot: String,
  in receiverMode: String,
  in functionName: String,
  in signature: ModuleFunctionSignature,
  in initialSubstitutions: Array<NativeValueBinding>
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
      const argumentType = try inferExpressionNodeType(
        module,
        modules,
        moduleIndex,
        arena,
        tree,
        nodeIndex,
        inout bindings
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
          inout bindings
        );
      }
      argumentTypes.push(argumentType);
    }
    argumentIndex = argumentIndex + 1;
  }
  let substitutions = copyValueBindings(initialSubstitutions);
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
          modules,
          moduleIndex,
          tree,
          argumentNodes[parameterIndex],
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
  return substituteGenericType(signature.returnType, substitutions);
}

function inferUnclassifiedCallArguments(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  in children: Array<usize>,
  inout bindings: Array<NativeValueBinding>
): void throws ModuleResolveError {
  let argumentTypes = Array<String>();
  let argumentIndex: usize = 1;
  while (argumentIndex < children.length) {
    const argumentType = try inferExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[argumentIndex],
      inout bindings
    );
    argumentTypes.push(argumentType);
    argumentIndex = argumentIndex + 1;
  }
}

function inferExpressionNodeType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize,
  inout bindings: Array<NativeValueBinding>
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
    try requireInitializedBinding(module, tree, index, bindings, lookup);
    return valueBindingType(bindings, lookup);
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
                  }
                  none => {}
                }
                let callableSignature = rebaseModuleFunctionSignature(
                  modules,
                  location.moduleIndex,
                  moduleIndex,
                  signature
                );
                callableSignature.returnType = value.copyBytes(0, value.byteLength);
                return try inferSignatureCallType(
                  module,
                  modules,
                  moduleIndex,
                  arena,
                  tree,
                  index,
                  children,
                  inout bindings,
                  "",
                  "",
                  `${value}.constructor`,
                  callableSignature,
                  substitutions
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
                  inout bindings
                );
                if (contextual.byteLength > 0) return value;
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
                inout bindings
              );
            } else {
              actual = try inferExpressionNodeType(
                module,
                modules,
                moduleIndex,
                arena,
                tree,
                children[1],
                inout bindings
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
              inout bindings
            );
          }
        }
        none => {}
      }
    }
    return value;
  }
  if (kind == ExpressionKind.matchExpression) {
    return try inferMatchExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      index,
      inout bindings
    );
  }
  if (kind == ExpressionKind.argumentReferenceExpression && children.length == 1) {
    if (value == "out") {
      const bindingName = identifierLookupName(tree.nodes[children[0]].value);
      return valueBindingType(bindings, bindingName);
    }
    return try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings);
  }
  if (kind == ExpressionKind.memberExpression && children.length == 1) {
    const receiverType = try inferExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[0],
      inout bindings
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
    const operand = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings);
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
    let left = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings);
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
        inout rightBindings
      );
      mergeBindingFlowStates(inout bindings, beforeRight, rightBindings);
      if (left.byteLength == 0 || right.byteLength == 0) return "";
      if (left == "boolean" && right == "boolean") return "boolean";
      throw invalidOperator(module, tree, index, `operator ${value} requires boolean operands`);
    }
    let right = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[1], inout bindings);
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
  if (kind == ExpressionKind.conditionalExpression && children.length == 3) {
    const condition = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings);
    if (condition.byteLength > 0) {
      try requireExpressionType(module, modules, moduleIndex, tree, children[0], "boolean", condition);
    }
    let thenBindings = copyValueBindings(bindings);
    let elseBindings = copyValueBindings(bindings);
    const thenType = try inferExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[1],
      inout thenBindings
    );
    const elseType = try inferExpressionNodeType(
      module,
      modules,
      moduleIndex,
      arena,
      tree,
      children[2],
      inout elseBindings
    );
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
        inout thenBindings
      );
      try consumeOwnedExpressionNode(
        module,
        modules,
        moduleIndex,
        tree,
        children[2],
        elseType,
        inout elseBindings
      );
      mergeBindingFlowStates(inout bindings, thenBindings, elseBindings);
      return thenType;
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
    let elementType = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings);
    if (elementType.byteLength == 0) return "";
    try consumeOwnedExpressionNode(
      module,
      modules,
      moduleIndex,
      tree,
      children[0],
      elementType,
      inout bindings
    );
    let childIndex: usize = 1;
    while (childIndex < children.length) {
      const candidate = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[childIndex], inout bindings);
      if (candidate.byteLength == 0) return "";
      try requireExpressionType(module, modules, moduleIndex, tree, children[childIndex], elementType, candidate);
      try consumeOwnedExpressionNode(
        module,
        modules,
        moduleIndex,
        tree,
        children[childIndex],
        elementType,
        inout bindings
      );
      childIndex = childIndex + 1;
    }
    return `${elementType}[${children.length}]`;
  }
  if (kind == ExpressionKind.indexExpression && children.length == 2) {
    const owner = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[0], inout bindings);
    const offset = try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, children[1], inout bindings);
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
                inout bindings
              );
            } else {
              actual = try inferExpressionNodeType(
                module,
                modules,
                moduleIndex,
                arena,
                tree,
                children[1],
                inout bindings
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
          const contextual = try inferContextualObjectExpressionNode(
            module,
            modules,
            moduleIndex,
            arena,
            tree,
            children[1],
            constructionType,
            inout bindings
          );
          if (contextual.byteLength > 0) return constructionType;
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
      const functionPrefix = "__z_native_function:";
      if (stringStartsWith(localType, functionPrefix)) {
        try inferUnclassifiedCallArguments(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          children,
          inout bindings
        );
        return localType.copyBytes(functionPrefix.byteLength, localType.byteLength);
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
          inout bindings
        );
        return "";
      }
      const base = identifierLookupName(callee);
      if (base == "Array") {
        try inferUnclassifiedCallArguments(
          module,
          modules,
          moduleIndex,
          arena,
          tree,
          children,
          inout bindings
        );
        return callee;
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
            inout bindings
          );
          return callee;
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
              argumentNodes,
              inout bindings,
              "",
              "",
              functionName,
              callableSignature,
              substitutions
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
        inout bindings
      );
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
        match (methodCallShape(modules, moduleIndex, ownerType, methodName, staticMethod)) {
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
            const callType = try inferSignatureCallType(
              module,
              modules,
              moduleIndex,
              arena,
              tree,
              calleeIndex,
              argumentNodes,
              inout bindings,
              receiverRoot,
              receiverAccess,
              `${method.ownerName}.${method.name}`,
              callableSignature,
              substitutions
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
      inout bindings
    );
    return "";
  }
  return "";
}

function inferExpressionType(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in expression: ExpressionSyntax,
  inout bindings: Array<NativeValueBinding>
): String throws ModuleResolveError {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      select try inferExpressionNodeType(module, modules, moduleIndex, arena, tree, root, inout bindings);
    }
    none => "";
  };
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
  in expectedReturn: String
): void throws ModuleResolveError {
  const kind = arena.nodes[index].kind;
  const statementChildren = copyIndices(arena.nodes[index].children);
  if (kind == StatementKind.variableStatement) {
    let inferred = "";
    match (in arena.nodes[index].expression) {
      some(expression) => inferred = try inferExpressionType(
        module,
        modules,
        moduleIndex,
        arena,
        expression,
        inout bindings
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
        stored = type.name.copyBytes(0, type.name.byteLength);
      }
      none => {}
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
    return;
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
                inout bindings
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
                inout bindings
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
        const actual = try inferExpressionType(module, modules, moduleIndex, arena, value, inout bindings);
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
    return;
  }
  if (
    kind == StatementKind.expressionStatement
    || kind == StatementKind.matchStatement
    || kind == StatementKind.throwStatement
  ) {
    match (in arena.nodes[index].expression) {
      some(expression) => {
        const expressionType = try inferExpressionType(
          module,
          modules,
          moduleIndex,
          arena,
          expression,
          inout bindings
        );
        if (expressionType.byteLength == 0) return;
        if (kind == StatementKind.throwStatement) {
          try consumeOwnedExpressionSyntax(
            module,
            modules,
            moduleIndex,
            expression,
            expressionType,
            inout bindings
          );
        }
      }
      none => {}
    }
    return;
  }
  if (kind == StatementKind.returnStatement || kind == StatementKind.selectStatement) {
    match (in arena.nodes[index].expression) {
      some(expression) => {
        const actual = try inferExpressionType(module, modules, moduleIndex, arena, expression, inout bindings);
        if (kind == StatementKind.returnStatement && expectedReturn.byteLength > 0) {
          try requireExpressionSyntaxType(
            module,
            modules,
            moduleIndex,
            expression,
            expectedReturn,
            actual
          );
        }
        let consumedType = actual.copyBytes(0, actual.byteLength);
        if (kind == StatementKind.returnStatement && expectedReturn.byteLength > 0) {
          consumedType = expectedReturn.copyBytes(0, expectedReturn.byteLength);
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
    return;
  }
  if (kind == StatementKind.ifStatement || kind == StatementKind.whileStatement) {
    match (in arena.nodes[index].expression) {
      some(condition) => {
        const actual = try inferExpressionType(module, modules, moduleIndex, arena, condition, inout bindings);
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
    if (statementChildren.length > 0) {
      try inferStatement(
        module,
        modules,
        moduleIndex,
        arena,
        statementChildren[0],
        inout thenBindings,
        expectedReturn
      );
    }
    if (statementChildren.length > 1) {
      try inferStatement(
        module,
        modules,
        moduleIndex,
        arena,
        statementChildren[1],
        inout elseBindings,
        expectedReturn
      );
    }
    mergeBindingFlowStates(
      inout bindings,
      thenBindings,
      elseBindings
    );
    return;
  }
  if (kind == StatementKind.whileStatement) {
    const beforeLoop = copyValueBindings(bindings);
    let loopBindings = copyValueBindings(bindings);
    try inferStatementSequence(
      module,
      modules,
      moduleIndex,
      arena,
      statementChildren,
      inout loopBindings,
      expectedReturn
    );
    mergeBindingFlowStates(
      inout bindings,
      beforeLoop,
      loopBindings
    );
    return;
  }
  if (kind == StatementKind.forStatement) {
    const beforeLoop = copyValueBindings(bindings);
    let loopBindings = copyValueBindings(bindings);
    let elementType = "";
    match (in arena.nodes[index].expression) {
      some(iterable) => {
        const iterableType = try inferExpressionType(module, modules, moduleIndex, arena, iterable, inout bindings);
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
      statementChildren,
      inout loopBindings,
      expectedReturn
    );
    mergeBindingFlowStates(
      inout bindings,
      beforeLoop,
      loopBindings
    );
    return;
  }
  let nestedBindings = copyValueBindings(bindings);
  try inferStatementSequence(
    module,
    modules,
    moduleIndex,
    arena,
    statementChildren,
    inout nestedBindings,
    expectedReturn
  );
  copyBindingFlowStates(inout bindings, nestedBindings);
}

function inferStatementSequence(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in arena: StatementArena,
  in indices: Array<usize>,
  inout bindings: Array<NativeValueBinding>,
  in expectedReturn: String
): void throws ModuleResolveError {
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

function inferFunctionExpressions(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in declaration: FunctionDeclaration,
  in ownerType: String
): void throws ModuleResolveError {
  let bindings = functionValueBindings(declaration.parameters);
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
    declaration.returnType.name
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
): void throws ModuleResolveError {
  for (const declaration of module.program.functions) {
    try inferFunctionExpressions(module, modules, moduleIndex, declaration, "");
  }
  for (const aggregate of module.program.aggregates) {
    match (in aggregate.constructorDeclaration) {
      some(initializer) => {
        let bindings = functionValueBindings(initializer.parameters);
        addMutableValueBinding(inout bindings, "this", aggregate.name);
        addValueBinding(inout bindings, "__z_native_owner_type", aggregate.name);
        addValueBinding(inout bindings, "__z_native_constructor_type", aggregate.name);
        try inferStatementSequence(
          module,
          modules,
          moduleIndex,
          initializer.body,
          initializer.body.roots,
          inout bindings,
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
      try inferFunctionExpressions(module, modules, moduleIndex, method, aggregate.name);
    }
    match (in aggregate.deinitializer) {
      some(deinitializer) => {
        let bindings = Array<NativeValueBinding>();
        addValueBinding(inout bindings, "this", aggregate.name);
        addValueBinding(inout bindings, "__z_native_owner_type", aggregate.name);
        try inferStatementSequence(
          module,
          modules,
          moduleIndex,
          deinitializer.body,
          deinitializer.body.roots,
          inout bindings,
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
