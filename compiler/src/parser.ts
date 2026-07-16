import type {
  Expression,
  EnumDeclaration,
  FunctionDeclaration,
  ImportDeclaration,
  Parameter,
  Program,
  Statement,
  StructDeclaration,
  TypeReference,
} from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { Token, TokenKind } from "./lexer.ts";

export function parse(tokens: Token[], fileName: string): Program {
  let current = 0;
  let importCounter = 0;

  const peek = (): Token => tokens[current];
  const previous = (): Token => tokens[current - 1];
  const at = (kind: TokenKind): boolean => peek().kind === kind;
  const take = (): Token => tokens[current++];
  const match = (kind: TokenKind): boolean => {
    if (!at(kind)) return false;
    take();
    return true;
  };
  const expect = (kind: TokenKind, description: string): Token => {
    if (at(kind)) return take();
    throw new DiagnosticError(fileName, peek().location, `expected ${description}, found ${tokenDescription(peek())}`);
  };

  const parseType = (): TypeReference => {
    const token = expect("identifier", "a type name");
    if (!match("dot")) return { name: token.text, location: token.location };
    const member = expect("identifier", "an imported type name");
    return { name: `${token.text}.${member.text}`, location: token.location };
  };

  const parseImport = (): ImportDeclaration => {
    const start = expect("import", "`import`").location;
    let moduleName: string;
    let bindings: ImportDeclaration["bindings"] = null;
    if (match("leftBrace")) {
      moduleName = `__z_selective_import_${importCounter++}`;
      bindings = [];
      if (at("rightBrace")) {
        throw new DiagnosticError(fileName, peek().location, "a selective import requires at least one C function name");
      }
      do {
        const imported = expect("identifier", "an imported C function name");
        const local = match("as")
          ? expect("identifier", "a local import alias")
          : imported;
        bindings.push({
          importedName: imported.text,
          localName: local.text,
          location: imported.location,
        });
      } while (match("comma") && !at("rightBrace"));
      expect("rightBrace", "`}`");
    } else {
      moduleName = expect("identifier", "an import name").text;
    }
    expect("from", "`from`");
    const header = expect("string", "a header string").text;
    expect("semicolon", "`;`");
    return { kind: "import", moduleName, bindings, header, location: start };
  };

  const parseParameters = (): Parameter[] => {
    const parameters: Parameter[] = [];
    if (at("rightParen")) return parameters;
    do {
      const nameToken = expect("identifier", "a parameter name");
      expect("colon", "`:`");
      const mode = match("in") ? "in" : match("inout") ? "inout" : "value";
      parameters.push({ name: nameToken.text, mode, type: parseType(), location: nameToken.location });
    } while (match("comma"));
    return parameters;
  };

  const precedence = (kind: TokenKind): number => {
    switch (kind) {
      case "orOr":
        return 1;
      case "andAnd":
        return 2;
      case "equalEqual":
      case "bangEqual":
        return 3;
      case "less":
      case "lessEqual":
      case "greater":
      case "greaterEqual":
        return 4;
      case "plus":
      case "minus":
        return 10;
      case "star":
      case "slash":
        return 20;
      default:
        return -1;
    }
  };

  let parseStatement: () => Statement;

  const parsePrimary = (): Expression => {
    if (match("out") || match("inout")) {
      const token = previous();
      const name = expect("identifier", "a mutable binding");
      return {
        kind: "argumentReference",
        access: token.kind as "out" | "inout",
        name: name.text,
        location: token.location,
      };
    }
    if (match("match")) {
      const token = previous();
      const expression = parseExpression();
      return { kind: "matchExpression", expression, arms: parseMatchArms(), location: token.location };
    }
    if (match("attempt")) {
      const token = previous();
      return { kind: "attempt", expression: parsePostfix(), location: token.location };
    }
    if (match("try")) {
      const token = previous();
      return { kind: "try", expression: parsePostfix(), location: token.location };
    }
    if (match("number")) {
      const token = previous();
      return { kind: "number", value: token.text, location: token.location };
    }
    if (match("string")) {
      const token = previous();
      return { kind: "string", value: token.text, location: token.location };
    }
    if (match("true") || match("false")) {
      const token = previous();
      return { kind: "boolean", value: token.kind === "true", location: token.location };
    }
    if (match("identifier")) {
      const token = previous();
      const beginsForeignStructLiteral = at("dot")
        && tokens[current + 1]?.kind === "identifier"
        && tokens[current + 2]?.kind === "leftBrace"
        && (tokens[current + 3]?.kind === "rightBrace"
          || (tokens[current + 3]?.kind === "identifier" && tokens[current + 4]?.kind === "colon"));
      if (beginsForeignStructLiteral) {
        take();
        const foreignType = take();
        take();
        const fields = [];
        while (!at("rightBrace")) {
          const field = expect("identifier", "a field name");
          expect("colon", "`:`");
          fields.push({ name: field.text, expression: parseExpression(), location: field.location });
          if (!match("comma")) break;
        }
        expect("rightBrace", "`}`");
        return {
          kind: "structExpression",
          typeName: `${token.text}.${foreignType.text}`,
          fields,
          location: token.location,
        };
      }
      const beginsStructLiteral = at("leftBrace")
        && (tokens[current + 1]?.kind === "rightBrace"
          || (tokens[current + 1]?.kind === "identifier" && tokens[current + 2]?.kind === "colon"));
      if (beginsStructLiteral) {
        take();
        const fields = [];
        while (!at("rightBrace")) {
          const field = expect("identifier", "a field name");
          expect("colon", "`:`");
          fields.push({
            name: field.text,
            expression: parseExpression(),
            location: field.location,
          });
          if (!match("comma")) break;
        }
        expect("rightBrace", "`}`");
        return {
          kind: "structExpression",
          typeName: token.text,
          fields,
          location: token.location,
        };
      }
      if (at("dot") && tokens[current + 1]?.kind === "identifier" && startsPrimary(tokens[current + 2]?.kind)) {
        take();
        const variant = take();
        return {
          kind: "variantExpression",
          enumName: token.text,
          variantName: variant.text,
          payload: parsePrimary(),
          location: token.location,
        };
      }
      return { kind: "identifier", name: token.text, location: token.location };
    }
    if (match("leftParen")) {
      const expression = parseExpression();
      expect("rightParen", "`)`");
      return expression;
    }
    throw new DiagnosticError(fileName, peek().location, `expected an expression, found ${tokenDescription(peek())}`);
  };

  const parsePostfix = (): Expression => {
    let expression = parsePrimary();
    while (true) {
      if (match("dot")) {
        const property = expect("identifier", "a member name");
        expression = { kind: "member", object: expression, property: property.text, location: property.location };
        continue;
      }
      if (match("leftParen")) {
        const callLocation = previous().location;
        const args: Expression[] = [];
        if (!at("rightParen")) {
          do args.push(parseExpression()); while (match("comma"));
        }
        expect("rightParen", "`)`");
        expression = { kind: "call", callee: expression, arguments: args, location: callLocation };
        continue;
      }
      return expression;
    }
  };

  const parseUnary = (): Expression => {
    if (match("bang")) {
      const token = previous();
      return { kind: "unary", operator: token.text, operand: parseUnary(), location: token.location };
    }
    return parsePostfix();
  };

  const parseBinary = (minimumPrecedence: number): Expression => {
    let left = parseUnary();
    while (precedence(peek().kind) >= minimumPrecedence) {
      const operator = take();
      const right = parseBinary(precedence(operator.kind) + 1);
      left = { kind: "binary", operator: operator.text, left, right, location: operator.location };
    }
    return left;
  };

  const parseExpression = (): Expression => parseBinary(0);

  const parseMatchArms = () => {
    expect("leftBrace", "`{`");
    const arms = [];
    while (!at("rightBrace") && !at("eof")) {
      const variantToken = expect("identifier", "a variant name");
      let binding: string | null = null;
      if (at("identifier")) binding = take().text;
      expect("fatArrow", "`=>`");
      arms.push({
        variantName: variantToken.text,
        binding,
        body: parseStatement(),
        location: variantToken.location,
      });
    }
    expect("rightBrace", "`}`");
    return arms;
  };

  parseStatement = (): Statement => {
    if (match("if")) {
      const ifToken = previous();
      expect("leftParen", "`(`");
      const condition = parseExpression();
      expect("rightParen", "`)`");
      const thenBranch = parseRequiredBlock("an `if` body");
      let elseBranch = null;
      if (match("else")) {
        elseBranch = at("if") ? parseStatement() : parseRequiredBlock("an `else` body");
        if (elseBranch.kind !== "if" && elseBranch.kind !== "block") {
          throw new DiagnosticError(fileName, elseBranch.location, "expected an `if` or block after `else`");
        }
      }
      return { kind: "if", condition, thenBranch, elseBranch, location: ifToken.location };
    }
    if (match("match")) {
      const matchToken = previous();
      const expression = parseExpression();
      return { kind: "match", expression, arms: parseMatchArms(), location: matchToken.location };
    }
    if (match("leftBrace")) {
      const blockToken = previous();
      const statements: Statement[] = [];
      while (!at("rightBrace") && !at("eof")) statements.push(parseStatement());
      expect("rightBrace", "`}`");
      return { kind: "block", statements, location: blockToken.location };
    }
    if (match("const") || match("let")) {
      const declarationToken = previous();
      const mutable = declarationToken.kind === "let";
      const name = expect("identifier", "a variable name").text;
      const type = match("colon") ? parseType() : null;
      expect("equal", "`=`");
      const initializer = parseExpression();
      expect("semicolon", "`;`");
      return { kind: "variable", mutable, name, type, initializer, location: declarationToken.location };
    }
    if (match("return")) {
      const returnToken = previous();
      const expression = at("semicolon") ? null : parseExpression();
      expect("semicolon", "`;`");
      return { kind: "return", expression, location: returnToken.location };
    }
    if (match("throw")) {
      const throwToken = previous();
      const expression = parseExpression();
      expect("semicolon", "`;`");
      return { kind: "throw", expression, location: throwToken.location };
    }
    if (match("yield")) {
      const yieldToken = previous();
      const expression = parseExpression();
      expect("semicolon", "`;`");
      return { kind: "yield", expression, location: yieldToken.location };
    }
    const expression = parseExpression();
    if (match("equal")) {
      if (expression.kind !== "identifier" && expression.kind !== "member") {
        throw new DiagnosticError(fileName, expression.location, "assignment target must be a mutable binding or one of its fields");
      }
      const value = parseExpression();
      expect("semicolon", "`;`");
      return { kind: "assignment", target: expression, expression: value, location: expression.location };
    }
    expect("semicolon", "`;`");
    return { kind: "expressionStatement", expression, location: expression.location };
  };

  function parseRequiredBlock(description: string) {
    const start = expect("leftBrace", description).location;
    const statements: Statement[] = [];
    while (!at("rightBrace") && !at("eof")) statements.push(parseStatement());
    expect("rightBrace", "`}`");
    return { kind: "block" as const, statements, location: start };
  }

  const parseFunction = (): FunctionDeclaration => {
    const start = expect("function", "`function`").location;
    const name = expect("identifier", "a function name").text;
    expect("leftParen", "`(`");
    let receiverMode: FunctionDeclaration["receiverMode"] = null;
    if (at("identifier") && peek().text === "this" && tokens[current + 1]?.kind === "colon" && tokens[current + 2]?.kind === "inout") {
      take();
      take();
      take();
      receiverMode = "inout";
      if (!at("rightParen")) expect("comma", "`,` after `this: inout`");
    }
    const parameters = parseParameters();
    expect("rightParen", "`)`");
    expect("colon", "`:`");
    const returnType = parseType();
    const errorType = match("throws") ? parseType() : null;
    expect("leftBrace", "`{`");
    const body: Statement[] = [];
    while (!at("rightBrace") && !at("eof")) body.push(parseStatement());
    expect("rightBrace", "`}`");
    return { kind: "function", name, receiverMode, parameters, returnType, errorType, body, location: start };
  };

  const parseStruct = (): StructDeclaration => {
    const start = expect("struct", "`struct`").location;
    const name = expect("identifier", "a struct name").text;
    expect("leftBrace", "`{`");
    const fields = [];
    const methods: FunctionDeclaration[] = [];
    let deinitializer = null;
    while (!at("rightBrace") && !at("eof")) {
      if (at("function")) {
        methods.push(parseFunction());
        continue;
      }
      if (match("deinit")) {
        const deinitToken = previous();
        if (deinitializer) {
          throw new DiagnosticError(fileName, deinitToken.location, `struct ${JSON.stringify(name)} cannot declare more than one deinit block`);
        }
        const block = parseRequiredBlock("a `deinit` body");
        deinitializer = { kind: "deinit" as const, body: block.statements, location: deinitToken.location };
        continue;
      }
      const field = expect("identifier", "a field or method declaration");
      expect("colon", "`:`");
      fields.push({ name: field.text, type: parseType(), location: field.location });
      expect("semicolon", "`;`");
    }
    expect("rightBrace", "`}`");
    return { kind: "struct", name, fields, methods, deinitializer, location: start };
  };

  const parseEnum = (): EnumDeclaration => {
    const start = expect("enum", "`enum`").location;
    const name = expect("identifier", "an enum name").text;
    expect("leftBrace", "`{`");
    const variants = [];
    while (!at("rightBrace") && !at("eof")) {
      const variant = expect("identifier", "a variant name");
      const payload = at("identifier") ? parseType() : null;
      variants.push({ name: variant.text, payload, location: variant.location });
      if (!match("comma")) break;
    }
    expect("rightBrace", "`}`");
    return { kind: "enum", name, variants, location: start };
  };

  const imports: ImportDeclaration[] = [];
  const structs: StructDeclaration[] = [];
  const enums: EnumDeclaration[] = [];
  const functions: FunctionDeclaration[] = [];
  while (!at("eof")) {
    if (at("import")) imports.push(parseImport());
    else if (at("struct")) structs.push(parseStruct());
    else if (at("enum")) enums.push(parseEnum());
    else if (at("function")) functions.push(parseFunction());
    else throw new DiagnosticError(fileName, peek().location, "expected an import, struct, enum, or function declaration");
  }
  return { kind: "program", imports, structs, enums, functions };
}

function startsPrimary(kind: TokenKind | undefined): boolean {
  return kind === "identifier" || kind === "number" || kind === "string" || kind === "true" || kind === "false";
}

function tokenDescription(token: Token): string {
  if (token.kind === "eof") return "end of file";
  return JSON.stringify(token.text);
}
