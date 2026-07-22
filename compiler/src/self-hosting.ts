import type { Token, TokenKind } from "./lexer.ts";

export type Stage1DeclarationKind = "import" | "function" | "struct" | "class" | "trait" | "enum";

export type Stage1Declaration = {
  readonly kind: Stage1DeclarationKind;
  readonly name: string;
  readonly exported: boolean;
  readonly asynchronous: boolean;
  readonly location: {
    readonly offset: number;
    readonly line: number;
    readonly column: number;
    readonly fileName: string;
  };
};

export type Stage1FunctionSignature = {
  readonly text: string;
  readonly location: {
    readonly offset: number;
    readonly line: number;
    readonly column: number;
    readonly fileName: string;
  };
};

export type Stage1FunctionBody = {
  readonly text: string;
  readonly location: {
    readonly offset: number;
    readonly line: number;
    readonly column: number;
    readonly fileName: string;
  };
};

export type Stage1ImportShape = {
  readonly text: string;
  readonly location: {
    readonly offset: number;
    readonly line: number;
    readonly column: number;
    readonly fileName: string;
  };
};

export type Stage1TypeShapeKind = "struct" | "class" | "trait" | "enum";

export type Stage1TypeShape = {
  readonly kind: Stage1TypeShapeKind;
  readonly text: string;
  readonly location: {
    readonly offset: number;
    readonly line: number;
    readonly column: number;
    readonly fileName: string;
  };
};

export type Stage1Program = {
  readonly declarations: readonly Stage1Declaration[];
  readonly importShapes: readonly Stage1ImportShape[];
  readonly functionSignatures: readonly Stage1FunctionSignature[];
  readonly functionBodies: readonly Stage1FunctionBody[];
  readonly typeShapes: readonly Stage1TypeShape[];
};

export type Stage1ProgramBatch = ReadonlyMap<string, Stage1Program>;

export type Stage1ModuleSource = {
  readonly path: string;
  readonly source: string;
};

export type Stage1ResolvedModule = {
  readonly path: string;
  readonly dependencies: readonly number[];
  readonly symbols: readonly Stage1ModuleSymbol[];
  readonly callResolutions: readonly Stage1ModuleCallResolution[];
  readonly bindingResolutions: readonly Stage1ModuleBindingResolution[];
};

export type Stage1ModuleBindingResolution = {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly name: string;
  readonly mutableBinding: boolean;
  readonly typeName: string;
  readonly targetModule: number | null;
  readonly targetSymbol: number | null;
};

export type Stage1ModuleCallResolution = {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly targetModule: number;
  readonly targetSymbol: number;
  readonly kind: "function" | "method" | "constructor";
  readonly targetName: string;
  readonly asynchronous: boolean;
  readonly receiverMode: string;
  readonly typeParameters: readonly string[];
  readonly typeArguments: readonly string[];
  readonly parameterModes: readonly ("value" | "in" | "inout" | "out")[];
  readonly parameterTypes: readonly string[];
  readonly returnType: string;
  readonly errorType: string | null;
};

export type Stage1ModuleSymbolKind = "function" | "struct" | "class" | "trait" | "enum" | "namespace" | "imported";

export type Stage1ModuleSymbol = {
  readonly name: string;
  readonly kind: Stage1ModuleSymbolKind;
  readonly exported: boolean;
  readonly targetModule: number | null;
  readonly importedName: string;
  readonly functionSignature: Stage1ModuleFunctionSignature | null;
  readonly typeSignature: Stage1ModuleTypeSignature | null;
  readonly location: {
    readonly offset: number;
    readonly line: number;
    readonly column: number;
  };
};

export type Stage1ModuleFieldSignature = {
  readonly name: string;
  readonly typeName: string;
  readonly visibility: "public" | "private";
  readonly readonlyField: boolean;
};

export type Stage1ModuleVariantSignature = {
  readonly name: string;
  readonly payloadType: string | null;
};

export type Stage1ModuleMethodSignature = {
  readonly name: string;
  readonly staticMethod: boolean;
  readonly visibility: "public" | "private";
  readonly receiverMode: "in" | "inout" | "move";
  readonly signature: Stage1ModuleFunctionSignature;
};

export type Stage1ModuleTypeParameterConstraint = {
  readonly parameter: string;
  readonly traitName: string;
};

export type Stage1ModuleTypeSignature = {
  readonly typeParameters: readonly string[];
  readonly typeParameterConstraints: readonly Stage1ModuleTypeParameterConstraint[];
  readonly implementedTraits: readonly string[];
  readonly fields: readonly Stage1ModuleFieldSignature[];
  readonly methods: readonly Stage1ModuleMethodSignature[];
  readonly variants: readonly Stage1ModuleVariantSignature[];
  readonly customDeinit: boolean;
  readonly customConstructor: boolean;
  readonly constructorSignature: Stage1ModuleFunctionSignature | null;
};

export type Stage1ModuleFunctionSignature = {
  readonly asynchronous: boolean;
  readonly typeParameters: readonly string[];
  readonly typeParameterConstraints: readonly Stage1ModuleTypeParameterConstraint[];
  readonly parameterModes: readonly ("value" | "in" | "inout" | "out")[];
  readonly parameterTypes: readonly string[];
  readonly returnType: string;
  readonly errorType: string | null;
};

export type Stage1ModuleGraph = {
  readonly modules: readonly Stage1ResolvedModule[];
  readonly dependencyOrder: readonly number[];
  readonly entry: number;
};

export function encodeStage1ModuleBatch(sources: readonly Stage1ModuleSource[]): Buffer {
  const records: Buffer[] = [];
  for (const source of sources) {
    const path = Buffer.from(source.path, "utf8");
    const text = Buffer.from(source.source, "utf8");
    const header = Buffer.from(
      path.byteLength.toString(16).padStart(16, "0")
      + text.byteLength.toString(16).padStart(16, "0"),
      "ascii",
    );
    records.push(header, path, text);
  }
  return Buffer.concat(records);
}

export function decodeStage1ModuleGraphStream(output: string): Stage1ModuleGraph {
  let entry: number | null = null;
  let dependencyOrder: number[] | null = null;
  const modules: Stage1ResolvedModule[] = [];
  for (const line of output.split("\n").filter((candidate) => candidate.length > 0)) {
    const fields = line.split("\t");
    if (fields[0] === "entry") {
      if (entry !== null || fields.length !== 2) throw new Error(`malformed stage-1 module entry line: ${line}`);
      entry = parseProtocolHexInteger(fields[1], "module entry");
      continue;
    }
    if (fields[0] === "module") {
      if (fields.length < 2 || !/^(?:[0-9a-f]{2})*$/.test(fields[1])) {
        throw new Error(`malformed stage-1 module line: ${line}`);
      }
      modules.push({
        path: Buffer.from(fields[1], "hex").toString("utf8"),
        dependencies: fields.slice(2).map((field) => parseProtocolHexInteger(field, "module dependency")),
        symbols: [],
        callResolutions: [],
        bindingResolutions: [],
      });
      continue;
    }
    if (fields[0] === "symbol") {
      if (fields.length !== 10) throw new Error(`malformed stage-1 module symbol line: ${line}`);
      const [, moduleText, kind, nameText, exportedText, targetText, importedNameText, offsetText, lineText, columnText] = fields;
      const moduleIndex = parseProtocolHexInteger(moduleText, "symbol module");
      const module = modules[moduleIndex];
      if (!module) throw new Error("stage-1 module symbol appeared before its module");
      if (!isStage1ModuleSymbolKind(kind)) throw new Error(`malformed stage-1 module symbol kind: ${kind}`);
      if (!/^(?:[0-9a-f]{2})*$/.test(nameText) || !/^(?:[0-9a-f]{2})*$/.test(importedNameText)) {
        throw new Error(`malformed stage-1 module symbol text: ${line}`);
      }
      if (exportedText !== "0" && exportedText !== "1") {
        throw new Error(`malformed stage-1 module symbol export state: ${exportedText}`);
      }
      (module.symbols as Stage1ModuleSymbol[]).push({
        name: Buffer.from(nameText, "hex").toString("utf8"),
        kind,
        exported: exportedText === "1",
        targetModule: targetText === "-" ? null : parseProtocolHexInteger(targetText, "symbol target"),
        importedName: Buffer.from(importedNameText, "hex").toString("utf8"),
        functionSignature: null,
        typeSignature: null,
        location: {
          offset: parseProtocolHexInteger(offsetText, "symbol offset"),
          line: parseProtocolHexInteger(lineText, "symbol line"),
          column: parseProtocolHexInteger(columnText, "symbol column"),
        },
      });
      continue;
    }
    if (fields[0] === "callResolution") {
      if (fields.length < 15) throw new Error(`malformed stage-1 call resolution line: ${line}`);
      const moduleIndex = parseProtocolHexInteger(fields[1], "call resolution module");
      const module = modules[moduleIndex];
      if (!module) throw new Error("stage-1 call resolution appeared before its module");
      const kind = Buffer.from(fields[7], "hex").toString("utf8");
      if (kind !== "function" && kind !== "method" && kind !== "constructor") {
        throw new Error(`malformed stage-1 call resolution kind: ${kind}`);
      }
      if (fields[9] !== "0" && fields[9] !== "1") {
        throw new Error(`malformed stage-1 call resolution async state: ${fields[9]}`);
      }
      const encodedText = [fields[7], fields[8], fields[10], fields[11], fields[12]];
      if (encodedText.some((field) => !/^(?:[0-9a-f]{2})*$/.test(field))) {
        throw new Error(`malformed stage-1 call resolution text: ${line}`);
      }
      const typeCount = parseProtocolHexInteger(fields[13], "call resolution type count");
      const parameterCount = parseProtocolHexInteger(fields[14], "call resolution parameter count");
      if (fields.length !== 15 + (typeCount * 2) + (parameterCount * 2)) {
        throw new Error(`malformed stage-1 call resolution arity: ${line}`);
      }
      const encodedTypes = fields.slice(15, 15 + (typeCount * 2));
      const encodedParameters = fields.slice(15 + (typeCount * 2));
      if (
        encodedTypes.some((field) => !/^(?:[0-9a-f]{2})*$/.test(field))
        || encodedParameters.some((field) => !/^(?:[0-9a-f]{2})*$/.test(field))
      ) {
        throw new Error(`malformed stage-1 call resolution contract: ${line}`);
      }
      const parameterModes = encodedParameters.filter((_, index) => index % 2 === 0)
        .map((field) => Buffer.from(field, "hex").toString("utf8"));
      if (!parameterModes.every(isStage1ParameterMode)) {
        throw new Error(`malformed stage-1 call resolution parameter mode: ${line}`);
      }
      (module.callResolutions as Stage1ModuleCallResolution[]).push({
        offset: parseProtocolHexInteger(fields[2], "call resolution offset"),
        line: parseProtocolHexInteger(fields[3], "call resolution line"),
        column: parseProtocolHexInteger(fields[4], "call resolution column"),
        targetModule: parseProtocolHexInteger(fields[5], "call resolution target module"),
        targetSymbol: parseProtocolHexInteger(fields[6], "call resolution target symbol"),
        kind,
        targetName: Buffer.from(fields[8], "hex").toString("utf8"),
        asynchronous: fields[9] === "1",
        receiverMode: Buffer.from(fields[10], "hex").toString("utf8"),
        returnType: Buffer.from(fields[11], "hex").toString("utf8"),
        errorType: fields[12].length === 0 ? null : Buffer.from(fields[12], "hex").toString("utf8"),
        typeParameters: encodedTypes.filter((_, index) => index % 2 === 0)
          .map((field) => Buffer.from(field, "hex").toString("utf8")),
        typeArguments: encodedTypes.filter((_, index) => index % 2 === 1)
          .map((field) => Buffer.from(field, "hex").toString("utf8")),
        parameterModes,
        parameterTypes: encodedParameters.filter((_, index) => index % 2 === 1)
          .map((field) => Buffer.from(field, "hex").toString("utf8")),
      });
      continue;
    }
    if (fields[0] === "bindingResolution") {
      if (fields.length !== 10) throw new Error(`malformed stage-1 binding resolution line: ${line}`);
      const moduleIndex = parseProtocolHexInteger(fields[1], "binding resolution module");
      const module = modules[moduleIndex];
      if (!module) throw new Error("stage-1 binding resolution appeared before its module");
      if (fields[6] !== "0" && fields[6] !== "1") {
        throw new Error(`malformed stage-1 binding resolution mutability: ${fields[6]}`);
      }
      if (!/^(?:[0-9a-f]{2})*$/.test(fields[5]) || !/^(?:[0-9a-f]{2})*$/.test(fields[7])) {
        throw new Error(`malformed stage-1 binding resolution text: ${line}`);
      }
      (module.bindingResolutions as Stage1ModuleBindingResolution[]).push({
        offset: parseProtocolHexInteger(fields[2], "binding resolution offset"),
        line: parseProtocolHexInteger(fields[3], "binding resolution line"),
        column: parseProtocolHexInteger(fields[4], "binding resolution column"),
        name: Buffer.from(fields[5], "hex").toString("utf8"),
        mutableBinding: fields[6] === "1",
        typeName: Buffer.from(fields[7], "hex").toString("utf8"),
        targetModule: fields[8] === "-" ? null : parseProtocolHexInteger(fields[8], "binding resolution target module"),
        targetSymbol: fields[9] === "-" ? null : parseProtocolHexInteger(fields[9], "binding resolution target symbol"),
      });
      continue;
    }
    if (fields[0] === "functionConstraint") {
      if (fields.length !== 5 || !fields.slice(3).every((field) => /^(?:[0-9a-f]{2})*$/.test(field))) {
        throw new Error(`malformed stage-1 function constraint: ${line}`);
      }
      const moduleIndex = parseProtocolHexInteger(fields[1], "function constraint module");
      const symbolIndex = parseProtocolHexInteger(fields[2], "function constraint symbol");
      const signature = modules[moduleIndex]?.symbols[symbolIndex]?.functionSignature;
      if (!signature) throw new Error("stage-1 function constraint appeared before its signature");
      (signature.typeParameterConstraints as Stage1ModuleTypeParameterConstraint[]).push({
        parameter: Buffer.from(fields[3], "hex").toString("utf8"),
        traitName: Buffer.from(fields[4], "hex").toString("utf8"),
      });
      continue;
    }
    if (fields[0] === "typeConstraint") {
      if (fields.length !== 5 || !fields.slice(3).every((field) => /^(?:[0-9a-f]{2})*$/.test(field))) {
        throw new Error(`malformed stage-1 type constraint: ${line}`);
      }
      const moduleIndex = parseProtocolHexInteger(fields[1], "type constraint module");
      const symbolIndex = parseProtocolHexInteger(fields[2], "type constraint symbol");
      const signature = modules[moduleIndex]?.symbols[symbolIndex]?.typeSignature;
      if (!signature) throw new Error("stage-1 type constraint appeared before its signature");
      (signature.typeParameterConstraints as Stage1ModuleTypeParameterConstraint[]).push({
        parameter: Buffer.from(fields[3], "hex").toString("utf8"),
        traitName: Buffer.from(fields[4], "hex").toString("utf8"),
      });
      continue;
    }
    if (fields[0] === "implements") {
      if (fields.length !== 4 || !/^(?:[0-9a-f]{2})*$/.test(fields[3])) {
        throw new Error(`malformed stage-1 implemented trait: ${line}`);
      }
      const moduleIndex = parseProtocolHexInteger(fields[1], "implemented trait module");
      const symbolIndex = parseProtocolHexInteger(fields[2], "implemented trait symbol");
      const signature = modules[moduleIndex]?.symbols[symbolIndex]?.typeSignature;
      if (!signature) throw new Error("stage-1 implemented trait appeared before its type signature");
      (signature.implementedTraits as string[]).push(Buffer.from(fields[3], "hex").toString("utf8"));
      continue;
    }
    if (fields[0] === "methodConstraint") {
      if (fields.length !== 6 || !fields.slice(3).every((field) => /^(?:[0-9a-f]{2})*$/.test(field))) {
        throw new Error(`malformed stage-1 method constraint: ${line}`);
      }
      const moduleIndex = parseProtocolHexInteger(fields[1], "method constraint module");
      const symbolIndex = parseProtocolHexInteger(fields[2], "method constraint symbol");
      const signature = modules[moduleIndex]?.symbols[symbolIndex]?.typeSignature;
      const methodName = Buffer.from(fields[3], "hex").toString("utf8");
      const method = signature?.methods.find((candidate) => candidate.name === methodName);
      if (!method) throw new Error("stage-1 method constraint appeared before its method signature");
      (method.signature.typeParameterConstraints as Stage1ModuleTypeParameterConstraint[]).push({
        parameter: Buffer.from(fields[4], "hex").toString("utf8"),
        traitName: Buffer.from(fields[5], "hex").toString("utf8"),
      });
      continue;
    }
    if (fields[0] === "typeSignature") {
      if (fields.length < 8) throw new Error(`malformed stage-1 type signature line: ${line}`);
      const moduleIndex = parseProtocolHexInteger(fields[1], "type signature module");
      const symbolIndex = parseProtocolHexInteger(fields[2], "type signature symbol");
      const symbol = modules[moduleIndex]?.symbols[symbolIndex] as Stage1ModuleSymbol | undefined;
      if (!symbol) throw new Error("stage-1 type signature appeared before its symbol");
      if (
        (symbol.kind !== "struct" && symbol.kind !== "class" && symbol.kind !== "trait" && symbol.kind !== "enum")
        || symbol.typeSignature !== null
      ) {
        throw new Error("stage-1 type signature does not identify an unsigned type symbol");
      }
      const typeParameterCount = parseProtocolHexInteger(fields[3], "type signature parameter count");
      const fieldCount = parseProtocolHexInteger(fields[4], "type signature field count");
      const variantCount = parseProtocolHexInteger(fields[5], "type signature variant count");
      const customDeinit = fields[6];
      if (customDeinit !== "0" && customDeinit !== "1") {
        throw new Error(`malformed stage-1 type signature deinit state: ${line}`);
      }
      const customConstructor = fields[7];
      if (customConstructor !== "0" && customConstructor !== "1") {
        throw new Error(`malformed stage-1 type signature constructor state: ${line}`);
      }
      if (fields.length !== 8 + typeParameterCount + (fieldCount * 4) + (variantCount * 2)) {
        throw new Error(`malformed stage-1 type signature arity: ${line}`);
      }
      const encoded = fields.slice(8);
      const typeParameters = encoded.slice(0, typeParameterCount);
      const encodedFields = encoded.slice(typeParameterCount, typeParameterCount + (fieldCount * 4));
      const encodedVariants = encoded.slice(typeParameterCount + (fieldCount * 4));
      if (
        typeParameters.some((field) => !/^(?:[0-9a-f]{2})*$/.test(field))
        || encodedFields.some((field, index) => index % 4 !== 3 && !/^(?:[0-9a-f]{2})*$/.test(field))
        || encodedVariants.some((field) => !/^(?:[0-9a-f]{2})*$/.test(field))
      ) {
        throw new Error(`malformed stage-1 type signature text: ${line}`);
      }
      const decodedFields: Stage1ModuleFieldSignature[] = [];
      for (let index = 0; index < encodedFields.length; index += 4) {
        const visibility = Buffer.from(encodedFields[index + 2], "hex").toString("utf8");
        const readonlyField = encodedFields[index + 3];
        if (visibility !== "public" && visibility !== "private") {
          throw new Error(`malformed stage-1 field visibility: ${line}`);
        }
        if (readonlyField !== "0" && readonlyField !== "1") {
          throw new Error(`malformed stage-1 field readonly state: ${line}`);
        }
        decodedFields.push({
          name: Buffer.from(encodedFields[index], "hex").toString("utf8"),
          typeName: Buffer.from(encodedFields[index + 1], "hex").toString("utf8"),
          visibility,
          readonlyField: readonlyField === "1",
        });
      }
      const decodedVariants: Stage1ModuleVariantSignature[] = [];
      for (let index = 0; index < encodedVariants.length; index += 2) {
        decodedVariants.push({
          name: Buffer.from(encodedVariants[index], "hex").toString("utf8"),
          payloadType: encodedVariants[index + 1].length === 0
            ? null
            : Buffer.from(encodedVariants[index + 1], "hex").toString("utf8"),
        });
      }
      (symbol as { typeSignature: Stage1ModuleTypeSignature | null }).typeSignature = {
        typeParameters: typeParameters.map((field) => Buffer.from(field, "hex").toString("utf8")),
        typeParameterConstraints: [],
        implementedTraits: [],
        fields: decodedFields,
        methods: [],
        variants: decodedVariants,
        customDeinit: customDeinit === "1",
        customConstructor: customConstructor === "1",
        constructorSignature: null,
      };
      continue;
    }
    if (fields[0] === "constructorSignature") {
      if (fields.length < 8) throw new Error(`malformed stage-1 constructor signature line: ${line}`);
      const moduleIndex = parseProtocolHexInteger(fields[1], "constructor signature module");
      const symbolIndex = parseProtocolHexInteger(fields[2], "constructor signature symbol");
      const symbol = modules[moduleIndex]?.symbols[symbolIndex] as Stage1ModuleSymbol | undefined;
      if (
        !symbol?.typeSignature
        || !symbol.typeSignature.customConstructor
        || symbol.typeSignature.constructorSignature !== null
      ) {
        throw new Error("stage-1 constructor signature does not identify an unsigned constructor type");
      }
      if (fields[3] !== "0") {
        throw new Error(`malformed stage-1 constructor async state: ${fields[3]}`);
      }
      if (!/^(?:[0-9a-f]{2})*$/.test(fields[4]) || !/^(?:[0-9a-f]{2})*$/.test(fields[5])) {
        throw new Error(`malformed stage-1 constructor signature text: ${line}`);
      }
      const typeParameterCount = parseProtocolHexInteger(fields[6], "constructor type parameter count");
      const parameterCount = parseProtocolHexInteger(fields[7], "constructor parameter count");
      if (fields.length !== 8 + typeParameterCount + (parameterCount * 2)) {
        throw new Error(`malformed stage-1 constructor signature arity: ${line}`);
      }
      const encodedTypes = fields.slice(8);
      if (encodedTypes.some((field) => !/^(?:[0-9a-f]{2})*$/.test(field))) {
        throw new Error(`malformed stage-1 constructor signature type: ${line}`);
      }
      const encodedParameters = encodedTypes.slice(typeParameterCount);
      const parameterModes = encodedParameters.filter((_, index) => index % 2 === 0)
        .map((field) => Buffer.from(field, "hex").toString("utf8"));
      if (!parameterModes.every(isStage1ParameterMode)) {
        throw new Error(`malformed stage-1 constructor parameter mode: ${line}`);
      }
      (symbol.typeSignature as { constructorSignature: Stage1ModuleFunctionSignature | null }).constructorSignature = {
        asynchronous: false,
        returnType: Buffer.from(fields[4], "hex").toString("utf8"),
        errorType: fields[5].length === 0 ? null : Buffer.from(fields[5], "hex").toString("utf8"),
        typeParameters: encodedTypes.slice(0, typeParameterCount)
          .map((field) => Buffer.from(field, "hex").toString("utf8")),
        typeParameterConstraints: [],
        parameterModes,
        parameterTypes: encodedParameters.filter((_, index) => index % 2 === 1)
          .map((field) => Buffer.from(field, "hex").toString("utf8")),
      };
      continue;
    }
    if (fields[0] === "methodSignature") {
      if (fields.length < 12) throw new Error(`malformed stage-1 method signature line: ${line}`);
      const moduleIndex = parseProtocolHexInteger(fields[1], "method signature module");
      const symbolIndex = parseProtocolHexInteger(fields[2], "method signature symbol");
      const symbol = modules[moduleIndex]?.symbols[symbolIndex] as Stage1ModuleSymbol | undefined;
      if (!symbol?.typeSignature) throw new Error("stage-1 method signature appeared before its type signature");
      if (fields[4] !== "0" && fields[4] !== "1") {
        throw new Error(`malformed stage-1 method static state: ${fields[4]}`);
      }
      if (fields[7] !== "0" && fields[7] !== "1") {
        throw new Error(`malformed stage-1 method async state: ${fields[7]}`);
      }
      if (![fields[3], fields[5], fields[6], fields[8], fields[9]].every((field) => /^(?:[0-9a-f]{2})*$/.test(field))) {
        throw new Error(`malformed stage-1 method signature text: ${line}`);
      }
      const visibility = Buffer.from(fields[5], "hex").toString("utf8");
      const receiverMode = Buffer.from(fields[6], "hex").toString("utf8");
      if (visibility !== "public" && visibility !== "private") {
        throw new Error(`malformed stage-1 method visibility: ${line}`);
      }
      if (receiverMode !== "in" && receiverMode !== "inout" && receiverMode !== "move") {
        throw new Error(`malformed stage-1 method receiver mode: ${line}`);
      }
      const typeParameterCount = parseProtocolHexInteger(fields[10], "method type parameter count");
      const parameterCount = parseProtocolHexInteger(fields[11], "method parameter count");
      if (fields.length !== 12 + typeParameterCount + (parameterCount * 2)) {
        throw new Error(`malformed stage-1 method signature arity: ${line}`);
      }
      const encodedTypes = fields.slice(12);
      if (encodedTypes.some((field) => !/^(?:[0-9a-f]{2})*$/.test(field))) {
        throw new Error(`malformed stage-1 method signature type: ${line}`);
      }
      const encodedParameters = encodedTypes.slice(typeParameterCount);
      const parameterModes = encodedParameters.filter((_, index) => index % 2 === 0)
        .map((field) => Buffer.from(field, "hex").toString("utf8"));
      if (!parameterModes.every(isStage1ParameterMode)) {
        throw new Error(`malformed stage-1 method parameter mode: ${line}`);
      }
      (symbol.typeSignature.methods as Stage1ModuleMethodSignature[]).push({
        name: Buffer.from(fields[3], "hex").toString("utf8"),
        staticMethod: fields[4] === "1",
        visibility,
        receiverMode,
        signature: {
          asynchronous: fields[7] === "1",
          returnType: Buffer.from(fields[8], "hex").toString("utf8"),
          errorType: fields[9].length === 0 ? null : Buffer.from(fields[9], "hex").toString("utf8"),
          typeParameters: encodedTypes.slice(0, typeParameterCount)
            .map((field) => Buffer.from(field, "hex").toString("utf8")),
          typeParameterConstraints: [],
          parameterModes,
          parameterTypes: encodedParameters.filter((_, index) => index % 2 === 1)
            .map((field) => Buffer.from(field, "hex").toString("utf8")),
        },
      });
      continue;
    }
    if (fields[0] === "signature") {
      if (fields.length < 8) throw new Error(`malformed stage-1 function signature line: ${line}`);
      const moduleIndex = parseProtocolHexInteger(fields[1], "signature module");
      const symbolIndex = parseProtocolHexInteger(fields[2], "signature symbol");
      const symbol = modules[moduleIndex]?.symbols[symbolIndex] as Stage1ModuleSymbol | undefined;
      if (!symbol) throw new Error("stage-1 function signature appeared before its symbol");
      if (symbol.kind !== "function" || symbol.functionSignature !== null) {
        throw new Error("stage-1 function signature does not identify an unsigned function symbol");
      }
      if (fields[3] !== "0" && fields[3] !== "1") {
        throw new Error(`malformed stage-1 function async state: ${fields[3]}`);
      }
      if (!/^(?:[0-9a-f]{2})*$/.test(fields[4]) || !/^(?:[0-9a-f]{2})*$/.test(fields[5])) {
        throw new Error(`malformed stage-1 function signature text: ${line}`);
      }
      const typeParameterCount = parseProtocolHexInteger(fields[6], "signature type parameter count");
      const parameterCount = parseProtocolHexInteger(fields[7], "signature parameter count");
      if (fields.length !== 8 + typeParameterCount + (parameterCount * 2)) {
        throw new Error(`malformed stage-1 function signature arity: ${line}`);
      }
      const encodedTypes = fields.slice(8);
      if (encodedTypes.some((field) => !/^(?:[0-9a-f]{2})*$/.test(field))) {
        throw new Error(`malformed stage-1 function signature type: ${line}`);
      }
      const encodedParameters = encodedTypes.slice(typeParameterCount);
      const parameterModes = encodedParameters.filter((_, index) => index % 2 === 0)
        .map((field) => Buffer.from(field, "hex").toString("utf8"));
      if (!parameterModes.every(isStage1ParameterMode)) {
        throw new Error(`malformed stage-1 function parameter mode: ${line}`);
      }
      (symbol as { functionSignature: Stage1ModuleFunctionSignature | null }).functionSignature = {
        asynchronous: fields[3] === "1",
        returnType: Buffer.from(fields[4], "hex").toString("utf8"),
        errorType: fields[5].length === 0 ? null : Buffer.from(fields[5], "hex").toString("utf8"),
        typeParameters: encodedTypes.slice(0, typeParameterCount).map((field) => Buffer.from(field, "hex").toString("utf8")),
        typeParameterConstraints: [],
        parameterModes,
        parameterTypes: encodedParameters.filter((_, index) => index % 2 === 1)
          .map((field) => Buffer.from(field, "hex").toString("utf8")),
      };
      continue;
    }
    if (fields[0] === "order") {
      if (dependencyOrder !== null) throw new Error("duplicate stage-1 module dependency order");
      dependencyOrder = fields.slice(1).map((field) => parseProtocolHexInteger(field, "module order"));
      continue;
    }
    throw new Error(`unknown stage-1 module graph record: ${line}`);
  }
  if (entry === null) throw new Error("stage-1 module graph did not contain an entry");
  if (dependencyOrder === null) throw new Error("stage-1 module graph did not contain a dependency order");
  if (entry >= modules.length) throw new Error("stage-1 module graph entry is outside the module batch");
  for (const module of modules) {
    if (module.dependencies.some((dependency) => dependency >= modules.length)) {
      throw new Error("stage-1 module dependency is outside the module batch");
    }
    if (module.symbols.some((symbol) => symbol.targetModule !== null && symbol.targetModule >= modules.length)) {
      throw new Error("stage-1 module symbol target is outside the module batch");
    }
    if (module.callResolutions.some((resolution) => (
      resolution.targetModule >= modules.length
      || resolution.targetSymbol >= (modules[resolution.targetModule]?.symbols.length ?? 0)
    ))) {
      throw new Error("stage-1 call resolution target is outside the module graph");
    }
    if (module.symbols.some((symbol) => (
      symbol.typeSignature?.customConstructor === true
      && symbol.typeSignature.constructorSignature === null
    ))) {
      throw new Error("stage-1 custom constructor is missing its callable signature");
    }
  }
  if (dependencyOrder.some((index) => index >= modules.length)) {
    throw new Error("stage-1 module order is outside the module batch");
  }
  return { modules, dependencyOrder, entry };
}

function isStage1ParameterMode(value: string): value is "value" | "in" | "inout" | "out" {
  return value === "value" || value === "in" || value === "inout" || value === "out";
}

function isStage1ModuleSymbolKind(value: string): value is Stage1ModuleSymbolKind {
  return value === "function"
    || value === "struct"
    || value === "class"
    || value === "trait"
    || value === "enum"
    || value === "namespace"
    || value === "imported";
}

// Token parity still crosses a subprocess boundary. Keep that bootstrap protocol
// isolated here so the parser-facing Token shape does not learn about transport;
// parser parity reuses the decoders through its in-process native-library bridge.
export function decodeStage1TokenStream(output: string, fileName: string): readonly Token[] {
  return output.split("\n").filter((line) => line.length > 0).map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 5) throw new Error(`malformed stage-1 token line: ${line}`);
    const [kind, offsetText, lineText, columnText, hexadecimalText] = fields;
    if (!/^(?:[0-9a-f]{2})*$/.test(hexadecimalText)) {
      throw new Error(`malformed stage-1 token text: ${hexadecimalText}`);
    }
    const offset = parseProtocolHexInteger(offsetText, "token offset");
    const sourceLine = parseProtocolHexInteger(lineText, "token line");
    const column = parseProtocolHexInteger(columnText, "token column");
    return {
      kind: kind as TokenKind,
      text: Buffer.from(hexadecimalText, "hex").toString("utf8"),
      location: { offset, line: sourceLine, column, fileName },
    };
  });
}

export function decodeStage1DeclarationStream(output: string, fileName: string): readonly Stage1Declaration[] {
  return decodeStage1ProgramStream(output, fileName).declarations;
}

export function decodeStage1ProgramStream(output: string, fileName: string): Stage1Program {
  const declarations: Stage1Declaration[] = [];
  const importShapes: Stage1ImportShape[] = [];
  const functionSignatures: Stage1FunctionSignature[] = [];
  const functionBodies: Stage1FunctionBody[] = [];
  const typeShapes: Stage1TypeShape[] = [];
  for (const line of output.split("\n").filter((candidate) => candidate.length > 0)) {
    const fields = line.split("\t");
    if (fields[0] === "importShape") {
      if (fields.length !== 5) throw new Error(`malformed stage-1 import shape line: ${line}`);
      const [, offsetText, lineText, columnText, hexadecimalText] = fields;
      if (!/^(?:[0-9a-f]{2})*$/.test(hexadecimalText)) {
        throw new Error(`malformed stage-1 import shape text: ${hexadecimalText}`);
      }
      importShapes.push({
        text: Buffer.from(hexadecimalText, "hex").toString("utf8"),
        location: {
          offset: parseProtocolHexInteger(offsetText, "import shape offset"),
          line: parseProtocolHexInteger(lineText, "import shape line"),
          column: parseProtocolHexInteger(columnText, "import shape column"),
          fileName,
        },
      });
      continue;
    }
    if (fields[0] === "signature") {
      if (fields.length !== 5) throw new Error(`malformed stage-1 function signature line: ${line}`);
      const [, offsetText, lineText, columnText, hexadecimalText] = fields;
      if (!/^(?:[0-9a-f]{2})*$/.test(hexadecimalText)) {
        throw new Error(`malformed stage-1 function signature text: ${hexadecimalText}`);
      }
      functionSignatures.push({
        text: Buffer.from(hexadecimalText, "hex").toString("utf8"),
        location: {
          offset: parseProtocolHexInteger(offsetText, "function signature offset"),
          line: parseProtocolHexInteger(lineText, "function signature line"),
          column: parseProtocolHexInteger(columnText, "function signature column"),
          fileName,
        },
      });
      continue;
    }
    if (fields[0] === "body") {
      if (fields.length !== 5) throw new Error(`malformed stage-1 function body line: ${line}`);
      const [, offsetText, lineText, columnText, hexadecimalText] = fields;
      if (!/^(?:[0-9a-f]{2})*$/.test(hexadecimalText)) {
        throw new Error(`malformed stage-1 function body text: ${hexadecimalText}`);
      }
      functionBodies.push({
        text: Buffer.from(hexadecimalText, "hex").toString("utf8"),
        location: {
          offset: parseProtocolHexInteger(offsetText, "function body offset"),
          line: parseProtocolHexInteger(lineText, "function body line"),
          column: parseProtocolHexInteger(columnText, "function body column"),
          fileName,
        },
      });
      continue;
    }
    if (fields[0] === "shape") {
      if (fields.length !== 6) throw new Error(`malformed stage-1 type shape line: ${line}`);
      const [, kind, offsetText, lineText, columnText, hexadecimalText] = fields;
      if (!isStage1TypeShapeKind(kind)) throw new Error(`malformed stage-1 type shape kind: ${kind}`);
      if (!/^(?:[0-9a-f]{2})*$/.test(hexadecimalText)) {
        throw new Error(`malformed stage-1 type shape text: ${hexadecimalText}`);
      }
      typeShapes.push({
        kind,
        text: Buffer.from(hexadecimalText, "hex").toString("utf8"),
        location: {
          offset: parseProtocolHexInteger(offsetText, "type shape offset"),
          line: parseProtocolHexInteger(lineText, "type shape line"),
          column: parseProtocolHexInteger(columnText, "type shape column"),
          fileName,
        },
      });
      continue;
    }
    if (fields.length !== 7) throw new Error(`malformed stage-1 declaration line: ${line}`);
    const [kind, exportedText, asynchronousText, offsetText, lineText, columnText, hexadecimalName] = fields;
    if (!isStage1DeclarationKind(kind)) throw new Error(`malformed stage-1 declaration kind: ${kind}`);
    if (exportedText !== "0" && exportedText !== "1") {
      throw new Error(`malformed stage-1 declaration export state: ${exportedText}`);
    }
    if (asynchronousText !== "0" && asynchronousText !== "1") {
      throw new Error(`malformed stage-1 declaration async state: ${asynchronousText}`);
    }
    if (!/^(?:[0-9a-f]{2})*$/.test(hexadecimalName)) {
      throw new Error(`malformed stage-1 declaration name: ${hexadecimalName}`);
    }
    declarations.push({
      kind,
      name: Buffer.from(hexadecimalName, "hex").toString("utf8"),
      exported: exportedText === "1",
      asynchronous: asynchronousText === "1",
      location: {
        offset: parseProtocolHexInteger(offsetText, "declaration offset"),
        line: parseProtocolHexInteger(lineText, "declaration line"),
        column: parseProtocolHexInteger(columnText, "declaration column"),
        fileName,
      },
    });
  }
  typeShapes.sort((left, right) => left.location.offset - right.location.offset);
  importShapes.sort((left, right) => left.location.offset - right.location.offset);
  return { declarations, importShapes, functionSignatures, functionBodies, typeShapes };
}

export function decodeStage1ProgramBatchStream(output: string): Stage1ProgramBatch {
  const programs = new Map<string, Stage1Program>();
  let fileName: string | null = null;
  let records: string[] = [];

  const finishProgram = (): void => {
    if (fileName === null) return;
    programs.set(fileName, decodeStage1ProgramStream(records.join("\n"), fileName));
  };

  for (const line of output.split("\n").filter((candidate) => candidate.length > 0)) {
    const fields = line.split("\t");
    if (fields[0] !== "file") {
      if (fileName === null) throw new Error("stage-1 program record appeared before its file header");
      records.push(line);
      continue;
    }
    if (fields.length !== 2 || !/^(?:[0-9a-f]{2})*$/.test(fields[1])) {
      throw new Error(`malformed stage-1 file header: ${line}`);
    }
    finishProgram();
    fileName = Buffer.from(fields[1], "hex").toString("utf8");
    if (programs.has(fileName)) throw new Error(`duplicate stage-1 program for ${fileName}`);
    records = [];
  }
  finishProgram();
  if (fileName === null) throw new Error("stage-1 program stream did not contain a file header");
  return programs;
}

function isStage1TypeShapeKind(value: string): value is Stage1TypeShapeKind {
  return value === "struct" || value === "class" || value === "trait" || value === "enum";
}

function isStage1DeclarationKind(value: string): value is Stage1DeclarationKind {
  return value === "import"
    || value === "function"
    || value === "struct"
    || value === "class"
    || value === "trait"
    || value === "enum";
}

function parseProtocolHexInteger(text: string, field: string): number {
  if (!/^[0-9a-f]{16}$/.test(text)) {
    throw new Error(`malformed stage-1 ${field}: ${text}`);
  }
  const value = Number.parseInt(text, 16);
  if (!Number.isSafeInteger(value)) throw new Error(`stage-1 ${field} exceeds the stage-0 integer range`);
  return value;
}
