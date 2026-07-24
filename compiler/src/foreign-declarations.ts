import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SourceLocation } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { ApiNotes, PointerNote, StatusNote } from "./foreign-api-notes.ts";
import type { ForeignFunctionDeclaration } from "./foreign-ir.ts";
import type { ForeignThreadContract } from "./foreign-ir.ts";
import { callbackParameterSpellings, normalizeCallbackContextType } from "./foreign-type-spelling.ts";
import { lex, type Token } from "./lexer.ts";

export type ContractParameter = {
  readonly name: string;
  readonly mode: "value" | "in" | "inout" | "out" | "move";
  readonly nullable: boolean;
  readonly nullOnly: boolean;
  readonly location: SourceLocation;
  readonly typeLocation: SourceLocation;
  readonly release: string | null;
  readonly releaseLocation: SourceLocation | null;
  readonly fixed: string | null;
  readonly fixedLocation: SourceLocation | null;
  readonly fixedValueLocation: SourceLocation | null;
};

export type ForeignFunctionContract = {
  readonly name: string;
  readonly parameters: readonly ContractParameter[];
  readonly returnNullable: boolean;
  readonly returnSemanticType: "inferred" | "view-cstring" | "status-void";
  readonly statusSuccessValues: readonly number[];
  readonly statusSuccessLocations: readonly SourceLocation[];
  readonly throwsLocation: SourceLocation | null;
  readonly release: string | null;
  readonly location: SourceLocation;
  readonly nameLocation: SourceLocation;
  readonly returnLocation: SourceLocation;
  readonly releaseLocation: SourceLocation | null;
  readonly thread: ForeignThreadContract;
  readonly threadLocations: ForeignThreadContractLocations;
  readonly callbacks: readonly ForeignCallbackContract[];
};

export type ForeignThreadContractLocations = {
  readonly location: SourceLocation | null;
  readonly transfer: SourceLocation | null;
  readonly share: SourceLocation | null;
  readonly deinit: SourceLocation | null;
};

export type ForeignCallbackContract = {
  readonly parameter: string;
  readonly context: string;
  readonly release: string | null;
  readonly thread: "caller" | "any" | null;
  readonly location: SourceLocation;
  readonly parameterLocation: SourceLocation;
  readonly contextLocation: SourceLocation;
  readonly releaseLocation: SourceLocation | null;
  readonly threadLocation: SourceLocation | null;
};

export type ForeignDeclarationContracts = {
  readonly moduleSpecifier: string;
  readonly functions: readonly ForeignFunctionContract[];
  readonly types: readonly ForeignValueContract[];
};

export type ForeignValueContract = {
  readonly name: string;
  readonly copy: boolean;
  readonly move: boolean;
  readonly deinit: boolean;
  readonly location: SourceLocation;
  readonly nameLocation: SourceLocation;
  readonly copyLocation: SourceLocation | null;
  readonly moveLocation: SourceLocation | null;
  readonly deinitLocation: SourceLocation | null;
  readonly thread: ForeignThreadContract;
  readonly threadLocations: ForeignThreadContractLocations;
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
  const parseReturnType = (): {
    readonly nullable: boolean;
    readonly location: SourceLocation;
    readonly semanticType: "inferred" | "view-cstring" | "status-void";
    readonly throwsLocation: SourceLocation | null;
  } => {
    if (at("void")) {
      const result = take();
      const throws = expectText("throws");
      const error = parseInferredType();
      if (error.nullable) fail(throws, "a native status error type cannot be nullable");
      return {
        nullable: false,
        location: result.location,
        semanticType: "status-void",
        throwsLocation: throws.location,
      };
    }
    if (!at("view")) return {
      ...parseInferredType(),
      semanticType: "inferred",
      throwsLocation: null,
    };
    const view = take();
    const target = expectIdentifier("`cstring` after `view`");
    if (target.text !== "cstring") fail(target, "foreign borrowed text results currently require `view cstring`");
    let nullable = false;
    if (at("|")) {
      take();
      expectText("null");
      nullable = true;
    }
    return {
      nullable,
      location: view.location,
      semanticType: "view-cstring",
      throwsLocation: null,
    };
  };
  const parseStatusValue = (): { readonly value: number; readonly location: SourceLocation } => {
    let sign = 1;
    if (at("-")) {
      take();
      sign = -1;
    } else if (at("+")) {
      take();
    }
    const literal = peek();
    if (literal.kind !== "number" || !/^[0-9]+$/.test(literal.text)) {
      fail(literal, "native status success values currently require an integer literal");
    }
    take();
    const value = sign * Number(literal.text);
    if (!Number.isSafeInteger(value)) fail(literal, "native status success value must be a safe integer");
    return { value, location: literal.location };
  };
  const parseParameter = (): ContractParameter => {
    let mode: ContractParameter["mode"] = "value";
    if (["in", "inout", "out", "move"].includes(peek().text)) mode = take().text as ContractParameter["mode"];
    const name = expectIdentifier("a native parameter name");
    expectText(":");
    const nullOnly = at("null");
    const type = nullOnly
      ? { nullable: true, location: take().location }
      : parseInferredType();
    let release: string | null = null;
    let releaseLocation: SourceLocation | null = null;
    let fixed: string | null = null;
    let fixedLocation: SourceLocation | null = null;
    let fixedValueLocation: SourceLocation | null = null;
    if (at("{")) {
      take();
      while (!at("}")) {
        const contract = peek();
        if (at("fixed")) {
          if (fixed) fail(contract, `foreign parameter ${JSON.stringify(name.text)} cannot declare more than one fixed native value`);
          take();
          const expression = expectIdentifier("a header-defined fixed native value");
          fixed = expression.text;
          fixedLocation = contract.location;
          fixedValueLocation = expression.location;
          expectText(";");
          continue;
        }
        if (!at("deinit")) {
          fail(contract, `expected "deinit" or "fixed" in foreign parameter contract, found ${JSON.stringify(contract.text)}`);
        }
        if (release) fail(contract, `foreign parameter ${JSON.stringify(name.text)} cannot declare more than one deinit contract`);
        take();
        const parsedRelease = parseQualifiedName();
        release = parsedRelease.name;
        releaseLocation = parsedRelease.location;
        expectText(";");
      }
      expectText("}");
    }
    if (release && mode !== "out") {
      fail(name, "parameter-local deinit is only valid on an out parameter that produces ownership");
    }
    if (nullOnly && mode !== "value") {
      fail(name, "a null-only native parameter cannot also declare in, inout, out, or move");
    }
    if (nullOnly && release) {
      fail(name, "a null-only native parameter cannot produce owned output");
    }
    if (fixed && (mode !== "value" || nullOnly || release)) {
      fail(name, "a fixed native parameter cannot also declare a capability, null-only type, or deinit");
    }
    return {
      name: name.text,
      mode,
      nullable: type.nullable,
      nullOnly,
      location: name.location,
      typeLocation: type.location,
      release,
      releaseLocation,
      fixed,
      fixedLocation,
      fixedValueLocation,
    };
  };
  const emptyThreadContract = (): {
    readonly thread: ForeignThreadContract;
    readonly locations: ForeignThreadContractLocations;
  } => ({
    thread: { transfer: false, share: false, deinit: false },
    locations: { location: null, transfer: null, share: null, deinit: null },
  });
  const parseThreadContract = (owner: string): {
    readonly thread: ForeignThreadContract;
    readonly locations: ForeignThreadContractLocations;
  } => {
    const start = expectText("thread");
    expectText("{");
    let transfer: SourceLocation | null = null;
    let share: SourceLocation | null = null;
    let deinit: SourceLocation | null = null;
    while (!at("}")) {
      const capability = take();
      if (!["transfer", "share", "deinit"].includes(capability.text)) {
        fail(capability, `expected "transfer", "share", or "deinit" in ${owner} thread contract, found ${JSON.stringify(capability.text)}`);
      }
      const duplicate = capability.text === "transfer" ? transfer : capability.text === "share" ? share : deinit;
      if (duplicate) fail(capability, `${owner} thread contract cannot declare ${capability.text} more than once`);
      if (capability.text === "transfer") transfer = capability.location;
      else if (capability.text === "share") share = capability.location;
      else deinit = capability.location;
      expectText(";");
    }
    expectText("}");
    if (transfer && share) {
      throw new DiagnosticError(fileName, share, `${owner} thread contract cannot declare both transfer and share; share already implies transfer`, { code: "Z0801" });
    }
    if (!transfer && !share) {
      fail(start, `${owner} thread contract requires transfer or share`);
    }
    return {
      thread: { transfer: Boolean(transfer), share: Boolean(share), deinit: Boolean(deinit) },
      locations: { location: start.location, transfer, share, deinit },
    };
  };

  expectText("declare");
  expectText("module");
  const moduleToken = peek();
  if (moduleToken.kind !== "string") fail(moduleToken, "expected a native module specifier in Z declaration file");
  const moduleSpecifier = take().text;
  expectText("{");
  const functions: ForeignFunctionContract[] = [];
  const types: ForeignValueContract[] = [];
  const functionNames = new Set<string>();
  const typeNames = new Set<string>();
  while (!at("}")) {
    expectText("export");
    if (at("type")) {
      const start = take();
      const parsedName = parseQualifiedName();
      const name = parsedName.name;
      if (typeNames.has(name)) fail(start, `duplicate declaration contract for foreign type ${JSON.stringify(name)}`);
      typeNames.add(name);
      expectText("{");
      let copyLocation: SourceLocation | null = null;
      let moveLocation: SourceLocation | null = null;
      let deinitLocation: SourceLocation | null = null;
      let threadContract = emptyThreadContract();
      while (!at("}")) {
        if (at("thread")) {
          if (threadContract.locations.location) fail(peek(), `foreign type ${JSON.stringify(name)} cannot declare more than one thread contract`);
          threadContract = parseThreadContract(`foreign type ${JSON.stringify(name)}`);
          continue;
        }
        const capability = take();
        if (!["copy", "move", "deinit"].includes(capability.text)) {
          fail(capability, `expected "copy", "move", or "deinit" in foreign type contract, found ${JSON.stringify(capability.text)}`);
        }
        if (capability.text === "copy") {
          if (copyLocation) fail(capability, `foreign type ${JSON.stringify(name)} cannot declare copy more than once`);
          copyLocation = capability.location;
        } else if (capability.text === "move") {
          if (moveLocation) fail(capability, `foreign type ${JSON.stringify(name)} cannot declare move more than once`);
          moveLocation = capability.location;
        } else {
          if (deinitLocation) fail(capability, `foreign type ${JSON.stringify(name)} cannot declare deinit more than once`);
          deinitLocation = capability.location;
        }
        expectText(";");
      }
      expectText("}");
      if (!deinitLocation) {
        fail(start, `foreign value type ${JSON.stringify(name)} must declare deterministic deinit`);
      }
      if (!copyLocation && !moveLocation) {
        fail(start, `foreign value type ${JSON.stringify(name)} must declare copy or move`);
      }
      types.push({
        name,
        copy: Boolean(copyLocation),
        move: Boolean(moveLocation),
        deinit: true,
        location: start.location,
        nameLocation: parsedName.location,
        copyLocation,
        moveLocation,
        deinitLocation,
        thread: threadContract.thread,
        threadLocations: threadContract.locations,
      });
      continue;
    }
    const start = expectText("function");
    const parsedName = parseQualifiedName();
    const name = parsedName.name;
    if (functionNames.has(name)) fail(start, `duplicate declaration contract for foreign function ${JSON.stringify(name)}`);
    functionNames.add(name);
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
    const returnType = parseReturnType();
    const returnNullable = returnType.nullable;
    const statusSuccessValues: number[] = [];
    const statusSuccessLocations: SourceLocation[] = [];
    let release: string | null = null;
    let releaseLocation: SourceLocation | null = null;
    let threadContract = emptyThreadContract();
    const callbacks: ForeignCallbackContract[] = [];
    if (at("{")) {
      take();
      while (!at("}")) {
        const contract = peek();
        if (at("thread")) {
          if (threadContract.locations.location) fail(contract, `foreign function ${JSON.stringify(name)} cannot declare more than one result thread contract`);
          threadContract = parseThreadContract(`result of foreign function ${JSON.stringify(name)}`);
          continue;
        }
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
              if (callbackThread.text !== "caller" && callbackThread.text !== "any") {
                fail(callbackThread, `callback threading must be "caller" or "any", found ${JSON.stringify(callbackThread.text)}`);
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
            thread: callbackThread?.text === "any" ? "any" : callbackThread ? "caller" : null,
            location: contract.location,
            parameterLocation: callback.location,
            contextLocation: context.location,
            releaseLocation: callbackRelease?.location ?? null,
            threadLocation: callbackThread?.location ?? null,
          });
          continue;
        }
        if (at("success")) {
          if (returnType.semanticType !== "status-void") {
            fail(contract, "success is only valid on a `void throws _` native status projection");
          }
          take();
          const parsed = parseStatusValue();
          if (statusSuccessValues.includes(parsed.value)) {
            fail(contract, `foreign function ${JSON.stringify(name)} cannot declare success status ${parsed.value} more than once`);
          }
          statusSuccessValues.push(parsed.value);
          statusSuccessLocations.push(contract.location);
          expectText(";");
          continue;
        }
        if (!at("deinit")) {
          fail(contract, `expected "deinit", "thread", "callback", or "success" in foreign function contract, found ${JSON.stringify(contract.text)}`);
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
    if (threadContract.locations.location && !release) {
      throw new DiagnosticError(fileName, threadContract.locations.location, `result thread contract on ${JSON.stringify(name)} requires an owned return with deinit`, { code: "Z0801" });
    }
    if (returnType.semanticType === "status-void") {
      if (statusSuccessValues.length === 0) {
        fail(start, `native status projection ${JSON.stringify(name)} requires at least one success value`);
      }
      if (release || threadContract.locations.location) {
        fail(start, `native status projection ${JSON.stringify(name)} cannot declare result deinit or thread ownership`);
      }
    }
    functions.push({
      name,
      parameters,
      returnNullable,
      returnSemanticType: returnType.semanticType,
      statusSuccessValues,
      statusSuccessLocations,
      throwsLocation: returnType.throwsLocation,
      release,
      location: start.location,
      nameLocation: parsedName.location,
      returnLocation: returnType.location,
      releaseLocation,
      thread: threadContract.thread,
      threadLocations: threadContract.locations,
      callbacks,
    });
  }
  expectText("}");
  if (peek().kind !== "eof") fail(peek(), `expected the end of the declaration file, found ${JSON.stringify(peek().text)}`);
  return { moduleSpecifier, functions, types };
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
  const exactSpecifier = contracts.moduleSpecifier === expectedModuleSpecifier;
  if (declaredHeader !== importedHeader && (!exactSpecifier || existsSync(declaredHeader))) {
    throw new DiagnosticError(
      fileName,
      { offset: 0, line: 1, column: 1, fileName },
      `Z declaration module ${JSON.stringify(contracts.moduleSpecifier)} does not match imported header ${JSON.stringify(expectedModuleSpecifier)}; resolved ${JSON.stringify(declaredHeader)} instead of ${JSON.stringify(importedHeader)}`,
      { code: "Z0801" },
    );
  }
  const functions: Record<string, {
    return?: PointerNote;
    parameters?: Record<string, PointerNote>;
    status?: StatusNote;
  }> = {};
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
        if (native.name !== null && native.name !== parameter.name) {
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
      if (parameter.mode === "move" && (!callback.release || !callback.thread)) {
        throw new DiagnosticError(
          fileName,
          callback.location,
          `escaping callback ${JSON.stringify(callback.parameter)} requires deinit and thread contracts`,
          {
            code: "Z0214",
            helps: [`add \`deinit <release parameter>;\` plus \`thread caller;\` or \`thread any;\` to the callback contract`],
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
        ...(contract.returnSemanticType === "view-cstring" ? { ownership: "borrowed" as const, semanticType: "view-cstring" as const } : {}),
        ...(contract.release ? { ownership: "owned" as const, release: contract.release } : {}),
        ...(contract.thread.transfer || contract.thread.share || contract.thread.deinit
          ? { thread: contract.thread }
          : {}),
      },
      ...(Object.keys(parameters).length ? { parameters } : {}),
      ...(contract.returnSemanticType === "status-void"
        ? {
          status: {
            success: contract.statusSuccessValues,
            result: "void" as const,
            error: "return" as const,
          },
        }
        : {}),
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
  if (parameter.fixed) return { fixed: parameter.fixed };
  if (parameter.nullOnly) return { nullable: true, nullOnly: true };
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
    return {
      access: parameter.mode,
      nullable: parameter.nullable,
      ...(parameter.release ? { ownership: "owned" as const, release: parameter.release } : {}),
    };
  }
  return { nullable: parameter.nullable };
}
