import type { SourceLocation } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { ApiNotes, PointerNote } from "./foreign-api-notes.ts";
import type { ForeignFunctionDeclaration } from "./foreign-ir.ts";
import { lex, type Token } from "./lexer.ts";

export type ContractParameter = {
  readonly name: string;
  readonly mode: "value" | "in" | "inout" | "out" | "move";
  readonly nullable: boolean;
  readonly location: SourceLocation;
  readonly typeLocation: SourceLocation;
};

export type ForeignFunctionContract = {
  readonly name: string;
  readonly parameters: readonly ContractParameter[];
  readonly returnNullable: boolean;
  readonly release: string | null;
  readonly location: SourceLocation;
  readonly nameLocation: SourceLocation;
  readonly returnLocation: SourceLocation;
  readonly releaseLocation: SourceLocation | null;
};

export type ForeignDeclarationContracts = {
  readonly moduleSpecifier: string;
  readonly functions: readonly ForeignFunctionContract[];
};

export function parseForeignDeclarationContracts(source: string, fileName: string): ForeignDeclarationContracts {
  const tokens = lex(source, fileName);
  let index = 0;
  const peek = (): Token => tokens[index];
  const take = (): Token => tokens[index++];
  const at = (text: string): boolean => peek().text === text;
  const fail = (token: Token, message: string): never => {
    throw new DiagnosticError(fileName, token.location, message, {
      code: "Z0801",
      length: Math.max(1, token.text.length),
    });
  };
  const expectText = (text: string): Token => {
    const token = peek();
    if (token.text !== text) fail(token, `expected ${JSON.stringify(text)} in Z declaration file, found ${JSON.stringify(token.text)}`);
    return take();
  };
  const expectIdentifier = (description: string): Token => {
    const token = peek();
    if (token.kind !== "identifier") fail(token, `expected ${description} in Z declaration file, found ${JSON.stringify(token.text)}`);
    return take();
  };
  const parseQualifiedName = (): { readonly name: string; readonly location: SourceLocation } => {
    const first = expectIdentifier("a native declaration name");
    let name = first.text;
    while (at(".")) {
      take();
      name += `.${expectIdentifier("a native declaration name after `.`").text}`;
    }
    return { name, location: first.location };
  };
  const parseInferredType = (): { readonly nullable: boolean; readonly location: SourceLocation } => {
    const placeholder = expectIdentifier("`_` as the header-derived type");
    if (placeholder.text !== "_") fail(placeholder, "the first Z declaration slice requires `_` for a header-derived type");
    if (!at("|")) return { nullable: false, location: placeholder.location };
    take();
    expectText("null");
    return { nullable: true, location: placeholder.location };
  };
  const parseParameter = (): ContractParameter => {
    let mode: ContractParameter["mode"] = "value";
    if (["in", "inout", "out", "move"].includes(peek().text)) mode = take().text as ContractParameter["mode"];
    const name = expectIdentifier("a native parameter name");
    expectText(":");
    const type = parseInferredType();
    return { name: name.text, mode, nullable: type.nullable, location: name.location, typeLocation: type.location };
  };

  expectText("declare");
  expectText("module");
  const moduleToken = peek();
  if (moduleToken.kind !== "string") fail(moduleToken, "expected a native module specifier in Z declaration file");
  const moduleSpecifier = take().text;
  expectText("{");
  const functions: ForeignFunctionContract[] = [];
  const names = new Set<string>();
  while (!at("}")) {
    expectText("export");
    const start = expectText("function");
    const parsedName = parseQualifiedName();
    const name = parsedName.name;
    if (names.has(name)) fail(start, `duplicate declaration contract for foreign function ${JSON.stringify(name)}`);
    names.add(name);
    expectText("(");
    const parameters: ContractParameter[] = [];
    if (!at(")")) {
      parameters.push(parseParameter());
      while (at(",")) {
        take();
        parameters.push(parseParameter());
      }
    }
    expectText(")");
    expectText(":");
    const returnType = parseInferredType();
    const returnNullable = returnType.nullable;
    let release: string | null = null;
    let releaseLocation: SourceLocation | null = null;
    if (at("{")) {
      take();
      while (!at("}")) {
        const contract = peek();
        if (!at("deinit")) {
          fail(contract, `expected "deinit" in foreign result contract, found ${JSON.stringify(contract.text)}`);
        }
        if (release) fail(contract, `foreign function ${JSON.stringify(name)} cannot declare more than one deinit contract`);
        take();
        const parsedRelease = parseQualifiedName();
        release = parsedRelease.name;
        releaseLocation = parsedRelease.location;
        expectText(";");
      }
      expectText("}");
    } else {
      expectText(";");
    }
    functions.push({
      name,
      parameters,
      returnNullable,
      release,
      location: start.location,
      nameLocation: parsedName.location,
      returnLocation: returnType.location,
      releaseLocation,
    });
  }
  expectText("}");
  if (peek().kind !== "eof") fail(peek(), `expected the end of the declaration file, found ${JSON.stringify(peek().text)}`);
  return { moduleSpecifier, functions };
}

export function foreignDeclarationApiNotes(
  contracts: ForeignDeclarationContracts,
  declarations: ReadonlyMap<string, ForeignFunctionDeclaration>,
  expectedModuleSpecifier: string,
  fileName: string,
): ApiNotes {
  if (contracts.moduleSpecifier !== expectedModuleSpecifier) {
    throw new DiagnosticError(
      fileName,
      { offset: 0, line: 1, column: 1, fileName },
      `Z declaration module ${JSON.stringify(contracts.moduleSpecifier)} does not match imported header ${JSON.stringify(expectedModuleSpecifier)}`,
      { code: "Z0801" },
    );
  }
  const functions: Record<string, { return?: PointerNote; parameters?: Record<string, PointerNote> }> = {};
  for (const contract of contracts.functions) {
    const declaration = declarations.get(contract.name);
    if (!declaration) {
      throw new DiagnosticError(fileName, contract.location, `declaration names unknown foreign function ${JSON.stringify(contract.name)}`, { code: "Z0801" });
    }
    const parameters: Record<string, PointerNote> = {};
    for (const overload of declaration.overloads) {
      if (overload.parameters.length !== contract.parameters.length) {
        throw new DiagnosticError(
          fileName,
          contract.location,
          `declaration for ${JSON.stringify(contract.name)} has ${contract.parameters.length} parameters but the native declaration has ${overload.parameters.length}`,
          { code: "Z0801" },
        );
      }
      for (let parameterIndex = 0; parameterIndex < contract.parameters.length; parameterIndex += 1) {
        const parameter = contract.parameters[parameterIndex];
        const native = overload.parameters[parameterIndex];
        if (native.name !== parameter.name) {
          throw new DiagnosticError(
            fileName,
            parameter.location,
            `declaration parameter ${JSON.stringify(parameter.name)} does not match native parameter ${JSON.stringify(native.name)} at position ${parameterIndex + 1}`,
            { code: "Z0801" },
          );
        }
      }
    }
    for (let parameterIndex = 0; parameterIndex < contract.parameters.length; parameterIndex += 1) {
      const parameter = contract.parameters[parameterIndex];
      parameters[String(parameterIndex)] = parameterNote(parameter);
    }
    functions[contract.name] = {
      return: {
        nullable: contract.returnNullable,
        ...(contract.release ? { ownership: "owned" as const, release: contract.release } : {}),
      },
      ...(Object.keys(parameters).length ? { parameters } : {}),
    };
  }
  return Object.keys(functions).length ? { functions } : {};
}

function parameterNote(parameter: ContractParameter): PointerNote {
  if (parameter.mode === "in") {
    return { ownership: "borrowed", access: "in", nullable: parameter.nullable };
  }
  if (parameter.mode === "move") {
    return { ownership: "consuming", nullable: parameter.nullable };
  }
  if (parameter.mode === "inout" || parameter.mode === "out") {
    return { access: parameter.mode, nullable: parameter.nullable };
  }
  return { nullable: parameter.nullable };
}
