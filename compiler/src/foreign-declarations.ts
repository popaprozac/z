import { dirname, resolve } from "node:path";
import type { SourceLocation } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { ApiNotes, PointerNote } from "./foreign-api-notes.ts";
import type { ForeignFunctionDeclaration } from "./foreign-ir.ts";
import { callbackParameterSpellings, normalizeCallbackContextType } from "./foreign-type-spelling.ts";
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
  readonly callbacks: readonly ForeignCallbackContract[];
};

export type ForeignCallbackContract = {
  readonly parameter: string;
  readonly context: string;
  readonly release: string | null;
  readonly thread: "caller" | null;
  readonly location: SourceLocation;
  readonly parameterLocation: SourceLocation;
  readonly contextLocation: SourceLocation;
  readonly releaseLocation: SourceLocation | null;
  readonly threadLocation: SourceLocation | null;
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
    const callbacks: ForeignCallbackContract[] = [];
    if (at("{")) {
      take();
      while (!at("}")) {
        const contract = peek();
        if (at("callback")) {
          take();
          const callback = expectIdentifier("a native callback parameter name");
          if (callbacks.some((entry) => entry.parameter === callback.text)) {
            fail(callback, `foreign function ${JSON.stringify(name)} cannot declare callback ${JSON.stringify(callback.text)} more than once`);
          }
          expectText("{");
          let context: Token | null = null;
          let callbackRelease: Token | null = null;
          let callbackThread: Token | null = null;
          while (!at("}")) {
            const callbackFact = peek();
            if (at("context")) {
              if (context) fail(callbackFact, `callback ${JSON.stringify(callback.text)} cannot declare more than one context parameter`);
              take();
              context = expectIdentifier("a native callback context parameter name");
              expectText(";");
              continue;
            }
            if (at("deinit")) {
              if (callbackRelease) fail(callbackFact, `callback ${JSON.stringify(callback.text)} cannot declare more than one deinit parameter`);
              take();
              callbackRelease = expectIdentifier("a native callback release parameter name");
              expectText(";");
              continue;
            }
            if (at("thread")) {
              if (callbackThread) fail(callbackFact, `callback ${JSON.stringify(callback.text)} cannot declare more than one thread guarantee`);
              take();
              callbackThread = expectIdentifier("a callback thread guarantee");
              if (callbackThread.text !== "caller") {
                fail(callbackThread, `the first escaping callback tier requires "caller" threading, found ${JSON.stringify(callbackThread.text)}`);
              }
              expectText(";");
              continue;
            }
            fail(
              callbackFact,
              `expected "context", "deinit", or "thread" in foreign callback contract, found ${JSON.stringify(callbackFact.text)}`,
            );
          }
          expectText("}");
          if (!context) {
            fail(callback, `callback ${JSON.stringify(callback.text)} requires a named native context parameter`);
          }
          callbacks.push({
            parameter: callback.text,
            context: context.text,
            release: callbackRelease?.text ?? null,
            thread: callbackThread ? "caller" : null,
            location: contract.location,
            parameterLocation: callback.location,
            contextLocation: context.location,
            releaseLocation: callbackRelease?.location ?? null,
            threadLocation: callbackThread?.location ?? null,
          });
          continue;
        }
        if (!at("deinit")) {
          fail(contract, `expected "deinit" or "callback" in foreign function contract, found ${JSON.stringify(contract.text)}`);
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
      callbacks,
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
  includeDirectory: string,
  fileName: string,
): ApiNotes {
  const declaredHeader = resolve(dirname(fileName), contracts.moduleSpecifier);
  const importedHeader = resolve(includeDirectory, expectedModuleSpecifier);
  if (declaredHeader !== importedHeader) {
    throw new DiagnosticError(
      fileName,
      { offset: 0, line: 1, column: 1, fileName },
      `Z declaration module ${JSON.stringify(contracts.moduleSpecifier)} does not match imported header ${JSON.stringify(expectedModuleSpecifier)}; resolved ${JSON.stringify(declaredHeader)} instead of ${JSON.stringify(importedHeader)}`,
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
    for (const callback of contract.callbacks) {
      const callbackIndex = contract.parameters.findIndex((parameter) => parameter.name === callback.parameter);
      if (callbackIndex < 0) {
        throw new DiagnosticError(
          fileName,
          callback.parameterLocation,
          `callback contract names unknown parameter ${JSON.stringify(callback.parameter)} on ${JSON.stringify(contract.name)}`,
          { code: "Z0801" },
        );
      }
      const contextIndex = contract.parameters.findIndex((parameter) => parameter.name === callback.context);
      if (contextIndex < 0) {
        throw new DiagnosticError(
          fileName,
          callback.contextLocation,
          `callback contract names unknown context parameter ${JSON.stringify(callback.context)} on ${JSON.stringify(contract.name)}`,
          { code: "Z0801" },
        );
      }
      if (callbackIndex === contextIndex) {
        throw new DiagnosticError(fileName, callback.location, "a callback cannot use itself as its native context parameter", { code: "Z0801" });
      }
      const parameter = contract.parameters[callbackIndex];
      if (parameter.mode !== "in" && parameter.mode !== "move") {
        throw new DiagnosticError(
          fileName,
          callback.parameterLocation,
          `callback ${JSON.stringify(callback.parameter)} must use \`in\` for call-scoped borrowing or \`move\` for escaping retention`,
          { code: "Z0801" },
        );
      }
      if (parameter.mode === "in" && (callback.release || callback.thread)) {
        throw new DiagnosticError(
          fileName,
          callback.location,
          `call-scoped callback ${JSON.stringify(callback.parameter)} cannot declare deinit or threading contracts`,
          { code: "Z0801" },
        );
      }
      if (parameter.mode === "move" && (!callback.release || callback.thread !== "caller")) {
        throw new DiagnosticError(
          fileName,
          callback.location,
          `escaping callback ${JSON.stringify(callback.parameter)} requires deinit and caller-thread contracts`,
          {
            code: "Z0214",
            helps: [`add \`deinit <release parameter>;\` and \`thread caller;\` to the callback contract`],
          },
        );
      }
      const callbackParameter = inferCallbackContextPosition(
        declaration,
        callbackIndex,
        callback,
        fileName,
      );
      const releaseIndex = callback.release
        ? contract.parameters.findIndex((candidate) => candidate.name === callback.release)
        : -1;
      if (callback.release && releaseIndex < 0) {
        throw new DiagnosticError(
          fileName,
          callback.releaseLocation!,
          `callback contract names unknown release parameter ${JSON.stringify(callback.release)} on ${JSON.stringify(contract.name)}`,
          { code: "Z0801" },
        );
      }
      if (releaseIndex === callbackIndex || releaseIndex === contextIndex) {
        throw new DiagnosticError(
          fileName,
          callback.releaseLocation!,
          "a callback release parameter must be distinct from its callback and context parameters",
          { code: "Z0801" },
        );
      }
      const releaseParameter = callback.release
        ? inferCallbackContextPosition(
          declaration,
          releaseIndex,
          {
            ...callback,
            parameter: callback.release,
            location: callback.releaseLocation!,
          },
          fileName,
        )
        : null;
      const note = parameters[String(callbackIndex)] ?? {};
      parameters[String(callbackIndex)] = {
        ...note,
        callback: {
          ...note.callback,
          lifetime: parameter.mode === "move" ? "escape" : "call",
          ...(callback.thread ? { thread: callback.thread } : {}),
          context: { parameter: contextIndex, callbackParameter },
          ...(callback.release && releaseParameter !== null
            ? { release: { parameter: releaseIndex, callbackParameter: releaseParameter } }
            : {}),
        },
      };
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

function inferCallbackContextPosition(
  declaration: ForeignFunctionDeclaration,
  callbackIndex: number,
  contract: ForeignCallbackContract,
  fileName: string,
): number {
  const positions = new Set<number>();
  for (const overload of declaration.overloads) {
    const type = overload.parameters[callbackIndex]?.type;
    const spellings = type
      ? callbackParameterSpellings(type.canonicalNativeName ?? type.nativeName)
      : null;
    const candidates = spellings
      ?.map((spelling, index) => normalizeCallbackContextType(spelling) === "void *" ? index : -1)
      .filter((index) => index >= 0) ?? [];
    if (candidates.length !== 1) {
      throw new DiagnosticError(
        fileName,
        contract.location,
        `callback ${JSON.stringify(contract.parameter)} on ${JSON.stringify(declaration.name)} must have exactly one native void * context parameter; found ${candidates.length}`,
        {
          code: "Z0801",
          helps: ["use a context-free callback contract or wait for explicit inner callback parameter selection"],
        },
      );
    }
    positions.add(candidates[0]);
  }
  if (positions.size !== 1) {
    throw new DiagnosticError(
      fileName,
      contract.location,
      `callback ${JSON.stringify(contract.parameter)} uses a different native context position across overloads`,
      { code: "Z0801" },
    );
  }
  return [...positions][0];
}

function parameterNote(parameter: ContractParameter): PointerNote {
  if (parameter.mode === "in") {
    return {
      ownership: "borrowed",
      access: "in",
      nullable: parameter.nullable,
      callback: { lifetime: "call" },
    };
  }
  if (parameter.mode === "move") {
    return { ownership: "consuming", nullable: parameter.nullable };
  }
  if (parameter.mode === "inout" || parameter.mode === "out") {
    return { access: parameter.mode, nullable: parameter.nullable };
  }
  return { nullable: parameter.nullable };
}
