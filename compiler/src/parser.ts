import type {
  Expression,
  EnumDeclaration,
  FunctionDeclaration,
  ImportDeclaration,
  Parameter,
  Program,
  Statement,
  StructDeclaration,
  TraitDeclaration,
  TypeReference,
} from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { dynamicArrayTypeName, fixedArrayTypeName, sliceTypeName } from "./array-types.ts";
import { genericTypeName } from "./generic-types.ts";
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
  const expectTypeGreater = (): Token => {
    if (at("greater")) return take();
    if (at("shiftRight")) {
      const combined = take();
      tokens.splice(current, 0, {
        kind: "greater",
        text: ">",
        location: {
          offset: combined.location.offset + 1,
          line: combined.location.line,
          column: combined.location.column + 1,
        },
      });
      return { ...combined, kind: "greater", text: ">" };
    }
    return expect("greater", "`>`");
  };

  const parseType = (): TypeReference => {
    const token = expect("identifier", "a type name");
    let name = token.text;
    if (token.text === "Slice" && match("less")) {
      name = sliceTypeName(parseType().name);
      expectTypeGreater();
    } else if (token.text === "Array" && match("less")) {
      name = dynamicArrayTypeName(parseType().name);
      expectTypeGreater();
    } else if (match("dot")) {
      const member = expect("identifier", "an imported type name");
      name = `${name}.${member.text}`;
    }
    if (at("less")) {
      take();
      const arguments_ = [];
      do arguments_.push(parseType().name); while (match("comma"));
      expectTypeGreater();
      name = genericTypeName(name, arguments_);
    }
    while (match("leftBracket")) {
      const length = expect("number", "a fixed array length");
      if (!/^[0-9]+$/.test(length.text) || Number(length.text) < 1) {
        throw new DiagnosticError(fileName, length.location, "a fixed array length must be a positive integer");
      }
      expect("rightBracket", "`]`");
      name = fixedArrayTypeName(name, Number(length.text));
    }
    return { name, location: token.location };
  };

  const parseImport = (): ImportDeclaration => {
    const start = expect("import", "`import`").location;
    let moduleName: string;
    let bindings: ImportDeclaration["bindings"] = null;
    if (match("leftBrace")) {
      moduleName = `__z_selective_import_${importCounter++}`;
      bindings = [];
      if (at("rightBrace")) {
        throw new DiagnosticError(fileName, peek().location, "a selective import requires at least one imported name");
      }
      do {
        const imported = expect("identifier", "an imported name");
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
    const header = expect("string", "a module path").text;
    expect("semicolon", "`;`");
    return { kind: "import", moduleName, bindings, header, location: start };
  };

  const parseParameters = (): Parameter[] => {
    const parameters: Parameter[] = [];
    if (at("rightParen")) return parameters;
    do {
      const mode = match("in") ? "in" : match("inout") ? "inout" : match("out") ? "out" : "value";
      const nameToken = expect("identifier", "a parameter name");
      expect("colon", "`:`");
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
      case "bitOr":
        return 3;
      case "bitXor":
        return 4;
      case "bitAnd":
        return 5;
      case "equalEqual":
      case "bangEqual":
        return 6;
      case "less":
      case "lessEqual":
      case "greater":
      case "greaterEqual":
        return 7;
      case "shiftLeft":
      case "shiftRight":
        return 8;
      case "plus":
      case "minus":
        return 10;
      case "star":
      case "slash":
      case "percent":
        return 20;
      default:
        return -1;
    }
  };

  let parseStatement: () => Statement;

  const parseTypeParameters = (): { names: string[]; constraints: NonNullable<FunctionDeclaration["typeParameterConstraints"]> } => {
    if (!match("less")) return { names: [], constraints: [] };
    const names = [];
    const constraints: NonNullable<FunctionDeclaration["typeParameterConstraints"]> = [];
    do {
      const parameter = expect("identifier", "a type parameter name");
      if (names.includes(parameter.text)) throw new DiagnosticError(fileName, parameter.location, `duplicate type parameter ${JSON.stringify(parameter.text)}`);
      names.push(parameter.text);
      if (match("colon")) {
        const traits = [];
        do {
          const trait = expect("identifier", "a trait constraint");
          if (traits.some((item) => item.name === trait.text)) {
            throw new DiagnosticError(fileName, trait.location, `duplicate constraint ${JSON.stringify(trait.text)} for ${JSON.stringify(parameter.text)}`);
          }
          traits.push({ name: trait.text, location: trait.location });
        } while (match("bitAnd"));
        constraints.push({ parameter: parameter.text, traits, location: parameter.location });
      }
    } while (match("comma"));
    expectTypeGreater();
    return { names, constraints };
  };

  const parsePrimary = (): Expression => {
    const closureCheckpoint = current;
    const closureCaptureMode = at("identifier") && peek().text === "move"
      ? (take(), "move" as const)
      : null;
    if (closureCaptureMode || at("leftParen")) {
      let recognizedClosure = false;
      const closureLocation = closureCaptureMode ? previous().location : peek().location;
      try {
        expect("leftParen", "`(` starting closure parameters");
        const parameters = parseParameters();
        expect("rightParen", "`)`");
        const returnType = match("colon") ? parseType() : null;
        expect("fatArrow", "`=>`");
        recognizedClosure = true;
        const body = at("leftBrace")
          ? parseRequiredBlock("a closure body")
          : parseExpression();
        return {
          kind: "closure",
          captureMode: closureCaptureMode ?? "borrow",
          parameters,
          returnType,
          body,
          location: closureLocation,
        };
      } catch (error) {
        if (recognizedClosure) throw error;
        current = closureCheckpoint;
      }
    }
    if (match("templateStart")) {
      const token = previous();
      const parts = [];
      while (!at("templateEnd") && !at("eof")) {
        if (match("templateText")) {
          parts.push({ kind: "text" as const, value: previous().text, location: previous().location });
          continue;
        }
        const start = expect("templateExpressionStart", "`${` starting an interpolated expression");
        const expression = parseExpression();
        expect("templateExpressionEnd", "`}` ending an interpolated expression");
        parts.push({ kind: "value" as const, expression, location: start.location });
      }
      expect("templateEnd", "a closing backtick");
      return { kind: "template", parts, location: token.location };
    }
    if (match("leftBracket")) {
      const token = previous();
      const elements: Expression[] = [];
      if (!at("rightBracket")) {
        do elements.push(parseExpression()); while (match("comma") && !at("rightBracket"));
      }
      expect("rightBracket", "`]`");
      return { kind: "arrayExpression", elements, location: token.location };
    }
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
    if (match("if")) {
      const token = previous();
      expect("leftParen", "`(`");
      const condition = parseExpression();
      expect("rightParen", "`)`");
      const thenBranch = parseRequiredBlock("an `if` expression body");
      expect("else", "`else` in a value-producing `if`");
      const elseBranch = at("if")
        ? parsePrimary()
        : parseRequiredBlock("an `else` expression body");
      if (elseBranch.kind !== "ifExpression" && elseBranch.kind !== "block") {
        throw new DiagnosticError(fileName, elseBranch.location, "expected an `if` expression or block after `else`");
      }
      return { kind: "ifExpression", condition, thenBranch, elseBranch, location: token.location };
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
    if (match("null")) {
      return { kind: "null", location: previous().location };
    }
    if (match("identifier")) {
      const token = previous();
      let identifierName = token.text;
      if (at("less")) {
        const checkpoint = current;
        try {
          take();
          const arguments_ = [];
          do arguments_.push(parseType().name); while (match("comma"));
          expectTypeGreater();
          if (!at("leftParen") && !at("leftBrace")) current = checkpoint;
          else identifierName = genericTypeName(token.text, arguments_);
        } catch {
          current = checkpoint;
        }
      }
      if (at("dot") && tokens[current + 1]?.kind === "identifier") {
        const checkpoint = current;
        try {
          take();
          const qualifiedType = take();
          let qualifiedTypeName = `${token.text}.${qualifiedType.text}`;
          if (match("less")) {
            const arguments_ = [];
            do arguments_.push(parseType().name); while (match("comma"));
            expectTypeGreater();
            qualifiedTypeName = genericTypeName(qualifiedTypeName, arguments_);
          }
          const beginsQualifiedStructLiteral = at("leftBrace")
            && (tokens[current + 1]?.kind === "rightBrace"
              || (tokens[current + 1]?.kind === "identifier" && tokens[current + 2]?.kind === "colon"));
          if (!beginsQualifiedStructLiteral) {
            current = checkpoint;
          } else {
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
              typeName: qualifiedTypeName,
              fields,
              location: token.location,
            };
          }
        } catch {
          current = checkpoint;
        }
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
          typeName: identifierName,
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
      return { kind: "identifier", name: identifierName, location: token.location };
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
        const property = peek();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(property.text)) {
          throw new DiagnosticError(fileName, property.location, `expected a member name, found ${tokenDescription(property)}`);
        }
        take();
        let propertyName = property.text;
        if (at("less")) {
          const checkpoint = current;
          try {
            take();
            const arguments_ = [];
            do arguments_.push(parseType().name); while (match("comma"));
            expectTypeGreater();
            if (!at("leftParen")) current = checkpoint;
            else propertyName = genericTypeName(property.text, arguments_);
          } catch {
            current = checkpoint;
          }
        }
        expression = { kind: "member", object: expression, property: propertyName, location: property.location };
        continue;
      }
      if (match("leftParen")) {
        const callLocation = previous().location;
        const args: Expression[] = [];
        const argumentLabels: (string | null)[] = [];
        if (!at("rightParen")) {
          do {
            const hasLabel = at("identifier") && tokens[current + 1]?.kind === "colon";
            argumentLabels.push(hasLabel ? take().text : null);
            if (hasLabel) take();
            args.push(parseExpression());
          } while (match("comma"));
        }
        expect("rightParen", "`)`");
        expression = { kind: "call", callee: expression, arguments: args, argumentLabels, location: callLocation };
        continue;
      }
      if (match("leftBracket")) {
        const location = previous().location;
        const index = parseExpression();
        expect("rightBracket", "`]`");
        expression = { kind: "index", object: expression, index, location };
        continue;
      }
      return expression;
    }
  };

  const parseUnary = (): Expression => {
    if (match("bang") || match("plus") || match("minus") || match("tilde")) {
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

  const parseExpression = (): Expression => {
    const condition = parseBinary(0);
    if (!match("question")) return condition;
    const thenExpression = parseExpression();
    expect("colon", "`:` in a conditional expression");
    const elseExpression = parseExpression();
    return {
      kind: "conditional",
      condition,
      thenExpression,
      elseExpression,
      location: condition.location,
    };
  };

  const parseMatchArms = () => {
    expect("leftBrace", "`{`");
    const arms = [];
    while (!at("rightBrace") && !at("eof")) {
      const variantToken = expect("identifier", "a variant name");
      const bindingToken = at("identifier") ? take() : null;
      expect("fatArrow", "`=>`");
      arms.push({
        variantName: variantToken.text,
        binding: bindingToken?.text ?? null,
        bindingLocation: bindingToken?.location ?? null,
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
    if (match("while")) {
      const whileToken = previous();
      expect("leftParen", "`(`");
      const condition = parseExpression();
      expect("rightParen", "`)`");
      const body = parseRequiredBlock("a `while` body");
      return { kind: "while", condition, body, location: whileToken.location };
    }
    if (match("for")) {
      const forToken = previous();
      expect("leftParen", "`(`");
      expect("const", "`const` in a read-only `for...of` binding");
      const binding = expect("identifier", "an iteration binding");
      expect("of", "`of`");
      const iterable = parseExpression();
      expect("rightParen", "`)`");
      const body = parseRequiredBlock("a `for...of` body");
      return {
        kind: "for",
        binding: binding.text,
        bindingLocation: binding.location,
        iterable,
        body,
        location: forToken.location,
      };
    }
    if (match("break")) {
      const breakToken = previous();
      expect("semicolon", "`;`");
      return { kind: "break", location: breakToken.location };
    }
    if (match("continue")) {
      const continueToken = previous();
      expect("semicolon", "`;`");
      return { kind: "continue", location: continueToken.location };
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
      const nameToken = expect("identifier", "a variable name");
      const name = nameToken.text;
      const type = match("colon") ? parseType() : null;
      if (match("semicolon")) {
        if (!mutable) {
          throw new DiagnosticError(fileName, declarationToken.location, "const declarations require an initializer");
        }
        if (!type) {
          throw new DiagnosticError(fileName, declarationToken.location, "an uninitialized let declaration requires a type annotation");
        }
        return { kind: "variable", mutable, name, nameLocation: nameToken.location, type, initializer: null, location: declarationToken.location };
      }
      expect("equal", "`=`");
      const initializer = parseExpression();
      expect("semicolon", "`;`");
      return { kind: "variable", mutable, name, nameLocation: nameToken.location, type, initializer, location: declarationToken.location };
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
    if (match("select")) {
      const selectToken = previous();
      const expression = parseExpression();
      expect("semicolon", "`;`");
      return { kind: "select", expression, location: selectToken.location };
    }
    if (match("yield")) {
      throw new DiagnosticError(fileName, previous().location, "yield is reserved for generators, which are not implemented yet");
    }
    const expression = parseExpression();
    if (match("equal")) {
      if (expression.kind !== "identifier" && expression.kind !== "member" && expression.kind !== "index") {
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

  const parseFunction = (signatureOnly = false): FunctionDeclaration => {
    const start = expect("function", "`function`").location;
    const name = expect("identifier", "a function name").text;
    const generic = parseTypeParameters();
    expect("leftParen", "`(`");
    let receiverMode: FunctionDeclaration["receiverMode"] = null;
    if (
      (at("inout") || (at("identifier") && peek().text === "move"))
      && tokens[current + 1]?.kind === "identifier"
      && tokens[current + 1]?.text === "this"
    ) {
      const capability = take();
      take();
      receiverMode = capability.text as "inout" | "move";
      if (!at("rightParen")) expect("comma", `\`,\` after \`${capability.text} this\``);
    }
    const parameters = parseParameters();
    expect("rightParen", "`)`");
    expect("colon", "`:`");
    const returnType = parseType();
    const errorType = match("throws") ? parseType() : null;
    const body: Statement[] = [];
    if (signatureOnly) {
      expect("semicolon", "`;`");
    } else {
      expect("leftBrace", "`{`");
      while (!at("rightBrace") && !at("eof")) body.push(parseStatement());
      expect("rightBrace", "`}`");
    }
    return {
      kind: "function",
      name,
      typeParameters: generic.names,
      typeParameterConstraints: generic.constraints,
      receiverMode,
      parameters,
      returnType,
      errorType,
      body,
      location: start,
    };
  };

  const parseAggregate = (): StructDeclaration => {
    const declarationToken = take();
    const kind = declarationToken.kind as "struct" | "class";
    const start = declarationToken.location;
    const name = expect("identifier", `a ${kind} name`).text;
    const generic = parseTypeParameters();
    const implemented: TypeReference[] = [];
    if (match("implements")) {
      do implemented.push(parseType()); while (match("comma"));
    }
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
          throw new DiagnosticError(fileName, deinitToken.location, `${kind} ${JSON.stringify(name)} cannot declare more than one deinit block`);
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
    return {
      kind,
      name,
      typeParameters: generic.names,
      typeParameterConstraints: generic.constraints,
      implements: implemented,
      fields,
      methods,
      deinitializer,
      location: start,
    };
  };

  const parseTrait = (): TraitDeclaration => {
    const start = expect("trait", "`trait`").location;
    const name = expect("identifier", "a trait name").text;
    expect("leftBrace", "`{`");
    const methods: FunctionDeclaration[] = [];
    while (!at("rightBrace") && !at("eof")) methods.push(parseFunction(true));
    expect("rightBrace", "`}`");
    return { kind: "trait", name, methods, location: start };
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
  const exports: Program["exports"] = [];
  const traits: TraitDeclaration[] = [];
  const structs: StructDeclaration[] = [];
  const enums: EnumDeclaration[] = [];
  const functions: FunctionDeclaration[] = [];
  while (!at("eof")) {
    const exportToken = match("export") ? previous() : null;
    if (at("import")) {
      if (exportToken) throw new DiagnosticError(fileName, exportToken.location, "imports cannot be exported; export declarations from their defining module");
      imports.push(parseImport());
    } else if (at("trait")) {
      const declaration = parseTrait();
      traits.push(declaration);
      if (exportToken) exports.push({ name: declaration.name, declarationKind: "trait", location: exportToken.location });
    } else if (at("struct") || at("class")) {
      const declaration = parseAggregate();
      structs.push(declaration);
      if (exportToken) exports.push({ name: declaration.name, declarationKind: declaration.kind, location: exportToken.location });
    } else if (at("enum")) {
      const declaration = parseEnum();
      enums.push(declaration);
      if (exportToken) exports.push({ name: declaration.name, declarationKind: "enum", location: exportToken.location });
    } else if (at("function")) {
      const declaration = parseFunction();
      functions.push(declaration);
      if (exportToken) exports.push({ name: declaration.name, declarationKind: "function", location: exportToken.location });
    } else {
      throw new DiagnosticError(fileName, peek().location, "expected an import, export, trait, struct, class, enum, or function declaration");
    }
  }
  return { kind: "program", imports, exports, traits, structs, enums, functions };
}

function startsPrimary(kind: TokenKind | undefined): boolean {
  return kind === "identifier" || kind === "number" || kind === "string" || kind === "true" || kind === "false" || kind === "null";
}

function tokenDescription(token: Token): string {
  if (token.kind === "eof") return "end of file";
  return JSON.stringify(token.text);
}
