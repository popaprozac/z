import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SourceLocation } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type {
  ApiNotes,
  ByteBufferProjectionNote,
  FunctionProjectionNote,
  PointerNote,
  StatusNote,
} from "./foreign-api-notes.ts";
import type {
  ForeignConstant,
  ForeignCallbackTypedef,
  ForeignBlockType,
  ForeignFunctionDeclaration,
  ForeignNamedType,
  ForeignObjCInterface,
  ForeignObjCMethod,
} from "./foreign-ir.ts";
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
  readonly explicitType: "cstring" | "clong" | null;
  readonly literal: string | null;
};

export type ContractStatusValue = {
  readonly value: number | string;
  readonly location: SourceLocation;
  readonly valueLocation: SourceLocation;
};

export type ForeignFunctionContract = {
  readonly name: string;
  readonly parameters: readonly ContractParameter[];
  readonly returnNullable: boolean;
  readonly returnSemanticType: "inferred" | "view-cstring" | "status-void" | "connection-status";
  readonly statusSuccessValues: readonly (number | string)[];
  readonly statusSuccessLocations: readonly SourceLocation[];
  readonly statusSuccessValueLocations: readonly SourceLocation[];
  readonly throwsLocation: SourceLocation | null;
  readonly release: string | null;
  readonly location: SourceLocation;
  readonly nameLocation: SourceLocation;
  readonly returnLocation: SourceLocation;
  readonly releaseLocation: SourceLocation | null;
  readonly thread: ForeignThreadContract;
  readonly threadLocations: ForeignThreadContractLocations;
  readonly callbacks: readonly ForeignCallbackContract[];
  readonly buffers: readonly ForeignBufferContract[];
  readonly asyncCallback: string | null;
  readonly asyncLocation: SourceLocation | null;
  readonly asyncCallbackLocation: SourceLocation | null;
  readonly asyncBindings: readonly {
    readonly name: string;
    readonly location: SourceLocation;
  }[];
  readonly asyncReturnBinding: string | null;
  readonly asyncReturnLocation: SourceLocation | null;
  readonly asyncThrowBinding: string | null;
  readonly asyncThrowLocation: SourceLocation | null;
  readonly executorAffinity: "main" | null;
  readonly executorAffinityLocation: SourceLocation | null;
};

export type ForeignBufferContract = {
  readonly buffer: string;
  readonly factors: readonly string[];
  readonly location: SourceLocation;
  readonly bufferLocation: SourceLocation;
  readonly factorLocations: readonly SourceLocation[];
};

export type ForeignThreadContractLocations = {
  readonly location: SourceLocation | null;
  readonly transfer: SourceLocation | null;
  readonly share: SourceLocation | null;
  readonly deinit: SourceLocation | null;
};

export type ForeignCallbackContract = {
  readonly parameter: string;
  readonly context: string | null;
  readonly contextOption: string | null;
  readonly release: string | null;
  readonly nativeType: string | null;
  readonly owner: string | null;
  readonly bytes: {
    readonly buffer: string;
    readonly factors: readonly string[];
    readonly location: SourceLocation;
    readonly bufferLocation: SourceLocation;
    readonly factorLocations: readonly SourceLocation[];
  } | null;
  readonly thread: "caller" | "any" | null;
  readonly location: SourceLocation;
  readonly parameterLocation: SourceLocation;
  readonly contextLocation: SourceLocation | null;
  readonly contextOptionLocation: SourceLocation | null;
  readonly releaseLocation: SourceLocation | null;
  readonly nativeTypeLocation: SourceLocation | null;
  readonly ownerLocation: SourceLocation | null;
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
  readonly executorAffinity: "main" | null;
  readonly executorAffinityLocation: SourceLocation | null;
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
    readonly semanticType: "inferred" | "view-cstring" | "status-void" | "connection-status";
    readonly throwsLocation: SourceLocation | null;
  } => {
    if (at("void") || at("connection")) {
      const result = take();
      const throws = expectText("throws");
      const error = parseInferredType();
      if (error.nullable) fail(throws, "a native status error type cannot be nullable");
      return {
        nullable: false,
        location: result.location,
        semanticType: result.text === "connection" ? "connection-status" : "status-void",
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
  const parseStatusValue = (): ContractStatusValue => {
    let sign = 1;
    if (at("-")) {
      take();
      sign = -1;
    } else if (at("+")) {
      take();
    }
    const literal = peek();
    if (sign === 1 && literal.kind === "identifier") {
      take();
      return { value: literal.text, location: literal.location, valueLocation: literal.location };
    }
    if (literal.kind !== "number" || !/^[0-9]+$/.test(literal.text)) {
      fail(literal, "native status success values require an integer literal or header constant");
    }
    take();
    const value = sign * Number(literal.text);
    if (!Number.isSafeInteger(value)) fail(literal, "native status success value must be a safe integer");
    return { value, location: literal.location, valueLocation: literal.location };
  };
  const parseParameter = (): ContractParameter => {
    let mode: ContractParameter["mode"] = "value";
    if (["in", "inout", "out", "move"].includes(peek().text)) mode = take().text as ContractParameter["mode"];
    const name = expectIdentifier("a native parameter name");
    expectText(":");
    const nullOnly = at("null");
    let explicitType: "cstring" | "clong" | null = null;
    let literal: string | null = null;
    let type: { readonly nullable: boolean; readonly location: SourceLocation };
    if (nullOnly) {
      type = { nullable: true, location: take().location };
    } else if (at("cstring") || at("clong")) {
      const token = take();
      explicitType = token.text as "cstring" | "clong";
      type = { nullable: false, location: token.location };
    } else if (!at("_")) {
      const token = expectIdentifier("`_`, a supported C ABI type, or a header constant");
      literal = token.text;
      type = { nullable: false, location: token.location };
    } else {
      type = parseInferredType();
    }
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
    if ((explicitType || literal) && (release || fixed || nullOnly)) {
      fail(name, "an explicit variadic type or literal discriminant cannot also declare null, fixed, or deinit");
    }
    if (literal && mode !== "value") {
      fail(name, "a native literal discriminant cannot declare in, inout, out, or move");
    }
    if (explicitType && mode !== "value" && mode !== "in") {
      fail(name, "an explicit variadic parameter supports value or in access");
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
      explicitType,
      literal,
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
  const parseExecutorAffinity = (): {
    readonly affinity: "main";
    readonly location: SourceLocation;
  } | null => {
    if (!at("on")) return null;
    const on = take();
    const namespace = expectIdentifier("`thread` after `on`");
    if (namespace.text !== "thread") fail(namespace, "foreign declaration affinity currently requires `on thread.main`");
    expectText(".");
    const executor = expectIdentifier("`main` after `on thread.`");
    if (executor.text !== "main") fail(executor, "foreign declaration affinity currently requires `on thread.main`");
    return { affinity: "main", location: on.location };
  };

  expectText("declare");
  expectText("module");
  const moduleToken = peek();
  if (moduleToken.kind !== "string") fail(moduleToken, "expected a native module specifier in Z declaration file");
  const moduleSpecifier = take().text;
  expectText("{");
  const functions: ForeignFunctionContract[] = [];
  const types: ForeignValueContract[] = [];
  const typeNames = new Set<string>();
  while (!at("}")) {
    expectText("export");
    if (at("type")) {
      const start = take();
      const parsedName = parseQualifiedName();
      const name = parsedName.name;
      if (typeNames.has(name)) fail(start, `duplicate declaration contract for foreign type ${JSON.stringify(name)}`);
      typeNames.add(name);
      const executorAffinity = parseExecutorAffinity();
      if (at(";")) {
        if (!executorAffinity) fail(peek(), "an affinity-only foreign type declaration requires `on thread.main`");
        take();
        const emptyThread = emptyThreadContract();
        types.push({
          name,
          copy: false,
          move: false,
          deinit: false,
          location: start.location,
          nameLocation: parsedName.location,
          copyLocation: null,
          moveLocation: null,
          deinitLocation: null,
          thread: emptyThread.thread,
          threadLocations: emptyThread.locations,
          executorAffinity: executorAffinity.affinity,
          executorAffinityLocation: executorAffinity.location,
        });
        continue;
      }
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
      const hasLifecycle = Boolean(copyLocation || moveLocation || deinitLocation || threadContract.locations.location);
      if (hasLifecycle && !deinitLocation) {
        fail(start, `foreign value type ${JSON.stringify(name)} must declare deterministic deinit`);
      }
      if (hasLifecycle && !copyLocation && !moveLocation) {
        fail(start, `foreign value type ${JSON.stringify(name)} must declare copy or move`);
      }
      if (!hasLifecycle && !executorAffinity) {
        fail(start, `foreign type ${JSON.stringify(name)} must declare lifecycle facts or \`on thread.main\``);
      }
      types.push({
        name,
        copy: Boolean(copyLocation),
        move: Boolean(moveLocation),
        deinit: Boolean(deinitLocation),
        location: start.location,
        nameLocation: parsedName.location,
        copyLocation,
        moveLocation,
        deinitLocation,
        thread: threadContract.thread,
        threadLocations: threadContract.locations,
        executorAffinity: executorAffinity?.affinity ?? null,
        executorAffinityLocation: executorAffinity?.location ?? null,
      });
      continue;
    }
    const start = expectText("function");
    const parsedName = parseQualifiedName();
    const name = parsedName.name;
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
    const executorAffinity = parseExecutorAffinity();
    const returnNullable = returnType.nullable;
    const statusSuccessValues: (number | string)[] = [];
    const statusSuccessLocations: SourceLocation[] = [];
    const statusSuccessValueLocations: SourceLocation[] = [];
    let release: string | null = null;
    let releaseLocation: SourceLocation | null = null;
    let threadContract = emptyThreadContract();
    const callbacks: ForeignCallbackContract[] = [];
    const buffers: ForeignBufferContract[] = [];
    let asyncCallback: string | null = null;
    let asyncLocation: SourceLocation | null = null;
    let asyncCallbackLocation: SourceLocation | null = null;
    let asyncBindings: { readonly name: string; readonly location: SourceLocation }[] = [];
    let asyncReturnBinding: string | null = null;
    let asyncReturnLocation: SourceLocation | null = null;
    let asyncThrowBinding: string | null = null;
    let asyncThrowLocation: SourceLocation | null = null;
    if (at("{")) {
      take();
      while (!at("}")) {
        const contract = peek();
        if (at("async")) {
          if (asyncCallback) fail(contract, `foreign function ${JSON.stringify(name)} cannot declare more than one async callback`);
          asyncLocation = take().location;
          const callback = expectIdentifier("a terminal callback parameter name after `async`");
          asyncCallback = callback.text;
          asyncCallbackLocation = callback.location;
          if (at(";")) {
            take();
            continue;
          }
          expectText("(");
          if (!at(")")) {
            const binding = expectIdentifier("an async callback value binding");
            asyncBindings.push({ name: binding.text, location: binding.location });
            while (at(",")) {
              take();
              const next = expectIdentifier("an async callback value binding");
              if (asyncBindings.some((candidate) => candidate.name === next.text)) {
                fail(next, `async callback binding ${JSON.stringify(next.text)} cannot be declared more than once`);
              }
              asyncBindings.push({ name: next.text, location: next.location });
            }
          }
          expectText(")");
          expectText("{");
          while (!at("}")) {
            const projection = peek();
            if (at("return")) {
              if (asyncReturnBinding) fail(projection, "an async callback projection cannot declare more than one return binding");
              take();
              const binding = expectIdentifier("an async callback binding after `return`");
              asyncReturnBinding = binding.text;
              asyncReturnLocation = projection.location;
              expectText(";");
              continue;
            }
            if (at("throw")) {
              if (asyncThrowBinding) fail(projection, "an async callback projection cannot declare more than one throw binding");
              take();
              const binding = expectIdentifier("an async callback binding after `throw`");
              asyncThrowBinding = binding.text;
              asyncThrowLocation = projection.location;
              expectText(";");
              continue;
            }
            fail(projection, `expected "return" or "throw" in async callback projection, found ${JSON.stringify(projection.text)}`);
          }
          expectText("}");
          if (!asyncThrowBinding) {
            fail(contract, "an expanded async callback projection requires `throw <binding>;`; use `async <callback>;` for an infallible callback");
          }
          continue;
        }
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
          let contextOption: Token | null = null;
          let callbackRelease: Token | null = null;
          let nativeType: Token | null = null;
          let callbackOwner: Token | null = null;
          let bytes: ForeignCallbackContract["bytes"] = null;
          let callbackThread: Token | null = null;
          while (!at("}")) {
            const callbackFact = peek();
            if (at("type")) {
              if (nativeType) fail(callbackFact, `callback ${JSON.stringify(callback.text)} cannot declare more than one native type`);
              take();
              nativeType = expectIdentifier("a native callback typedef name");
              expectText(";");
              continue;
            }
            if (at("context")) {
              if (context || contextOption) fail(callbackFact, `callback ${JSON.stringify(callback.text)} cannot declare more than one context source`);
              take();
              if (at("option")) {
                take();
                contextOption = expectIdentifier("a native context option constant");
              } else {
                context = expectIdentifier("a native callback context parameter name");
              }
              expectText(";");
              continue;
            }
            if (at("owner")) {
              if (callbackOwner) fail(callbackFact, `callback ${JSON.stringify(callback.text)} cannot declare more than one owner`);
              take();
              callbackOwner = expectIdentifier("an owner parameter name");
              expectText(";");
              continue;
            }
            if (at("bytes")) {
              if (bytes) fail(callbackFact, `callback ${JSON.stringify(callback.text)} cannot declare more than one byte-slice projection`);
              take();
              expectText("from");
              const buffer = expectIdentifier("a native callback buffer parameter");
              expectText("length");
              const factors: Token[] = [expectIdentifier("a native callback length parameter")];
              while (at("*")) {
                take();
                factors.push(expectIdentifier("a native callback length parameter"));
              }
              expectText(";");
              bytes = {
                buffer: buffer.text,
                factors: factors.map((factor) => factor.text),
                location: callbackFact.location,
                bufferLocation: buffer.location,
                factorLocations: factors.map((factor) => factor.location),
              };
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
              `expected "type", "context", "owner", "bytes", "deinit", or "thread" in foreign callback contract, found ${JSON.stringify(callbackFact.text)}`,
            );
          }
          expectText("}");
          callbacks.push({
            parameter: callback.text,
            context: context?.text ?? null,
            contextOption: contextOption?.text ?? null,
            release: callbackRelease?.text ?? null,
            nativeType: nativeType?.text ?? null,
            owner: callbackOwner?.text ?? null,
            bytes,
            thread: callbackThread?.text === "any" ? "any" : callbackThread ? "caller" : null,
            location: contract.location,
            parameterLocation: callback.location,
            contextLocation: context?.location ?? null,
            contextOptionLocation: contextOption?.location ?? null,
            releaseLocation: callbackRelease?.location ?? null,
            nativeTypeLocation: nativeType?.location ?? null,
            ownerLocation: callbackOwner?.location ?? null,
            threadLocation: callbackThread?.location ?? null,
          });
          continue;
        }
        if (at("bytes")) {
          take();
          expectText("from");
          const buffer = expectIdentifier("a native buffer parameter");
          expectText("length");
          const factors: Token[] = [expectIdentifier("a native buffer length parameter")];
          while (at("*")) {
            take();
            factors.push(expectIdentifier("a native buffer length parameter"));
          }
          expectText(";");
          if (buffers.some((candidate) => candidate.buffer === buffer.text)) {
            fail(buffer, `foreign function ${JSON.stringify(name)} cannot project buffer ${JSON.stringify(buffer.text)} more than once`);
          }
          buffers.push({
            buffer: buffer.text,
            factors: factors.map((factor) => factor.text),
            location: contract.location,
            bufferLocation: buffer.location,
            factorLocations: factors.map((factor) => factor.location),
          });
          continue;
        }
        if (at("success")) {
          if (returnType.semanticType !== "status-void" && returnType.semanticType !== "connection-status") {
            fail(contract, "success is only valid on a `void throws _` or `connection throws _` native status projection");
          }
          take();
          const parsed = parseStatusValue();
          if (statusSuccessValues.includes(parsed.value)) {
            fail(contract, `foreign function ${JSON.stringify(name)} cannot declare success status ${parsed.value} more than once`);
          }
          statusSuccessValues.push(parsed.value);
          statusSuccessLocations.push(contract.location);
          statusSuccessValueLocations.push(parsed.valueLocation);
          expectText(";");
          continue;
        }
        if (!at("deinit")) {
          fail(contract, `expected "async", "bytes", "deinit", "thread", "callback", or "success" in foreign function contract, found ${JSON.stringify(contract.text)}`);
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
    if (returnType.semanticType === "status-void" || returnType.semanticType === "connection-status") {
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
      statusSuccessValueLocations,
      throwsLocation: returnType.throwsLocation,
      release,
      location: start.location,
      nameLocation: parsedName.location,
      returnLocation: returnType.location,
      releaseLocation,
      thread: threadContract.thread,
      threadLocations: threadContract.locations,
      callbacks,
      buffers,
      asyncCallback,
      asyncLocation,
      asyncCallbackLocation,
      asyncBindings,
      asyncReturnBinding,
      asyncReturnLocation,
      asyncThrowBinding,
      asyncThrowLocation,
      executorAffinity: executorAffinity?.affinity ?? null,
      executorAffinityLocation: executorAffinity?.location ?? null,
    });
  }
  expectText("}");
  if (peek().kind !== "eof") fail(peek(), `expected the end of the declaration file, found ${JSON.stringify(peek().text)}`);
  return { moduleSpecifier, functions, types };
}

export function foreignDeclarationApiNotes(
  contracts: ForeignDeclarationContracts,
  declarations: ReadonlyMap<string, ForeignFunctionDeclaration>,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  interfaces: ReadonlyMap<string, ForeignObjCInterface>,
  constants: ReadonlyMap<string, ForeignConstant>,
  callbackTypedefs: ReadonlyMap<string, ForeignCallbackTypedef>,
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
    buffers?: ByteBufferProjectionNote[];
    executorAffinity?: "main";
    projections?: FunctionProjectionNote[];
  }> = {};
  const types: Record<string, { executorAffinity?: "main" }> = {};
  const objcMethods: Record<string, {
    parameters?: Record<string, PointerNote>;
    executorAffinity?: "main";
    async?: {
      readonly callbackParameter: number;
      readonly resultParameter: number | null;
      readonly errorParameter: number | null;
    };
  }> = {};
  for (const contract of contracts.types) {
    if (!contract.executorAffinity) continue;
    const namedType = namedTypes.get(contract.name);
    const interfaceType = interfaces.get(contract.name);
    if (!namedType && !interfaceType) {
      throw new DiagnosticError(
        fileName,
        contract.nameLocation,
        `declaration names unknown foreign type ${JSON.stringify(contract.name)}`,
        { code: "Z0801" },
      );
    }
    types[contract.name] = { executorAffinity: contract.executorAffinity };
  }
  for (const contract of contracts.functions) {
    const declaration = declarations.get(contract.name);
    if (!declaration) {
      const method = resolveObjCMethodContract(contract, interfaces, fileName);
      if (!method) {
        const kind = contract.name.includes(".")
          ? "foreign function or Objective-C method"
          : "foreign function";
        throw new DiagnosticError(fileName, contract.location, `declaration names unknown ${kind} ${JSON.stringify(contract.name)}`, { code: "Z0801" });
      }
      objcMethods[method.key] = objectiveCMethodApiNote(contract, method.method, fileName);
      continue;
    }
    if (contract.asyncCallback) {
      throw new DiagnosticError(
        fileName,
        contract.asyncCallbackLocation!,
        "the first async callback projection tier supports Objective-C methods only",
        { code: "Z0801" },
      );
    }
    const pairedCallback = contract.returnSemanticType === "connection-status"
      ? contract.callbacks[0] ?? null
      : null;
    if (contract.returnSemanticType === "connection-status" && contract.callbacks.length !== 1) {
      throw new DiagnosticError(
        fileName,
        contract.returnLocation,
        "a connection status projection requires exactly one callback contract",
        { code: "Z0801" },
      );
    }
    if (pairedCallback) validatePairedOptionCallbackContract(
      contract,
      pairedCallback,
      declaration,
      callbackTypedefs,
      constants,
      namedTypes,
      fileName,
    );
    const buffers = validateFunctionBufferContracts(contract, declaration, fileName);
    const projection = contract.parameters.some((parameter) => parameter.literal || parameter.explicitType)
      || Boolean(pairedCallback)
      || declaration.overloads.some((overload) => contract.parameters.length > overload.parameters.length);
    const parameters: Record<string, PointerNote> = {};
    for (const overload of declaration.overloads) {
      if (
        (!projection && overload.parameters.length !== contract.parameters.length)
        || (projection && (!overload.variadic || contract.parameters.length < overload.parameters.length))
      ) {
        throw new DiagnosticError(
          fileName,
          contract.location,
          projection
            ? `typed variadic declaration for ${JSON.stringify(contract.name)} requires a variadic native function and at least its ${overload.parameters.length} fixed parameters`
            : `declaration for ${JSON.stringify(contract.name)} has ${contract.parameters.length} parameters but the native declaration has ${overload.parameters.length}`,
          { code: "Z0801" },
        );
      }
      for (let parameterIndex = 0; parameterIndex < overload.parameters.length; parameterIndex += 1) {
        const parameter = contract.parameters[parameterIndex];
        const native = overload.parameters[parameterIndex];
        if (parameter.explicitType) {
          throw new DiagnosticError(
            fileName,
            parameter.typeLocation,
            `explicit type ${JSON.stringify(parameter.explicitType)} is only valid for a C variadic argument after the ${overload.parameters.length} fixed native parameters`,
            { code: "Z0801" },
          );
        }
        if (native.name !== null && native.name !== parameter.name) {
          throw new DiagnosticError(
            fileName,
            parameter.location,
            `declaration parameter ${JSON.stringify(parameter.name)} does not match native parameter ${JSON.stringify(native.name)} at position ${parameterIndex + 1}`,
            { code: "Z0801" },
          );
        }
        if (parameter.literal) {
          validateContractConstant(
            parameter.literal,
            parameter.typeLocation,
            native.type.nativeName,
            constants,
            namedTypes,
            fileName,
            `literal discriminant for parameter ${JSON.stringify(parameter.name)}`,
          );
        }
      }
      for (let parameterIndex = overload.parameters.length; parameterIndex < contract.parameters.length; parameterIndex += 1) {
        const parameter = contract.parameters[parameterIndex];
        if (!parameter.explicitType && parameter.name !== pairedCallback?.parameter) {
          throw new DiagnosticError(
            fileName,
            parameter.typeLocation,
            "a typed C variadic argument requires an explicit supported type such as `cstring` or `clong`",
            { code: "Z0801" },
          );
        }
      }
    }
    const nativeParameterCount = declaration.overloads[0]?.parameters.length ?? contract.parameters.length;
    for (let parameterIndex = 0; parameterIndex < nativeParameterCount; parameterIndex += 1) {
      const parameter = contract.parameters[parameterIndex];
      parameters[String(parameterIndex)] = parameterNote(parameter);
    }
    for (const callback of contract.callbacks) {
      if (callback === pairedCallback) continue;
      if (!callback.context || !callback.contextLocation) {
        throw new DiagnosticError(
          fileName,
          callback.location,
          `C callback ${JSON.stringify(callback.parameter)} requires a named native context parameter`,
          {
            code: "Z0801",
            helps: ["add `context <parameter>;`; context-free callback environments remain unsupported"],
          },
        );
      }
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
    const success = contract.statusSuccessValues.map((value, index) => {
      if (typeof value === "number") return value;
      return validateContractConstant(
        value,
        contract.statusSuccessValueLocations[index],
        declaration.overloads[0]?.returnType.nativeName ?? "",
        constants,
        namedTypes,
        fileName,
        "native success status",
      ).cName;
    });
    const note = {
      ...(contract.executorAffinity ? { executorAffinity: contract.executorAffinity } : {}),
      return: {
        nullable: contract.returnNullable,
        ...(contract.returnSemanticType === "view-cstring" ? { ownership: "borrowed" as const, semanticType: "view-cstring" as const } : {}),
        ...(contract.release ? { ownership: "owned" as const, release: contract.release } : {}),
        ...(contract.thread.transfer || contract.thread.share || contract.thread.deinit
          ? { thread: contract.thread }
          : {}),
      },
      ...(Object.keys(parameters).length ? { parameters } : {}),
      ...(buffers.length ? { buffers } : {}),
      ...(
        contract.returnSemanticType === "status-void"
        || contract.returnSemanticType === "connection-status"
        ? {
          status: {
            success,
            result: "void" as const,
            error: "return" as const,
          },
        }
        : {}),
    };
    if (projection) {
      const literals = Object.fromEntries(
        contract.parameters
          .slice(0, nativeParameterCount)
          .map((parameter, index) => [String(index), parameter.literal])
          .filter((entry): entry is [string, string] => entry[1] !== null),
      );
      if (Object.keys(literals).length === 0) {
        throw new DiagnosticError(
          fileName,
          contract.location,
          `typed variadic declaration for ${JSON.stringify(contract.name)} requires at least one header-constant discriminant`,
          { code: "Z0801" },
        );
      }
      const existing = functions[contract.name] ??= {};
      const projections = existing.projections ??= [];
      const key = JSON.stringify(literals);
      if (projections.some((candidate) => JSON.stringify(candidate.literals) === key)) {
        throw new DiagnosticError(
          fileName,
          contract.location,
          `duplicate typed variadic declaration for ${JSON.stringify(contract.name)} and discriminant ${Object.values(literals).join(", ")}`,
          { code: "Z0801" },
        );
      }
      projections.push({
        ...note,
        literals,
        ...(pairedCallback
          ? {
            connection: pairedOptionConnectionNote(
              contract,
              pairedCallback,
              declaration,
              callbackTypedefs.get(pairedCallback.nativeType!)!,
            ),
          }
          : {}),
        variadicParameters: contract.parameters.slice(nativeParameterCount).map((parameter) => {
          if (parameter.name === pairedCallback?.parameter) {
            const callback = callbackTypedefs.get(pairedCallback.nativeType!)!;
            const parameterNames = callback.parameterNames;
            return {
              name: parameter.name,
              type: "callback" as const,
              access: "value" as const,
              callback: {
                nativeType: callback.name,
                nativeSignature: callback.signature,
                nativeParameterNames: callback.parameterNames,
                thread: "caller" as const,
                bytes: {
                  bufferParameter: parameterNames.indexOf(pairedCallback.bytes!.buffer),
                  lengthParameters: pairedCallback.bytes!.factors.map((factor) => parameterNames.indexOf(factor)),
                },
              },
            };
          }
          return {
            name: parameter.name,
            type: parameter.explicitType!,
            access: parameter.mode === "in" ? "in" as const : "value" as const,
          };
        }),
      });
    } else {
      if (functions[contract.name]) {
        throw new DiagnosticError(
          fileName,
          contract.location,
          `duplicate declaration contract for foreign function ${JSON.stringify(contract.name)}`,
          { code: "Z0801" },
        );
      }
      functions[contract.name] = note;
    }
  }
  return {
    ...(Object.keys(types).length ? { types } : {}),
    ...(Object.keys(functions).length ? { functions } : {}),
    ...(Object.keys(objcMethods).length ? { objcMethods } : {}),
  };
}

function validateFunctionBufferContracts(
  contract: ForeignFunctionContract,
  declaration: ForeignFunctionDeclaration,
  fileName: string,
): ByteBufferProjectionNote[] {
  const used = new Set<number>();
  return contract.buffers.map((buffer) => {
    if (buffer.factors.length !== 1) {
      throw new DiagnosticError(
        fileName,
        buffer.location,
        "ordinary byte-buffer projection currently requires exactly one size_t length parameter",
        {
          code: "Z0801",
          notes: ["multi-factor byte counts remain available for callback projections"],
          helps: ["write `bytes from <buffer> length <length>;`"],
        },
      );
    }
    const bufferParameter = contract.parameters.findIndex((parameter) => parameter.name === buffer.buffer);
    if (bufferParameter < 0) {
      throw new DiagnosticError(
        fileName,
        buffer.bufferLocation,
        `byte projection names unknown function parameter ${JSON.stringify(buffer.buffer)}`,
        { code: "Z0801" },
      );
    }
    const lengthName = buffer.factors[0];
    const lengthParameter = contract.parameters.findIndex((parameter) => parameter.name === lengthName);
    if (lengthParameter < 0) {
      throw new DiagnosticError(
        fileName,
        buffer.factorLocations[0],
        `byte projection names unknown function parameter ${JSON.stringify(lengthName)}`,
        { code: "Z0801" },
      );
    }
    if (bufferParameter === lengthParameter || used.has(bufferParameter) || used.has(lengthParameter)) {
      throw new DiagnosticError(
        fileName,
        buffer.location,
        "ordinary byte-buffer projection parameters must be distinct and may belong to only one projection",
        { code: "Z0801" },
      );
    }
    const bufferContract = contract.parameters[bufferParameter];
    const lengthContract = contract.parameters[lengthParameter];
    if (bufferContract.mode !== "in") {
      throw new DiagnosticError(
        fileName,
        bufferContract.location,
        `projected byte buffer ${JSON.stringify(buffer.buffer)} requires in borrowing`,
        { code: "Z0801", helps: [`write \`in ${buffer.buffer}: _\``] },
      );
    }
    if (lengthContract.mode !== "value") {
      throw new DiagnosticError(
        fileName,
        lengthContract.location,
        `projected byte length ${JSON.stringify(lengthName)} is a derived value and cannot declare a capability`,
        { code: "Z0801", helps: [`write \`${lengthName}: _\``] },
      );
    }
    for (const overload of declaration.overloads) {
      const nativeBuffer = overload.parameters[bufferParameter];
      const nativeLength = overload.parameters[lengthParameter];
      if (!nativeBuffer || !nativeLength) {
        throw new DiagnosticError(
          fileName,
          buffer.location,
          "ordinary byte-buffer projection must name fixed native parameters",
          { code: "Z0801" },
        );
      }
      const pointerSpellings = [
        nativeBuffer.type.nativeName,
        nativeBuffer.type.canonicalNativeName,
      ].filter((value): value is string => Boolean(value));
      const constBytePointer = pointerSpellings.some((spelling) => {
        const normalized = normalizeCallbackContextType(spelling);
        return normalized === "const char *"
          || normalized === "const unsigned char *"
          || normalized === "const void *";
      });
      if (!constBytePointer) {
        throw new DiagnosticError(
          fileName,
          buffer.bufferLocation,
          `ordinary byte projection requires a const native byte pointer, found ${JSON.stringify(nativeBuffer.type.nativeName)}`,
          {
            code: "Z0801",
            notes: ["the first tier exposes read-only Slice<u8>; mutable native buffers require a separate reviewed contract"],
          },
        );
      }
      const lengthSpellings = [
        nativeLength.type.nativeName,
        nativeLength.type.canonicalNativeName,
      ].filter((value): value is string => Boolean(value));
      if (!lengthSpellings.some((spelling) => normalizeCallbackContextType(spelling) === "size_t")) {
        throw new DiagnosticError(
          fileName,
          buffer.factorLocations[0],
          `ordinary byte projection length must have native type size_t, found ${JSON.stringify(nativeLength.type.nativeName)}`,
          { code: "Z0801" },
        );
      }
    }
    used.add(bufferParameter);
    used.add(lengthParameter);
    return {
      bufferParameter,
      lengthParameters: [lengthParameter],
      elementType: "u8",
    };
  });
}

function validatePairedOptionCallbackContract(
  contract: ForeignFunctionContract,
  callback: ForeignCallbackContract,
  declaration: ForeignFunctionDeclaration,
  callbackTypedefs: ReadonlyMap<string, ForeignCallbackTypedef>,
  constants: ReadonlyMap<string, ForeignConstant>,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
): void {
  const parameter = contract.parameters.find((candidate) => candidate.name === callback.parameter);
  if (!parameter) {
    throw new DiagnosticError(
      fileName,
      callback.parameterLocation,
      `callback contract names unknown parameter ${JSON.stringify(callback.parameter)} on ${JSON.stringify(contract.name)}`,
      { code: "Z0801" },
    );
  }
  if (parameter.mode !== "move") {
    throw new DiagnosticError(
      fileName,
      callback.parameterLocation,
      `connection callback ${JSON.stringify(callback.parameter)} requires move ownership`,
      { code: "Z0801", helps: [`write \`move ${callback.parameter}: _\``] },
    );
  }
  if (callback.context || callback.release) {
    throw new DiagnosticError(
      fileName,
      callback.location,
      "a paired-option connection uses `context option`, not a same-call context or deinit parameter",
      { code: "Z0801" },
    );
  }
  if (!callback.contextOption || !callback.contextOptionLocation) {
    throw new DiagnosticError(
      fileName,
      callback.location,
      `connection callback ${JSON.stringify(callback.parameter)} requires a native context option`,
      { code: "Z0801", helps: ["add `context option <HEADER_CONSTANT>;`"] },
    );
  }
  if (!callback.owner || !callback.ownerLocation) {
    throw new DiagnosticError(
      fileName,
      callback.location,
      `connection callback ${JSON.stringify(callback.parameter)} requires an owner parameter`,
      { code: "Z0801", helps: ["add `owner <parameter>;`"] },
    );
  }
  const ownerIndex = contract.parameters.findIndex((candidate) => candidate.name === callback.owner);
  const nativeParameterCount = declaration.overloads[0]?.parameters.length ?? 0;
  if (ownerIndex < 0 || ownerIndex >= nativeParameterCount) {
    throw new DiagnosticError(
      fileName,
      callback.ownerLocation,
      `connection owner ${JSON.stringify(callback.owner)} must name a fixed native parameter`,
      { code: "Z0801" },
    );
  }
  if (contract.parameters[ownerIndex].mode !== "in") {
    throw new DiagnosticError(
      fileName,
      contract.parameters[ownerIndex].location,
      `connection owner ${JSON.stringify(callback.owner)} must use in borrowing`,
      { code: "Z0801" },
    );
  }
  const nativeOwner = declaration.overloads[0]?.parameters[ownerIndex];
  if (!nativeOwner || !/\*\s*$/.test(nativeOwner.type.nativeName)) {
    throw new DiagnosticError(
      fileName,
      callback.ownerLocation,
      `connection owner ${JSON.stringify(callback.owner)} must be a native pointer`,
      { code: "Z0801" },
    );
  }
  if (callback.thread !== "caller") {
    throw new DiagnosticError(
      fileName,
      callback.threadLocation ?? callback.location,
      "the first paired-option connection tier requires `thread caller`",
      { code: "Z0801" },
    );
  }
  if (!callback.nativeType || !callback.nativeTypeLocation) {
    throw new DiagnosticError(
      fileName,
      callback.location,
      `connection callback ${JSON.stringify(callback.parameter)} requires its native callback typedef`,
      { code: "Z0801", helps: ["add `type <header_callback_typedef>;`"] },
    );
  }
  const nativeCallback = callbackTypedefs.get(callback.nativeType);
  if (!nativeCallback) {
    throw new DiagnosticError(
      fileName,
      callback.nativeTypeLocation,
      `callback type names unknown header typedef ${JSON.stringify(callback.nativeType)}`,
      { code: "Z0801" },
    );
  }
  if (!callback.bytes) {
    throw new DiagnosticError(
      fileName,
      callback.location,
      "the first paired-option callback tier requires a byte-slice projection",
      { code: "Z0801", helps: ["add `bytes from <buffer> length <factor> * <factor>;`"] },
    );
  }
  const parameterTypes = callbackParameterSpellings(nativeCallback.signature)!;
  const names = nativeCallback.parameterNames;
  const bufferIndex = names.indexOf(callback.bytes.buffer);
  if (bufferIndex < 0) {
    throw new DiagnosticError(
      fileName,
      callback.bytes.bufferLocation,
      `byte projection names unknown callback parameter ${JSON.stringify(callback.bytes.buffer)}`,
      { code: "Z0801", notes: [`${callback.nativeType} parameters: ${names.join(", ")}`] },
    );
  }
  const normalizedBuffer = normalizeCallbackContextType(parameterTypes[bufferIndex]).replace(/^const /, "");
  if (normalizedBuffer !== "char *" && normalizedBuffer !== "unsigned char *" && normalizedBuffer !== "void *") {
    throw new DiagnosticError(
      fileName,
      callback.bytes.bufferLocation,
      `byte projection buffer must be a native byte pointer, found ${JSON.stringify(parameterTypes[bufferIndex])}`,
      { code: "Z0801" },
    );
  }
  const factorIndexes = callback.bytes.factors.map((factor, index) => {
    const parameterIndex = names.indexOf(factor);
    if (parameterIndex < 0) {
      throw new DiagnosticError(
        fileName,
        callback.bytes!.factorLocations[index],
        `byte projection names unknown callback parameter ${JSON.stringify(factor)}`,
        { code: "Z0801", notes: [`${callback.nativeType} parameters: ${names.join(", ")}`] },
      );
    }
    if (normalizeCallbackContextType(parameterTypes[parameterIndex]) !== "size_t") {
      throw new DiagnosticError(
        fileName,
        callback.bytes!.factorLocations[index],
        `byte projection length factor must have native type size_t, found ${JSON.stringify(parameterTypes[parameterIndex])}`,
        { code: "Z0801" },
      );
    }
    return parameterIndex;
  });
  if (new Set([bufferIndex, ...factorIndexes]).size !== factorIndexes.length + 1) {
    throw new DiagnosticError(fileName, callback.bytes.location, "byte projection parameters must be distinct", { code: "Z0801" });
  }
  const contextIndexes = parameterTypes
    .map((type, index) => normalizeCallbackContextType(type) === "void *" ? index : -1)
    .filter((index) => index >= 0 && index !== bufferIndex);
  if (contextIndexes.length !== 1) {
    throw new DiagnosticError(
      fileName,
      callback.location,
      `${callback.nativeType} must have exactly one void * context parameter outside the byte projection`,
      { code: "Z0801" },
    );
  }
  const returnType = nativeCallback.signature.slice(0, nativeCallback.signature.indexOf("(*")).trim();
  if (normalizeCallbackContextType(returnType) !== "size_t") {
    throw new DiagnosticError(
      fileName,
      callback.nativeTypeLocation,
      `byte callback must return size_t, found ${JSON.stringify(returnType)}`,
      { code: "Z0801" },
    );
  }
  const discriminants = contract.parameters.filter((candidate) => candidate.literal);
  if (discriminants.length !== 1) {
    throw new DiagnosticError(
      fileName,
      contract.location,
      "a paired-option connection requires exactly one callback option discriminant",
      { code: "Z0801" },
    );
  }
  const optionIndex = contract.parameters.indexOf(discriminants[0]);
  const nativeOption = declaration.overloads[0]?.parameters[optionIndex];
  if (!nativeOption) {
    throw new DiagnosticError(fileName, discriminants[0].typeLocation, "callback option must occupy a fixed native parameter", { code: "Z0801" });
  }
  validateContractConstant(
    callback.contextOption,
    callback.contextOptionLocation,
    nativeOption.type.nativeName,
    constants,
    namedTypes,
    fileName,
    "native callback context option",
  );
  if (callback.contextOption === discriminants[0].literal) {
    throw new DiagnosticError(fileName, callback.contextOptionLocation, "callback and context options must be distinct", { code: "Z0801" });
  }
  if (
    nativeParameterCount !== 2
    || new Set([ownerIndex, optionIndex]).size !== 2
    || ![ownerIndex, optionIndex].every((index) => index >= 0 && index < nativeParameterCount)
  ) {
    throw new DiagnosticError(
      fileName,
      contract.location,
      "the first paired-option connection tier requires exactly one native owner parameter and one native option parameter",
      { code: "Z0801" },
    );
  }
}

function pairedOptionConnectionNote(
  contract: ForeignFunctionContract,
  callback: ForeignCallbackContract,
  declaration: ForeignFunctionDeclaration,
  nativeCallback: ForeignCallbackTypedef,
): NonNullable<FunctionProjectionNote["connection"]> {
  const parameterNames = nativeCallback.parameterNames;
  const nativeParameterCount = declaration.overloads[0]?.parameters.length ?? 0;
  const callbackParameter = contract.parameters.findIndex((parameter) => parameter.name === callback.parameter);
  const ownerParameter = contract.parameters.findIndex((parameter) => parameter.name === callback.owner);
  const callbackOption = contract.parameters.find((parameter) => parameter.literal)!.literal!;
  if (callbackParameter < nativeParameterCount) throw new Error("validated callback connection must use a variadic parameter");
  if (parameterNames.indexOf(callback.bytes!.buffer) < 0) throw new Error("validated callback buffer is missing");
  return {
    ownerParameter,
    callbackParameter,
    callbackOption,
    contextOption: callback.contextOption!,
  };
}

function validateContractConstant(
  name: string,
  location: SourceLocation,
  nativeType: string,
  constants: ReadonlyMap<string, ForeignConstant>,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
  role: string,
): ForeignConstant {
  const constant = constants.get(name);
  if (!constant) {
    throw new DiagnosticError(fileName, location, `${role} names unknown header constant ${JSON.stringify(name)}`, {
      code: "Z0801",
    });
  }
  const named = namedTypes.get(constant.typeName);
  const compact = nativeType.replace(/\b(?:const|volatile|enum)\b/g, "").replace(/\s+/g, "");
  const nativeNamed = [...namedTypes.values()].find((candidate) => (
    [candidate.cName, candidate.exportName, candidate.qualifiedName]
      .map((value) => value.replace(/\s+/g, ""))
      .some((spelling) => compact.includes(spelling))
  ));
  if (nativeNamed?.kind === "enum" && constant.typeName !== nativeNamed.typeName) {
    throw new DiagnosticError(
      fileName,
      location,
      `${role} ${JSON.stringify(name)} has type ${constant.typeName}, which does not match native enum ${nativeNamed.exportName}`,
      { code: "Z0801" },
    );
  }
  if (named?.kind === "enum") {
    const spellings = [named.cName, named.exportName, named.qualifiedName]
      .map((value) => value.replace(/\s+/g, ""));
    if (!spellings.some((spelling) => compact.includes(spelling))) {
      throw new DiagnosticError(
        fileName,
        location,
        `${role} ${JSON.stringify(name)} has type ${named.exportName}, which does not match native type ${JSON.stringify(nativeType)}`,
        { code: "Z0801" },
      );
    }
  }
  return constant;
}

function resolveObjCMethodContract(
  contract: ForeignFunctionContract,
  interfaces: ReadonlyMap<string, ForeignObjCInterface>,
  fileName: string,
): { readonly key: string; readonly method: ForeignObjCMethod } | null {
  const separator = contract.name.lastIndexOf(".");
  if (separator < 1 || separator === contract.name.length - 1) return null;
  const className = contract.name.slice(0, separator);
  const baseName = contract.name.slice(separator + 1);
  const declaration = interfaces.get(className);
  if (!declaration) return null;
  const candidates = declaration.methods.filter((method) => (
    method.baseName === baseName
    && method.parameters.length === contract.parameters.length
    && method.parameters.every((parameter, index) => (
      parameter.name === null || parameter.name === contract.parameters[index]?.name
    ))
  ));
  if (candidates.length === 0) {
    throw new DiagnosticError(
      fileName,
      contract.location,
      `declaration does not match an Objective-C method ${JSON.stringify(contract.name)} with parameters (${contract.parameters.map((parameter) => parameter.name).join(", ")})`,
      {
        code: "Z0801",
        notes: ["the class exists, but no selector has the same base name and native parameter names"],
      },
    );
  }
  if (candidates.length > 1) {
    throw new DiagnosticError(
      fileName,
      contract.location,
      `declaration is ambiguous across Objective-C selectors ${candidates.map((method) => JSON.stringify(method.selector)).join(", ")}`,
      { code: "Z0801" },
    );
  }
  return { key: `${className}.${candidates[0].selector}`, method: candidates[0] };
}

function objectiveCMethodApiNote(
  contract: ForeignFunctionContract,
  method: ForeignObjCMethod,
  fileName: string,
): {
  readonly parameters?: Readonly<Record<string, PointerNote>>;
  readonly executorAffinity?: "main";
  readonly async?: {
    readonly callbackParameter: number;
    readonly resultParameter: number | null;
    readonly errorParameter: number | null;
  };
} {
  if (
    contract.returnSemanticType !== "inferred"
    || contract.release
    || contract.thread.transfer
    || contract.thread.share
    || contract.thread.deinit
    || contract.statusSuccessValues.length > 0
    || contract.buffers.length > 0
  ) {
    throw new DiagnosticError(
      fileName,
      contract.returnLocation,
      "the first Objective-C method contract tier refines block parameters only",
      { code: "Z0801" },
    );
  }
  const callbacks = new Map(contract.callbacks.map((callback) => [callback.parameter, callback]));
  const parameters: Record<string, PointerNote> = {};
  for (let index = 0; index < contract.parameters.length; index += 1) {
    const parameter = contract.parameters[index];
    const native = method.parameters[index];
    if (native.name !== null && native.name !== parameter.name) {
      throw new DiagnosticError(
        fileName,
        parameter.location,
        `declaration parameter ${JSON.stringify(parameter.name)} does not match native parameter ${JSON.stringify(native.name)} at position ${index + 1}`,
        { code: "Z0801" },
      );
    }
    const callback = callbacks.get(parameter.name);
    if (native.type.kind !== "block") {
      if (callback) {
        throw new DiagnosticError(
          fileName,
          callback.parameterLocation,
          `callback contract parameter ${JSON.stringify(parameter.name)} is not an Objective-C block`,
          { code: "Z0801" },
        );
      }
      if (parameter.mode !== "value") {
        throw new DiagnosticError(
          fileName,
          parameter.location,
          `non-block Objective-C parameter ${JSON.stringify(parameter.name)} cannot use ${parameter.mode} in this contract tier`,
          { code: "Z0801" },
        );
      }
      continue;
    }
    validateObjCBlockContract(parameter, native.type, callback, fileName);
    parameters[String(index)] = {
      callback: {
        lifetime: native.type.escaping ? "escape" : "call",
        ...(callback?.thread ? { thread: callback.thread } : {}),
      },
    };
  }
  for (const callback of contract.callbacks) {
    if (!contract.parameters.some((parameter) => parameter.name === callback.parameter)) {
      throw new DiagnosticError(
        fileName,
        callback.parameterLocation,
        `callback contract names unknown parameter ${JSON.stringify(callback.parameter)} on ${JSON.stringify(contract.name)}`,
        { code: "Z0801" },
      );
    }
  }
  let asyncProjection: {
    readonly callbackParameter: number;
    readonly resultParameter: number | null;
    readonly errorParameter: number | null;
  } | undefined;
  if (contract.asyncCallback) {
    const callbackIndex = contract.parameters.findIndex((parameter) => parameter.name === contract.asyncCallback);
    if (callbackIndex < 0) {
      throw new DiagnosticError(
        fileName,
        contract.asyncCallbackLocation!,
        `async contract names unknown callback parameter ${JSON.stringify(contract.asyncCallback)} on ${JSON.stringify(contract.name)}`,
        { code: "Z0801" },
      );
    }
    const parameter = contract.parameters[callbackIndex];
    const native = method.parameters[callbackIndex];
    const callback = callbacks.get(contract.asyncCallback);
    if (native.type.kind !== "block" || !callback) {
      throw new DiagnosticError(
        fileName,
        contract.asyncCallbackLocation!,
        `async callback ${JSON.stringify(contract.asyncCallback)} must name a declared Objective-C block callback`,
        { code: "Z0801" },
      );
    }
    if (callbackIndex !== contract.parameters.length - 1) {
      throw new DiagnosticError(
        fileName,
        contract.asyncCallbackLocation!,
        `async callback ${JSON.stringify(contract.asyncCallback)} must be the terminal native parameter in the first projection tier`,
        { code: "Z0801" },
      );
    }
    if (!native.type.escaping || parameter.mode !== "move") {
      throw new DiagnosticError(
        fileName,
        contract.asyncCallbackLocation!,
        `async callback ${JSON.stringify(contract.asyncCallback)} must be an escaping move block`,
        { code: "Z0801" },
      );
    }
    if (callback.thread !== "caller" && callback.thread !== "any") {
      throw new DiagnosticError(
        fileName,
        contract.asyncCallbackLocation!,
        `async callback ${JSON.stringify(contract.asyncCallback)} requires a caller or any thread guarantee`,
        { code: "Z0801" },
      );
    }
    if (!isVoidForeignType(method.returnType)) {
      throw new DiagnosticError(
        fileName,
        contract.returnLocation,
        "an async Objective-C projection currently requires the native method to return void",
        { code: "Z0801" },
      );
    }
    if (!isVoidForeignType(native.type.returnType)) {
      throw new DiagnosticError(
        fileName,
        contract.asyncCallbackLocation!,
        "an async Objective-C projection currently requires its callback to return void",
        { code: "Z0801" },
      );
    }
    const expanded = contract.asyncBindings.length > 0;
    if (!expanded && native.type.parameters.length > 1) {
      throw new DiagnosticError(
        fileName,
        contract.asyncCallbackLocation!,
        `an async Objective-C projection currently supports zero or one callback value, found ${native.type.parameters.length}`,
        { code: "Z0801" },
      );
    }
    if (expanded && native.type.parameters.length !== contract.asyncBindings.length) {
      throw new DiagnosticError(
        fileName,
        contract.asyncCallbackLocation!,
        `async callback projection declares ${contract.asyncBindings.length} binding(s), but the native block receives ${native.type.parameters.length}`,
        { code: "Z0801" },
      );
    }
    const resultParameter = contract.asyncReturnBinding === null
      ? expanded ? null : native.type.parameters.length === 1 ? 0 : null
      : contract.asyncBindings.findIndex((binding) => binding.name === contract.asyncReturnBinding);
    if (contract.asyncReturnBinding !== null && resultParameter < 0) {
      throw new DiagnosticError(
        fileName,
        contract.asyncReturnLocation!,
        `return names unknown async callback binding ${JSON.stringify(contract.asyncReturnBinding)}`,
        { code: "Z0801" },
      );
    }
    const errorParameter = contract.asyncThrowBinding === null
      ? null
      : contract.asyncBindings.findIndex((binding) => binding.name === contract.asyncThrowBinding);
    if (contract.asyncThrowBinding !== null && errorParameter < 0) {
      throw new DiagnosticError(
        fileName,
        contract.asyncThrowLocation!,
        `throw names unknown async callback binding ${JSON.stringify(contract.asyncThrowBinding)}`,
        { code: "Z0801" },
      );
    }
    if (resultParameter !== null && resultParameter === errorParameter) {
      throw new DiagnosticError(
        fileName,
        contract.asyncThrowLocation!,
        "the same async callback binding cannot be both returned and thrown",
        { code: "Z0801" },
      );
    }
    if (errorParameter !== null) {
      const errorType = native.type.parameters[errorParameter];
      if (errorType.kind !== "object" || !errorType.nullable) {
        throw new DiagnosticError(
          fileName,
          contract.asyncThrowLocation!,
          `the first typed async projection tier requires a nullable Objective-C error reference, found ${JSON.stringify(errorType.cName)}`,
          { code: "Z0801" },
        );
      }
    }
    asyncProjection = { callbackParameter: callbackIndex, resultParameter, errorParameter };
  }
  return {
    ...(contract.executorAffinity ? { executorAffinity: contract.executorAffinity } : {}),
    ...(Object.keys(parameters).length ? { parameters } : {}),
    ...(asyncProjection ? { async: asyncProjection } : {}),
  };
}

function isVoidForeignType(type: ForeignBlockType["returnType"]): boolean {
  return type.kind === "z" && type.name === "void";
}

function validateObjCBlockContract(
  parameter: ContractParameter,
  block: ForeignBlockType,
  callback: ForeignCallbackContract | undefined,
  fileName: string,
): void {
  if (!callback) {
    throw new DiagnosticError(
      fileName,
      parameter.location,
      `Objective-C block parameter ${JSON.stringify(parameter.name)} requires a callback contract`,
      {
        code: "Z0801",
        helps: [`add \`callback ${parameter.name} { thread caller; }\` or \`thread any;\``],
      },
    );
  }
  if (callback.context || callback.release) {
    throw new DiagnosticError(
      fileName,
      callback.location,
      `Objective-C block ${JSON.stringify(parameter.name)} is ARC-owned and cannot declare context or deinit parameters`,
      { code: "Z0801" },
    );
  }
  const expectedMode = block.escaping ? "move" : "in";
  if (parameter.mode !== expectedMode) {
    throw new DiagnosticError(
      fileName,
      parameter.location,
      `${block.escaping ? "escaping" : "non-escaping"} Objective-C block ${JSON.stringify(parameter.name)} requires ${expectedMode}`,
      { code: "Z0801" },
    );
  }
  if (!callback.thread) {
    throw new DiagnosticError(
      fileName,
      callback.location,
      `Objective-C block ${JSON.stringify(parameter.name)} requires an explicit thread guarantee`,
      {
        code: "Z0214",
        helps: ["add `thread caller;` or `thread any;` after verifying the native API"],
      },
    );
  }
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
