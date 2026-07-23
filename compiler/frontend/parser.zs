import { Token, TokenKind, tokenKindName } from "./lexer.zs";
import { TextBuffer } from "std/text";

export enum DeclarationKind {
  importDeclaration,
  functionDeclaration,
  structDeclaration,
  classDeclaration,
  traitDeclaration,
  typeAliasDeclaration,
  enumDeclaration,
}

export struct Declaration {
  kind: DeclarationKind;
  name: String;
  exported: boolean;
  asynchronous: boolean;
  offset: usize;
  line: usize;
  column: usize;
}

export enum ParameterMode {
  value,
  input,
  inputOutput,
  output,
}

export enum ReceiverMode {
  none,
  inputOutput,
  move,
}

export enum Visibility {
  publicVisibility,
  privateVisibility,
}

export struct TypeReference {
  name: String;
  references: Array<TypeNameReference>;
  offset: usize;
  line: usize;
  column: usize;
}

export struct TypeNameReference {
  name: String;
  offset: usize;
  line: usize;
  column: usize;
}

export struct TypeParameter {
  name: String;
  constraints: Array<TypeReference>;
  offset: usize;
  line: usize;
  column: usize;
}

export struct Parameter {
  name: String;
  mode: ParameterMode;
  type: TypeReference;
  offset: usize;
  line: usize;
  column: usize;
}

export enum StatementKind {
  variableStatement,
  destructureStatement,
  assignmentStatement,
  returnStatement,
  throwStatement,
  yieldStatement,
  selectStatement,
  expressionStatement,
  blockStatement,
  ifStatement,
  whileStatement,
  forStatement,
  forAwaitStatement,
  forTryAwaitStatement,
  matchStatement,
  asyncScopeStatement,
  breakStatement,
  continueStatement,
}

export struct ObjectBinding {
  fieldName: String;
  bindingName: String;
  fieldOffset: usize;
  fieldLine: usize;
  fieldColumn: usize;
  bindingOffset: usize;
  bindingLine: usize;
  bindingColumn: usize;
}

export enum ExpressionKind {
  identifierExpression,
  numberExpression,
  stringExpression,
  booleanExpression,
  nullExpression,
  templateTextExpression,
  templateExpression,
  closureParameterExpression,
  closureExpression,
  arrayExpression,
  objectExpression,
  memberExpression,
  callExpression,
  indexExpression,
  unaryExpression,
  binaryExpression,
  conditionalExpression,
  newExpression,
  variantMarkerExpression,
  variantExpression,
  argumentBindingExpression,
  argumentReferenceExpression,
  weakExpression,
  tryExpression,
  attemptExpression,
  awaitExpression,
  spawnExpression,
  matchExpression,
  matchArmExpression,
  matchBindingExpression,
  matchObjectFieldExpression,
  ifExpression,
  whileExpression,
  forExpression,
  forBindingExpression,
  valueBlockExpression,
  executorPlacementExpression,
  executorOnExpression,
}

export struct ExpressionNode {
  kind: ExpressionKind;
  value: String;
  children: Array<usize>;
  statements: Array<usize>;
  labels: Array<String>;
  typeReferences: Array<TypeReference>;
  offset: usize;
  line: usize;
  column: usize;
}

export struct ExpressionTree {
  nodes: Array<ExpressionNode>;
  root: usize;
}

export struct ExpressionSyntax {
  tokens: String;
  assignment: boolean;
  tree: Option<ExpressionTree>;
  offset: usize;
  line: usize;
  column: usize;
}

export struct Statement {
  kind: StatementKind;
  mutableBinding: boolean;
  name: String;
  nameOffset: usize;
  nameLine: usize;
  nameColumn: usize;
  typeAnnotation: Option<TypeReference>;
  expression: Option<ExpressionSyntax>;
  secondExpression: Option<ExpressionSyntax>;
  objectBindings: Array<ObjectBinding>;
  children: Array<usize>;
  offset: usize;
  line: usize;
  column: usize;
}

export struct StatementArena {
  nodes: Array<Statement>;
  roots: Array<usize>;
}

export struct FunctionDeclaration {
  name: String;
  asynchronous: boolean;
  staticMethod: boolean;
  visibility: Visibility;
  typeParameters: Array<TypeParameter>;
  receiverMode: ReceiverMode;
  parameters: Array<Parameter>;
  returnType: TypeReference;
  errorType: Option<TypeReference>;
  body: StatementArena;
  offset: usize;
  line: usize;
  column: usize;
}

export struct FieldDeclaration {
  name: String;
  type: TypeReference;
  visibility: Visibility;
  readonlyField: boolean;
  offset: usize;
  line: usize;
  column: usize;
}

export struct ConstructorDeclaration {
  parameters: Array<Parameter>;
  errorType: Option<TypeReference>;
  body: StatementArena;
  offset: usize;
  line: usize;
  column: usize;
}

export struct DeinitDeclaration {
  body: StatementArena;
  offset: usize;
  line: usize;
  column: usize;
}

export struct AggregateDeclaration {
  kind: DeclarationKind;
  name: String;
  typeParameters: Array<TypeParameter>;
  implementedTraits: Array<TypeReference>;
  fields: Array<FieldDeclaration>;
  constructorDeclaration: Option<ConstructorDeclaration>;
  methods: Array<FunctionDeclaration>;
  deinitializer: Option<DeinitDeclaration>;
  offset: usize;
  line: usize;
  column: usize;
}

export struct TraitDeclaration {
  name: String;
  typeParameters: Array<TypeParameter>;
  methods: Array<FunctionDeclaration>;
  offset: usize;
  line: usize;
  column: usize;
}

export struct TypeAliasDeclaration {
  name: String;
  target: TypeReference;
  offset: usize;
  line: usize;
  column: usize;
}

export struct EnumVariant {
  name: String;
  payload: Option<TypeReference>;
  offset: usize;
  line: usize;
  column: usize;
}

export struct EnumDeclaration {
  name: String;
  variants: Array<EnumVariant>;
  offset: usize;
  line: usize;
  column: usize;
}

export struct ImportBinding {
  importedName: String;
  localName: String;
  offset: usize;
  line: usize;
  column: usize;
}

export struct ImportDeclaration {
  moduleName: String;
  bindings: Array<ImportBinding>;
  selective: boolean;
  header: String;
  offset: usize;
  line: usize;
  column: usize;
}

export struct Program {
  declarations: Array<Declaration>;
  imports: Array<ImportDeclaration>;
  typeAliases: Array<TypeAliasDeclaration>;
  functions: Array<FunctionDeclaration>;
  aggregates: Array<AggregateDeclaration>;
  traits: Array<TraitDeclaration>;
  enums: Array<EnumDeclaration>;
}

export struct ParserError {
  message: String;
  offset: usize;
  line: usize;
  column: usize;
}

function snapshot(in token: Token): Token {
  return Token({
    kind: token.kind,
    text: token.text.copyBytes(0, token.text.byteLength),
    offset: token.offset,
    line: token.line,
    column: token.column,
  });
}

function fail(in token: Token, in message: String): ParserError {
  return ParserError({
    message: message.copyBytes(0, message.byteLength),
    offset: token.offset,
    line: token.line,
    column: token.column,
  });
}

function expect(
  in tokens: Array<Token>,
  inout current: usize,
  kind: TokenKind,
  in description: String
): Token throws ParserError {
  const token = snapshot(tokens[current]);
  if (token.kind != kind) throw fail(token, `expected ${description}, found ${token.text}`);
  current = current + 1;
  return token;
}

function expectKind(
  in tokens: Array<Token>,
  inout current: usize,
  kind: TokenKind,
  in description: String
): void throws ParserError {
  if (tokens[current].kind != kind) throw fail(tokens[current], `expected ${description}, found ${tokens[current].text}`);
  current = current + 1;
}

function takeIf(in tokens: Array<Token>, inout current: usize, kind: TokenKind): boolean {
  if (tokens[current].kind != kind) return false;
  current = current + 1;
  return true;
}

function expectTypeGreater(
  in tokens: Array<Token>,
  inout current: usize,
  inout pendingGreater: usize
): void throws ParserError {
  if (pendingGreater > 0) {
    pendingGreater = pendingGreater - 1;
    return;
  }
  if (tokens[current].kind == TokenKind.greater) {
    current = current + 1;
    return;
  }
  if (tokens[current].kind == TokenKind.shiftRight) {
    current = current + 1;
    pendingGreater = pendingGreater + 1;
    return;
  }
  throw fail(tokens[current], "expected `>` to close a type argument list");
}

function parameterMode(in tokens: Array<Token>, inout current: usize): ParameterMode {
  if (takeIf(tokens, inout current, TokenKind.inKeyword)) return ParameterMode.input;
  if (takeIf(tokens, inout current, TokenKind.inoutKeyword)) return ParameterMode.inputOutput;
  if (takeIf(tokens, inout current, TokenKind.outKeyword)) return ParameterMode.output;
  return ParameterMode.value;
}

function parameterModeName(mode: ParameterMode): String {
  return match (mode) {
    value => "";
    input => "in ";
    inputOutput => "inout ";
    output => "out ";
  };
}

function isPositiveInteger(in text: String): boolean {
  let current: usize = 0;
  let positive = false;
  while (current < text.byteLength) {
    const byte = text.byteAt(current);
    if (byte < 48 || byte > 57) return false;
    if (byte != 48) positive = true;
    current = current + 1;
  }
  return positive;
}

function normalizePositiveInteger(in text: String): String {
  let start: usize = 0;
  while (start + 1 < text.byteLength && text.byteAt(start) == 48) {
    start = start + 1;
  }
  return text.copyBytes(start, text.byteLength);
}

function appendTypeNameReferences(
  inout target: Array<TypeNameReference>,
  in source: Array<TypeNameReference>
): void {
  for (const reference of source) {
    target.push(TypeNameReference({
      name: reference.name.copyBytes(0, reference.name.byteLength),
      offset: reference.offset,
      line: reference.line,
      column: reference.column,
    }));
  }
}

function appendGenericArgumentReference(
  inout target: Array<TypeReference>,
  in type: TypeReference
): void {
  if (type.references.length < 2) return;
  let references = Array<TypeNameReference>();
  let index: usize = 1;
  while (index < type.references.length) {
    references.push(TypeNameReference({
      name: type.references[index].name.copyBytes(0, type.references[index].name.byteLength),
      offset: type.references[index].offset,
      line: type.references[index].line,
      column: type.references[index].column,
    }));
    index = index + 1;
  }
  target.push(TypeReference({
    name: type.name.copyBytes(0, type.name.byteLength),
    references,
    offset: type.offset,
    line: type.line,
    column: type.column,
  }));
}

function parseType(
  in tokens: Array<Token>,
  inout current: usize,
  inout pendingGreater: usize
): TypeReference throws ParserError {
  if (tokens[current].kind == TokenKind.leftParen) {
    const start = try expect(tokens, inout current, TokenKind.leftParen, "a function type");
    let output = TextBuffer();
    let references = Array<TypeNameReference>();
    output.append("(");
    let first = true;
    while (tokens[current].kind != TokenKind.rightParen) {
      if (!first) {
        try expectKind(tokens, inout current, TokenKind.comma, "`,` between function-type parameters");
        output.append(", ");
      }
      first = false;
      const mode = parameterMode(tokens, inout current);
      const name = try expect(tokens, inout current, TokenKind.identifier, "a function-type parameter name");
      try expectKind(tokens, inout current, TokenKind.colon, "`:` after a function-type parameter name");
      const type = try parseType(tokens, inout current, inout pendingGreater);
      output.append(parameterModeName(mode));
      output.append(name.text);
      output.append(": ");
      output.append(type.name);
      appendTypeNameReferences(inout references, type.references);
    }
    try expectKind(tokens, inout current, TokenKind.rightParen, "`)` after function-type parameters");
    try expectKind(tokens, inout current, TokenKind.fatArrow, "`=>` in a function type");
    const returnType = try parseType(tokens, inout current, inout pendingGreater);
    output.append(") => ");
    output.append(returnType.name);
    appendTypeNameReferences(inout references, returnType.references);
    return TypeReference({
      name: output.finish(),
      references,
      offset: start.offset,
      line: start.line,
      column: start.column,
    });
  }

  const start = try expect(tokens, inout current, TokenKind.identifier, "a type name");
  if (start.text == "view") {
    const target = try parseType(tokens, inout current, inout pendingGreater);
    let references = Array<TypeNameReference>();
    appendTypeNameReferences(inout references, target.references);
    return TypeReference({
      name: `view ${target.name}`,
      references,
      offset: start.offset,
      line: start.line,
      column: start.column,
    });
  }

  let name = start.text.copyBytes(0, start.text.byteLength);
  let references = Array<TypeNameReference>();
  while (takeIf(tokens, inout current, TokenKind.dot)) {
    const member = try expect(tokens, inout current, TokenKind.identifier, "an imported type name");
    name = `${name}.${member.text}`;
  }
  references.push(TypeNameReference({
    name: name.copyBytes(0, name.byteLength),
    offset: start.offset,
    line: start.line,
    column: start.column,
  }));

  if (takeIf(tokens, inout current, TokenKind.less)) {
    let output = TextBuffer();
    output.append(name);
    output.append("<");
    let first = true;
    while (true) {
      if (!first) output.append(", ");
      first = false;
      const argument = try parseType(tokens, inout current, inout pendingGreater);
      output.append(argument.name);
      appendTypeNameReferences(inout references, argument.references);
      if (pendingGreater > 0) break;
      if (!takeIf(tokens, inout current, TokenKind.comma)) break;
    }
    try expectTypeGreater(tokens, inout current, inout pendingGreater);
    output.append(">");
    name = output.finish();
  }

  while (takeIf(tokens, inout current, TokenKind.leftBracket)) {
    const length = try expect(tokens, inout current, TokenKind.number, "a fixed array length");
    if (!isPositiveInteger(length.text)) throw fail(length, "a fixed array length must be a positive integer");
    try expectKind(tokens, inout current, TokenKind.rightBracket, "`]` after a fixed array length");
    const normalizedLength = normalizePositiveInteger(length.text);
    name = `${name}[${normalizedLength}]`;
  }

  if (takeIf(tokens, inout current, TokenKind.bitOr)) {
    try expectKind(tokens, inout current, TokenKind.nullKeyword, "`null` after `|` in an optional type");
    name = `${name} | null`;
  }

  return TypeReference({
    name,
    references,
    offset: start.offset,
    line: start.line,
    column: start.column,
  });
}

function parseTypeParameters(
  in tokens: Array<Token>,
  inout current: usize,
  inout pendingGreater: usize
): Array<TypeParameter> throws ParserError {
  let parameters = Array<TypeParameter>();
  if (!takeIf(tokens, inout current, TokenKind.less)) return parameters;
  while (true) {
    const name = try expect(tokens, inout current, TokenKind.identifier, "a type parameter name");
    let constraints = Array<TypeReference>();
    if (takeIf(tokens, inout current, TokenKind.colon)) {
      while (true) {
        const constraint = try parseType(tokens, inout current, inout pendingGreater);
        constraints.push(constraint);
        if (!takeIf(tokens, inout current, TokenKind.bitAnd)) break;
      }
    }
    parameters.push(TypeParameter({
      name: name.text.copyBytes(0, name.text.byteLength),
      constraints,
      offset: name.offset,
      line: name.line,
      column: name.column,
    }));
    if (!takeIf(tokens, inout current, TokenKind.comma)) break;
  }
  try expectTypeGreater(tokens, inout current, inout pendingGreater);
  return parameters;
}

function parseParameters(
  in tokens: Array<Token>,
  inout current: usize,
  inout pendingGreater: usize
): Array<Parameter> throws ParserError {
  let parameters = Array<Parameter>();
  if (tokens[current].kind == TokenKind.rightParen) return parameters;
  while (true) {
    const mode = parameterMode(tokens, inout current);
    const name = try expect(tokens, inout current, TokenKind.identifier, "a parameter name");
    try expectKind(tokens, inout current, TokenKind.colon, "`:` after a parameter name");
    const type = try parseType(tokens, inout current, inout pendingGreater);
    parameters.push(Parameter({
      name: name.text.copyBytes(0, name.text.byteLength),
      mode,
      type,
      offset: name.offset,
      line: name.line,
      column: name.column,
    }));
    if (!takeIf(tokens, inout current, TokenKind.comma)) break;
  }
  return parameters;
}

function skipDelimited(
  in tokens: Array<Token>,
  inout current: usize,
  opening: TokenKind,
  closing: TokenKind,
  in description: String
): void throws ParserError {
  const startIndex = current;
  if (tokens[current].kind != opening) throw fail(tokens[current], `expected ${description}`);
  current = current + 1;
  let depth: usize = 1;
  while (depth > 0) {
    if (tokens[current].kind == TokenKind.eof) throw fail(tokens[startIndex], `unterminated ${description}`);
    if (tokens[current].kind == opening) depth = depth + 1;
    if (tokens[current].kind == closing) depth = depth - 1;
    current = current + 1;
  }
}

function pushExpressionNode(
  inout nodes: Array<ExpressionNode>,
  kind: ExpressionKind,
  value: String,
  children: Array<usize>,
  labels: Array<String>,
  in token: Token
): usize {
  return pushExpressionNodeAt(
    inout nodes,
    kind,
    value,
    children,
    labels,
    token.offset,
    token.line,
    token.column
  );
}

function pushExpressionNodeAt(
  inout nodes: Array<ExpressionNode>,
  kind: ExpressionKind,
  value: String,
  children: Array<usize>,
  labels: Array<String>,
  offset: usize,
  line: usize,
  column: usize
): usize {
  const index = nodes.length;
  nodes.push(ExpressionNode({
    kind,
    value,
    children,
    statements: Array<usize>(),
    labels,
    typeReferences: Array<TypeReference>(),
    offset,
    line,
    column,
  }));
  return index;
}

function pushExpressionNodeWithStatements(
  inout nodes: Array<ExpressionNode>,
  kind: ExpressionKind,
  value: String,
  children: Array<usize>,
  statements: Array<usize>,
  labels: Array<String>,
  in token: Token
): usize {
  const index = nodes.length;
  nodes.push(ExpressionNode({
    kind,
    value,
    children,
    statements,
    labels,
    typeReferences: Array<TypeReference>(),
    offset: token.offset,
    line: token.line,
    column: token.column,
  }));
  return index;
}

function pushExpressionNodeWithTypes(
  inout nodes: Array<ExpressionNode>,
  kind: ExpressionKind,
  value: String,
  children: Array<usize>,
  labels: Array<String>,
  typeReferences: Array<TypeReference>,
  in token: Token
): usize {
  const index = nodes.length;
  nodes.push(ExpressionNode({
    kind,
    value,
    children,
    statements: Array<usize>(),
    labels,
    typeReferences,
    offset: token.offset,
    line: token.line,
    column: token.column,
  }));
  return index;
}

function pushExpressionNodeWithStatementsAndTypes(
  inout nodes: Array<ExpressionNode>,
  kind: ExpressionKind,
  value: String,
  children: Array<usize>,
  statements: Array<usize>,
  labels: Array<String>,
  typeReferences: Array<TypeReference>,
  in token: Token
): usize {
  const index = nodes.length;
  nodes.push(ExpressionNode({
    kind,
    value,
    children,
    statements,
    labels,
    typeReferences,
    offset: token.offset,
    line: token.line,
    column: token.column,
  }));
  return index;
}

function isAsciiMemberName(in token: Token): boolean {
  if (token.text.byteLength == 0) return false;
  const first = token.text.byteAt(0);
  if (
    !((first >= 65 && first <= 90)
      || (first >= 97 && first <= 122)
      || first == 95)
  ) return false;
  let index: usize = 1;
  while (index < token.text.byteLength) {
    const byte = token.text.byteAt(index);
    if (
      !((byte >= 65 && byte <= 90)
        || (byte >= 97 && byte <= 122)
        || (byte >= 48 && byte <= 57)
        || byte == 95)
    ) return false;
    index = index + 1;
  }
  return true;
}

function startsClosureExpression(
  in tokens: Array<Token>,
  current: usize,
  end: usize
): boolean {
  let cursor = current;
  if (
    cursor < end
    && tokens[cursor].kind == TokenKind.identifier
    && tokens[cursor].text == "move"
  ) cursor = cursor + 1;
  if (cursor >= end || tokens[cursor].kind != TokenKind.leftParen) return false;
  let depth: usize = 1;
  cursor = cursor + 1;
  while (cursor < end && depth > 0) {
    if (tokens[cursor].kind == TokenKind.leftParen) depth = depth + 1;
    else if (tokens[cursor].kind == TokenKind.rightParen) depth = depth - 1;
    cursor = cursor + 1;
  }
  if (depth != 0 || cursor >= end) return false;
  return tokens[cursor].kind == TokenKind.fatArrow
    || tokens[cursor].kind == TokenKind.colon
    || tokens[cursor].kind == TokenKind.throwsKeyword;
}

function parseMatchTree(
  in tokens: Array<Token>,
  inout current: usize,
  end: usize,
  inout nodes: Array<ExpressionNode>,
  inout statementNodes: Array<Statement>
): usize throws ParserError {
  const start = snapshot(tokens[current]);
  try expectKind(tokens, inout current, TokenKind.matchKeyword, "`match`");
  try expectKind(tokens, inout current, TokenKind.leftParen, "`(` after `match`");
  let mode = "auto";
  if (takeIf(tokens, inout current, TokenKind.inKeyword)) mode = "in";
  let children = Array<usize>();
  const subject = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
  children.push(subject);
  try expectKind(tokens, inout current, TokenKind.rightParen, "`)` after the match subject");
  try expectKind(tokens, inout current, TokenKind.leftBrace, "`{` starting match arms");
  while (tokens[current].kind != TokenKind.rightBrace && tokens[current].kind != TokenKind.eof) {
    const variant = snapshot(tokens[current]);
    try expectKind(tokens, inout current, TokenKind.identifier, "a variant name");
    let patternKind = "none";
    let patternChildren = Array<usize>();
    if (takeIf(tokens, inout current, TokenKind.leftParen)) {
      if (takeIf(tokens, inout current, TokenKind.leftBrace)) {
        patternKind = "object";
        if (tokens[current].kind != TokenKind.rightBrace) {
          while (true) {
            const field = snapshot(tokens[current]);
            try expectKind(tokens, inout current, TokenKind.identifier, "a payload field name");
            let bindingName = field.text.copyBytes(0, field.text.byteLength);
            let bindingOffset = field.offset;
            let bindingLine = field.line;
            let bindingColumn = field.column;
            if (takeIf(tokens, inout current, TokenKind.colon)) {
              const binding = snapshot(tokens[current]);
              try expectKind(tokens, inout current, TokenKind.identifier, "a pattern binding name");
              bindingName = binding.text.copyBytes(0, binding.text.byteLength);
              bindingOffset = binding.offset;
              bindingLine = binding.line;
              bindingColumn = binding.column;
            }
            const bindingNode = pushExpressionNodeAt(
              inout nodes,
              ExpressionKind.matchBindingExpression,
              bindingName,
              Array<usize>(),
              Array<String>(),
              bindingOffset,
              bindingLine,
              bindingColumn
            );
            let fieldChildren = Array<usize>();
            fieldChildren.push(bindingNode);
            patternChildren.push(pushExpressionNode(
              inout nodes,
              ExpressionKind.matchObjectFieldExpression,
              field.text.copyBytes(0, field.text.byteLength),
              fieldChildren,
              Array<String>(),
              field
            ));
            if (!takeIf(tokens, inout current, TokenKind.comma)) break;
            if (tokens[current].kind == TokenKind.rightBrace) break;
          }
        }
        try expectKind(tokens, inout current, TokenKind.rightBrace, "`}` ending an object pattern");
      } else {
        patternKind = "binding";
        const binding = snapshot(tokens[current]);
        try expectKind(tokens, inout current, TokenKind.identifier, "a payload binding");
        patternChildren.push(pushExpressionNode(
          inout nodes,
          ExpressionKind.matchBindingExpression,
          binding.text.copyBytes(0, binding.text.byteLength),
          Array<usize>(),
          Array<String>(),
          binding
        ));
      }
      try expectKind(tokens, inout current, TokenKind.rightParen, "`)` ending a variant pattern");
    }
    try expectKind(tokens, inout current, TokenKind.fatArrow, "`=>` after a variant pattern");
    let body = Array<usize>();
    const parsedBody = try parseProjectedStatement(tokens, inout current, inout statementNodes);
    match (parsedBody) {
      some(index) => body.push(index);
      none => {}
    }
    let labels = Array<String>();
    labels.push(patternKind);
    const arm = pushExpressionNodeWithStatements(
      inout nodes,
      ExpressionKind.matchArmExpression,
      variant.text.copyBytes(0, variant.text.byteLength),
      patternChildren,
      body,
      labels,
      variant
    );
    children.push(arm);
  }
  try expectKind(tokens, inout current, TokenKind.rightBrace, "`}` ending match arms");
  return pushExpressionNode(
    inout nodes,
    ExpressionKind.matchExpression,
    mode,
    children,
    Array<String>(),
    start
  );
}

function parseValueBlockTree(
  in tokens: Array<Token>,
  inout current: usize,
  in description: String,
  inout nodes: Array<ExpressionNode>,
  inout statementNodes: Array<Statement>
): usize throws ParserError {
  const start = snapshot(tokens[current]);
  const statements = try parseProjectedBlock(tokens, inout current, description, inout statementNodes);
  return pushExpressionNodeWithStatements(
    inout nodes,
    ExpressionKind.valueBlockExpression,
    "",
    Array<usize>(),
    statements,
    Array<String>(),
    start
  );
}

function parseIfExpressionTree(
  in tokens: Array<Token>,
  inout current: usize,
  end: usize,
  inout nodes: Array<ExpressionNode>,
  inout statementNodes: Array<Statement>
): usize throws ParserError {
  const start = snapshot(tokens[current]);
  try expectKind(tokens, inout current, TokenKind.ifKeyword, "`if`");
  try expectKind(tokens, inout current, TokenKind.leftParen, "`(` after `if`");
  let children = Array<usize>();
  const condition = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
  children.push(condition);
  try expectKind(tokens, inout current, TokenKind.rightParen, "`)` after an if-expression condition");
  const thenBranch = try parseValueBlockTree(
    tokens,
    inout current,
    "an `if` expression body",
    inout nodes,
    inout statementNodes
  );
  children.push(thenBranch);
  try expectKind(tokens, inout current, TokenKind.elseKeyword, "`else` in a value-producing `if`");
  let elseBranch: usize;
  if (tokens[current].kind == TokenKind.ifKeyword) {
    elseBranch = try parseIfExpressionTree(tokens, inout current, end, inout nodes, inout statementNodes);
  } else {
    elseBranch = try parseValueBlockTree(
      tokens,
      inout current,
      "an `else` expression body",
      inout nodes,
      inout statementNodes
    );
  }
  children.push(elseBranch);
  return pushExpressionNode(
    inout nodes,
    ExpressionKind.ifExpression,
    "",
    children,
    Array<String>(),
    start
  );
}

function parseWhileExpressionTree(
  in tokens: Array<Token>,
  inout current: usize,
  end: usize,
  inout nodes: Array<ExpressionNode>,
  inout statementNodes: Array<Statement>
): usize throws ParserError {
  const start = snapshot(tokens[current]);
  try expectKind(tokens, inout current, TokenKind.whileKeyword, "`while`");
  try expectKind(tokens, inout current, TokenKind.leftParen, "`(` after `while`");
  let children = Array<usize>();
  const condition = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
  children.push(condition);
  try expectKind(tokens, inout current, TokenKind.rightParen, "`)` after a while-expression condition");
  const body = try parseValueBlockTree(
    tokens,
    inout current,
    "a `while` expression body",
    inout nodes,
    inout statementNodes
  );
  children.push(body);
  try expectKind(tokens, inout current, TokenKind.elseKeyword, "`else` in a value-producing `while`");
  const elseBranch = try parseValueBlockTree(
    tokens,
    inout current,
    "a `while` exhaustion body",
    inout nodes,
    inout statementNodes
  );
  children.push(elseBranch);
  return pushExpressionNode(
    inout nodes,
    ExpressionKind.whileExpression,
    "",
    children,
    Array<String>(),
    start
  );
}

function parseForExpressionTree(
  in tokens: Array<Token>,
  inout current: usize,
  end: usize,
  inout nodes: Array<ExpressionNode>,
  inout statementNodes: Array<Statement>
): usize throws ParserError {
  const start = snapshot(tokens[current]);
  try expectKind(tokens, inout current, TokenKind.forKeyword, "`for`");
  try expectKind(tokens, inout current, TokenKind.leftParen, "`(` after `for`");
  try expectKind(tokens, inout current, TokenKind.constKeyword, "`const` in a read-only `for...of` binding");
  let patternChildren = Array<usize>();
  let patternKind = "binding";
  let patternStart = snapshot(tokens[current]);
  if (takeIf(tokens, inout current, TokenKind.leftBrace)) {
    patternKind = "object";
    if (tokens[current].kind != TokenKind.rightBrace) {
      while (true) {
        const field = snapshot(tokens[current]);
        try expectKind(tokens, inout current, TokenKind.identifier, "an iteration field name");
        let bindingName = field.text.copyBytes(0, field.text.byteLength);
        let bindingOffset = field.offset;
        let bindingLine = field.line;
        let bindingColumn = field.column;
        if (takeIf(tokens, inout current, TokenKind.colon)) {
          const binding = snapshot(tokens[current]);
          try expectKind(tokens, inout current, TokenKind.identifier, "an iteration binding name");
          bindingName = binding.text.copyBytes(0, binding.text.byteLength);
          bindingOffset = binding.offset;
          bindingLine = binding.line;
          bindingColumn = binding.column;
        }
        const bindingNode = pushExpressionNodeAt(
          inout nodes,
          ExpressionKind.matchBindingExpression,
          bindingName,
          Array<usize>(),
          Array<String>(),
          bindingOffset,
          bindingLine,
          bindingColumn
        );
        let fieldChildren = Array<usize>();
        fieldChildren.push(bindingNode);
        patternChildren.push(pushExpressionNode(
          inout nodes,
          ExpressionKind.matchObjectFieldExpression,
          field.text.copyBytes(0, field.text.byteLength),
          fieldChildren,
          Array<String>(),
          field
        ));
        if (!takeIf(tokens, inout current, TokenKind.comma)) break;
        if (tokens[current].kind == TokenKind.rightBrace) break;
      }
    }
    try expectKind(tokens, inout current, TokenKind.rightBrace, "`}` ending an iteration pattern");
  } else {
    const binding = snapshot(tokens[current]);
    try expectKind(tokens, inout current, TokenKind.identifier, "an iteration binding");
    patternChildren.push(pushExpressionNode(
      inout nodes,
      ExpressionKind.matchBindingExpression,
      binding.text.copyBytes(0, binding.text.byteLength),
      Array<usize>(),
      Array<String>(),
      binding
    ));
  }
  const pattern = pushExpressionNode(
    inout nodes,
    ExpressionKind.forBindingExpression,
    patternKind,
    patternChildren,
    Array<String>(),
    patternStart
  );
  try expectKind(tokens, inout current, TokenKind.ofKeyword, "`of` after an iteration binding");
  let mode = "auto";
  if (takeIf(tokens, inout current, TokenKind.inoutKeyword)) mode = "inout";
  let children = Array<usize>();
  children.push(pattern);
  const iterable = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
  children.push(iterable);
  try expectKind(tokens, inout current, TokenKind.rightParen, "`)` after a `for...of` expression header");
  const body = try parseValueBlockTree(
    tokens,
    inout current,
    "a `for...of` expression body",
    inout nodes,
    inout statementNodes
  );
  children.push(body);
  try expectKind(tokens, inout current, TokenKind.elseKeyword, "`else` in a value-producing `for...of`");
  const elseBranch = try parseValueBlockTree(
    tokens,
    inout current,
    "a `for...of` exhaustion body",
    inout nodes,
    inout statementNodes
  );
  children.push(elseBranch);
  return pushExpressionNode(
    inout nodes,
    ExpressionKind.forExpression,
    mode,
    children,
    Array<String>(),
    start
  );
}

function parseExecutorPlacementTree(
  in tokens: Array<Token>,
  inout current: usize,
  end: usize,
  inout nodes: Array<ExpressionNode>,
  inout statementNodes: Array<Statement>
): usize throws ParserError {
  const start = snapshot(tokens[current]);
  let mode = "sync";
  if (tokens[current].kind == TokenKind.awaitKeyword) {
    mode = "await";
    current = current + 1;
  } else if (tokens[current].kind == TokenKind.spawnKeyword) {
    mode = "spawn";
    current = current + 1;
  }
  const onToken = snapshot(tokens[current]);
  try expectKind(tokens, inout current, TokenKind.onKeyword, "`on` in an executor placement");
  let children = Array<usize>();
  children.push(pushExpressionNode(
    inout nodes,
    ExpressionKind.executorOnExpression,
    "",
    Array<usize>(),
    Array<String>(),
    onToken
  ));
  const executor = try parsePostfixTree(tokens, inout current, end, inout nodes, inout statementNodes);
  children.push(executor);
  let typeReferences = Array<TypeReference>();
  let returnType = "";
  if (takeIf(tokens, inout current, TokenKind.colon)) {
    let pendingGreater: usize = 0;
    const type = try parseType(tokens, inout current, inout pendingGreater);
    returnType = type.name.copyBytes(0, type.name.byteLength);
    typeReferences.push(type);
  }
  let errorType = "";
  if (takeIf(tokens, inout current, TokenKind.throwsKeyword)) {
    let pendingGreater: usize = 0;
    const type = try parseType(tokens, inout current, inout pendingGreater);
    errorType = type.name.copyBytes(0, type.name.byteLength);
    typeReferences.push(type);
  }
  const statements = try parseProjectedBlock(
    tokens,
    inout current,
    "an executor-placement body",
    inout statementNodes
  );
  let labels = Array<String>();
  labels.push(returnType);
  labels.push(errorType);
  return pushExpressionNodeWithStatementsAndTypes(
    inout nodes,
    ExpressionKind.executorPlacementExpression,
    mode,
    children,
    statements,
    labels,
    typeReferences,
    start
  );
}

function parsePrimaryTree(
  in tokens: Array<Token>,
  inout current: usize,
  end: usize,
  inout nodes: Array<ExpressionNode>,
  inout statementNodes: Array<Statement>
): usize throws ParserError {
  if (current >= end) throw fail(tokens[current], "expected a primary expression");
  const start = snapshot(tokens[current]);
  if (start.kind == TokenKind.outKeyword || start.kind == TokenKind.inoutKeyword) {
    current = current + 1;
    const binding = try expect(tokens, inout current, TokenKind.identifier, "a mutable binding");
    const bindingNode = pushExpressionNode(
      inout nodes,
      ExpressionKind.argumentBindingExpression,
      binding.text.copyBytes(0, binding.text.byteLength),
      Array<usize>(),
      Array<String>(),
      binding
    );
    let children = Array<usize>();
    children.push(bindingNode);
    return pushExpressionNode(
      inout nodes,
      ExpressionKind.argumentReferenceExpression,
      start.text.copyBytes(0, start.text.byteLength),
      children,
      Array<String>(),
      start
    );
  }
  if (startsExecutorPlacement(tokens, current)) {
    return try parseExecutorPlacementTree(tokens, inout current, end, inout nodes, inout statementNodes);
  }
  if (start.kind == TokenKind.ifKeyword) {
    return try parseIfExpressionTree(tokens, inout current, end, inout nodes, inout statementNodes);
  }
  if (start.kind == TokenKind.whileKeyword) {
    return try parseWhileExpressionTree(tokens, inout current, end, inout nodes, inout statementNodes);
  }
  if (start.kind == TokenKind.forKeyword) {
    return try parseForExpressionTree(tokens, inout current, end, inout nodes, inout statementNodes);
  }
  if (start.kind == TokenKind.matchKeyword) {
    return try parseMatchTree(tokens, inout current, end, inout nodes, inout statementNodes);
  }
  if (startsClosureExpression(tokens, current, end)) {
    let captureMode = "borrow";
    if (tokens[current].kind == TokenKind.identifier && tokens[current].text == "move") {
      captureMode = "move";
      current = current + 1;
    }
    try expectKind(tokens, inout current, TokenKind.leftParen, "`(` starting closure parameters");
    let children = Array<usize>();
    if (tokens[current].kind != TokenKind.rightParen) {
      while (true) {
        let capability = "value";
        if (tokens[current].kind == TokenKind.inKeyword) {
          capability = "in";
          current = current + 1;
        } else if (tokens[current].kind == TokenKind.inoutKeyword) {
          capability = "inout";
          current = current + 1;
        } else if (tokens[current].kind == TokenKind.outKeyword) {
          capability = "out";
          current = current + 1;
        }
        const parameter = try expect(
          tokens,
          inout current,
          TokenKind.identifier,
          "a closure parameter name"
        );
        let parameterType = "";
        let parameterTypes = Array<TypeReference>();
        if (takeIf(tokens, inout current, TokenKind.colon)) {
          let pendingGreater: usize = 0;
          const type = try parseType(tokens, inout current, inout pendingGreater);
          parameterType = type.name.copyBytes(0, type.name.byteLength);
          parameterTypes.push(type);
        }
        let labels = Array<String>();
        labels.push(capability);
        labels.push(parameterType);
        children.push(pushExpressionNodeWithTypes(
          inout nodes,
          ExpressionKind.closureParameterExpression,
          parameter.text.copyBytes(0, parameter.text.byteLength),
          Array<usize>(),
          labels,
          parameterTypes,
          parameter
        ));
        if (!takeIf(tokens, inout current, TokenKind.comma)) break;
      }
    }
    try expectKind(tokens, inout current, TokenKind.rightParen, "`)` after closure parameters");
    let signatureTypes = Array<TypeReference>();
    let returnType = "";
    if (takeIf(tokens, inout current, TokenKind.colon)) {
      let pendingGreater: usize = 0;
      const type = try parseType(tokens, inout current, inout pendingGreater);
      returnType = type.name.copyBytes(0, type.name.byteLength);
      signatureTypes.push(type);
    }
    let errorType = "";
    if (takeIf(tokens, inout current, TokenKind.throwsKeyword)) {
      let pendingGreater: usize = 0;
      const type = try parseType(tokens, inout current, inout pendingGreater);
      errorType = type.name.copyBytes(0, type.name.byteLength);
      signatureTypes.push(type);
    }
    try expectKind(tokens, inout current, TokenKind.fatArrow, "`=>` after a closure signature");
    let labels = Array<String>();
    labels.push(returnType);
    labels.push(errorType);
    if (tokens[current].kind == TokenKind.leftBrace) {
      const statements = try parseProjectedBlock(
        tokens,
        inout current,
        "a closure body",
        inout statementNodes
      );
      labels.push("block");
      return pushExpressionNodeWithStatementsAndTypes(
        inout nodes,
        ExpressionKind.closureExpression,
        captureMode,
        children,
        statements,
        labels,
        signatureTypes,
        start
      );
    }
    const body = try parseConditionalTree(
      tokens,
      inout current,
      end,
      inout nodes,
      inout statementNodes
    );
    children.push(body);
    labels.push("expression");
    return pushExpressionNodeWithTypes(
      inout nodes,
      ExpressionKind.closureExpression,
      captureMode,
      children,
      labels,
      signatureTypes,
      start
    );
  }
  if (start.kind == TokenKind.newKeyword) {
    current = current + 1;
    let pendingGreater: usize = 0;
    const type = try parseType(tokens, inout current, inout pendingGreater);
    try expectKind(tokens, inout current, TokenKind.leftParen, "`(` after a class name");
    let children = Array<usize>();
    let labels = Array<String>();
    if (tokens[current].kind != TokenKind.rightParen) {
      while (true) {
        if (
          current + 1 < end
          && tokens[current].kind == TokenKind.identifier
          && tokens[current + 1].kind == TokenKind.colon
        ) {
          labels.push(tokens[current].text.copyBytes(0, tokens[current].text.byteLength));
          current = current + 2;
        } else labels.push("");
        const argument = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
        children.push(argument);
        if (!takeIf(tokens, inout current, TokenKind.comma)) break;
      }
    }
    try expectKind(tokens, inout current, TokenKind.rightParen, "`)` after a class initializer");
    const typeName = type.name.copyBytes(0, type.name.byteLength);
    let typeReferences = Array<TypeReference>();
    typeReferences.push(type);
    return pushExpressionNodeWithTypes(
      inout nodes,
      ExpressionKind.newExpression,
      typeName,
      children,
      labels,
      typeReferences,
      start
    );
  }
  if (
    start.kind == TokenKind.weakKeyword
    || start.kind == TokenKind.tryKeyword
    || start.kind == TokenKind.attemptKeyword
    || start.kind == TokenKind.awaitKeyword
    || start.kind == TokenKind.spawnKeyword
  ) {
    current = current + 1;
    const operand = try parsePostfixTree(tokens, inout current, end, inout nodes, inout statementNodes);
    let children = Array<usize>();
    children.push(operand);
    let expressionKind = ExpressionKind.weakExpression;
    if (start.kind == TokenKind.tryKeyword) expressionKind = ExpressionKind.tryExpression;
    else if (start.kind == TokenKind.attemptKeyword) expressionKind = ExpressionKind.attemptExpression;
    else if (start.kind == TokenKind.awaitKeyword) expressionKind = ExpressionKind.awaitExpression;
    else if (start.kind == TokenKind.spawnKeyword) expressionKind = ExpressionKind.spawnExpression;
    return pushExpressionNode(
      inout nodes,
      expressionKind,
      "",
      children,
      Array<String>(),
      start
    );
  }
  if (start.kind == TokenKind.identifier) {
    let name = start.text.copyBytes(0, start.text.byteLength);
    let genericTypes = Array<TypeReference>();
    let afterName = current + 1;
    if (afterName < end && tokens[afterName].kind == TokenKind.less) {
      let candidate = current;
      let pendingGreater: usize = 0;
      const typeOutcome = attempt parseType(tokens, inout candidate, inout pendingGreater);
      match (typeOutcome) {
        success(type) => {
          if (
            candidate < end
            && (
              tokens[candidate].kind == TokenKind.leftParen
              || tokens[candidate].kind == TokenKind.leftBrace
              || tokens[candidate].kind == TokenKind.dot
            )
          ) {
            name = type.name.copyBytes(0, type.name.byteLength);
            afterName = candidate;
            appendGenericArgumentReference(inout genericTypes, type);
          }
        }
        failure(error) => {}
      }
    }
    let variantDot = Option<usize>.none;
    if (
      afterName + 2 < end
      && tokens[afterName].kind == TokenKind.dot
      && tokens[afterName + 1].kind == TokenKind.identifier
      && (
        tokens[afterName + 2].kind == TokenKind.identifier
        || tokens[afterName + 2].kind == TokenKind.number
        || tokens[afterName + 2].kind == TokenKind.string
        || tokens[afterName + 2].kind == TokenKind.trueKeyword
        || tokens[afterName + 2].kind == TokenKind.falseKeyword
        || tokens[afterName + 2].kind == TokenKind.nullKeyword
      )
    ) variantDot = Option.some(afterName);
    match (variantDot) {
      some(dot) => {
        const variant = snapshot(tokens[dot + 1]);
        current = dot + 2;
        const marker = pushExpressionNode(
          inout nodes,
          ExpressionKind.variantMarkerExpression,
          variant.text.copyBytes(0, variant.text.byteLength),
          Array<usize>(),
          Array<String>(),
          variant
        );
        const payload = try parsePrimaryTree(tokens, inout current, end, inout nodes, inout statementNodes);
        let children = Array<usize>();
        children.push(marker);
        children.push(payload);
        return pushExpressionNodeWithTypes(
          inout nodes,
          ExpressionKind.variantExpression,
          start.text.copyBytes(0, start.text.byteLength),
          children,
          Array<String>(),
          genericTypes,
          start
        );
      }
      none => {}
    }
    current = afterName;
    return pushExpressionNodeWithTypes(
      inout nodes,
      ExpressionKind.identifierExpression,
      name,
      Array<usize>(),
      Array<String>(),
      genericTypes,
      start
    );
  }
  if (start.kind == TokenKind.number) {
    current = current + 1;
    return pushExpressionNode(
      inout nodes,
      ExpressionKind.numberExpression,
      start.text.copyBytes(0, start.text.byteLength),
      Array<usize>(),
      Array<String>(),
      start
    );
  }
  if (start.kind == TokenKind.string) {
    current = current + 1;
    return pushExpressionNode(
      inout nodes,
      ExpressionKind.stringExpression,
      start.text.copyBytes(0, start.text.byteLength),
      Array<usize>(),
      Array<String>(),
      start
    );
  }
  if (start.kind == TokenKind.trueKeyword || start.kind == TokenKind.falseKeyword) {
    current = current + 1;
    return pushExpressionNode(
      inout nodes,
      ExpressionKind.booleanExpression,
      start.text.copyBytes(0, start.text.byteLength),
      Array<usize>(),
      Array<String>(),
      start
    );
  }
  if (start.kind == TokenKind.nullKeyword) {
    current = current + 1;
    return pushExpressionNode(
      inout nodes,
      ExpressionKind.nullExpression,
      "",
      Array<usize>(),
      Array<String>(),
      start
    );
  }
  if (start.kind == TokenKind.templateStart) {
    current = current + 1;
    let children = Array<usize>();
    while (current < end && tokens[current].kind != TokenKind.templateEnd) {
      if (tokens[current].kind == TokenKind.templateText) {
        const text = snapshot(tokens[current]);
        current = current + 1;
        children.push(pushExpressionNode(
          inout nodes,
          ExpressionKind.templateTextExpression,
          text.text.copyBytes(0, text.text.byteLength),
          Array<usize>(),
          Array<String>(),
          text
        ));
        continue;
      }
      try expectKind(
        tokens,
        inout current,
        TokenKind.templateExpressionStart,
        "`${` starting an interpolated expression"
      );
      const expression = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
      children.push(expression);
      try expectKind(
        tokens,
        inout current,
        TokenKind.templateExpressionEnd,
        "`}` ending an interpolated expression"
      );
    }
    try expectKind(tokens, inout current, TokenKind.templateEnd, "a closing backtick");
    return pushExpressionNode(
      inout nodes,
      ExpressionKind.templateExpression,
      "",
      children,
      Array<String>(),
      start
    );
  }
  if (start.kind == TokenKind.leftParen) {
    current = current + 1;
    const root = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
    try expectKind(tokens, inout current, TokenKind.rightParen, "`)` after a parenthesized expression");
    return root;
  }
  if (start.kind == TokenKind.leftBracket) {
    current = current + 1;
    let children = Array<usize>();
    if (tokens[current].kind != TokenKind.rightBracket) {
      while (true) {
        const element = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
        children.push(element);
        if (!takeIf(tokens, inout current, TokenKind.comma)) break;
        if (tokens[current].kind == TokenKind.rightBracket) break;
      }
    }
    try expectKind(tokens, inout current, TokenKind.rightBracket, "`]` after array elements");
    return pushExpressionNode(
      inout nodes,
      ExpressionKind.arrayExpression,
      "",
      children,
      Array<String>(),
      start
    );
  }
  if (start.kind == TokenKind.leftBrace) {
    current = current + 1;
    let children = Array<usize>();
    let labels = Array<String>();
    while (tokens[current].kind != TokenKind.rightBrace) {
      const field = try expect(tokens, inout current, TokenKind.identifier, "an object field name");
      labels.push(field.text.copyBytes(0, field.text.byteLength));
      if (takeIf(tokens, inout current, TokenKind.colon)) {
        const value = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
        children.push(value);
      } else {
        const value = pushExpressionNode(
          inout nodes,
          ExpressionKind.identifierExpression,
          field.text.copyBytes(0, field.text.byteLength),
          Array<usize>(),
          Array<String>(),
          field
        );
        children.push(value);
      }
      if (!takeIf(tokens, inout current, TokenKind.comma)) break;
      if (tokens[current].kind == TokenKind.rightBrace) break;
    }
    try expectKind(tokens, inout current, TokenKind.rightBrace, "`}` after object fields");
    return pushExpressionNode(
      inout nodes,
      ExpressionKind.objectExpression,
      "",
      children,
      labels,
      start
    );
  }
  throw fail(start, `primary expression ${start.text} is not in the first expression-tree slice`);
}

function parsePostfixTree(
  in tokens: Array<Token>,
  inout current: usize,
  end: usize,
  inout nodes: Array<ExpressionNode>,
  inout statementNodes: Array<Statement>
): usize throws ParserError {
  let root = try parsePrimaryTree(tokens, inout current, end, inout nodes, inout statementNodes);
  while (current < end) {
    if (takeIf(tokens, inout current, TokenKind.dot)) {
      if (!isAsciiMemberName(tokens[current])) throw fail(tokens[current], "expected a member name");
      const property = snapshot(tokens[current]);
      current = current + 1;
      let propertyName = property.text.copyBytes(0, property.text.byteLength);
      let typeReferences = Array<TypeReference>();
      if (current < end && tokens[current].kind == TokenKind.less) {
        let candidate = current - 1;
        let pendingGreater: usize = 0;
        const typeOutcome = attempt parseType(tokens, inout candidate, inout pendingGreater);
        match (typeOutcome) {
          success(type) => {
            if (candidate < end && tokens[candidate].kind == TokenKind.leftParen) {
              propertyName = type.name.copyBytes(0, type.name.byteLength);
              current = candidate;
              appendGenericArgumentReference(inout typeReferences, type);
            }
          }
          failure(error) => {}
        }
      }
      let children = Array<usize>();
      children.push(root);
      root = pushExpressionNodeWithTypes(
        inout nodes,
        ExpressionKind.memberExpression,
        propertyName,
        children,
        Array<String>(),
        typeReferences,
        property
      );
      continue;
    }
    if (tokens[current].kind == TokenKind.leftParen) {
      const call = snapshot(tokens[current]);
      current = current + 1;
      let children = Array<usize>();
      let labels = Array<String>();
      children.push(root);
      if (tokens[current].kind != TokenKind.rightParen) {
        while (true) {
          if (
            current + 1 < end
            && tokens[current].kind == TokenKind.identifier
            && tokens[current + 1].kind == TokenKind.colon
          ) {
            labels.push(tokens[current].text.copyBytes(0, tokens[current].text.byteLength));
            current = current + 2;
          } else labels.push("");
          const argument = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
          children.push(argument);
          if (!takeIf(tokens, inout current, TokenKind.comma)) break;
        }
      }
      try expectKind(tokens, inout current, TokenKind.rightParen, "`)` after call arguments");
      root = pushExpressionNode(
        inout nodes,
        ExpressionKind.callExpression,
        "",
        children,
        labels,
        call
      );
      continue;
    }
    if (tokens[current].kind == TokenKind.leftBracket) {
      const bracket = snapshot(tokens[current]);
      current = current + 1;
      const index = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
      try expectKind(tokens, inout current, TokenKind.rightBracket, "`]` after an index expression");
      let children = Array<usize>();
      children.push(root);
      children.push(index);
      root = pushExpressionNode(
        inout nodes,
        ExpressionKind.indexExpression,
        "",
        children,
        Array<String>(),
        bracket
      );
      continue;
    }
    break;
  }
  return root;
}

function binaryPrecedence(kind: TokenKind): i32 {
  if (kind == TokenKind.orOr) return 1;
  if (kind == TokenKind.andAnd) return 2;
  if (kind == TokenKind.bitOr) return 3;
  if (kind == TokenKind.bitXor) return 4;
  if (kind == TokenKind.bitAnd) return 5;
  if (kind == TokenKind.equalEqual || kind == TokenKind.bangEqual) return 6;
  if (
    kind == TokenKind.less
    || kind == TokenKind.lessEqual
    || kind == TokenKind.greater
    || kind == TokenKind.greaterEqual
  ) return 7;
  if (kind == TokenKind.shiftLeft || kind == TokenKind.shiftRight) return 8;
  if (kind == TokenKind.plus || kind == TokenKind.minus) return 10;
  if (kind == TokenKind.star || kind == TokenKind.slash || kind == TokenKind.percent) return 20;
  return -1;
}

function parseUnaryTree(
  in tokens: Array<Token>,
  inout current: usize,
  end: usize,
  inout nodes: Array<ExpressionNode>,
  inout statementNodes: Array<Statement>
): usize throws ParserError {
  const kind = tokens[current].kind;
  if (
    kind == TokenKind.bang
    || kind == TokenKind.plus
    || kind == TokenKind.minus
    || kind == TokenKind.tilde
  ) {
    const operator = snapshot(tokens[current]);
    current = current + 1;
    const operand = try parseUnaryTree(tokens, inout current, end, inout nodes, inout statementNodes);
    let children = Array<usize>();
    children.push(operand);
    return pushExpressionNode(
      inout nodes,
      ExpressionKind.unaryExpression,
      operator.text.copyBytes(0, operator.text.byteLength),
      children,
      Array<String>(),
      operator
    );
  }
  if (
    kind == TokenKind.identifier
    && (tokens[current].text == "copy" || tokens[current].text == "move")
    && current + 1 < end
    && tokens[current + 1].kind != TokenKind.leftParen
  ) {
    const operator = snapshot(tokens[current]);
    current = current + 1;
    const operand = try parseUnaryTree(tokens, inout current, end, inout nodes, inout statementNodes);
    let children = Array<usize>();
    children.push(operand);
    return pushExpressionNode(
      inout nodes,
      ExpressionKind.unaryExpression,
      operator.text.copyBytes(0, operator.text.byteLength),
      children,
      Array<String>(),
      operator
    );
  }
  return try parsePostfixTree(tokens, inout current, end, inout nodes, inout statementNodes);
}

function parseBinaryTree(
  in tokens: Array<Token>,
  inout current: usize,
  end: usize,
  minimumPrecedence: i32,
  inout nodes: Array<ExpressionNode>,
  inout statementNodes: Array<Statement>
): usize throws ParserError {
  let left = try parseUnaryTree(tokens, inout current, end, inout nodes, inout statementNodes);
  while (current < end) {
    const precedence = binaryPrecedence(tokens[current].kind);
    if (precedence < minimumPrecedence) break;
    const operator = snapshot(tokens[current]);
    current = current + 1;
    const right = try parseBinaryTree(tokens, inout current, end, precedence + 1, inout nodes, inout statementNodes);
    let children = Array<usize>();
    children.push(left);
    children.push(right);
    left = pushExpressionNode(
      inout nodes,
      ExpressionKind.binaryExpression,
      operator.text.copyBytes(0, operator.text.byteLength),
      children,
      Array<String>(),
      operator
    );
  }
  return left;
}

function parseConditionalTree(
  in tokens: Array<Token>,
  inout current: usize,
  end: usize,
  inout nodes: Array<ExpressionNode>,
  inout statementNodes: Array<Statement>
): usize throws ParserError {
  const condition = try parseBinaryTree(tokens, inout current, end, 0, inout nodes, inout statementNodes);
  if (!takeIf(tokens, inout current, TokenKind.question)) return condition;
  const thenExpression = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
  try expectKind(tokens, inout current, TokenKind.colon, "`:` in a conditional expression");
  const elseExpression = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
  let children = Array<usize>();
  children.push(condition);
  children.push(thenExpression);
  children.push(elseExpression);
  const offset = nodes[condition].offset;
  const line = nodes[condition].line;
  const column = nodes[condition].column;
  return pushExpressionNodeAt(
    inout nodes,
    ExpressionKind.conditionalExpression,
    "",
    children,
    Array<String>(),
    offset,
    line,
    column
  );
}

function parseExpressionTree(
  in tokens: Array<Token>,
  start: usize,
  end: usize,
  inout statementNodes: Array<Statement>
): ExpressionTree throws ParserError {
  let current = start;
  let nodes = Array<ExpressionNode>();
  const root = try parseConditionalTree(tokens, inout current, end, inout nodes, inout statementNodes);
  if (current != end) throw fail(tokens[current], `expression token ${tokens[current].text} is not in the first expression-tree slice`);
  return ExpressionTree({ nodes, root });
}

function projectExpressionRange(
  in tokens: Array<Token>,
  startIndex: usize,
  end: usize,
  inout statementNodes: Array<Statement>
): ExpressionSyntax throws ParserError {
  const start = snapshot(tokens[startIndex]);
  let output = TextBuffer();
  let cursor = startIndex;
  let assignment = false;
  while (cursor < end) {
    const kind = tokens[cursor].kind;
    if (kind == TokenKind.equal) assignment = true;
    output.append(tokenKindName(kind));
    output.append(":");
    output.append(`${tokens[cursor].text.byteLength}`);
    output.append(":");
    output.append(tokens[cursor].text);
    output.append(";");
    cursor = cursor + 1;
  }
  let tree = Option<ExpressionTree>.none;
  const treeOutcome = attempt parseExpressionTree(tokens, startIndex, end, inout statementNodes);
  match (treeOutcome) {
    success(parsed) => tree = Option.some(parsed);
    failure(error) => {}
  }
  return ExpressionSyntax({
    tokens: output.finish(),
    assignment,
    tree,
    offset: start.offset,
    line: start.line,
    column: start.column,
  });
}

function scanExpression(
  in tokens: Array<Token>,
  inout current: usize,
  in description: String,
  inout statementNodes: Array<Statement>
): ExpressionSyntax throws ParserError {
  const startIndex = current;
  const start = snapshot(tokens[current]);
  let parentheses: usize = 0;
  let brackets: usize = 0;
  let braces: usize = 0;
  let templates: usize = 0;
  while (true) {
    const kind = tokens[current].kind;
    if (kind == TokenKind.eof) throw fail(start, `unterminated ${description}`);
    if (
      kind == TokenKind.semicolon
      && parentheses == 0
      && brackets == 0
      && braces == 0
      && templates == 0
    ) break;
    if (
      kind == TokenKind.rightBrace
      && parentheses == 0
      && brackets == 0
      && braces == 0
      && templates == 0
    ) throw fail(start, `expected \`;\` after ${description}`);
    if (kind == TokenKind.leftParen) parentheses = parentheses + 1;
    else if (kind == TokenKind.rightParen && parentheses > 0) parentheses = parentheses - 1;
    else if (kind == TokenKind.leftBracket) brackets = brackets + 1;
    else if (kind == TokenKind.rightBracket && brackets > 0) brackets = brackets - 1;
    else if (kind == TokenKind.leftBrace) braces = braces + 1;
    else if (kind == TokenKind.rightBrace && braces > 0) braces = braces - 1;
    else if (kind == TokenKind.templateExpressionStart) templates = templates + 1;
    else if (kind == TokenKind.templateExpressionEnd && templates > 0) templates = templates - 1;
    current = current + 1;
  }
  if (current == startIndex) throw fail(start, `expected ${description}`);
  const expression = try projectExpressionRange(tokens, startIndex, current, inout statementNodes);
  current = current + 1;
  return expression;
}

function skipProjectedStatement(
  in tokens: Array<Token>,
  inout current: usize,
  inout statementNodes: Array<Statement>
): void throws ParserError {
  const kind = tokens[current].kind;
  if (kind == TokenKind.leftBrace) {
    try skipDelimited(tokens, inout current, TokenKind.leftBrace, TokenKind.rightBrace, "a statement block");
    return;
  }
  if (kind == TokenKind.ifKeyword) {
    current = current + 1;
    try skipDelimited(tokens, inout current, TokenKind.leftParen, TokenKind.rightParen, "an if condition");
    try skipProjectedStatement(tokens, inout current, inout statementNodes);
    if (takeIf(tokens, inout current, TokenKind.elseKeyword)) {
      try skipProjectedStatement(tokens, inout current, inout statementNodes);
    }
    return;
  }
  if (kind == TokenKind.whileKeyword || kind == TokenKind.forKeyword) {
    current = current + 1;
    try skipDelimited(tokens, inout current, TokenKind.leftParen, TokenKind.rightParen, "a loop condition");
    try skipProjectedStatement(tokens, inout current, inout statementNodes);
    return;
  }
  if (kind == TokenKind.matchKeyword) {
    current = current + 1;
    try skipDelimited(tokens, inout current, TokenKind.leftParen, TokenKind.rightParen, "a match subject");
    try skipDelimited(tokens, inout current, TokenKind.leftBrace, TokenKind.rightBrace, "match arms");
    return;
  }
  if (kind == TokenKind.asyncKeyword && current + 1 < tokens.length && tokens[current + 1].kind == TokenKind.scopeKeyword) {
    current = current + 2;
    try skipProjectedStatement(tokens, inout current, inout statementNodes);
    return;
  }
  const ignored = try scanExpression(tokens, inout current, "a statement", inout statementNodes);
  if (ignored.assignment) return;
}

function startsExecutorPlacement(in tokens: Array<Token>, current: usize): boolean {
  if (tokens[current].kind == TokenKind.onKeyword) return true;
  return (tokens[current].kind == TokenKind.awaitKeyword || tokens[current].kind == TokenKind.spawnKeyword)
    && current + 1 < tokens.length
    && tokens[current + 1].kind == TokenKind.onKeyword;
}

function projectedExecutorPlacementEnd(
  in tokens: Array<Token>,
  startIndex: usize
): usize throws ParserError {
  const start = snapshot(tokens[startIndex]);
  let current = startIndex;
  if (tokens[current].kind == TokenKind.awaitKeyword || tokens[current].kind == TokenKind.spawnKeyword) {
    current = current + 1;
  }
  try expectKind(tokens, inout current, TokenKind.onKeyword, "`on` in an executor placement");
  let parentheses: usize = 0;
  let brackets: usize = 0;
  while (true) {
    const kind = tokens[current].kind;
    if (kind == TokenKind.eof) throw fail(start, "unterminated executor placement");
    if (kind == TokenKind.leftBrace && parentheses == 0 && brackets == 0) break;
    if (kind == TokenKind.leftParen) parentheses = parentheses + 1;
    else if (kind == TokenKind.rightParen && parentheses > 0) parentheses = parentheses - 1;
    else if (kind == TokenKind.leftBracket) brackets = brackets + 1;
    else if (kind == TokenKind.rightBracket && brackets > 0) brackets = brackets - 1;
    current = current + 1;
  }
  try skipDelimited(tokens, inout current, TokenKind.leftBrace, TokenKind.rightBrace, "an executor-placement body");
  return current;
}

function parseProjectedBlock(
  in tokens: Array<Token>,
  inout current: usize,
  in description: String,
  inout nodes: Array<Statement>
): Array<usize> throws ParserError {
  const start = snapshot(tokens[current]);
  try expectKind(tokens, inout current, TokenKind.leftBrace, description);
  let statements = Array<usize>();
  while (tokens[current].kind != TokenKind.rightBrace && tokens[current].kind != TokenKind.eof) {
    const statement = try parseProjectedStatement(tokens, inout current, inout nodes);
    match (statement) {
      some(value) => statements.push(value);
      none => {}
    }
  }
  if (tokens[current].kind == TokenKind.eof) throw fail(start, `unterminated ${description}`);
  try expectKind(tokens, inout current, TokenKind.rightBrace, "`}` after a statement block");
  return statements;
}

function topLevelAssignmentIndex(
  in tokens: Array<Token>,
  start: usize
): Option<usize> {
  let current = start;
  let parentheses: usize = 0;
  let brackets: usize = 0;
  let braces: usize = 0;
  let templates: usize = 0;
  while (tokens[current].kind != TokenKind.eof) {
    const kind = tokens[current].kind;
    if (
      kind == TokenKind.semicolon
      && parentheses == 0
      && brackets == 0
      && braces == 0
      && templates == 0
    ) return Option<usize>.none;
    if (
      kind == TokenKind.equal
      && parentheses == 0
      && brackets == 0
      && braces == 0
      && templates == 0
    ) return Option.some(current);
    if (kind == TokenKind.leftParen) parentheses = parentheses + 1;
    else if (kind == TokenKind.rightParen && parentheses > 0) parentheses = parentheses - 1;
    else if (kind == TokenKind.leftBracket) brackets = brackets + 1;
    else if (kind == TokenKind.rightBracket && brackets > 0) brackets = brackets - 1;
    else if (kind == TokenKind.leftBrace) braces = braces + 1;
    else if (kind == TokenKind.rightBrace && braces > 0) braces = braces - 1;
    else if (kind == TokenKind.templateExpressionStart) templates = templates + 1;
    else if (kind == TokenKind.templateExpressionEnd && templates > 0) templates = templates - 1;
    current = current + 1;
  }
  return Option<usize>.none;
}

function parenthesizedExpressionEnd(
  in tokens: Array<Token>,
  start: usize,
  in description: String
): usize throws ParserError {
  let current = start;
  let depth: usize = 1;
  while (tokens[current].kind != TokenKind.eof) {
    if (tokens[current].kind == TokenKind.leftParen) depth = depth + 1;
    else if (tokens[current].kind == TokenKind.rightParen) {
      depth = depth - 1;
      if (depth == 0) return current;
    }
    current = current + 1;
  }
  throw fail(tokens[start], `unterminated ${description}`);
}

function projectedMatchEnd(
  in tokens: Array<Token>,
  start: usize
): usize throws ParserError {
  let current = start + 1;
  try skipDelimited(tokens, inout current, TokenKind.leftParen, TokenKind.rightParen, "a match subject");
  try skipDelimited(tokens, inout current, TokenKind.leftBrace, TokenKind.rightBrace, "match arms");
  return current;
}

function parseObjectBindings(
  in tokens: Array<Token>,
  inout current: usize,
  in fieldDescription: String
): Array<ObjectBinding> throws ParserError {
  let bindings = Array<ObjectBinding>();
  if (tokens[current].kind != TokenKind.rightBrace) {
    while (true) {
      const field = try expect(tokens, inout current, TokenKind.identifier, fieldDescription);
      let binding = snapshot(field);
      if (takeIf(tokens, inout current, TokenKind.colon)) {
        binding = try expect(tokens, inout current, TokenKind.identifier, "a pattern binding name");
      }
      bindings.push(ObjectBinding({
        fieldName: field.text.copyBytes(0, field.text.byteLength),
        bindingName: binding.text.copyBytes(0, binding.text.byteLength),
        fieldOffset: field.offset,
        fieldLine: field.line,
        fieldColumn: field.column,
        bindingOffset: binding.offset,
        bindingLine: binding.line,
        bindingColumn: binding.column,
      }));
      if (!takeIf(tokens, inout current, TokenKind.comma)) break;
      if (tokens[current].kind == TokenKind.rightBrace) break;
    }
  }
  try expectKind(tokens, inout current, TokenKind.rightBrace, "`}` ending an object pattern");
  return bindings;
}

function pushProjectedBlock(
  inout nodes: Array<Statement>,
  children: Array<usize>,
  in start: Token
): usize {
  return pushProjectedBlockAt(
    inout nodes,
    children,
    start.offset,
    start.line,
    start.column
  );
}

function pushProjectedBlockAt(
  inout nodes: Array<Statement>,
  children: Array<usize>,
  offset: usize,
  line: usize,
  column: usize
): usize {
  const index = nodes.length;
  nodes.push(Statement({
    kind: StatementKind.blockStatement,
    mutableBinding: false,
    name: "",
    nameOffset: 0,
    nameLine: 0,
    nameColumn: 0,
    typeAnnotation: Option<TypeReference>.none,
    expression: Option<ExpressionSyntax>.none,
    secondExpression: Option<ExpressionSyntax>.none,
    objectBindings: Array<ObjectBinding>(),
    children,
    offset,
    line,
    column,
  }));
  return index;
}

function parseProjectedBranch(
  in tokens: Array<Token>,
  inout current: usize,
  inout nodes: Array<Statement>
): usize throws ParserError {
  const start = snapshot(tokens[current]);
  let children = Array<usize>();
  if (tokens[current].kind == TokenKind.leftBrace) {
    children = try parseProjectedBlock(tokens, inout current, "a statement block", inout nodes);
  } else {
    const statement = try parseProjectedStatement(tokens, inout current, inout nodes);
    match (statement) {
      some(index) => {
        children.push(index);
        let offset = nodes[index].offset;
        let line = nodes[index].line;
        let column = nodes[index].column;
        if (
          nodes[index].kind == StatementKind.expressionStatement
          || nodes[index].kind == StatementKind.assignmentStatement
        ) {
          match (in nodes[index].expression) {
            some(expression) => {
              match (in expression.tree) {
                some(tree) => {
                  offset = tree.nodes[tree.root].offset;
                  line = tree.nodes[tree.root].line;
                  column = tree.nodes[tree.root].column;
                }
                none => {
                  offset = expression.offset;
                  line = expression.line;
                  column = expression.column;
                }
              }
            }
            none => {}
          }
        }
        return pushProjectedBlockAt(inout nodes, children, offset, line, column);
      }
      none => {}
    }
  }
  return pushProjectedBlock(inout nodes, children, start);
}

function parseProjectedStatement(
  in tokens: Array<Token>,
  inout current: usize,
  inout nodes: Array<Statement>
): Option<usize> throws ParserError {
  const kind = tokens[current].kind;
  if (startsExecutorPlacement(tokens, current)) {
    const startIndex = current;
    const start = snapshot(tokens[current]);
    const end = try projectedExecutorPlacementEnd(tokens, current);
    const expression = try projectExpressionRange(tokens, startIndex, end, inout nodes);
    current = end;
    takeIf(tokens, inout current, TokenKind.semicolon);
    const index = nodes.length;
    nodes.push(Statement({
      kind: StatementKind.expressionStatement,
      mutableBinding: false,
      name: "",
      nameOffset: 0,
      nameLine: 0,
      nameColumn: 0,
      typeAnnotation: Option<TypeReference>.none,
      expression: Option.some(expression),
      secondExpression: Option<ExpressionSyntax>.none,
      objectBindings: Array<ObjectBinding>(),
      children: Array<usize>(),
      offset: start.offset,
      line: start.line,
      column: start.column,
    }));
    return Option.some(index);
  }
  if (kind == TokenKind.leftBrace) {
    const start = snapshot(tokens[current]);
    const statements = try parseProjectedBlock(tokens, inout current, "a statement block", inout nodes);
    return Option.some(pushProjectedBlock(inout nodes, statements, start));
  }
  if (kind == TokenKind.asyncKeyword) {
    const start = snapshot(tokens[current]);
    current = current + 1;
    try expectKind(tokens, inout current, TokenKind.scopeKeyword, "`scope` after `async`");
    const bodyStart = snapshot(tokens[current]);
    const bodyStatements = try parseProjectedBlock(tokens, inout current, "an `async scope` body", inout nodes);
    let children = Array<usize>();
    children.push(pushProjectedBlock(inout nodes, bodyStatements, bodyStart));
    const index = nodes.length;
    nodes.push(Statement({
      kind: StatementKind.asyncScopeStatement,
      mutableBinding: false,
      name: "",
      nameOffset: 0,
      nameLine: 0,
      nameColumn: 0,
      typeAnnotation: Option<TypeReference>.none,
      expression: Option<ExpressionSyntax>.none,
      secondExpression: Option<ExpressionSyntax>.none,
      objectBindings: Array<ObjectBinding>(),
      children,
      offset: start.offset,
      line: start.line,
      column: start.column,
    }));
    return Option.some(index);
  }
  if (kind == TokenKind.ifKeyword) {
    const start = snapshot(tokens[current]);
    current = current + 1;
    try expectKind(tokens, inout current, TokenKind.leftParen, "`(` after `if`");
    const conditionStart = current;
    const conditionEnd = try parenthesizedExpressionEnd(tokens, current, "an if condition");
    const condition = try projectExpressionRange(tokens, conditionStart, conditionEnd, inout nodes);
    current = conditionEnd + 1;
    let children = Array<usize>();
    const thenBranch = try parseProjectedBranch(tokens, inout current, inout nodes);
    children.push(thenBranch);
    if (takeIf(tokens, inout current, TokenKind.elseKeyword)) {
      if (tokens[current].kind == TokenKind.ifKeyword) {
        const elseStatement = try parseProjectedStatement(tokens, inout current, inout nodes);
        match (elseStatement) {
          some(index) => children.push(index);
          none => {}
        }
      } else {
        const elseBranch = try parseProjectedBranch(tokens, inout current, inout nodes);
        children.push(elseBranch);
      }
    }
    const index = nodes.length;
    nodes.push(Statement({
      kind: StatementKind.ifStatement,
      mutableBinding: false,
      name: "",
      nameOffset: 0,
      nameLine: 0,
      nameColumn: 0,
      typeAnnotation: Option<TypeReference>.none,
      expression: Option.some(condition),
      secondExpression: Option<ExpressionSyntax>.none,
      objectBindings: Array<ObjectBinding>(),
      children,
      offset: start.offset,
      line: start.line,
      column: start.column,
    }));
    return Option.some(index);
  }
  if (kind == TokenKind.matchKeyword) {
    const startIndex = current;
    const start = snapshot(tokens[current]);
    const end = try projectedMatchEnd(tokens, current);
    const expression = try projectExpressionRange(tokens, startIndex, end, inout nodes);
    current = end;
    const index = nodes.length;
    nodes.push(Statement({
      kind: StatementKind.matchStatement,
      mutableBinding: false,
      name: "",
      nameOffset: 0,
      nameLine: 0,
      nameColumn: 0,
      typeAnnotation: Option<TypeReference>.none,
      expression: Option.some(expression),
      secondExpression: Option<ExpressionSyntax>.none,
      objectBindings: Array<ObjectBinding>(),
      children: Array<usize>(),
      offset: start.offset,
      line: start.line,
      column: start.column,
    }));
    return Option.some(index);
  }
  if (kind == TokenKind.whileKeyword) {
    const start = snapshot(tokens[current]);
    current = current + 1;
    try expectKind(tokens, inout current, TokenKind.leftParen, "`(` after `while`");
    const conditionStart = current;
    const conditionEnd = try parenthesizedExpressionEnd(tokens, current, "a while condition");
    const condition = try projectExpressionRange(tokens, conditionStart, conditionEnd, inout nodes);
    current = conditionEnd + 1;
    const bodyStart = snapshot(tokens[current]);
    const bodyStatements = try parseProjectedBlock(tokens, inout current, "a `while` body", inout nodes);
    let children = Array<usize>();
    children.push(pushProjectedBlock(inout nodes, bodyStatements, bodyStart));
    const index = nodes.length;
    nodes.push(Statement({
      kind: StatementKind.whileStatement,
      mutableBinding: false,
      name: "",
      nameOffset: 0,
      nameLine: 0,
      nameColumn: 0,
      typeAnnotation: Option<TypeReference>.none,
      expression: Option.some(condition),
      secondExpression: Option<ExpressionSyntax>.none,
      objectBindings: Array<ObjectBinding>(),
      children,
      offset: start.offset,
      line: start.line,
      column: start.column,
    }));
    return Option.some(index);
  }
  if (
    kind == TokenKind.forKeyword
    || (
      kind == TokenKind.tryKeyword
      && tokens[current + 1].kind == TokenKind.forKeyword
    )
  ) {
    const start = snapshot(tokens[current]);
    const propagating = kind == TokenKind.tryKeyword;
    if (propagating) {
      current = current + 1;
      try expectKind(tokens, inout current, TokenKind.forKeyword, "`for` after `try`");
    } else {
      current = current + 1;
    }
    let asynchronous = takeIf(tokens, inout current, TokenKind.awaitKeyword);
    if (propagating && !asynchronous) {
      try expectKind(tokens, inout current, TokenKind.awaitKeyword, "`await` after `try for`");
      asynchronous = true;
    }
    try expectKind(tokens, inout current, TokenKind.leftParen, "`(` after `for`");
    try expectKind(tokens, inout current, TokenKind.constKeyword, "`const` in a read-only `for...of` binding");
    let bindingName = "";
    let bindingOffset: usize = 0;
    let bindingLine: usize = 0;
    let bindingColumn: usize = 0;
    let objectBindings = Array<ObjectBinding>();
    if (takeIf(tokens, inout current, TokenKind.leftBrace)) {
      objectBindings = try parseObjectBindings(tokens, inout current, "an iteration field name");
    } else {
      const binding = try expect(tokens, inout current, TokenKind.identifier, "an iteration binding");
      bindingName = binding.text.copyBytes(0, binding.text.byteLength);
      bindingOffset = binding.offset;
      bindingLine = binding.line;
      bindingColumn = binding.column;
    }
    try expectKind(tokens, inout current, TokenKind.ofKeyword, "`of` after an iteration binding");
    const mutableIterator = takeIf(tokens, inout current, TokenKind.inoutKeyword);
    const iterableStart = current;
    const iterableEnd = try parenthesizedExpressionEnd(tokens, current, "a for-of iterable");
    const iterable = try projectExpressionRange(tokens, iterableStart, iterableEnd, inout nodes);
    current = iterableEnd + 1;
    const bodyStart = snapshot(tokens[current]);
    const bodyStatements = try parseProjectedBlock(tokens, inout current, "a `for...of` body", inout nodes);
    let children = Array<usize>();
    children.push(pushProjectedBlock(inout nodes, bodyStatements, bodyStart));
    let statementKind = StatementKind.forStatement;
    if (asynchronous) statementKind = StatementKind.forAwaitStatement;
    if (propagating) statementKind = StatementKind.forTryAwaitStatement;
    const index = nodes.length;
    nodes.push(Statement({
      kind: statementKind,
      mutableBinding: mutableIterator,
      name: bindingName,
      nameOffset: bindingOffset,
      nameLine: bindingLine,
      nameColumn: bindingColumn,
      typeAnnotation: Option<TypeReference>.none,
      expression: Option.some(iterable),
      secondExpression: Option<ExpressionSyntax>.none,
      objectBindings,
      children,
      offset: start.offset,
      line: start.line,
      column: start.column,
    }));
    return Option.some(index);
  }
  if (kind == TokenKind.constKeyword || kind == TokenKind.letKeyword) {
    const start = snapshot(tokens[current]);
    const mutableBinding = kind == TokenKind.letKeyword;
    current = current + 1;
    let name = "";
    let nameOffset: usize = 0;
    let nameLine: usize = 0;
    let nameColumn: usize = 0;
    let objectBindings = Array<ObjectBinding>();
    let objectPattern = false;
    if (takeIf(tokens, inout current, TokenKind.leftBrace)) {
      objectPattern = true;
      objectBindings = try parseObjectBindings(tokens, inout current, "an object field name");
    } else {
      const binding = try expect(tokens, inout current, TokenKind.identifier, "a variable name");
      name = binding.text.copyBytes(0, binding.text.byteLength);
      nameOffset = binding.offset;
      nameLine = binding.line;
      nameColumn = binding.column;
    }
    let typeAnnotation = Option<TypeReference>.none;
    if (takeIf(tokens, inout current, TokenKind.colon)) {
      let pendingGreater: usize = 0;
      const parsedType = try parseType(tokens, inout current, inout pendingGreater);
      typeAnnotation = Option.some(parsedType);
    }
    let expression = Option<ExpressionSyntax>.none;
    if (takeIf(tokens, inout current, TokenKind.semicolon)) {
      if (objectPattern) throw fail(start, "object destructuring requires an initializer");
      if (!mutableBinding) throw fail(start, "const declarations require an initializer");
    } else {
      try expectKind(tokens, inout current, TokenKind.equal, "`=` in a variable declaration");
      const scanned = try scanExpression(tokens, inout current, "a variable initializer", inout nodes);
      expression = Option.some(scanned);
    }
    const index = nodes.length;
    nodes.push(Statement({
      kind: objectPattern
        ? StatementKind.destructureStatement
        : StatementKind.variableStatement,
      mutableBinding,
      name,
      nameOffset,
      nameLine,
      nameColumn,
      typeAnnotation,
      expression,
      secondExpression: Option<ExpressionSyntax>.none,
      objectBindings,
      children: Array<usize>(),
      offset: start.offset,
      line: start.line,
      column: start.column,
    }));
    return Option.some(index);
  }
  if (kind == TokenKind.returnKeyword) {
    const start = snapshot(tokens[current]);
    current = current + 1;
    let expression = Option<ExpressionSyntax>.none;
    if (!takeIf(tokens, inout current, TokenKind.semicolon)) {
      const scanned = try scanExpression(tokens, inout current, "a return value", inout nodes);
      expression = Option.some(scanned);
    }
    const index = nodes.length;
    nodes.push(Statement({
      kind: StatementKind.returnStatement,
      mutableBinding: false,
      name: "",
      nameOffset: 0,
      nameLine: 0,
      nameColumn: 0,
      typeAnnotation: Option<TypeReference>.none,
      expression,
      secondExpression: Option<ExpressionSyntax>.none,
      objectBindings: Array<ObjectBinding>(),
      children: Array<usize>(),
      offset: start.offset,
      line: start.line,
      column: start.column,
    }));
    return Option.some(index);
  }
  if (
    kind == TokenKind.throwKeyword
    || kind == TokenKind.yieldKeyword
    || kind == TokenKind.selectKeyword
  ) {
    const start = snapshot(tokens[current]);
    current = current + 1;
    const description = kind == TokenKind.throwKeyword
      ? "a thrown value"
      : kind == TokenKind.yieldKeyword ? "a yielded value" : "a selected value";
    const expression = try scanExpression(
      tokens,
      inout current,
      description,
      inout nodes
    );
    const index = nodes.length;
    nodes.push(Statement({
      kind: kind == TokenKind.throwKeyword
        ? StatementKind.throwStatement
        : kind == TokenKind.yieldKeyword
          ? StatementKind.yieldStatement
          : StatementKind.selectStatement,
      mutableBinding: false,
      name: "",
      nameOffset: 0,
      nameLine: 0,
      nameColumn: 0,
      typeAnnotation: Option<TypeReference>.none,
      expression: Option.some(expression),
      secondExpression: Option<ExpressionSyntax>.none,
      objectBindings: Array<ObjectBinding>(),
      children: Array<usize>(),
      offset: start.offset,
      line: start.line,
      column: start.column,
    }));
    return Option.some(index);
  }
  if (kind == TokenKind.breakKeyword || kind == TokenKind.continueKeyword) {
    const start = snapshot(tokens[current]);
    current = current + 1;
    try expectKind(tokens, inout current, TokenKind.semicolon, "`;` after loop control");
    const index = nodes.length;
    nodes.push(Statement({
      kind: kind == TokenKind.breakKeyword
        ? StatementKind.breakStatement
        : StatementKind.continueStatement,
      mutableBinding: false,
      name: "",
      nameOffset: 0,
      nameLine: 0,
      nameColumn: 0,
      typeAnnotation: Option<TypeReference>.none,
      expression: Option<ExpressionSyntax>.none,
      secondExpression: Option<ExpressionSyntax>.none,
      objectBindings: Array<ObjectBinding>(),
      children: Array<usize>(),
      offset: start.offset,
      line: start.line,
      column: start.column,
    }));
    return Option.some(index);
  }
  const start = snapshot(tokens[current]);
  const assignment = topLevelAssignmentIndex(tokens, current);
  match (assignment) {
    some(equalIndex) => {
      const target = try projectExpressionRange(tokens, current, equalIndex, inout nodes);
      current = equalIndex + 1;
      const value = try scanExpression(tokens, inout current, "an assignment value", inout nodes);
      const index = nodes.length;
      nodes.push(Statement({
        kind: StatementKind.assignmentStatement,
        mutableBinding: false,
        name: "",
        nameOffset: 0,
        nameLine: 0,
        nameColumn: 0,
        typeAnnotation: Option<TypeReference>.none,
        expression: Option.some(target),
        secondExpression: Option.some(value),
        objectBindings: Array<ObjectBinding>(),
        children: Array<usize>(),
        offset: start.offset,
        line: start.line,
        column: start.column,
      }));
      return Option.some(index);
    }
    none => {}
  }
  const scanned = try scanExpression(tokens, inout current, "an expression statement", inout nodes);
  const index = nodes.length;
  nodes.push(Statement({
    kind: StatementKind.expressionStatement,
    mutableBinding: false,
    name: "",
    nameOffset: 0,
    nameLine: 0,
    nameColumn: 0,
    typeAnnotation: Option<TypeReference>.none,
    expression: Option.some(scanned),
    secondExpression: Option<ExpressionSyntax>.none,
    objectBindings: Array<ObjectBinding>(),
    children: Array<usize>(),
    offset: start.offset,
    line: start.line,
    column: start.column,
  }));
  return Option.some(index);
}

function parseImport(
  in tokens: Array<Token>,
  inout current: usize
): ImportDeclaration throws ParserError {
  const start = try expect(tokens, inout current, TokenKind.importKeyword, "an import declaration");
  let moduleName = "";
  let bindings = Array<ImportBinding>();
  let selective = false;
  if (takeIf(tokens, inout current, TokenKind.leftBrace)) {
    selective = true;
    if (tokens[current].kind == TokenKind.rightBrace) {
      throw fail(tokens[current], "a selective import requires at least one imported name");
    }
    while (true) {
      const imported = try expect(tokens, inout current, TokenKind.identifier, "an imported name");
      let localName = imported.text.copyBytes(0, imported.text.byteLength);
      if (takeIf(tokens, inout current, TokenKind.asKeyword)) {
        const local = try expect(tokens, inout current, TokenKind.identifier, "a local import alias");
        localName = local.text.copyBytes(0, local.text.byteLength);
      }
      bindings.push(ImportBinding({
        importedName: imported.text.copyBytes(0, imported.text.byteLength),
        localName,
        offset: imported.offset,
        line: imported.line,
        column: imported.column,
      }));
      if (!takeIf(tokens, inout current, TokenKind.comma)) break;
      if (tokens[current].kind == TokenKind.rightBrace) break;
    }
    try expectKind(tokens, inout current, TokenKind.rightBrace, "`}` after selective imports");
  } else {
    const module = try expect(tokens, inout current, TokenKind.identifier, "an import name");
    moduleName = module.text.copyBytes(0, module.text.byteLength);
  }
  try expectKind(tokens, inout current, TokenKind.fromKeyword, "`from`");
  const header = try expect(tokens, inout current, TokenKind.string, "a module path");
  try expectKind(tokens, inout current, TokenKind.semicolon, "`;` after an import declaration");
  return ImportDeclaration({
    moduleName,
    bindings,
    selective,
    header: header.text.copyBytes(0, header.text.byteLength),
    offset: start.offset,
    line: start.line,
    column: start.column,
  });
}

function parseFunctionDeclaration(
  in tokens: Array<Token>,
  inout current: usize,
  asynchronous: boolean,
  isStatic: boolean,
  visibility: Visibility,
  signatureOnly: boolean
): FunctionDeclaration throws ParserError {
  let pendingGreater: usize = 0;
  const start = try expect(tokens, inout current, TokenKind.functionKeyword, "a function declaration");
  const name = try expect(tokens, inout current, TokenKind.identifier, "a function name");
  const typeParameters = try parseTypeParameters(tokens, inout current, inout pendingGreater);
  try expectKind(tokens, inout current, TokenKind.leftParen, "`(` after a function name");

  let receiverMode = ReceiverMode.none;
  if (current + 1 < tokens.length && tokens[current + 1].kind == TokenKind.identifier && tokens[current + 1].text == "this") {
    if (tokens[current].kind == TokenKind.inoutKeyword) {
      receiverMode = ReceiverMode.inputOutput;
      current = current + 2;
    } else if (tokens[current].kind == TokenKind.identifier && tokens[current].text == "move") {
      receiverMode = ReceiverMode.move;
      current = current + 2;
    }
    if (receiverMode != ReceiverMode.none && tokens[current].kind != TokenKind.rightParen) {
      try expectKind(tokens, inout current, TokenKind.comma, "`,` after a receiver capability");
    }
  }

  const parameters = try parseParameters(tokens, inout current, inout pendingGreater);
  try expectKind(tokens, inout current, TokenKind.rightParen, "`)` after function parameters");
  try expectKind(tokens, inout current, TokenKind.colon, "`:` before a function return type");
  const returnType = try parseType(tokens, inout current, inout pendingGreater);
  let errorType = Option<TypeReference>.none;
  if (takeIf(tokens, inout current, TokenKind.throwsKeyword)) {
    const error = try parseType(tokens, inout current, inout pendingGreater);
    errorType = Option.some(error);
  }
  // Stage 1 does not consume Objective-C selector evidence semantically yet,
  // but it must accept the authoritative source grammar so the native frontend
  // remains usable while protocol conformance is lowered by the bootstrap.
  if (takeIf(tokens, inout current, TokenKind.asKeyword)) {
    try expectKind(tokens, inout current, TokenKind.string, "an Objective-C selector string after `as`");
  }
  let body = StatementArena({ nodes: Array<Statement>(), roots: Array<usize>() });
  if (signatureOnly) {
    try expectKind(tokens, inout current, TokenKind.semicolon, "`;` after a function signature");
  } else {
    let bodyNodes = Array<Statement>();
    const bodyRoots = try parseProjectedBlock(
      tokens,
      inout current,
      `the body of ${name.text}`,
      inout bodyNodes
    );
    body = StatementArena({ nodes: bodyNodes, roots: bodyRoots });
  }
  return FunctionDeclaration({
    name: name.text.copyBytes(0, name.text.byteLength),
    asynchronous,
    staticMethod: isStatic,
    visibility,
    typeParameters,
    receiverMode,
    parameters,
    returnType,
    errorType,
    body,
    offset: start.offset,
    line: start.line,
    column: start.column,
  });
}

function parseConstructor(
  in tokens: Array<Token>,
  inout current: usize,
  in ownerName: String
): ConstructorDeclaration throws ParserError {
  let pendingGreater: usize = 0;
  const start = try expect(tokens, inout current, TokenKind.constructorKeyword, "a constructor declaration");
  try expectKind(tokens, inout current, TokenKind.leftParen, "`(` after `constructor`");
  const parameters = try parseParameters(tokens, inout current, inout pendingGreater);
  try expectKind(tokens, inout current, TokenKind.rightParen, "`)` after constructor parameters");
  let errorType = Option<TypeReference>.none;
  if (takeIf(tokens, inout current, TokenKind.throwsKeyword)) {
    const error = try parseType(tokens, inout current, inout pendingGreater);
    errorType = Option.some(error);
  }
  let bodyNodes = Array<Statement>();
  const bodyRoots = try parseProjectedBlock(
    tokens,
    inout current,
    `the constructor body of ${ownerName}`,
    inout bodyNodes
  );
  const body = StatementArena({ nodes: bodyNodes, roots: bodyRoots });
  return ConstructorDeclaration({
    parameters,
    errorType,
    body,
    offset: start.offset,
    line: start.line,
    column: start.column,
  });
}

function parseAggregateDeclaration(
  in tokens: Array<Token>,
  inout current: usize,
  keyword: TokenKind,
  kind: DeclarationKind,
  aggregateReadonly: boolean,
  in description: String
): AggregateDeclaration throws ParserError {
  let pendingGreater: usize = 0;
  const start = try expect(tokens, inout current, keyword, description);
  const name = try expect(tokens, inout current, TokenKind.identifier, `a name after ${start.text}`);
  const typeParameters = try parseTypeParameters(tokens, inout current, inout pendingGreater);
  let implementedTraits = Array<TypeReference>();
  if (takeIf(tokens, inout current, TokenKind.implementsKeyword)) {
    while (true) {
      const implemented = try parseType(tokens, inout current, inout pendingGreater);
      implementedTraits.push(implemented);
      if (!takeIf(tokens, inout current, TokenKind.comma)) break;
    }
  }
  try expectKind(tokens, inout current, TokenKind.leftBrace, `the body of ${name.text}`);

  let fields = Array<FieldDeclaration>();
  let methods = Array<FunctionDeclaration>();
  let initializer = Option<ConstructorDeclaration>.none;
  let deinitializer = Option<DeinitDeclaration>.none;
  let hasConstructor = false;
  let hasDeinitializer = false;
  while (tokens[current].kind != TokenKind.rightBrace && tokens[current].kind != TokenKind.eof) {
    if (tokens[current].kind == TokenKind.constructorKeyword) {
      if (hasConstructor) throw fail(tokens[current], `${name.text} cannot declare more than one constructor`);
      const parsed = try parseConstructor(tokens, inout current, name.text);
      initializer = Option.some(parsed);
      hasConstructor = true;
      continue;
    }
    if (tokens[current].kind == TokenKind.deinitKeyword) {
      if (hasDeinitializer) throw fail(tokens[current], `${name.text} cannot declare more than one deinit block`);
      const cleanupToken = try expect(tokens, inout current, TokenKind.deinitKeyword, "a deinit declaration");
      let bodyNodes = Array<Statement>();
      const bodyRoots = try parseProjectedBlock(
        tokens,
        inout current,
        `the deinit body of ${name.text}`,
        inout bodyNodes
      );
      const body = StatementArena({ nodes: bodyNodes, roots: bodyRoots });
      deinitializer = Option.some(DeinitDeclaration({
        body,
        offset: cleanupToken.offset,
        line: cleanupToken.line,
        column: cleanupToken.column,
      }));
      hasDeinitializer = true;
      continue;
    }

    let visibility = Visibility.publicVisibility;
    if (takeIf(tokens, inout current, TokenKind.publicKeyword)) visibility = Visibility.publicVisibility;
    else if (takeIf(tokens, inout current, TokenKind.privateKeyword)) visibility = Visibility.privateVisibility;
    const fieldReadonly = takeIf(tokens, inout current, TokenKind.readonlyKeyword);
    const isStatic = takeIf(tokens, inout current, TokenKind.staticKeyword);
    const asynchronous = takeIf(tokens, inout current, TokenKind.asyncKeyword);
    if (tokens[current].kind == TokenKind.functionKeyword) {
      if (fieldReadonly) throw fail(tokens[current], "`readonly` applies to stored fields, not methods");
      const method = try parseFunctionDeclaration(tokens, inout current, asynchronous, isStatic, visibility, false);
      methods.push(method);
      continue;
    }
    if (asynchronous) throw fail(tokens[current], "`async` must precede a function declaration");
    if (isStatic) throw fail(tokens[current], "static fields are not implemented");
    const field = try expect(tokens, inout current, TokenKind.identifier, "a field or method declaration");
    try expectKind(tokens, inout current, TokenKind.colon, "`:` after a field name");
    const type = try parseType(tokens, inout current, inout pendingGreater);
    try expectKind(tokens, inout current, TokenKind.semicolon, "`;` after a field declaration");
    fields.push(FieldDeclaration({
      name: field.text.copyBytes(0, field.text.byteLength),
      type,
      visibility,
      readonlyField: aggregateReadonly || fieldReadonly,
      offset: field.offset,
      line: field.line,
      column: field.column,
    }));
  }
  try expectKind(tokens, inout current, TokenKind.rightBrace, "`}` after an aggregate declaration");
  return AggregateDeclaration({
    kind,
    name: name.text.copyBytes(0, name.text.byteLength),
    typeParameters,
    implementedTraits,
    fields,
    constructorDeclaration: initializer,
    methods,
    deinitializer,
    offset: start.offset,
    line: start.line,
    column: start.column,
  });
}

function parseTraitDeclaration(
  in tokens: Array<Token>,
  inout current: usize
): TraitDeclaration throws ParserError {
  let pendingGreater: usize = 0;
  const start = try expect(tokens, inout current, TokenKind.traitKeyword, "a trait declaration");
  const name = try expect(tokens, inout current, TokenKind.identifier, "a trait name");
  const typeParameters = try parseTypeParameters(tokens, inout current, inout pendingGreater);
  try expectKind(tokens, inout current, TokenKind.leftBrace, `the body of ${name.text}`);
  let methods = Array<FunctionDeclaration>();
  while (tokens[current].kind != TokenKind.rightBrace && tokens[current].kind != TokenKind.eof) {
    const asynchronous = takeIf(tokens, inout current, TokenKind.asyncKeyword);
    const method = try parseFunctionDeclaration(
      tokens,
      inout current,
      asynchronous,
      false,
      Visibility.publicVisibility,
      true
    );
    methods.push(method);
  }
  try expectKind(tokens, inout current, TokenKind.rightBrace, "`}` after a trait declaration");
  return TraitDeclaration({
    name: name.text.copyBytes(0, name.text.byteLength),
    typeParameters,
    methods,
    offset: start.offset,
    line: start.line,
    column: start.column,
  });
}

function parseTypeAliasDeclaration(
  in tokens: Array<Token>,
  inout current: usize
): TypeAliasDeclaration throws ParserError {
  let pendingGreater: usize = 0;
  const start = try expect(tokens, inout current, TokenKind.identifier, "`type`");
  const name = try expect(tokens, inout current, TokenKind.identifier, "a type alias name");
  try expectKind(tokens, inout current, TokenKind.equal, "`=` after a type alias name");
  const target = try parseType(tokens, inout current, inout pendingGreater);
  try expectKind(tokens, inout current, TokenKind.semicolon, "`;` after a type alias");
  return TypeAliasDeclaration({
    name: name.text.copyBytes(0, name.text.byteLength),
    target,
    offset: start.offset,
    line: start.line,
    column: start.column,
  });
}

function parseEnumDeclaration(
  in tokens: Array<Token>,
  inout current: usize
): EnumDeclaration throws ParserError {
  let pendingGreater: usize = 0;
  const start = try expect(tokens, inout current, TokenKind.enumKeyword, "an enum declaration");
  const name = try expect(tokens, inout current, TokenKind.identifier, "an enum name");
  try expectKind(tokens, inout current, TokenKind.leftBrace, `the body of ${name.text}`);
  let variants = Array<EnumVariant>();
  while (tokens[current].kind != TokenKind.rightBrace && tokens[current].kind != TokenKind.eof) {
    const variant = try expect(tokens, inout current, TokenKind.identifier, "an enum variant name");
    let payload = Option<TypeReference>.none;
    if (tokens[current].kind == TokenKind.identifier) {
      const parsed = try parseType(tokens, inout current, inout pendingGreater);
      payload = Option.some(parsed);
    }
    variants.push(EnumVariant({
      name: variant.text.copyBytes(0, variant.text.byteLength),
      payload,
      offset: variant.offset,
      line: variant.line,
      column: variant.column,
    }));
    if (!takeIf(tokens, inout current, TokenKind.comma)) break;
  }
  try expectKind(tokens, inout current, TokenKind.rightBrace, "`}` after an enum declaration");
  return EnumDeclaration({
    name: name.text.copyBytes(0, name.text.byteLength),
    variants,
    offset: start.offset,
    line: start.line,
    column: start.column,
  });
}

export function parseProgram(in tokens: Array<Token>): Program throws ParserError {
  let declarations = Array<Declaration>();
  let imports = Array<ImportDeclaration>();
  let typeAliases = Array<TypeAliasDeclaration>();
  let functions = Array<FunctionDeclaration>();
  let aggregates = Array<AggregateDeclaration>();
  let traits = Array<TraitDeclaration>();
  let enums = Array<EnumDeclaration>();
  let current: usize = 0;
  while (tokens[current].kind != TokenKind.eof) {
    let exported = false;
    if (tokens[current].kind == TokenKind.exportKeyword) {
      exported = true;
      current = current + 1;
    }

    let aggregateReadonly = false;
    if (tokens[current].kind == TokenKind.readonlyKeyword) {
      aggregateReadonly = true;
      current = current + 1;
    }

    let asynchronous = false;
    if (tokens[current].kind == TokenKind.asyncKeyword) {
      asynchronous = true;
      current = current + 1;
    }

    const kind = tokens[current].kind;
    if (kind == TokenKind.importKeyword) {
      if (aggregateReadonly) throw fail(tokens[current], "`readonly` can only modify a struct or class declaration");
      if (exported) throw fail(tokens[current], "imports cannot be exported");
      if (asynchronous) throw fail(tokens[current], "imports cannot be async");
      const importDeclaration = try parseImport(tokens, inout current);
      const declaration = Declaration({
        kind: DeclarationKind.importDeclaration,
        name: importDeclaration.header.copyBytes(0, importDeclaration.header.byteLength),
        exported: false,
        asynchronous: false,
        offset: importDeclaration.offset,
        line: importDeclaration.line,
        column: importDeclaration.column,
      });
      declarations.push(declaration);
      imports.push(importDeclaration);
    } else if (kind == TokenKind.identifier && tokens[current].text == "type") {
      if (aggregateReadonly) throw fail(tokens[current], "`readonly` can only modify a struct or class declaration");
      if (asynchronous) throw fail(tokens[current], "a type alias cannot be async");
      const alias = try parseTypeAliasDeclaration(tokens, inout current);
      declarations.push(Declaration({
        kind: DeclarationKind.typeAliasDeclaration,
        name: alias.name.copyBytes(0, alias.name.byteLength),
        exported,
        asynchronous: false,
        offset: alias.offset,
        line: alias.line,
        column: alias.column,
      }));
      typeAliases.push(alias);
    } else if (kind == TokenKind.functionKeyword) {
      if (aggregateReadonly) throw fail(tokens[current], "`readonly` can only modify a struct or class declaration");
      const functionDeclaration = try parseFunctionDeclaration(
        tokens,
        inout current,
        asynchronous,
        false,
        Visibility.publicVisibility,
        false
      );
      const declaration = Declaration({
        kind: DeclarationKind.functionDeclaration,
        name: functionDeclaration.name.copyBytes(0, functionDeclaration.name.byteLength),
        exported,
        asynchronous,
        offset: functionDeclaration.offset,
        line: functionDeclaration.line,
        column: functionDeclaration.column,
      });
      declarations.push(declaration);
      functions.push(functionDeclaration);
    } else if (kind == TokenKind.structKeyword) {
      if (asynchronous) throw fail(tokens[current], "a struct declaration cannot be async");
      const aggregate = try parseAggregateDeclaration(
        tokens,
        inout current,
        TokenKind.structKeyword,
        DeclarationKind.structDeclaration,
        aggregateReadonly,
        "a struct declaration"
      );
      const declaration = Declaration({
        kind: DeclarationKind.structDeclaration,
        name: aggregate.name.copyBytes(0, aggregate.name.byteLength),
        exported,
        asynchronous: false,
        offset: aggregate.offset,
        line: aggregate.line,
        column: aggregate.column,
      });
      declarations.push(declaration);
      aggregates.push(aggregate);
    } else if (kind == TokenKind.classKeyword) {
      if (asynchronous) throw fail(tokens[current], "a class declaration cannot be async");
      const aggregate = try parseAggregateDeclaration(
        tokens,
        inout current,
        TokenKind.classKeyword,
        DeclarationKind.classDeclaration,
        aggregateReadonly,
        "a class declaration"
      );
      const declaration = Declaration({
        kind: DeclarationKind.classDeclaration,
        name: aggregate.name.copyBytes(0, aggregate.name.byteLength),
        exported,
        asynchronous: false,
        offset: aggregate.offset,
        line: aggregate.line,
        column: aggregate.column,
      });
      declarations.push(declaration);
      aggregates.push(aggregate);
    } else if (kind == TokenKind.traitKeyword) {
      if (aggregateReadonly) throw fail(tokens[current], "`readonly` can only modify a struct or class declaration");
      if (asynchronous) throw fail(tokens[current], "a trait declaration cannot be async");
      const traitDeclaration = try parseTraitDeclaration(tokens, inout current);
      const declaration = Declaration({
        kind: DeclarationKind.traitDeclaration,
        name: traitDeclaration.name.copyBytes(0, traitDeclaration.name.byteLength),
        exported,
        asynchronous: false,
        offset: traitDeclaration.offset,
        line: traitDeclaration.line,
        column: traitDeclaration.column,
      });
      declarations.push(declaration);
      traits.push(traitDeclaration);
    } else if (kind == TokenKind.enumKeyword) {
      if (aggregateReadonly) throw fail(tokens[current], "`readonly` can only modify a struct or class declaration");
      if (asynchronous) throw fail(tokens[current], "an enum declaration cannot be async");
      const enumDeclaration = try parseEnumDeclaration(tokens, inout current);
      const declaration = Declaration({
        kind: DeclarationKind.enumDeclaration,
        name: enumDeclaration.name.copyBytes(0, enumDeclaration.name.byteLength),
        exported,
        asynchronous: false,
        offset: enumDeclaration.offset,
        line: enumDeclaration.line,
        column: enumDeclaration.column,
      });
      declarations.push(declaration);
      enums.push(enumDeclaration);
    } else {
      if (aggregateReadonly) throw fail(tokens[current], "`readonly` can only modify a struct or class declaration");
      throw fail(tokens[current], "expected an import, type, function, struct, class, trait, or enum declaration");
    }
  }
  return Program({ declarations, imports, typeAliases, functions, aggregates, traits, enums });
}

function expressionKindName(kind: ExpressionKind): String {
  return match (kind) {
    identifierExpression => "identifier";
    numberExpression => "number";
    stringExpression => "string";
    booleanExpression => "boolean";
    nullExpression => "null";
    templateTextExpression => "templateText";
    templateExpression => "template";
    closureParameterExpression => "closureParameter";
    closureExpression => "closure";
    arrayExpression => "arrayExpression";
    objectExpression => "objectExpression";
    memberExpression => "member";
    callExpression => "call";
    indexExpression => "index";
    unaryExpression => "unary";
    binaryExpression => "binary";
    conditionalExpression => "conditional";
    newExpression => "new";
    variantMarkerExpression => "variantMarker";
    variantExpression => "variant";
    argumentBindingExpression => "argumentBinding";
    argumentReferenceExpression => "argumentReference";
    weakExpression => "weak";
    tryExpression => "try";
    attemptExpression => "attempt";
    awaitExpression => "await";
    spawnExpression => "spawn";
    matchExpression => "match";
    matchArmExpression => "matchArm";
    matchBindingExpression => "matchBinding";
    matchObjectFieldExpression => "matchObjectField";
    ifExpression => "ifExpression";
    whileExpression => "whileExpression";
    forExpression => "forExpression";
    forBindingExpression => "forBinding";
    valueBlockExpression => "valueBlock";
    executorPlacementExpression => "executorPlacement";
    executorOnExpression => "executorOn";
  };
}

function expressionTreeText(in tree: ExpressionTree, in arena: StatementArena): String {
  let output = TextBuffer();
  output.append(`root:${tree.root};`);
  for (const node of tree.nodes) {
    output.append(expressionKindName(node.kind));
    output.append("@");
    output.append(`${node.offset},${node.line},${node.column}`);
    output.append(":");
    output.append(`${node.value.byteLength}`);
    output.append(":");
    output.append(node.value);
    output.append("[");
    let firstChild = true;
    for (const child of node.children) {
      if (!firstChild) output.append(",");
      firstChild = false;
      output.append(`${child}`);
    }
    output.append("]{");
    let firstLabel = true;
    for (const label of node.labels) {
      if (!firstLabel) output.append(",");
      firstLabel = false;
      output.append(`${label.byteLength}:`);
      output.append(label);
    }
    output.append("}");
    if (node.statements.length > 0) {
      output.append("body{");
      for (const statement of node.statements) {
        const rendered = statementText(arena, statement);
        output.append(rendered);
      }
      output.append("}");
    }
    output.append(";");
  }
  return output.finish();
}

function statementText(in arena: StatementArena, index: usize): String {
  return renderStatementText(arena, arena.nodes[index]);
}

function expressionSyntaxText(
  in expression: ExpressionSyntax,
  in arena: StatementArena
): String {
  let output = TextBuffer();
  output.append(`${expression.offset},${expression.line},${expression.column}`);
  output.append(":");
  output.append(expression.tokens);
  output.append("#");
  match (in expression.tree) {
    some(tree) => {
      const renderedTree = expressionTreeText(tree, arena);
      output.append(renderedTree);
    }
    none => output.append("opaque");
  }
  return output.finish();
}

function objectBindingsText(in bindings: Array<ObjectBinding>): String {
  let output = TextBuffer();
  output.append("{");
  let first = true;
  for (const binding of bindings) {
    if (!first) output.append(",");
    first = false;
    output.append(binding.fieldName);
    output.append("@");
    output.append(`${binding.fieldOffset},${binding.fieldLine},${binding.fieldColumn}`);
    output.append(":");
    output.append(binding.bindingName);
    output.append("@");
    output.append(`${binding.bindingOffset},${binding.bindingLine},${binding.bindingColumn}`);
  }
  output.append("}");
  return output.finish();
}

function renderStatementText(in arena: StatementArena, in statement: Statement): String {
  let output = TextBuffer();
  if (statement.kind == StatementKind.variableStatement) output.append("variable@");
  else if (statement.kind == StatementKind.destructureStatement) output.append("destructure@");
  else if (statement.kind == StatementKind.assignmentStatement) output.append("assignment@");
  else if (statement.kind == StatementKind.returnStatement) output.append("return@");
  else if (statement.kind == StatementKind.throwStatement) output.append("throw@");
  else if (statement.kind == StatementKind.yieldStatement) output.append("yield@");
  else if (statement.kind == StatementKind.selectStatement) output.append("select@");
  else if (statement.kind == StatementKind.expressionStatement) output.append("expression@");
  else if (statement.kind == StatementKind.ifStatement) output.append("if@");
  else if (statement.kind == StatementKind.whileStatement) output.append("while@");
  else if (statement.kind == StatementKind.forAwaitStatement) output.append("for-await@");
  else if (statement.kind == StatementKind.forTryAwaitStatement) output.append("try-for-await@");
  else if (statement.kind == StatementKind.forStatement) output.append("for@");
  else if (statement.kind == StatementKind.matchStatement) output.append("match@");
  else if (statement.kind == StatementKind.asyncScopeStatement) output.append("asyncScope@");
  else if (statement.kind == StatementKind.breakStatement) output.append("break@");
  else if (statement.kind == StatementKind.continueStatement) output.append("continue@");
  else output.append("block@");
  output.append(`${statement.offset},${statement.line},${statement.column}`);
  output.append("(");
  if (statement.kind == StatementKind.variableStatement) {
    if (statement.mutableBinding) output.append("let:");
    else output.append("const:");
    output.append(statement.name);
    output.append("@");
    output.append(`${statement.nameOffset},${statement.nameLine},${statement.nameColumn}`);
    match (in statement.typeAnnotation) {
      some(typeAnnotation) => {
        output.append(":");
        output.append(typeAnnotation.name);
        output.append("@");
        output.append(`${typeAnnotation.offset},${typeAnnotation.line},${typeAnnotation.column}`);
      }
      none => {}
    }
  } else if (statement.kind == StatementKind.destructureStatement) {
    if (statement.mutableBinding) output.append("let:");
    else output.append("const:");
    const pattern = objectBindingsText(statement.objectBindings);
    output.append(pattern);
    match (in statement.typeAnnotation) {
      some(typeAnnotation) => {
        output.append(":");
        output.append(typeAnnotation.name);
        output.append("@");
        output.append(`${typeAnnotation.offset},${typeAnnotation.line},${typeAnnotation.column}`);
      }
      none => {}
    }
  }
  if (statement.kind == StatementKind.assignmentStatement) {
    match (in statement.expression) {
      some(expression) => {
        output.append("target=");
        const rendered = expressionSyntaxText(expression, arena);
        output.append(rendered);
      }
      none => {}
    }
    match (in statement.secondExpression) {
      some(expression) => {
        output.append("value=");
        const rendered = expressionSyntaxText(expression, arena);
        output.append(rendered);
      }
      none => {}
    }
  } else if (
    statement.kind == StatementKind.forStatement
    || statement.kind == StatementKind.forAwaitStatement
    || statement.kind == StatementKind.forTryAwaitStatement
  ) {
    output.append("const:");
    if (statement.name.byteLength > 0) {
      output.append(statement.name);
      output.append("@");
      output.append(`${statement.nameOffset},${statement.nameLine},${statement.nameColumn}`);
    } else {
      const pattern = objectBindingsText(statement.objectBindings);
      output.append(pattern);
    }
    if (statement.mutableBinding) output.append("inout:");
    match (in statement.expression) {
      some(expression) => {
        output.append("iterable=");
        const rendered = expressionSyntaxText(expression, arena);
        output.append(rendered);
      }
      none => {}
    }
  } else {
    match (in statement.expression) {
      some(expression) => {
        output.append("=");
        const rendered = expressionSyntaxText(expression, arena);
        output.append(rendered);
      }
      none => {}
    }
  }
  if (statement.kind == StatementKind.ifStatement) {
    if (statement.children.length > 0) {
      output.append("then=");
      const branch = statementText(arena, statement.children[0]);
      output.append(branch);
    }
    if (statement.children.length > 1) {
      output.append("else=");
      const branch = statementText(arena, statement.children[1]);
      output.append(branch);
    }
  } else if (
    statement.kind == StatementKind.whileStatement
    || statement.kind == StatementKind.forStatement
    || statement.kind == StatementKind.forAwaitStatement
    || statement.kind == StatementKind.forTryAwaitStatement
    || statement.kind == StatementKind.asyncScopeStatement
  ) {
    if (statement.children.length > 0) {
      output.append("body=");
      const body = statementText(arena, statement.children[0]);
      output.append(body);
    }
  } else {
    for (const child of statement.children) {
      const childText = statementText(arena, child);
      output.append(childText);
    }
  }
  output.append(")");
  return output.finish();
}

export function functionBodyText(in declaration: FunctionDeclaration): String {
  let output = TextBuffer();
  output.append("{");
  for (const root of declaration.body.roots) {
    const rendered = statementText(declaration.body, root);
    output.append(rendered);
  }
  output.append("}");
  return output.finish();
}

export function functionSignatureText(in declaration: FunctionDeclaration): String {
  let output = TextBuffer();
  if (declaration.asynchronous) output.append("async ");
  output.append("function ");
  output.append(declaration.name);
  if (declaration.typeParameters.length > 0) {
    output.append("<");
    let firstTypeParameter = true;
    for (const typeParameter of declaration.typeParameters) {
      if (!firstTypeParameter) output.append(", ");
      firstTypeParameter = false;
      output.append(typeParameter.name);
      if (typeParameter.constraints.length > 0) {
        output.append(": ");
        let firstConstraint = true;
        for (const constraint of typeParameter.constraints) {
          if (!firstConstraint) output.append(" & ");
          firstConstraint = false;
          output.append(constraint.name);
        }
      }
    }
    output.append(">");
  }
  output.append("(");
  let firstParameter = true;
  if (declaration.receiverMode == ReceiverMode.inputOutput) {
    output.append("inout this");
    firstParameter = false;
  } else if (declaration.receiverMode == ReceiverMode.move) {
    output.append("move this");
    firstParameter = false;
  }
  for (const parameter of declaration.parameters) {
    if (!firstParameter) output.append(", ");
    firstParameter = false;
    output.append(parameterModeName(parameter.mode));
    output.append(parameter.name);
    output.append(": ");
    output.append(parameter.type.name);
  }
  output.append("): ");
  output.append(declaration.returnType.name);
  match (in declaration.errorType) {
    some(error) => {
      output.append(" throws ");
      output.append(error.name);
    }
    none => {}
  }
  return output.finish();
}

function visibilityName(visibility: Visibility): String {
  return match (visibility) {
    publicVisibility => "public ";
    privateVisibility => "private ";
  };
}

export function aggregateShapeText(in declaration: AggregateDeclaration): String {
  let output = TextBuffer();
  if (declaration.kind == DeclarationKind.structDeclaration) output.append("struct ");
  else output.append("class ");
  output.append(declaration.name);
  if (declaration.typeParameters.length > 0) {
    output.append("<");
    let firstTypeParameter = true;
    for (const typeParameter of declaration.typeParameters) {
      if (!firstTypeParameter) output.append(", ");
      firstTypeParameter = false;
      output.append(typeParameter.name);
      if (typeParameter.constraints.length > 0) {
        output.append(": ");
        let firstConstraint = true;
        for (const constraint of typeParameter.constraints) {
          if (!firstConstraint) output.append(" & ");
          firstConstraint = false;
          output.append(constraint.name);
        }
      }
    }
    output.append(">");
  }
  if (declaration.implementedTraits.length > 0) {
    output.append(" implements ");
    let firstImplemented = true;
    for (const implemented of declaration.implementedTraits) {
      if (!firstImplemented) output.append(", ");
      firstImplemented = false;
      output.append(implemented.name);
    }
  }
  output.append(" {");
  for (const field of declaration.fields) {
    output.append(" ");
    output.append(visibilityName(field.visibility));
    if (field.readonlyField) output.append("readonly ");
    output.append(field.name);
    output.append(": ");
    output.append(field.type.name);
    output.append(";");
  }
  match (in declaration.constructorDeclaration) {
    some(initializer) => {
      output.append(" constructor(");
      let firstParameter = true;
      for (const parameter of initializer.parameters) {
        if (!firstParameter) output.append(", ");
        firstParameter = false;
        output.append(parameterModeName(parameter.mode));
        output.append(parameter.name);
        output.append(": ");
        output.append(parameter.type.name);
      }
      output.append(")");
      match (in initializer.errorType) {
        some(error) => {
          output.append(" throws ");
          output.append(error.name);
        }
        none => {}
      }
      output.append(";");
    }
    none => {}
  }
  for (const method of declaration.methods) {
    output.append(" ");
    output.append(visibilityName(method.visibility));
    if (method.staticMethod) output.append("static ");
    const signature = functionSignatureText(method);
    output.append(signature);
    output.append(";");
  }
  match (in declaration.deinitializer) {
    some(deinitializer) => {
      output.append(" deinit@");
      const offset = `${deinitializer.offset}`;
      output.append(offset);
      output.append(";");
    }
    none => {}
  }
  output.append(" }");
  return output.finish();
}

export function traitShapeText(in declaration: TraitDeclaration): String {
  let output = TextBuffer();
  output.append("trait ");
  output.append(declaration.name);
  if (declaration.typeParameters.length > 0) {
    output.append("<");
    let firstTypeParameter = true;
    for (const typeParameter of declaration.typeParameters) {
      if (!firstTypeParameter) output.append(", ");
      firstTypeParameter = false;
      output.append(typeParameter.name);
      if (typeParameter.constraints.length > 0) {
        output.append(": ");
        let firstConstraint = true;
        for (const constraint of typeParameter.constraints) {
          if (!firstConstraint) output.append(" & ");
          firstConstraint = false;
          output.append(constraint.name);
        }
      }
    }
    output.append(">");
  }
  output.append(" {");
  for (const method of declaration.methods) {
    output.append(" ");
    const signature = functionSignatureText(method);
    output.append(signature);
    output.append(";");
  }
  output.append(" }");
  return output.finish();
}

export function enumShapeText(in declaration: EnumDeclaration): String {
  let output = TextBuffer();
  output.append("enum ");
  output.append(declaration.name);
  output.append(" {");
  for (const variant of declaration.variants) {
    output.append(" ");
    output.append(variant.name);
    match (in variant.payload) {
      some(payload) => {
        output.append(" ");
        output.append(payload.name);
      }
      none => {}
    }
    output.append(";");
  }
  output.append(" }");
  return output.finish();
}

export function declarationKindName(kind: DeclarationKind): String {
  return match (kind) {
    importDeclaration => "import";
    functionDeclaration => "function";
    structDeclaration => "struct";
    classDeclaration => "class";
    traitDeclaration => "trait";
    typeAliasDeclaration => "type";
    enumDeclaration => "enum";
  };
}

export function typeAliasShapeText(in declaration: TypeAliasDeclaration): String {
  return `type ${declaration.name} = ${declaration.target.name}`;
}

export function importShapeText(in declaration: ImportDeclaration): String {
  let output = TextBuffer();
  output.append("import ");
  if (declaration.selective) {
    output.append("{");
    let first = true;
    for (const binding of declaration.bindings) {
      if (!first) output.append(", ");
      first = false;
      output.append(binding.importedName);
      output.append(`@${binding.offset},${binding.line},${binding.column}`);
      if (binding.localName != binding.importedName) {
        output.append(" as ");
        output.append(binding.localName);
      }
    }
    output.append("}");
  } else output.append(declaration.moduleName);
  output.append(" from \"");
  output.append(declaration.header);
  output.append("\";");
  return output.finish();
}
