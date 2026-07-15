import type {
  Expression,
  FunctionDeclaration,
  ImportDeclaration,
  Parameter,
  Program,
  Statement,
  TypeReference,
} from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { Token, TokenKind } from "./lexer.ts";

export function parse(tokens: Token[], fileName: string): Program {
  let current = 0;

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
    return { name: token.text, location: token.location };
  };

  const parseImport = (): ImportDeclaration => {
    const start = expect("import", "`import`").location;
    const moduleName = expect("identifier", "an import name").text;
    expect("from", "`from`");
    const header = expect("string", "a header string").text;
    expect("semicolon", "`;`");
    return { kind: "import", moduleName, header, location: start };
  };

  const parseParameters = (): Parameter[] => {
    const parameters: Parameter[] = [];
    if (at("rightParen")) return parameters;
    do {
      const nameToken = expect("identifier", "a parameter name");
      expect("colon", "`:`");
      parameters.push({ name: nameToken.text, type: parseType(), location: nameToken.location });
    } while (match("comma"));
    return parameters;
  };

  const precedence = (kind: TokenKind): number => {
    switch (kind) {
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

  const parsePrimary = (): Expression => {
    if (match("number")) {
      const token = previous();
      return { kind: "number", value: token.text, location: token.location };
    }
    if (match("string")) {
      const token = previous();
      return { kind: "string", value: token.text, location: token.location };
    }
    if (match("identifier")) {
      const token = previous();
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

  const parseBinary = (minimumPrecedence: number): Expression => {
    let left = parsePostfix();
    while (precedence(peek().kind) >= minimumPrecedence) {
      const operator = take();
      const right = parseBinary(precedence(operator.kind) + 1);
      left = { kind: "binary", operator: operator.text, left, right, location: operator.location };
    }
    return left;
  };

  const parseExpression = (): Expression => parseBinary(0);

  const parseStatement = (): Statement => {
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
    const expression = parseExpression();
    expect("semicolon", "`;`");
    return { kind: "expressionStatement", expression, location: expression.location };
  };

  const parseFunction = (): FunctionDeclaration => {
    const start = expect("function", "`function`").location;
    const name = expect("identifier", "a function name").text;
    expect("leftParen", "`(`");
    const parameters = parseParameters();
    expect("rightParen", "`)`");
    expect("colon", "`:`");
    const returnType = parseType();
    expect("leftBrace", "`{`");
    const body: Statement[] = [];
    while (!at("rightBrace") && !at("eof")) body.push(parseStatement());
    expect("rightBrace", "`}`");
    return { kind: "function", name, parameters, returnType, body, location: start };
  };

  const imports: ImportDeclaration[] = [];
  const functions: FunctionDeclaration[] = [];
  while (!at("eof")) {
    if (at("import")) imports.push(parseImport());
    else if (at("function")) functions.push(parseFunction());
    else throw new DiagnosticError(fileName, peek().location, "expected an import or function declaration");
  }
  return { kind: "program", imports, functions };
}

function tokenDescription(token: Token): string {
  if (token.kind === "eof") return "end of file";
  return JSON.stringify(token.text);
}
