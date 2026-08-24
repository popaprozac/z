import type {
  ClosureParameter,
  EnumDeclaration,
  Expression,
  FunctionDeclaration,
  ImportDeclaration,
  Parameter,
  Program,
  SourceLocation,
  Statement,
  StructDeclaration,
  TraitDeclaration,
  TypeAliasDeclaration,
  TypeReference,
} from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { dynamicArrayTypeName, fixedArrayTypeName, sliceTypeName } from "./array-types.ts";
import { genericTypeName } from "./generic-types.ts";
import { functionTypeName } from "./function-types.ts";
import { nullableObjCTypeName } from "./objc-types.ts";
import { readonlyTypeName } from "./readonly-types.ts";
import { viewTypeName } from "./view-types.ts";
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
    if (match("readonly")) {
      const location = previous().location;
      return { name: readonlyTypeName(parseType().name), location };
    }
    const asynchronous = match("async");
    if (asynchronous || match("leftParen")) {
      const location = previous().location;
      if (asynchronous) expect("leftParen", "`(` after `async` in a function type");
      const parameters = [];
      if (!at("rightParen")) {
        do {
          const mode = match("in") ? "in" : match("inout") ? "inout" : match("out") ? "out" : "value";
          const parameter = expect("identifier", "a function-type parameter name");
          expect("colon", "`:`");
          parameters.push({ name: parameter.text, mode, type: parseType().name });
        } while (match("comma"));
      }
      expect("rightParen", "`)`");
      expect("fatArrow", "`=>` in a function type");
      const returnType = parseType();
      const errorType = match("throws") ? parseType() : null;
      let thread: "local" | "main" | "any" = "local";
      if (match("on")) {
        const namespace = expect("identifier", "`thread` after `on` in a function type");
        expect("dot", "`.` after `thread`");
        const member = expect("identifier", "`main` or `any` after `thread.` in a function type");
        if (namespace.text !== "thread" || (member.text !== "main" && member.text !== "any")) {
          throw new DiagnosticError(
            fileName,
            namespace.location,
            "function types currently support only `on thread.main` and `on thread.any` callable contracts",
          );
        }
        thread = member.text;
      }
      return {
        name: functionTypeName(parameters, returnType.name, errorType?.name ?? null, thread, asynchronous),
        location,
      };
    }
    const token = expect("identifier", "a type name");
    let name = token.text;
    if (token.text === "view") {
      name = viewTypeName(parseType().name);
    } else if (token.text === "Slice" && match("less")) {
      name = sliceTypeName(parseType().name);
      expectTypeGreater();
    } else if (token.text === "Array" && match("less")) {
      name = dynamicArrayTypeName(parseType().name);
      expectTypeGreater();
    } else {
      while (match("dot")) {
        const member = expect("identifier", "an imported type name");
        name = `${name}.${member.text}`;
      }
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
    if (match("bitOr")) {
      expect("null", "`null` after `|` in an optional type");
      name = nullableObjCTypeName(name);
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

  const parseClosureParameters = (): ClosureParameter[] => {
    const parameters: ClosureParameter[] = [];
    if (at("rightParen")) return parameters;
    do {
      const mode = match("in") ? "in" : match("inout") ? "inout" : match("out") ? "out" : "value";
      const nameToken = expect("identifier", "a closure parameter name");
      const type = match("colon") ? parseType() : null;
      parameters.push({ name: nameToken.text, mode, type, location: nameToken.location });
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
      case "instanceof":
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

  const parseExecutorCapability = (): Expression => {
    const root = expect("identifier", "an executor capability");
    let expression: Expression = { kind: "identifier", name: root.text, location: root.location };
    while (match("dot")) {
      const property = expect("identifier", "an executor capability member");
      expression = {
        kind: "member",
        object: expression,
        property: property.text,
        location: property.location,
      };
    }
    return expression;
  };

  const parseExecutorPlacement = (
    mode: "await" | "spawn",
    location: SourceLocation,
    onLocation: SourceLocation,
  ): Expression => {
    const executor = parseExecutorCapability();
    const captures: Extract<Expression, { kind: "executorPlacement" }>["captures"][number][] = [];
    if (at("identifier") && peek().text === "using") {
      const using = take();
      expect("leftParen", "`(` after `using`");
      if (!at("rightParen")) {
        do {
          if (at("out")) {
            const out = take();
            throw new DiagnosticError(fileName, out.location, "`out` executor captures are not supported yet", {
              code: "Z0704",
              notes: ["failure and cancellation need a sound definite-initialization rule before child tasks may initialize caller storage"],
              helps: ["return an owned value from the placement and assign it after await"],
            });
          }
          const capability = at("in") || at("inout")
            ? take()
            : at("identifier") && peek().text === "move"
              ? take()
              : null;
          if (!capability) {
            throw new DiagnosticError(fileName, peek().location, "executor captures require `in`, `inout`, or `move`", {
              code: "Z0704",
              helps: ["write `using (in value, inout state, move owner)`"],
            });
          }
          const name = expect("identifier", "a captured binding name");
          captures.push({
            mode: capability.text as "in" | "inout" | "move",
            name: name.text,
            nameLocation: name.location,
            location: capability.location,
          });
        } while (match("comma"));
      }
      expect("rightParen", "`)` after executor captures");
      if (!at("colon") && !at("throws") && !at("leftBrace")) {
        throw new DiagnosticError(fileName, using.location, "`using` belongs to a multi-statement executor-placement block", {
          code: "Z0710",
          notes: ["a direct placed call already declares access through its ordinary parameter and argument capabilities"],
          helps: [`remove the \`using\` clause and write \`${mode === "spawn" ? "task" : "await"} on thread.main operation(...)\``],
        });
      }
    }
    if (captures.length === 0 && !at("colon") && !at("throws") && !at("leftBrace")) {
      const call = parsePostfix();
      if (call.kind !== "call") {
        throw new DiagnosticError(fileName, call.location, "executor placement requires a direct function or method call, or a block", {
          code: "Z0710",
          helps: [
            `write \`${mode === "spawn" ? "task" : "await"} on thread.main operation()\``,
            `or use \`${mode === "spawn" ? "task" : "await"} on thread.main { ... }\` for multiple statements`,
          ],
        });
      }
      const body = { kind: "block" as const, statements: [], location: call.location };
      return {
        kind: "executorPlacement",
        mode,
        executor,
        captures,
        returnType: null,
        errorType: null,
        body,
        call,
        location,
        onLocation,
      };
    }
    const returnType = match("colon") ? parseType() : null;
    const errorType = match("throws") ? parseType() : null;
    if (errorType && !returnType) {
      throw new DiagnosticError(fileName, errorType.location, "a throwing executor block requires an explicit success type");
    }
    const body = parseRequiredBlock("an executor-placement body");
    return { kind: "executorPlacement", mode, executor, captures, returnType, errorType, body, call: null, location, onLocation };
  };

  const parseExecutorAffinity = (): FunctionDeclaration["executorAffinity"] => {
    if (!match("on")) return undefined;
    const onLocation = previous().location;
    return { executor: parsePostfix(), onLocation };
  };

  const parseFunctionExecutionContract = (): Pick<FunctionDeclaration, "executorAffinity" | "threadContract"> => {
    if (!match("on")) return {};
    const onLocation = previous().location;
    const capability = parsePostfix();
    if (capability.kind === "member" && capability.property === "any") {
      return { threadContract: { thread: "any", capability, onLocation } };
    }
    return { executorAffinity: { executor: capability, onLocation } };
  };

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
          const trait = parseType();
          if (traits.some((item) => item.name === trait.name)) {
            throw new DiagnosticError(fileName, trait.location, `duplicate constraint ${JSON.stringify(trait.name)} for ${JSON.stringify(parameter.text)}`);
          }
          traits.push(trait);
        } while (match("bitAnd"));
        constraints.push({ parameter: parameter.text, traits, location: parameter.location });
      }
    } while (match("comma"));
    expectTypeGreater();
    return { names, constraints };
  };

  const parseRawLanguageAndBody = (): {
    language: "c" | "cpp" | "objc";
    body: NonNullable<FunctionDeclaration["rawBody"]>;
  } => {
    const language = expect("identifier", "`c`, `cpp`, or `objc` after `raw`");
    if (language.text !== "c" && language.text !== "cpp" && language.text !== "objc") {
      throw new DiagnosticError(fileName, language.location, "raw native language must be `c`, `cpp`, or `objc`");
    }
    expect("leftBrace", "`{` starting a raw native body");
    const body = expect("rawBody", "raw native source");
    expect("rightBrace", "`}` ending a raw native body");
    return {
      language: language.text,
      body: { language: language.text, source: body.text, location: body.location },
    };
  };

  const parseRawExpression = (): Expression => {
    const raw = expect("identifier", "`raw`");
    const language = expect("identifier", "`c`, `cpp`, or `objc` after `raw`");
    if (language.text !== "c" && language.text !== "cpp" && language.text !== "objc") {
      throw new DiagnosticError(fileName, language.location, "raw native language must be `c`, `cpp`, or `objc`");
    }
    const using = expect("identifier", "`using` after the raw native language");
    if (using.text !== "using") {
      throw new DiagnosticError(fileName, using.location, "a raw expression requires an explicit `using` boundary");
    }
    expect("leftParen", "`(` after `using`");
    const captures = [];
    if (!at("rightParen")) {
      do {
        const capability = at("in") || at("inout") || at("out") ? take() : null;
        if (!capability) {
          throw new DiagnosticError(fileName, peek().location, "raw operands require `in`, `inout`, or `out`");
        }
        const name = expect("identifier", "a captured binding name");
        captures.push({
          mode: capability.text as "in" | "inout" | "out",
          name: name.text,
          nameLocation: name.location,
          location: capability.location,
        });
      } while (match("comma"));
    }
    expect("rightParen", "`)` after raw captures");
    expect("colon", "`:` before a raw expression result type");
    const returnType = parseType();
    expect("leftBrace", "`{` starting a raw native body");
    const body = expect("rawBody", "raw native source");
    expect("rightBrace", "`}` ending a raw native body");
    return {
      kind: "raw",
      language: language.text,
      captures,
      returnType,
      body: { language: language.text, source: body.text, location: body.location },
      location: raw.location,
    };
  };

  const parsePrimary = (): Expression => {
    const closureCheckpoint = current;
    const closureAsync = match("async");
    const closureCaptureMode = at("identifier") && peek().text === "move"
      ? (take(), "move" as const)
      : null;
    if (closureAsync || closureCaptureMode || at("leftParen")) {
      let recognizedClosure = false;
      const closureLocation = closureAsync
        ? tokens[closureCheckpoint].location
        : closureCaptureMode ? previous().location : peek().location;
      try {
        expect("leftParen", "`(` starting closure parameters");
        const parameters = parseClosureParameters();
        expect("rightParen", "`)`");
        const returnType = match("colon") ? parseType() : null;
        const errorType = match("throws") ? parseType() : null;
        if (errorType && !returnType) {
          recognizedClosure = true;
          throw new DiagnosticError(fileName, errorType.location, "a throwing closure requires an explicit return type");
        }
        expect("fatArrow", "`=>`");
        recognizedClosure = true;
        const body = at("leftBrace")
          ? parseRequiredBlock("a closure body")
          : parseExpression();
        return {
          kind: "closure",
          async: closureAsync,
          captureMode: closureCaptureMode ?? "borrow",
          parameters,
          returnType,
          errorType,
          body,
          location: closureLocation,
        };
      } catch (error) {
        if (recognizedClosure) throw error;
        current = closureCheckpoint;
      }
    }
    if (match("new")) {
      const token = previous();
      const type = parseType();
      expect("leftParen", "`(` after a class name");
      const arguments_: Expression[] = [];
      const argumentLabels: (string | null)[] = [];
      if (!at("rightParen")) {
        do {
          const hasLabel = at("identifier") && tokens[current + 1]?.kind === "colon";
          argumentLabels.push(hasLabel ? take().text : null);
          if (hasLabel) take();
          arguments_.push(parseExpression());
        } while (match("comma"));
      }
      expect("rightParen", "`)` after a class initializer");
      return { kind: "new", typeName: type.name, arguments: arguments_, argumentLabels, location: token.location };
    }
    if (match("unsafe")) {
      const token = previous();
      const body = parseRequiredBlock("an `unsafe` expression body");
      return { kind: "unsafeExpression", body, location: token.location };
    }
    if (
      at("identifier")
      && peek().text === "raw"
      && tokens[current + 1]?.kind === "identifier"
      && ["c", "cpp", "objc"].includes(tokens[current + 1].text)
    ) {
      return parseRawExpression();
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
    if (match("leftBrace")) {
      const token = previous();
      const fields = [];
      let spread = null;
      const spreadMode = at("ellipsis")
        ? "value" as const
        : at("identifier")
            && (peek().text === "copy" || peek().text === "move")
            && tokens[current + 1]?.kind === "ellipsis"
          ? peek().text as "copy" | "move"
          : null;
      if (spreadMode) {
        const capability = spreadMode === "value" ? null : take();
        const ellipsis = expect("ellipsis", "`...` starting a struct spread");
        spread = {
          mode: spreadMode,
          expression: parseExpression(),
          location: capability?.location ?? ellipsis.location,
        };
        if (!at("rightBrace")) expect("comma", "`,` after a struct spread");
      }
      while (!at("rightBrace")) {
        if (
          at("ellipsis")
          || (
            at("identifier")
            && (peek().text === "copy" || peek().text === "move")
            && tokens[current + 1]?.kind === "ellipsis"
          )
        ) {
          throw new DiagnosticError(fileName, peek().location, "a struct spread must be the first entry and only one spread is allowed");
        }
        const field = expect("identifier", "an object field name");
        const expression = match("colon")
          ? parseExpression()
          : { kind: "identifier" as const, name: field.text, location: field.location };
        fields.push({ name: field.text, expression, location: field.location });
        if (!match("comma")) break;
      }
      expect("rightBrace", "`}`");
      return { kind: "objectExpression", fields, spread, location: token.location };
    }
    if (match("in") || match("out") || match("inout")) {
      const token = previous();
      const name = expect(
        "identifier",
        token.kind === "in" ? "a borrowed binding" : "a mutable binding",
      );
      return {
        kind: "argumentReference",
        access: token.kind as "in" | "out" | "inout",
        name: name.text,
        nameLocation: name.location,
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
    if (match("while")) {
      const token = previous();
      expect("leftParen", "`(` after `while`");
      const condition = parseExpression();
      expect("rightParen", "`)` after a `while` expression condition");
      const body = parseRequiredBlock("a `while` expression body");
      expect("else", "`else` in a value-producing `while`");
      const elseBranch = parseRequiredBlock("a `while` exhaustion body");
      return { kind: "whileExpression", condition, body, elseBranch, location: token.location };
    }
    if (match("for")) {
      const token = previous();
      expect("leftParen", "`(` after `for`");
      expect("const", "`const` in a read-only `for...of` binding");
      const objectBindings = match("leftBrace") ? parseObjectBindings() : null;
      const binding = objectBindings ? null : expect("identifier", "an iteration binding");
      expect("of", "`of`");
      const mode = match("inout") ? "inout" : "auto";
      const iterable = parseExpression();
      expect("rightParen", "`)` after a `for...of` expression header");
      const body = parseRequiredBlock("a `for...of` expression body");
      expect("else", "`else` in a value-producing `for...of`");
      const elseBranch = parseRequiredBlock("a `for...of` exhaustion body");
      return {
        kind: "forExpression",
        mode,
        binding: binding?.text ?? null,
        bindingLocation: binding?.location ?? null,
        objectBindings,
        iterable,
        body,
        elseBranch,
        location: token.location,
      };
    }
    if (match("match")) {
      const token = previous();
      expect("leftParen", "`(` after `match`");
      const mode = match("in") ? "in" : "auto";
      const expression = parseExpression();
      expect("rightParen", "`)` after the match subject");
      return { kind: "matchExpression", mode, expression, arms: parseMatchArms(), location: token.location };
    }
    if (match("await")) {
      const token = previous();
      if (match("on")) return parseExecutorPlacement("await", token.location, previous().location);
      return { kind: "await", expression: parsePostfix(), location: token.location };
    }
    if (
      at("identifier")
      && peek().text === "task"
      && (tokens[current + 1]?.kind === "on" || tokens[current + 1]?.kind === "identifier")
    ) {
      const token = take();
      if (match("on")) return parseExecutorPlacement("spawn", token.location, previous().location);
      return { kind: "spawn", expression: parsePostfix(), location: token.location };
    }
    if (match("attempt")) {
      const token = previous();
      return { kind: "attempt", expression: parsePostfix(), location: token.location };
    }
    if (match("try")) {
      const token = previous();
      return { kind: "try", expression: parsePostfix(), location: token.location };
    }
    if (match("weak")) {
      const token = previous();
      return { kind: "weak", expression: parsePostfix(), location: token.location };
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
          if (!at("leftParen") && !at("leftBrace") && !at("dot")) current = checkpoint;
          else identifierName = genericTypeName(token.text, arguments_);
        } catch {
          current = checkpoint;
        }
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
      const optional = at("question") && tokens[current + 1]?.kind === "dot";
      if (optional) take();
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
        expression = {
          kind: "member",
          object: expression,
          property: propertyName,
          optional,
          location: property.location,
        };
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
    if (
      at("identifier")
      && (peek().text === "copy" || peek().text === "move" || peek().text === "view")
      // Keep `copy(...)`, `move(...)`, and `view(...)` available as ordinary
      // calls/aliases and preserve the existing `move (...) =>` closure
      // spelling. Ownership operators use readable whitespace-separated forms.
      && tokens[current + 1]?.kind === "identifier"
    ) {
      const token = take();
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

  const parseObjectBindings = () => {
    const bindings = [];
    if (!at("rightBrace")) {
      do {
        const field = expect("identifier", "an object field name");
        const binding = match("colon")
          ? expect("identifier", "a pattern binding name")
          : field;
        bindings.push({
          fieldName: field.text,
          bindingName: binding.text,
          fieldLocation: field.location,
          bindingLocation: binding.location,
        });
      } while (match("comma") && !at("rightBrace"));
    }
    expect("rightBrace", "`}` ending an object pattern");
    return bindings;
  };

  const parseArrayBindings = () => {
    const bindings = [];
    if (at("rightBracket")) {
      throw new DiagnosticError(fileName, peek().location, "array destructuring requires at least one binding");
    }
    while (!at("rightBracket") && !at("eof")) {
      if (match("ellipsis")) {
        const rest = previous();
        const binding = expect("identifier", "a rest binding name");
        if (binding.text === "_") {
          throw new DiagnosticError(fileName, binding.location, "array rest requires a named binding");
        }
        bindings.push({
          kind: "rest" as const,
          bindingName: binding.text,
          location: rest.location,
          bindingLocation: binding.location,
        });
        if (!at("rightBracket")) {
          throw new DiagnosticError(fileName, peek().location, "array rest must be the final binding");
        }
        break;
      }
      const binding = expect("identifier", "an array binding name or `_`");
      bindings.push({
        kind: binding.text === "_" ? "discard" as const : "binding" as const,
        bindingName: binding.text === "_" ? null : binding.text,
        location: binding.location,
        bindingLocation: binding.text === "_" ? null : binding.location,
      });
      if (!match("comma")) break;
      if (at("rightBracket")) {
        throw new DiagnosticError(fileName, peek().location, "array destructuring does not use empty or trailing positions", {
          helps: ["use `_` to skip an element explicitly"],
        });
      }
    }
    expect("rightBracket", "`]` ending an array pattern");
    return bindings;
  };

  const parseMatchArms = () => {
    expect("leftBrace", "`{`");
    const arms = [];
    while (!at("rightBrace") && !at("eof")) {
      const variantToken = expect("identifier", "a variant name");
      let bindingToken: Token | null = null;
      let objectBindings = null;
      if (match("leftParen")) {
        if (match("leftBrace")) {
          objectBindings = parseObjectBindings();
        } else {
          bindingToken = expect("identifier", "a payload binding");
        }
        expect("rightParen", "`)` ending a variant pattern");
      }
      expect("fatArrow", "`=>`");
      arms.push({
        variantName: variantToken.text,
        binding: bindingToken?.text ?? null,
        bindingLocation: bindingToken?.location ?? null,
        objectBindings,
        body: parseStatement(),
        location: variantToken.location,
      });
    }
    expect("rightBrace", "`}`");
    return arms;
  };

  parseStatement = (): Statement => {
    if (match("unsafe")) {
      const token = previous();
      const body = parseRequiredBlock("an `unsafe` body");
      return { kind: "unsafe", body, location: token.location };
    }
    if (match("async")) {
      const token = previous();
      expect("scope", "`scope` after `async`");
      const nameToken = at("identifier") ? take() : null;
      const body = parseRequiredBlock("an `async scope` body");
      return {
        kind: "asyncScope",
        name: nameToken?.text ?? null,
        nameLocation: nameToken?.location ?? null,
        body,
        location: token.location,
      };
    }
    if (match("if")) {
      const ifToken = previous();
      expect("leftParen", "`(`");
      const condition = parseExpression();
      expect("rightParen", "`)`");
      const thenBranch = parseStatementBlock();
      let elseBranch = null;
      if (match("else")) {
        elseBranch = at("if") ? parseStatement() : parseStatementBlock();
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
    const tryForToken = at("try") && tokens[current + 1]?.kind === "for" ? take() : null;
    if (match("for")) {
      const forToken = previous();
      let asynchronous = false;
      if (tryForToken) {
        expect("await", "`await` after `try for`");
        asynchronous = true;
      } else {
        asynchronous = match("await");
      }
      expect("leftParen", "`(`");
      expect("const", "`const` in a read-only `for...of` binding");
      const objectBindings = match("leftBrace") ? parseObjectBindings() : null;
      const binding = objectBindings ? null : expect("identifier", "an iteration binding");
      expect("of", "`of`");
      const mode = match("inout") ? "inout" : "auto";
      const iterable = parseExpression();
      expect("rightParen", "`)`");
      const body = parseRequiredBlock("a `for...of` body");
      return {
        kind: "for",
        asynchronous,
        errorMode: tryForToken ? "try" : "none",
        mode,
        binding: binding?.text ?? null,
        bindingLocation: binding?.location ?? null,
        objectBindings,
        iterable,
        body,
        location: tryForToken?.location ?? forToken.location,
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
      expect("leftParen", "`(` after `match`");
      const mode = match("in") ? "in" : "auto";
      const expression = parseExpression();
      expect("rightParen", "`)` after the match subject");
      return { kind: "match", mode, expression, arms: parseMatchArms(), location: matchToken.location };
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
      if (match("leftBrace")) {
        const objectBindings = parseObjectBindings();
        const type = match("colon") ? parseType() : null;
        expect("equal", "`=` after an object binding pattern");
        const initializer = parseExpression();
        expect("semicolon", "`;`");
        return {
          kind: "destructure",
          mutable,
          objectBindings,
          arrayBindings: null,
          type,
          initializer,
          location: declarationToken.location,
        };
      }
      if (match("leftBracket")) {
        const arrayBindings = parseArrayBindings();
        const type = match("colon") ? parseType() : null;
        expect("equal", "`=` after an array binding pattern");
        const initializer = parseExpression();
        expect("semicolon", "`;`");
        return {
          kind: "destructure",
          mutable,
          objectBindings: [],
          arrayBindings,
          type,
          initializer,
          location: declarationToken.location,
        };
      }
      const nameToken = expect("identifier", "a variable name");
      const name = nameToken.text;
      const type = match("colon") ? parseType() : null;
      if (match("semicolon")) {
        if (!mutable) {
          throw new DiagnosticError(fileName, declarationToken.location, "const declarations require an initializer");
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
      const yieldToken = previous();
      const expression = parseExpression();
      expect("semicolon", "`;`");
      return { kind: "yield", expression, location: yieldToken.location };
    }
    const expression = parseExpression();
    if (match("equal")) {
      if (expression.kind !== "identifier" && expression.kind !== "member" && expression.kind !== "index") {
        throw new DiagnosticError(fileName, expression.location, "assignment target must be a mutable binding or one of its fields");
      }
      if (assignmentPathContainsOptionalChain(expression)) {
        throw new DiagnosticError(
          fileName,
          expression.location,
          "optional chaining is never an assignment target",
          {
            code: "Z0206",
            notes: ["an absent receiver cannot identify mutable storage"],
            helps: ["use an explicit `match` to unwrap the receiver before assigning"],
          },
        );
      }
      const value = parseExpression();
      expect("semicolon", "`;`");
      return { kind: "assignment", target: expression, expression: value, location: expression.location };
    }
    if (expression.kind === "executorPlacement") {
      match("semicolon");
      return { kind: "expressionStatement", expression, location: expression.location };
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

  function parseStatementBlock() {
    if (at("leftBrace")) return parseRequiredBlock("a statement block");
    const statement = parseStatement();
    return { kind: "block" as const, statements: [statement], location: statement.location };
  }

  const parseFunction = (signatureOnly = false, isAsync = false): FunctionDeclaration => {
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
    const executionContract = parseFunctionExecutionContract();
    const nativeSelector = match("as")
      ? expect("string", "an Objective-C selector string after `as`").text
      : null;
    const body: Statement[] = [];
    let rawBody: FunctionDeclaration["rawBody"] = null;
    if (signatureOnly) {
      expect("semicolon", "`;`");
    } else if (match("equal")) {
      const raw = expect("identifier", "`raw` after `=`");
      if (raw.text !== "raw") {
        throw new DiagnosticError(fileName, raw.location, "a native function body must use `= raw c`, `= raw cpp`, or `= raw objc`");
      }
      rawBody = parseRawLanguageAndBody().body;
    } else {
      expect("leftBrace", "`{`");
      while (!at("rightBrace") && !at("eof")) body.push(parseStatement());
      expect("rightBrace", "`}`");
    }
    return {
      kind: "function",
      name,
      async: isAsync,
      typeParameters: generic.names,
      typeParameterConstraints: generic.constraints,
      receiverMode,
      parameters,
      returnType,
      errorType,
      ...executionContract,
      nativeSelector,
      rawBody,
      body,
      location: start,
    };
  };

  const parseTest = (): FunctionDeclaration => {
    const start = take();
    const displayName = expect("string", "a test name string after `test`");
    if (displayName.text.length === 0) {
      throw new DiagnosticError(fileName, displayName.location, "a test name cannot be empty");
    }
    const block = parseRequiredBlock("a test body");
    return {
      kind: "function",
      name: `__z_test_${start.location.offset}`,
      testName: displayName.text,
      receiverMode: null,
      parameters: [],
      returnType: { name: "void", location: start.location },
      errorType: { name: "String", location: start.location },
      body: block.statements,
      location: start.location,
    };
  };

  const parseAggregate = (
    aggregateReadonly = false,
    nativeLayoutToken: Token | null = null,
  ): StructDeclaration => {
    const declarationToken = take();
    const kind = declarationToken.kind as "struct" | "class";
    const start = declarationToken.location;
    const name = expect("identifier", `a ${kind} name`).text;
    const generic = parseTypeParameters();
    const executorAffinity = parseExecutorAffinity();
    const implemented: TypeReference[] = [];
    if (match("implements")) {
      do implemented.push(parseType()); while (match("comma"));
    }
    expect("leftBrace", "`{`");
    const fields = [];
    const methods: FunctionDeclaration[] = [];
    let constructor = null;
    let deinitializer = null;
    while (!at("rightBrace") && !at("eof")) {
      if (match("constructor")) {
        const constructorToken = previous();
        if (constructor) {
          throw new DiagnosticError(fileName, constructorToken.location, `${kind} ${JSON.stringify(name)} cannot declare more than one constructor`);
        }
        expect("leftParen", "`(`");
        const parameters = parseParameters();
        expect("rightParen", "`)`");
        const errorType = match("throws") ? parseType() : null;
        const block = parseRequiredBlock("a `constructor` body");
        constructor = {
          kind: "constructor" as const,
          parameters,
          errorType,
          body: block.statements,
          location: constructorToken.location,
        };
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
      const visibilityToken = match("public") ? "public" : match("private") ? "private" : null;
      const visibility = visibilityToken ?? "public";
      const fieldReadonly = Boolean(match("readonly"));
      const isStatic = match("static");
      const isAsync = match("async");
      if (at("function")) {
        if (fieldReadonly) {
          throw new DiagnosticError(fileName, previous().location, "`readonly` applies to stored fields, not methods");
        }
        methods.push({ ...parseFunction(false, isAsync), static: isStatic, visibility });
        continue;
      }
      if (isAsync) {
        throw new DiagnosticError(fileName, previous().location, "`async` must precede a function declaration");
      }
      if (isStatic) {
        throw new DiagnosticError(fileName, previous().location, "static fields are not implemented; `static` currently applies only to functions");
      }
      const field = expect("identifier", "a field or method declaration");
      const optional = match("question");
      if (optional && kind !== "struct") {
        throw new DiagnosticError(
          fileName,
          field.location,
          "optional stored fields are currently supported only on value structs",
        );
      }
      expect("colon", "`:`");
      const declaredType = parseType();
      const fieldExecutorAffinity = parseExecutorAffinity();
      const type = optional
        ? { ...declaredType, name: genericTypeName("Option", [declaredType.name]) }
        : declaredType;
      if (optional && at("equal")) {
        throw new DiagnosticError(
          fileName,
          peek().location,
          `optional field ${JSON.stringify(field.text)} already defaults to Option.none`,
          {
            helps: [
              `remove the default, or declare ${field.text}: ${declaredType.name} = ... when a concrete default is intended`,
            ],
          },
        );
      }
      const defaultValue = match("equal") ? parseExpression() : null;
      fields.push({
        name: field.text,
        type,
        executorAffinity: fieldExecutorAffinity,
        optional,
        defaultValue,
        visibility,
        readonly: aggregateReadonly || fieldReadonly,
        location: field.location,
      });
      expect("semicolon", "`;`");
    }
    expect("rightBrace", "`}`");
    return {
      kind,
      name,
      nativeLayout: nativeLayoutToken
        ? {
            language: "c" as const,
            name,
            location: nativeLayoutToken.location,
          }
        : undefined,
      typeParameters: generic.names,
      typeParameterConstraints: generic.constraints,
      executorAffinity,
      implements: implemented,
      fields,
      constructor,
      methods,
      deinitializer,
      location: start,
    };
  };

  const parseTrait = (): TraitDeclaration => {
    const start = expect("trait", "`trait`").location;
    const name = expect("identifier", "a trait name").text;
    const generic = parseTypeParameters();
    expect("leftBrace", "`{`");
    const methods: FunctionDeclaration[] = [];
    while (!at("rightBrace") && !at("eof")) {
      const isAsync = match("async");
      methods.push(parseFunction(true, isAsync));
    }
    expect("rightBrace", "`}`");
    return {
      kind: "trait",
      name,
      typeParameters: generic.names,
      typeParameterConstraints: generic.constraints,
      methods,
      location: start,
    };
  };

  const parseTypeAlias = (): TypeAliasDeclaration => {
    const keyword = expect("identifier", "`type`");
    if (keyword.text !== "type") {
      throw new DiagnosticError(fileName, keyword.location, `expected \`type\`, found ${tokenDescription(keyword)}`);
    }
    const start = keyword.location;
    const name = expect("identifier", "a type alias name").text;
    expect("equal", "`=` after a type alias name");
    const target = parseType();
    expect("semicolon", "`;` after a type alias");
    return { kind: "type", name, target, location: start };
  };

  const parseEnum = (nativeLayoutToken: Token | null = null): EnumDeclaration => {
    const start = expect("enum", "`enum`").location;
    const name = expect("identifier", "an enum name").text;
    let underlyingType = null;
    if (nativeLayoutToken) {
      expect("colon", "`:` before a C enum representation type");
      underlyingType = parseType();
    }
    expect("leftBrace", "`{`");
    const variants = [];
    while (!at("rightBrace") && !at("eof")) {
      const variant = expect("identifier", "a variant name");
      const payload = at("identifier") ? parseType() : null;
      variants.push({ name: variant.text, payload, location: variant.location });
      if (!match("comma")) break;
    }
    expect("rightBrace", "`}`");
    return {
      kind: "enum",
      name,
      nativeLayout: nativeLayoutToken
        ? {
            language: "c" as const,
            name,
            location: nativeLayoutToken.location,
          }
        : undefined,
      underlyingType,
      variants,
      location: start,
    };
  };

  const imports: ImportDeclaration[] = [];
  const exports: Program["exports"] = [];
  const constants: Program["constants"] = [];
  const typeAliases: TypeAliasDeclaration[] = [];
  const traits: TraitDeclaration[] = [];
  const structs: StructDeclaration[] = [];
  const enums: EnumDeclaration[] = [];
  const functions: FunctionDeclaration[] = [];
  while (!at("eof")) {
    const exportToken = match("export") ? previous() : null;
    const nativeCToken = at("identifier") && peek().text === "c"
      ? take()
      : null;
    const readonlyToken = match("readonly") ? previous() : null;
    if (at("import")) {
      if (nativeCToken) throw new DiagnosticError(fileName, nativeCToken.location, "`c` can only modify a function, struct, or enum declaration");
      if (readonlyToken) throw new DiagnosticError(fileName, readonlyToken.location, "`readonly` can only modify a struct or class declaration");
      if (exportToken) throw new DiagnosticError(fileName, exportToken.location, "imports cannot be exported; export declarations from their defining module");
      imports.push(parseImport());
    } else if (at("const")) {
      if (nativeCToken) throw new DiagnosticError(fileName, nativeCToken.location, "`c` cannot modify a module constant");
      if (readonlyToken) throw new DiagnosticError(fileName, readonlyToken.location, "`readonly` cannot modify a module constant");
      const start = expect("const", "`const`").location;
      const name = expect("identifier", "a module constant name");
      const type = match("colon") ? parseType() : null;
      if (exportToken && !type) {
        throw new DiagnosticError(fileName, name.location, `exported module constant ${JSON.stringify(name.text)} requires an explicit type`, {
          code: "Z0604",
          helps: [`write \`export const ${name.text}: Type = ...;\``],
        });
      }
      expect("equal", "`=` after a module constant");
      const initializer = parseExpression();
      expect("semicolon", "`;` after a module constant");
      constants.push({
        kind: "constant",
        name: name.text,
        nameLocation: name.location,
        type,
        initializer,
        location: start,
      });
      if (exportToken) exports.push({ name: name.text, declarationKind: "const", location: exportToken.location });
    } else if (at("identifier") && peek().text === "type") {
      if (nativeCToken) throw new DiagnosticError(fileName, nativeCToken.location, "`c` can only modify a function, struct, or enum declaration");
      if (readonlyToken) throw new DiagnosticError(fileName, readonlyToken.location, "`readonly` can only modify a struct or class declaration");
      const declaration = parseTypeAlias();
      typeAliases.push(declaration);
      if (exportToken) exports.push({ name: declaration.name, declarationKind: "type", location: exportToken.location });
    } else if (at("trait")) {
      if (nativeCToken) throw new DiagnosticError(fileName, nativeCToken.location, "`c` can only modify a function, struct, or enum declaration");
      if (readonlyToken) throw new DiagnosticError(fileName, readonlyToken.location, "`readonly` can only modify a struct or class declaration");
      const declaration = parseTrait();
      traits.push(declaration);
      if (exportToken) exports.push({ name: declaration.name, declarationKind: "trait", location: exportToken.location });
    } else if (at("struct") || at("class")) {
      if (nativeCToken && at("class")) {
        throw new DiagnosticError(fileName, nativeCToken.location, "`c class` is not supported; use a C-layout struct or an opaque exported handle");
      }
      const declaration = parseAggregate(Boolean(readonlyToken), nativeCToken);
      structs.push(declaration);
      if (exportToken) exports.push({ name: declaration.name, declarationKind: declaration.kind, location: exportToken.location });
    } else if (at("enum")) {
      if (readonlyToken) throw new DiagnosticError(fileName, readonlyToken.location, "`readonly` can only modify a struct or class declaration");
      const declaration = parseEnum(nativeCToken);
      enums.push(declaration);
      if (exportToken) exports.push({ name: declaration.name, declarationKind: "enum", location: exportToken.location });
    } else if (
      at("async")
      && tokens[current + 1]?.kind === "identifier"
      && tokens[current + 1]?.text === "test"
    ) {
      throw new DiagnosticError(fileName, peek().location, "async tests are not implemented yet", {
        code: "Z0900",
        helps: ["use a synchronous test until the async test runner tier lands"],
      });
    } else if (at("identifier") && peek().text === "test") {
      if (exportToken) {
        throw new DiagnosticError(fileName, exportToken.location, "tests cannot be exported");
      }
      if (nativeCToken) {
        throw new DiagnosticError(fileName, nativeCToken.location, "`c` cannot modify a test declaration");
      }
      if (readonlyToken) {
        throw new DiagnosticError(fileName, readonlyToken.location, "`readonly` cannot modify a test declaration");
      }
      functions.push(parseTest());
    } else if (at("function") || at("async")) {
      if (readonlyToken) throw new DiagnosticError(fileName, readonlyToken.location, "`readonly` can only modify a struct or class declaration");
      if (nativeCToken && !exportToken) {
        throw new DiagnosticError(fileName, nativeCToken.location, "a C ABI function must use `export c function`");
      }
      const isAsync = match("async");
      const parsed = parseFunction(false, isAsync);
      const declaration = nativeCToken
        ? {
            ...parsed,
            nativeExport: {
              language: "c" as const,
              name: parsed.name,
              location: nativeCToken.location,
            },
          }
        : parsed;
      functions.push(declaration);
      if (exportToken) exports.push({ name: declaration.name, declarationKind: "function", location: exportToken.location });
    } else {
      if (nativeCToken) throw new DiagnosticError(fileName, nativeCToken.location, "`c` must be followed by a function, struct, or enum declaration");
      if (readonlyToken) throw new DiagnosticError(fileName, readonlyToken.location, "`readonly` can only modify a struct or class declaration");
      throw new DiagnosticError(fileName, peek().location, "expected an import, export, const, type, trait, struct, class, enum, function, or test declaration");
    }
  }
  return { kind: "program", imports, exports, constants, typeAliases, traits, structs, enums, functions };
}

function startsPrimary(kind: TokenKind | undefined): boolean {
  return kind === "identifier" || kind === "number" || kind === "string" || kind === "true" || kind === "false" || kind === "null";
}

function assignmentPathContainsOptionalChain(expression: Expression): boolean {
  if (expression.kind === "member") {
    return Boolean(expression.optional)
      || assignmentPathContainsOptionalChain(expression.object);
  }
  if (expression.kind === "index") {
    return assignmentPathContainsOptionalChain(expression.object);
  }
  if (expression.kind === "call") {
    return assignmentPathContainsOptionalChain(expression.callee);
  }
  return false;
}

function tokenDescription(token: Token): string {
  if (token.kind === "eof") return "end of file";
  return JSON.stringify(token.text);
}
