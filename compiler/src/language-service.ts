import type {
  Expression,
  ObjectExpression,
  Program,
  SourceLocation,
  Statement,
  StructDeclaration,
  StructExpression,
  TypeReference,
  TypeParameterConstraint,
} from "./ast.ts";
import { analyzeSource, type AnalyzedSource } from "./compiler.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type {
  ForeignCxxMethod,
  ForeignCxxStaticMethod,
  ForeignConstant,
  ForeignDeclarationMetadata,
  ForeignFunction,
  ForeignModule,
  ForeignObjCInterface,
  ForeignObjCMethod,
  ForeignObjCProperty,
  ForeignObjCProtocol,
  ForeignObjCProtocolMethod,
  ForeignType,
  ForeignNamedType,
} from "./foreign.ts";
import { lex } from "./lexer.ts";
import { parse } from "./parser.ts";
import { displayArrayType, parseDynamicArrayType, parseFixedArrayType, parseSliceType } from "./array-types.ts";
import { parseGenericType } from "./generic-types.ts";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isLocalSourceModuleSpecifier, type SourceModuleInfo } from "./modules.ts";
import { displayFunctionType, functionTypeName, parseFunctionType } from "./function-types.ts";
import { displayTaskType, parseTaskType } from "./async-types.ts";
import { parseWeakType } from "./weak-types.ts";
import { parseViewType } from "./view-types.ts";
import { parseMapType } from "./map-types.ts";
import { parseSetType } from "./set-types.ts";
import { parseAsyncGeneratorType, parseGeneratorType } from "./generator-types.ts";
import { publicObjCTypeName } from "./objc-types.ts";
import { displayUnsafeNativeType } from "./unsafe-types.ts";
import type { ExecutorAffinityInfo, ExplicitCopyPlan, IntegerConversion, ObjCCallInfo } from "./sema.ts";
import { collectForeignHandleTypeAliases } from "./foreign-handle-types.ts";
import {
  parseForeignDeclarationContracts,
  type ForeignDeclarationContracts,
} from "./foreign-declarations.ts";
import {
  fsLockTypeName,
  objcConnectionTypeName,
  standardFunctionSignature,
  standardModuleFunction,
  standardModuleMemberNames,
  type StandardFunctionName,
} from "./standard-library.ts";

export type Position = { readonly line: number; readonly character: number };
export type Range = { readonly start: Position; readonly end: Position };
export type ServiceDiagnostic = {
  readonly range: Range;
  readonly severity: 1 | 2;
  readonly source: "z";
  readonly code?: string;
  readonly message: string;
  readonly relatedInformation?: readonly {
    readonly location: { readonly uri: string; readonly range: Range };
    readonly message: string;
  }[];
  readonly data?: { readonly helps: readonly string[] };
};
export type CompletionItem = {
  readonly label: string;
  readonly kind: number;
  readonly detail?: string;
  readonly insertText?: string;
  readonly insertTextFormat?: 2;
  readonly sortText?: string;
};
export type Hover = { readonly contents: { readonly kind: "markdown"; readonly value: string }; readonly range?: Range };
export type Location = { readonly uri: string; readonly range: Range };

const completionKinds = {
  method: 2,
  function: 3,
  field: 5,
  class: 7,
  module: 9,
  property: 10,
  variable: 6,
  enum: 13,
  enumMember: 20,
  constant: 21,
  struct: 22,
  typeParameter: 25,
  interface: 8,
  keyword: 14,
} as const;

const sourceKeywordTokens = [
  "as", "async", "attempt", "await", "break", "class", "const", "constructor",
  "continue", "declare", "deinit", "else", "enum", "export", "for", "from",
  "function", "if", "implements", "import", "in", "inout", "let", "match", "module",
  "copy", "move", "mut", "new", "of", "on", "out", "private", "public", "return", "scope", "select",
  "readonly", "static", "struct", "task", "test", "throw", "throws", "trait", "type", "try", "unsafe", "view",
  "using", "weak", "while", "yield", "raw",
] as const;

const primitiveTypeTokens = [
  "void", "boolean", "String", "cstring", "Slice", "Array", "Option", "Result", "Task", "Weak",
  "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "usize", "isize",
] as const;

const declarationKeywordTokens = [
  "declare", "module", "export", "function", "type", "copy", "in", "inout", "out", "move", "deinit",
  "async", "callback", "context", "thread", "caller", "any", "transfer", "share", "fixed", "throws", "success", "failure",
  "owned", "borrowed",
  "connection", "option", "owner", "project", "data", "length", "from", "return", "throw", "invoked", "once", "repeatedly",
] as const;

export function diagnostics(source: string, fileName: string): ServiceDiagnostic[] {
  try {
    if (fileName.endsWith(".zd")) {
      const contracts = parseForeignDeclarationContracts(source, fileName);
      const declarationProbe = `import nativeContract from ${JSON.stringify(contracts.moduleSpecifier)};`;
      return analyzeSource(declarationProbe, fileName, {
        requireMain: false,
        foreignDeclarationOverrides: {
          [contracts.moduleSpecifier]: { source, fileName },
        },
      }).semanticInfo.warnings
        .map((warning) => serviceDiagnostic(warning, fileName));
    }
    return analyzeSource(source, fileName, { requireMain: false }).semanticInfo.warnings
      .map((warning) => serviceDiagnostic(warning, fileName));
  } catch (error) {
    return [error instanceof DiagnosticError
      ? serviceDiagnostic(error, fileName)
      : {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 1,
        source: "z",
        message: error instanceof Error ? error.message : String(error),
      }];
  }
}

function serviceDiagnostic(diagnostic: DiagnosticError, fileName: string): ServiceDiagnostic {
  const crossFile = resolve(diagnostic.fileName) !== resolve(fileName);
  const location = crossFile ? { offset: 0, line: 1, column: 1 } : diagnostic.location;
  const start = { line: location.line - 1, character: location.column - 1 };
  const relatedInformation = diagnostic.labels.map((label) => {
    const labelStart = { line: label.location.line - 1, character: label.location.column - 1 };
    return {
      location: {
        uri: diagnosticUri(label.location.fileName ?? diagnostic.fileName),
        range: {
          start: labelStart,
          end: { line: labelStart.line, character: labelStart.character + (label.length ?? 1) },
        },
      },
      message: label.message,
    };
  });
  if (crossFile) {
    const origin = { line: diagnostic.location.line - 1, character: diagnostic.location.column - 1 };
    relatedInformation.unshift({
      location: {
        uri: diagnosticUri(diagnostic.fileName),
        range: { start: origin, end: { line: origin.line, character: origin.character + diagnostic.length } },
      },
      message: `${diagnostic.severity} originates in an imported Z module or declaration contract`,
    });
  }
  return {
    range: { start, end: { line: start.line, character: start.character + diagnostic.length } },
    severity: diagnostic.severity === "warning" ? 2 : 1,
    source: "z",
    code: diagnostic.code ?? undefined,
    message: [
      crossFile ? `${diagnostic.fileName}: ${diagnostic.summary}` : diagnostic.summary,
      ...diagnostic.notes.map((note) => `note: ${note}`),
      ...diagnostic.helps.map((help) => `help: ${help}`),
    ].join("\n"),
    relatedInformation: relatedInformation.length ? relatedInformation : undefined,
    data: diagnostic.helps.length ? { helps: diagnostic.helps } : undefined,
  };
}

export function completions(source: string, fileName: string, offset: number): CompletionItem[] {
  if (fileName.endsWith(".zd")) return foreignDeclarationCompletions(source, fileName, offset);
  const selectiveImport = selectiveImportCompletions(source, fileName, offset);
  if (selectiveImport) return selectiveImport;
  const before = source.slice(0, offset);
  const nativeExport = /\bexport\s+([A-Za-z_]*)$/.exec(before);
  if (nativeExport) {
    return filterCompletions([{
      label: "c",
      kind: completionKinds.keyword,
      detail: "declare a checked public C ABI function or C-layout value type",
      insertText: "c ",
      sortText: "0-c",
    }], nativeExport[1], 3);
  }
  const rawLanguage = /\braw\s+([A-Za-z_]*)$/.exec(before);
  if (rawLanguage) {
    return filterCompletions(
      ["c", "cpp", "objc"].map((label) => ({
        label,
        kind: completionKinds.keyword,
        detail: `${label === "cpp" ? "C++" : label === "objc" ? "Objective-C" : "C"} native source body`,
        sortText: `0-${label}`,
      })),
      rawLanguage[1],
      3,
    );
  }
  if (/\busing\s*\([^)]*$/.test(before)) {
    const rawBoundary = /\braw\s+(?:c|cpp|objc)\s+using\s*\([^)]*$/.test(before);
    const symbols = symbolCompletions(source, fileName, offset, true);
    const capabilities: CompletionItem[] = [
      {
        label: "in",
        kind: completionKinds.keyword,
        detail: rawBoundary ? "read-only raw native operand" : "read-only executor capture loan",
        insertText: "in ",
        sortText: "0-in",
      },
      {
        label: "inout",
        kind: completionKinds.keyword,
        detail: rawBoundary ? "read/write raw native operand" : "exclusive mutable executor capture loan",
        insertText: "inout ",
        sortText: "0-inout",
      },
      rawBoundary ? {
        label: "out",
        kind: completionKinds.keyword,
        detail: "write-only raw native output; initializes caller storage",
        insertText: "out ",
        sortText: "0-out",
      } : {
        label: "move",
        kind: completionKinds.keyword,
        detail: "transfer unique ownership into executor placement",
        insertText: "move ",
        sortText: "0-move",
      },
    ];
    return [
      ...capabilities,
      ...symbols.filter((item) => !["in", "inout", "out", "move"].includes(item.label)),
    ];
  }
  const testMatcher = before.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\.([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (
    testMatcher
    && importedTestBinding(source, testMatcher[1]) === "expect"
  ) {
    return filterCompletions([{
      label: "toEqual",
      kind: completionKinds.method,
      detail: "toEqual(expected: T): void  // statement-bounded equality expectation",
      insertText: "toEqual()",
    }], testMatcher[2] ?? "", 100);
  }
  const member = before.match(/([A-Za-z_][A-Za-z0-9_]*(?:<[^<>]+>)?(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (member) return memberCompletions(source, fileName, offset, member[1], member[2] ?? "");
  const objectFields = objectFieldCompletions(source, fileName, offset);
  if (objectFields) return objectFields;
  const protocolMethods = objcProtocolMethodCompletions(source, fileName, offset);
  if (protocolMethods) return protocolMethods;
  const labels = labelCompletions(source, fileName, offset);
  return labels.length > 0 ? labels : symbolCompletions(source, fileName, offset);
}

export const semanticTokenTypes = [
  "namespace",
  "type",
  "class",
  "enum",
  "function",
  "method",
  "property",
  "variable",
  "parameter",
  "interface",
  "enumMember",
] as const;

export const semanticTokenModifiers = ["declaration", "readonly", "defaultLibrary"] as const;

export function semanticTokens(source: string, fileName: string): { readonly data: number[] } {
  const context = safeAnalysis(source, fileName);
  if (!context) return { data: [] };
  const classifications = new Map<number, { readonly type: number; readonly modifiers: number }>();
  const bindings = collectBindings(context);
  const bindingsByName = new Map<string, Binding[]>();
  for (const binding of bindings) {
    const named = bindingsByName.get(binding.name) ?? [];
    named.push(binding);
    bindingsByName.set(binding.name, named);
  }
  const functionNames = new Set([...context.program.functions, ...context.sourceProgram.functions].map((item) => item.name));
  const structNames = new Set(
    [...context.program.structs, ...context.sourceProgram.structs]
      .filter((item) => item.kind === "struct")
      .map((item) => item.name),
  );
  const classNames = new Set(
    [...context.program.structs, ...context.sourceProgram.structs]
      .filter((item) => item.kind === "class")
      .map((item) => item.name),
  );
  const fieldDeclarations = new Set(
    context.sourceProgram.structs.flatMap((declaration) => declaration.fields.map((field) => field.location.offset)),
  );
  const readonlyFieldDeclarations = new Set(
    context.sourceProgram.structs.flatMap((declaration) => (
      declaration.fields.filter((field) => field.readonly).map((field) => field.location.offset)
    )),
  );
  const methodDeclarations = new Set(
    context.sourceProgram.structs.flatMap((declaration) => declaration.methods.map((method) => method.location.offset)),
  );
  const fieldInitializers = new Set(collectStructLiteralFields(context.sourceProgram).map((item) => item.location.offset));
  const traitNames = new Set(context.program.traits.map((item) => item.name));
  const typeAliasNames = new Set([
    ...context.program.typeAliases,
    ...context.sourceProgram.typeAliases,
  ].map((item) => item.name));
  const enumNames = new Set(context.program.enums.map((item) => item.name));
  const enumVariantDeclarations = new Set(
    context.sourceProgram.enums.flatMap((declaration) => declaration.variants.map((variant) => variant.location.offset)),
  );
  const matchVariants = new Set(collectMatchArmInfos(context).map((item) => item.variantOffset));
  const modules = new Map([...context.foreignModules.keys()].map((name) => [name, context.foreignModules.get(name)!]));
  const nativeNamespaceBindings = foreignNamespaceBindings(context);
  const localNamespaces = new Map(
    context.sourceProgram.imports
      .filter((declaration) => isLocalSourceModuleSpecifier(declaration.header) && !declaration.bindings)
      .map((declaration) => [declaration.moduleName, localSourceModule(context, declaration)] as const)
      .filter((entry): entry is [string, SourceModuleInfo] => Boolean(entry[1])),
  );
  const localBindings = new Map(
    context.sourceProgram.imports
      .filter((declaration) => isLocalSourceModuleSpecifier(declaration.header) && declaration.bindings)
      .flatMap((declaration) => declaration.bindings!.map((binding) => [binding.localName, {
        module: localSourceModule(context, declaration),
        importedName: binding.importedName,
      }] as const))
      .filter((entry): entry is [string, { module: SourceModuleInfo; importedName: string }] => Boolean(entry[1].module)),
  );
  const consoleBindings = context.semanticInfo.consoleBindings;
  const tokens = lex(source, fileName);
  const objcArgumentLabels = new Map(
    collectObjCArgumentLabelInfos(context, tokens)
      .map((info) => [info.offset, info] as const),
  );

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const keywordMember = previous?.kind === "dot" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.text);
    if (token.kind !== "identifier" && !keywordMember) continue;
    const contextualTask = token.text === "task"
      && (next?.kind === "on" || next?.kind === "identifier");
    const contextualOwnership = (token.text === "copy" || token.text === "move" || token.text === "view")
      && next?.kind === "identifier";
    if (contextualTask || contextualOwnership) continue;
    if (keywordMember && tokens[index - 2]?.text === "String" && token.text === "from") {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("method"), modifiers: 4 });
      continue;
    }
    const optionMethodMember = previous?.kind === "dot"
      && token.text === "fromNullable"
      && /Option(?:<[^<>]+>)?\.$/.test(source.slice(0, token.location.offset));
    if (optionMethodMember) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("method"), modifiers: 4 });
      continue;
    }
    const testMatcherMember = previous?.kind === "dot"
      && token.text === "toEqual"
      && (() => {
        const prefix = source.slice(0, previous.location.offset);
        const match = prefix.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^()]*(?:\([^()]*\)[^()]*)*\)$/);
        return Boolean(match && importedTestBinding(source, match[1]) === "expect");
      })();
    if (testMatcherMember) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("method"), modifiers: 4 });
      continue;
    }
    const optionVariantMember = previous?.kind === "dot"
      && (token.text === "some" || token.text === "none")
      && /Option(?:<[^<>]+>)?\.$/.test(source.slice(0, token.location.offset));
    if (enumVariantDeclarations.has(token.location.offset) || matchVariants.has(token.location.offset) || optionVariantMember) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("enumMember"),
        modifiers: enumVariantDeclarations.has(token.location.offset) ? 1 : 0,
      });
      continue;
    }
    if (fieldDeclarations.has(token.location.offset)) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("property"),
        modifiers: 1 | (readonlyFieldDeclarations.has(token.location.offset) ? 2 : 0),
      });
      continue;
    }
    if (previous?.kind === "function" && methodDeclarations.has(previous.location.offset)) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("method"),
        modifiers: 1,
      });
      continue;
    }
    if (fieldInitializers.has(token.location.offset)) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("property"),
        modifiers: 0,
      });
      continue;
    }
    if (objcArgumentLabels.has(token.location.offset)) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("property"),
        modifiers: 4,
      });
      continue;
    }
    const namedBindings = (bindingsByName.get(token.text) ?? []).filter((candidate) => (
      !candidate.fileName || resolve(candidate.fileName) === resolve(fileName)
    ));
    const binding = namedBindings.filter((candidate) => candidate.offset <= token.location.offset).at(-1)
      ?? namedBindings[0];
    if (binding) {
      const declaration = token.location.offset === binding.offset ? 1 : 0;
      const readonly = binding.readonly ? 2 : 0;
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf(binding.parameter ? "parameter" : "variable"),
        modifiers: declaration | readonly,
      });
      continue;
    }
    if (consoleBindings.has(token.text)) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("namespace"), modifiers: 4 });
      continue;
    }
    if (context.semanticInfo.standardModuleBindings.has(token.text)) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("namespace"), modifiers: 4 });
      continue;
    }
    if (context.semanticInfo.standardFunctionBindings.has(token.text)) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("function"), modifiers: 4 });
      continue;
    }
    if (context.semanticInfo.testBindings.has(token.text)) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("function"), modifiers: 4 });
      continue;
    }
    if (context.semanticInfo.standardTypeBindings.has(token.text)) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("type"), modifiers: 4 });
      continue;
    }
    if (localNamespaces.has(token.text)) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("namespace"), modifiers: 4 });
      continue;
    }
    const localImport = localBindings.get(token.text);
    if (localImport) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf(sourceExportTokenType(localImport.module, localImport.importedName)),
        modifiers: 4,
      });
      continue;
    }
    if (
      previous?.kind === "dot"
      && consoleBindings.has(tokens[index - 2]?.text ?? "")
      && ["log", "write", "error", "debug"].includes(token.text)
    ) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("method"), modifiers: 4 });
      continue;
    }
    if (
      previous?.kind === "dot"
      && context.semanticInfo.standardModuleBindings.has(tokens[index - 2]?.text ?? "")
    ) {
      const owner = context.semanticInfo.standardModuleBindings.get(tokens[index - 2]?.text ?? "");
      const objcType = owner === "objc" && (token.text === "Connection" || token.text === "Binding");
      const standardType = owner === "fs" && token.text === "Lock";
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf(
          standardType
            ? "type"
            : objcType
              ? "class"
              : owner === "thread" && token.text === "main"
                ? "property"
                : "method",
        ),
        modifiers: owner === "thread" && token.text === "main" ? 6 : 4,
      });
      continue;
    }
    if (modules.has(token.text) || nativeNamespaceBindings.has(token.text)) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("namespace"), modifiers: 4 });
      continue;
    }
    if (previous?.kind === "function") {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("function"), modifiers: 1 });
      continue;
    }
    if (previous?.kind === "struct" || previous?.kind === "class") {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf(previous.kind === "class" ? "class" : "type"),
        modifiers: 1,
      });
      continue;
    }
    if (typeAliasNames.has(token.text)) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("type"),
        modifiers: previous?.text === "type" ? 1 : 0,
      });
      continue;
    }
    if (functionNames.has(token.text)) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("function"),
        modifiers: previous?.kind === "function" ? 1 : 0,
      });
      continue;
    }
    if (token.text === "Slice" || token.text === "Array" || token.text === "Option") {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("type"), modifiers: 4 });
      continue;
    }
    if (structNames.has(token.text) || context.semanticInfo.foreignNamedTypes.has(token.text)) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("type"), modifiers: previous?.kind === "struct" ? 1 : 0 });
      continue;
    }
    if (classNames.has(token.text)) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("class"), modifiers: previous?.kind === "class" ? 1 : 0 });
      continue;
    }
    if (traitNames.has(token.text)) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("interface"), modifiers: previous?.kind === "trait" ? 1 : 0 });
      continue;
    }
    if (enumNames.has(token.text)) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("enum"), modifiers: previous?.kind === "enum" ? 1 : 0 });
      continue;
    }
    if (previous?.kind === "dot") {
      const namespaceToken = tokens[index - 2];
      const localModule = namespaceToken ? localNamespaces.get(namespaceToken.text) : null;
      if (localModule?.exports.has(token.text)) {
        classifications.set(token.location.offset, {
          type: semanticTokenTypes.indexOf(sourceExportTokenType(localModule, token.text)),
          modifiers: 4,
        });
        continue;
      }
      const components = [token.text];
      let cursor = index - 2;
      while (cursor >= 0 && tokens[cursor]?.kind === "identifier") {
        components.unshift(tokens[cursor].text);
        if (tokens[cursor - 1]?.kind !== "dot") break;
        cursor -= 2;
      }
      const namespaceBinding = nativeNamespaceBindings.get(components[0]);
      const module = modules.get(components[0]) ?? namespaceBinding?.module;
      const memberPath = [...(namespaceBinding?.namespacePath ?? []), ...components.slice(1)];
      const namespacePath = memberPath.slice(0, -1);
      const memberName = memberPath.at(-1) ?? "";
      const named = module ? resolveModuleNamedType(module, namespacePath, memberName) : null;
      const fn = module ? resolveModuleFunction(module, namespacePath, memberName) : null;
      const handle = module && namespacePath.length === 0
        ? resolveModuleHandleType(module, memberName)
        : null;
      if (module?.namespaces.has(memberPath.join("."))) {
        classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("namespace"), modifiers: 4 });
      } else if (namespacePath.length === 0 && module?.interfaces.has(memberName)) {
        classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("class"), modifiers: 4 });
      } else if (namespacePath.length === 0 && module?.protocols.has(memberName)) {
        classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("interface"), modifiers: 4 });
      } else if (named) {
        classifications.set(token.location.offset, {
          type: semanticTokenTypes.indexOf(named.kind === "enum" ? "enum" : "type"),
          modifiers: 4,
        });
      } else if (handle) {
        classifications.set(token.location.offset, {
          type: semanticTokenTypes.indexOf("type"),
          modifiers: 4,
        });
      } else if (fn) {
        classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("function"), modifiers: 4 });
      } else {
        classifications.set(token.location.offset, {
          type: semanticTokenTypes.indexOf(next?.kind === "leftParen" ? "method" : "property"),
          modifiers: module ? 4 : 0,
        });
      }
    }
  }

  const encoded: number[] = [];
  let previousLine = 0;
  let previousCharacter = 0;
  for (const token of tokens.filter((item) => classifications.has(item.location.offset))) {
    const classification = classifications.get(token.location.offset)!;
    const line = token.location.line - 1;
    const character = token.location.column - 1;
    const deltaLine = line - previousLine;
    const deltaCharacter = deltaLine === 0 ? character - previousCharacter : character;
    encoded.push(deltaLine, deltaCharacter, token.text.length, classification.type, classification.modifiers);
    previousLine = line;
    previousCharacter = character;
  }
  return { data: encoded };
}

export function hover(source: string, fileName: string, offset: number): Hover | null {
  if (fileName.endsWith(".zd")) return foreignDeclarationHover(source, fileName, offset);
  const word = wordAt(source, offset);
  if (!word) return null;
  const context = safeAnalysis(source, fileName);
  if (!context) return declarationHover(source, null, word.text, word.start, word.end);
  if (word.text === "Option") {
    return markdownHover("compiler-provided enum Option<T>", source, word.start, word.end);
  }
  if (word.text === "raw") {
    return markdownHover(
      "raw c | raw cpp | raw objc  // isolated native-source boundary; prefer checked header import plus .zd when representable",
      source,
      word.start,
      word.end,
    );
  }
  if (word.text === "unsafe") {
    return markdownHover(
      "unsafe { ... }  // local unverified native assertions remain in Z syntax and types; prefer reusable checked .zd contracts",
      source,
      word.start,
      word.end,
    );
  }
  if (
    word.text === "c"
    && (
      /\bexport\s+$/.test(source.slice(Math.max(0, word.start - 24), word.start))
      || /^\s*(?:struct|enum)\b/.test(source.slice(word.end))
    )
  ) {
    return markdownHover(
      "c  // checked C ABI contract: `export c function`, `c struct`, or fixed-representation `c enum`",
      source,
      word.start,
      word.end,
    );
  }
  if (word.text === "yield") {
    const memberPrefix = source.slice(0, word.start).match(/([A-Za-z_][A-Za-z0-9_]*)\.$/)?.[1];
    if (memberPrefix && context.semanticInfo.standardModuleBindings.get(memberPrefix) === "scheduler") {
      return markdownHover(
        "async yield(): void  // cooperatively requeues the current task on its existing executor",
        source,
        word.start,
        word.end,
      );
    }
    return markdownHover("yield value  // suspends the current Generator and transfers one yielded value to its consumer", source, word.start, word.end);
  }
  const conversionSuffix = source.slice(word.end).match(/^\s*\(/)?.[0];
  const integerConversion = conversionSuffix
    ? context.semanticInfo.integerConversions.get(word.end + conversionSuffix.lastIndexOf("("))
    : undefined;
  if (integerConversion) {
    return markdownHover(integerConversionHover(integerConversion), source, word.start, word.end);
  }
  const directWordType = context.semanticInfo.bindingTypes.get(word.start)
    ?? context.semanticInfo.numericLiteralTypes.get(word.start)
    ?? context.semanticInfo.expressionTypes.get(word.start);

  if (
    word.text === "using"
    && /\braw\s+(?:c|cpp|objc)\s+$/.test(
      source.slice(Math.max(0, word.start - 96), word.start),
    )
  ) {
    return markdownHover(
      "using (in input, inout state, out result)  // complete operand contract for an anonymous raw helper",
      source,
      word.start,
      word.end,
    );
  }
  if (
    word.text === "using"
    && /\b(?:await|task)\s+on\s+[A-Za-z_][A-Za-z0-9_.]*\s+$/.test(
      source.slice(Math.max(0, word.start - 96), word.start),
    )
  ) {
    return markdownHover(
      "using (in value, inout state, move owner)  // explicit lexical capture contract for an executor-placement block",
      source,
      word.start,
      word.end,
    );
  }
  if (
    (word.text === "in" || word.text === "inout" || word.text === "out")
    && /\braw\s+(?:c|cpp|objc)\s+using\s*\([^)]*$/.test(
      source.slice(Math.max(0, word.start - 200), word.start),
    )
  ) {
    const detail = word.text === "in"
      ? "native code may read but not replace caller storage"
      : word.text === "inout"
        ? "native code may read and replace mutable caller storage"
        : "native code must initialize mutable caller storage without reading its prior value";
    return markdownHover(
      `${word.text} raw operand  // ${detail}`,
      source,
      word.start,
      word.end,
    );
  }
  if (
    (word.text === "in" || word.text === "inout" || word.text === "move")
    && /\busing\s*\([^)]*$/.test(source.slice(Math.max(0, word.start - 160), word.start))
  ) {
    const detail = word.text === "in"
      ? "read-only loan; caller storage stays alive until the placement joins"
      : word.text === "inout"
        ? "exclusive mutable loan; conflicting caller access is rejected until join"
        : "transfers unique ownership into the placed operation; the source becomes unavailable";
    return markdownHover(
      `${word.text} capture  // ${detail}`,
      source,
      word.start,
      word.end,
    );
  }

  if (
    word.text === "task"
    && /^\s+(?:on\b|[A-Za-z_][A-Za-z0-9_]*)/.test(source.slice(word.end))
  ) {
    const result = directWordType
      ? displayType(String(directWordType), context.typeDisplayNames)
      : "Task<T, E?>";
    return markdownHover(
      `task operation() -> ${result}  // starts a hot structured child on the selected or inherited executor`,
      source,
      word.start,
      word.end,
    );
  }

  if (word.text === "copy") {
    const plan = context.semanticInfo.explicitCopies.get(word.start);
    if (plan) return markdownHover(explicitCopyHover(plan, context), source, word.start, word.end);
  }
  if (
    word.text === "move"
    && /^\s+[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(word.end))
    && context.semanticInfo.expressionTypes.has(word.start)
  ) {
    const type = context.semanticInfo.expressionTypes.get(word.start)!;
    return markdownHover(explicitMoveHover(type, context), source, word.start, word.end);
  }
  if (
    word.text === "view"
    && /^\s+[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(word.end))
    && context.semanticInfo.expressionTypes.has(word.start)
  ) {
    const type = displayType(
      context.semanticInfo.expressionTypes.get(word.start)!,
      context.typeDisplayNames,
    );
    const ownerName = localViewOwnerAt(context, word.start);
    const owner = ownerName ? ` of ${ownerName}` : "";
    return markdownHover(
      `${type}${owner}  // read-only projection; the owner's shared loan ends after the view's last use`,
      source,
      word.start,
      word.end,
    );
  }
  if (
    word.text === "inout"
    && /\bof\s+$/.test(source.slice(Math.max(0, word.start - 12), word.start))
  ) {
    return markdownHover(
      "inout iterator  // Iterator.next mutates traversal state; the iterator remains usable after the loop",
      source,
      word.start,
      word.end,
    );
  }

  const declaredField = context.sourceProgram.structs
    .flatMap((declaration) => declaration.fields)
    .find((field) => field.location.offset === word.start && field.name === word.text);
  if (declaredField) {
    return markdownHover(fieldDetail(declaredField, context.typeDisplayNames), source, word.start, word.end);
  }
  const declaredMethod = context.sourceProgram.structs
    .flatMap((declaration) => declaration.methods)
    .find((method) => (
      method.name === word.text
      && method.location.offset <= word.start
      && new RegExp(`^function\\s+${word.text}$`).test(source.slice(method.location.offset, word.end))
    ));
  if (declaredMethod) {
    const nativeRequirement = [...context.semanticInfo.objcProtocolConformances.values()]
      .map((conformance) => conformance.methods.get(declaredMethod.location.offset))
      .find((requirement) => requirement);
    const nativeDetail = nativeRequirement
      ? `\n\nObjective-C ${nativeRequirement.required ? "required" : "optional"} protocol selector: \`${nativeRequirement.selector}\`${foreignAvailabilityDetail(nativeRequirement.metadata)}`
      : "";
    return markdownHover(`${methodDetail(declaredMethod, context.typeDisplayNames)}${nativeDetail}`, source, word.start, word.end);
  }

  const literalField = structLiteralFieldHover(context, word.start);
  if (literalField) return markdownHover(literalField, source, word.start, word.end);

  const objcArgumentLabel = collectObjCArgumentLabelInfos(context, lex(source, fileName))
    .find((info) => info.offset === word.start);
  if (objcArgumentLabel) {
    return markdownHover(
      `${objcArgumentLabel.label}: ${foreignTypeName(objcArgumentLabel.parameterType)}  // Objective-C selector ${objcArgumentLabel.selector}`,
      source,
      word.start,
      word.end,
    );
  }

  const matchVariant = collectMatchArmInfos(context).find((item) => item.variantOffset === word.start);
  if (matchVariant) {
    const payload = matchVariant.payloadType
      ? `(${displayType(matchVariant.payloadType, context.typeDisplayNames)})`
      : "";
    return markdownHover(
      `${displayType(matchVariant.enumName, context.typeDisplayNames)}.${matchVariant.variantName}${payload}`,
      source,
      word.start,
      word.end,
    );
  }
  const matchBinding = collectMatchArmInfos(context).find((item) => item.bindingOffset === word.start);
  if (matchBinding?.binding && matchBinding.payloadType) {
    const capability = matchBinding.borrowed ? "in " : "";
    const bindingType = directWordType ?? matchBinding.payloadType;
    const owner = context.semanticInfo.viewBindingOwners.get(word.start);
    const provenance = owner ? `  // view of ${owner}` : "";
    return markdownHover(
      `${capability}${matchBinding.binding}: ${displayType(String(bindingType), context.typeDisplayNames)}${provenance}`,
      source,
      word.start,
      word.end,
    );
  }

  const module = context.foreignModules.get(word.text);
  if (module) {
    return markdownHover(`import ${word.text} from ${JSON.stringify(module.declaration.header)}`, source, word.start, word.end);
  }
  const nativeNamespace = foreignNamespaceBindings(context).get(word.text);
  if (nativeNamespace && !directWordType && !sourceNameIsShadowed(context, word.text, word.start, fileName)) {
    return markdownHover(
      `native namespace ${nativeNamespace.namespacePath.join(".")} imported as ${word.text} from ${JSON.stringify(nativeNamespace.module.declaration.header)}`,
      source,
      word.start,
      word.end,
    );
  }
  const sourceNamespace = context.sourceProgram.imports.find((declaration) => (
    isLocalSourceModuleSpecifier(declaration.header) && !declaration.bindings && declaration.moduleName === word.text
  ));
  const sourceNamespaceShadowed = sourceNameIsShadowed(context, word.text, word.start, fileName);
  if (sourceNamespace && !sourceNamespaceShadowed) {
    return markdownHover(`import ${word.text} from ${JSON.stringify(sourceNamespace.header)}  // Z module`, source, word.start, word.end);
  }
  const sourceBinding = localSourceBinding(context, word.text);
  if (sourceBinding && !directWordType) {
    const detail = sourceExportDetail(
      sourceBinding.module,
      sourceBinding.importedName,
      context.typeDisplayNames,
      sourceBinding.localName,
    );
    return sourceImportHover(detail, sourceBinding, source, word.start, word.end);
  }
  if (context.semanticInfo.consoleBindings.has(word.text)) {
    return markdownHover(`standard console imported as ${word.text}`, source, word.start, word.end);
  }
  const standardModule = context.semanticInfo.standardModuleBindings.get(word.text);
  if (standardModule) {
    return markdownHover(`standard ${standardModule} module imported as ${word.text}`, source, word.start, word.end);
  }
  const standardFunction = context.semanticInfo.standardFunctionBindings.get(word.text);
  if (standardFunction) {
    return markdownHover(standardFunctionDetail(word.text, standardFunction), source, word.start, word.end);
  }
  const testBinding = context.semanticInfo.testBindings.get(word.text);
  if (testBinding === "expect") {
    return markdownHover("expect<T>(value: in T): Expectation<T>  // borrows for one expectation statement", source, word.start, word.end);
  }
  if (testBinding === "fail") {
    return markdownHover("fail(message: in String): void  // ends the current test with a cleanup-aware failure", source, word.start, word.end);
  }
  if (word.text === "toEqual") {
    const prefix = source.slice(0, word.start).replace(/\.\s*$/, "");
    const match = prefix.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^()]*(?:\([^()]*\)[^()]*)*\)$/);
    if (match && importedTestBinding(source, match[1]) === "expect") {
      return markdownHover(
        "toEqual(expected: T): void  // uses Z `==`; failure ends this test after deterministic cleanup",
        source,
        word.start,
        word.end,
      );
    }
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "TextBuffer") {
    return markdownHover("standard value type TextBuffer  // move-only UTF-8 construction storage", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "Arena") {
    return markdownHover("Arena(options?: { initialCapacity: usize }): Arena  // move-only growable region storage", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "Map") {
    return markdownHover("Map<K, V>(): Map<K, V>  // owned associative storage", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "Set") {
    return markdownHover("Set<T>(): Set<T>  // owned unique-value storage", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "Hashable") {
    return markdownHover("trait Hashable  // equals(in other: this) and hash(inout hasher: Hasher)", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "Hasher") {
    return markdownHover("standard Hasher  // mutable hash-composition state", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "Iterator") {
    return markdownHover("trait Iterator<T>  // next(inout this): Option<T>", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "Generator") {
    return markdownHover("Generator<Yield, Return?, Error?>  // cold, move-only synchronous sequence with deterministic cleanup", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "AsyncGenerator") {
    return markdownHover("AsyncGenerator<Yield, Return?, Error?>  // cold, move-only asynchronous sequence with awaited advancement", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "TaskScope") {
    return markdownHover("TaskScope  // thread-safe structured owner for dynamically submitted child work", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "TaskControl") {
    return markdownHover("TaskControl  // non-joining per-operation cancellation control; its TaskScope owns completion", source, word.start, word.end);
  }
  if (word.text === "next") {
    const receiver = source.slice(0, word.start).match(/([A-Za-z_][A-Za-z0-9_]*)\.$/)?.[1];
    const binding = receiver
      ? collectBindings(context).filter((candidate) => candidate.name === receiver && candidate.offset < word.start).at(-1)
      : null;
    const generator = binding ? parseGeneratorType(binding.type) : null;
    const asyncGenerator = binding ? parseAsyncGeneratorType(binding.type) : null;
    if (generator) {
      return markdownHover(
        `next(): ${generatorNextDisplayType(generator, context.typeDisplayNames)}  // advances the suspended generator frame`,
        source,
        word.start,
        word.end,
      );
    }
    if (asyncGenerator) {
      return markdownHover(
        `async next(): ${asyncGeneratorNextDisplayType(asyncGenerator, context.typeDisplayNames)}  // resumes the persistent frame until yield or return`,
        source,
        word.start,
        word.end,
      );
    }
  }

  const chainedCall = objectiveCCallAt(context, word.start);
  if (chainedCall) {
    const declaration = [...context.semanticInfo.foreignInterfaces.values()]
      .find((candidate) => candidate.className === chainedCall.className);
    const method = chainedCall.async?.method
      ?? declaration?.methods.find((candidate) => (
        candidate.selector === chainedCall.selector
        && candidate.instance === chainedCall.instance
      ));
    if (method) {
      return objCMethodHover(
        method,
        declaration ? foreignObjCRequiresMain(declaration, context) : false,
        source,
        word.start,
        word.end,
      );
    }
  }

  const memberPrefix = source.slice(0, word.start).match(/([A-Za-z_][A-Za-z0-9_]*(?:<[^<>]+>)?(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.$/);
  if (memberPrefix) {
    if (memberPrefix[1] === "Option" || /^Option<[^<>]+>$/.test(memberPrefix[1])) {
      const explicit = memberPrefix[1].startsWith("Option<") ? memberPrefix[1].slice(7, -1) : "T";
      if (word.text === "some") {
        return markdownHover(`some(value: ${explicit}): Option<${explicit}>`, source, word.start, word.end);
      }
      if (word.text === "none") {
        return markdownHover(`none: Option<${explicit}>`, source, word.start, word.end);
      }
      if (word.text === "fromNullable") {
        return markdownHover(`fromNullable(value: ${explicit} | null): Option<${explicit}>`, source, word.start, word.end);
      }
    }
    if (context.semanticInfo.consoleBindings.has(memberPrefix[1])) {
      const detail = consoleMethodDetail(word.text);
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
    const standardOwner = context.semanticInfo.standardModuleBindings.get(memberPrefix[1]);
    if (standardOwner === "thread" && word.text === "spawn") {
      return markdownHover(
        "spawn<T>(operation: () => T): Task<T>\nspawn<T, E>(operation: () => T throws E): Task<T, E>  // starts one native thread; accepts synchronous or async one-shot closures; async continuations stay worker-affine",
        source,
        word.start,
        word.end,
      );
    }
    if (standardOwner === "thread" && word.text === "main") {
      return markdownHover("thread.main: Executor  // main-thread execution target", source, word.start, word.end);
    }
    if (standardOwner === "fs" && word.text === "Lock") {
      return markdownHover(
        "fs.Lock  // move-only exclusive interprocess filesystem lock; released on scope exit",
        source,
        word.start,
        word.end,
      );
    }
    if (standardOwner === "objc" && word.text === "connect") {
      return markdownHover(
        "connect(control: Objective-C target/action object, operation: move () => void): objc.Connection  // owns the control and callback lifetime",
        source,
        word.start,
        word.end,
      );
    }
    if (standardOwner === "objc" && word.text === "bind") {
      return markdownHover(
        "bind(object: Objective-C object, protocols: { property: ZController }): objc.Binding  // owns the native object, generated protocol adapters, and Z controllers",
        source,
        word.start,
        word.end,
      );
    }
    if (standardOwner === "objc" && word.text === "Connection") {
      return markdownHover(
        "objc.Connection  // owned Objective-C target/action lifetime",
        source,
        word.start,
        word.end,
      );
    }
    if (standardOwner === "objc" && word.text === "Binding") {
      return markdownHover(
        "objc.Binding  // owns an Objective-C object, protocol adapters, and Z controllers",
        source,
        word.start,
        word.end,
      );
    }
    const standardName = standardOwner ? standardModuleFunction(standardOwner, word.text) : null;
    if (standardName) {
      return markdownHover(standardFunctionDetail(word.text, standardName), source, word.start, word.end);
    }
    if (memberPrefix[1] === "String" && word.text === "from") {
      return markdownHover("from(value: cstring): String  // copies borrowed C bytes", source, word.start, word.end);
    }
    const foreignStaticOwner = resolveForeignValueType(context, memberPrefix[1]);
    const foreignStaticMethod = foreignStaticOwner?.staticMethods.find((item) => item.name === word.text);
    if (foreignStaticMethod) {
      return markdownHover(foreignCxxStaticMethodDetail(foreignStaticMethod), source, word.start, word.end);
    }
    const staticOwner = sourceAggregateForType(context, memberPrefix[1]);
    const staticMethod = staticOwner?.declaration.methods.find((item) => item.static && item.name === word.text);
    if (staticOwner && staticMethod) {
      const includePrivate = insideAggregateBody(source, fileName, word.start, staticOwner.declaration.name);
      if ((staticMethod.visibility ?? "public") === "public" || includePrivate) {
        return markdownHover(
          methodDetail(staticMethod, context.typeDisplayNames, staticOwner.substitutions),
          source,
          word.start,
          word.end,
        );
      }
    }
    const handleModule = context.foreignModules.get(memberPrefix[1]);
    const handleType = handleModule ? resolveModuleHandleType(handleModule, word.text) : null;
    if (handleType) {
      return markdownHover(
        `${memberPrefix[1]}.${word.text}  // owned opaque native handle; deinit ${handleType.release}`,
        source,
        word.start,
        word.end,
      );
    }
    const sourceImport = context.sourceProgram.imports.find((declaration) => (
      isLocalSourceModuleSpecifier(declaration.header)
      && !declaration.bindings
      && declaration.moduleName === memberPrefix[1]
    ));
    const sourceModule = sourceImport ? localSourceModule(context, sourceImport) : null;
    if (sourceModule?.exports.has(word.text)
      && !sourceNameIsShadowed(context, memberPrefix[1], word.start, fileName)) {
      return markdownHover(sourceExportDetail(sourceModule, word.text, context.typeDisplayNames), source, word.start, word.end);
    }
    const resolved = resolveReceiver(context, memberPrefix[1], word.start - memberPrefix[1].length - 1);
    if (resolved?.kind === "module") {
      const declaration = resolveModuleFunction(resolved.module, resolved.namespacePath, word.text);
      if (declaration) {
        return foreignFunctionHover(declaration, resolved.module, source, word.start, word.end);
      }
      const item = describeModuleMember(resolved.module, resolved.namespacePath, word.text);
      if (item) return markdownHover(item, source, word.start, word.end);
    }
    if (resolved?.kind === "objc") {
      const mainIsolated = foreignObjCRequiresMain(resolved.declaration, context);
      const property = collectObjCProperties(resolved.declaration, resolved.instance, context).find((item) => item.name === word.text);
      if (property) {
        return objCPropertyHover(property, mainIsolated, source, word.start, word.end);
      }
      const methods = collectObjCMethods(resolved.declaration, resolved.instance, context).filter((item) => item.baseName === word.text);
      if (methods.length) {
        return objCMethodsHover(methods, mainIsolated, source, word.start, word.end);
      }
    }
    if (resolved?.kind === "struct") {
      const affinity = context.semanticInfo.aggregateExecutorAffinities.get(resolved.declaration.name);
      const field = resolved.declaration.fields.find((item) => item.name === word.text);
      if (field) {
        return markdownHover(
          `${fieldDetail(field, context.typeDisplayNames)}${executorAffinityHover(affinity)}`,
          source,
          word.start,
          word.end,
        );
      }
      const method = resolved.declaration.methods.find((item) => item.name === word.text)
        ?? resolved.sourceDeclaration?.methods.find((item) => item.name === word.text);
      if (method) {
        return markdownHover(
          `${methodDetail(method, context.typeDisplayNames)}${executorAffinityHover(affinity)}`,
          source,
          word.start,
          word.end,
        );
      }
    }
    if (resolved?.kind === "foreignValue") {
      const method = resolved.declaration.methods.find((candidate) => candidate.name === word.text);
      if (method) return markdownHover(foreignCxxMethodDetail(method), source, word.start, word.end);
    }
    if (resolved?.kind === "weak" && word.text === "upgrade") {
      return markdownHover(`upgrade(): ${displayType(resolved.target, context.typeDisplayNames)} throws WeakExpired`, source, word.start, word.end);
    }
    if (resolved?.kind === "task" && word.text === "cancel") {
      return markdownHover(
        "async cancel(): void  // consumes the Task; requests cancellation and joins cleanup",
        source,
        word.start,
        word.end,
      );
    }
    if (resolved?.kind === "taskScope") {
      const detail = word.text === "schedule"
        ? [
            "schedule(thread.main, operation: () => void): TaskControl",
            "schedule(thread.main, operation: async () => void): TaskControl",
            "// scope owns joining; returned control can request cancellation",
          ].join("\n")
        : word.text === "close"
          ? "async close(): void  // rejects new work and joins accepted children"
          : word.text === "cancel"
            ? "async cancel(): void  // rejects new work, cancels pending children, and joins"
            : null;
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
    if (resolved?.kind === "taskControl") {
      const detail = word.text === "requestCancel"
        ? "requestCancel(): boolean  // requests cancellation once; TaskScope retains join ownership"
        : word.text === "accepted"
          ? "accepted: boolean  // false when scope closing won the scheduling race"
          : word.text === "isCancellationRequested"
            ? "isCancellationRequested: boolean"
            : null;
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
    if (resolved?.kind === "fsLock" && word.text === "unlock") {
      return markdownHover(
        "unlock(): void  // consumes fs.Lock and releases it immediately",
        source,
        word.start,
        word.end,
      );
    }
    if (resolved?.kind === "integer") {
      const detail = integerMethodDetail(word.text, resolved.type);
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
    if (resolved?.kind === "array" && word.text === "length") {
      return markdownHover(`length: usize  // ${displayType(resolved.type, context.typeDisplayNames)}`, source, word.start, word.end);
    }
    if (resolved?.kind === "array" && parseDynamicArrayType(resolved.type)) {
      if (word.text === "capacity") return markdownHover("capacity: usize", source, word.start, word.end);
      if (word.text === "push") {
        const element = parseDynamicArrayType(resolved.type)!.elementType;
        return markdownHover(`push(value: ${displayType(element, context.typeDisplayNames)}): void`, source, word.start, word.end);
      }
    }
    if (resolved?.kind === "string") {
      if (word.text === "byteLength") {
        return markdownHover("byteLength: usize  // UTF-8 storage bytes", source, word.start, word.end);
      }
      if (word.text === "isEmpty") return markdownHover("isEmpty: boolean", source, word.start, word.end);
      if (word.text === "byteAt") {
        return markdownHover("byteAt(index: usize): u8  // checked UTF-8 byte access", source, word.start, word.end);
      }
      if (word.text === "copyBytes") {
        return markdownHover("copyBytes(start: usize, end: usize): String  // checked owned copy", source, word.start, word.end);
      }
    }
    if (resolved?.kind === "textBuffer") {
      if (word.text === "byteLength") return markdownHover("byteLength: usize", source, word.start, word.end);
      if (word.text === "isEmpty") return markdownHover("isEmpty: boolean", source, word.start, word.end);
      if (word.text === "append") {
        return markdownHover("append(in text: String): void", source, word.start, word.end);
      }
      if (word.text === "appendBytes") {
        return markdownHover("appendBytes(in text: String, start: usize, end: usize): void", source, word.start, word.end);
      }
      if (word.text === "appendAscii") {
        return markdownHover("appendAscii(byte: u8): void", source, word.start, word.end);
      }
      if (word.text === "finish") {
        return markdownHover("finish(): String  // consumes the TextBuffer", source, word.start, word.end);
      }
    }
    if (resolved?.kind === "arena") {
      if (word.text === "create") {
        return markdownHover("create<T>(value: T): view T  // transfers a value into stable region storage", source, word.start, word.end);
      }
      if (word.text === "reset") {
        return markdownHover("reset(): void  // destroys allocations newest-first; requires no live views", source, word.start, word.end);
      }
    }
    if (resolved?.kind === "hasher" && word.text === "add") {
      return markdownHover("add<T>(in value: T): void  // feeds a supported scalar, String, enum, or Hashable value", source, word.start, word.end);
    }
    if (resolved?.kind === "map") {
      const detail = mapMemberDetail(
        word.text,
        resolved.keyType,
        resolved.valueType,
        context.typeDisplayNames,
        mapValueHasReferenceIdentity(context, resolved.valueType),
      );
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
    if (resolved?.kind === "set") {
      const detail = setMemberDetail(word.text, resolved.elementType, context.typeDisplayNames);
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
  }

  const type = directWordType;
  if (type) {
    const binding = collectBindings(context)
      .filter((candidate) => candidate.name === word.text && candidate.offset <= word.start)
      .sort((left, right) => left.offset - right.offset)
      .at(-1);
    const owner = context.semanticInfo.viewBindingOwners.get(binding?.offset ?? word.start);
    const borrowedResource = String(type).startsWith("__z_borrowed:");
    const provenance = owner
      ? `  // view of ${owner}`
      : borrowedResource ? "  // borrowed native resource; non-escaping" : "";
    const sourceType = binding ? sourceBindingTypeName(context.sourceProgram, binding.offset) : null;
    const aliasType = sourceType ? sourceAliasDisplayType(context, sourceType) : null;
    const affinity = context.semanticInfo.aggregateExecutorAffinities.get(String(type))
      ?? (sourceType ? context.semanticInfo.aggregateExecutorAffinities.get(sourceType) : undefined)
      ?? foreignTypeExecutorAffinity(type, context);
    return markdownHover(
      `${word.text}: ${aliasType ?? displayServiceType(type, context)}${provenance}${executorAffinityHover(affinity)}`,
      source,
      word.start,
      word.end,
    );
  }
  return declarationHover(
    source,
    context.sourceProgram,
    word.text,
    word.start,
    word.end,
    context.typeDisplayNames,
    context.semanticInfo.aggregateExecutorAffinities,
  );
}

export function definition(source: string, uri: string, offset: number): Location | null {
  const word = wordAt(source, offset);
  if (!word) return null;
  const fileName = uriToFileName(uri);
  if (fileName.endsWith(".zd")) {
    const module = foreignDeclarationNativeModule(source, fileName);
    const declaration = module?.functions.get(word.text);
    const nativeFunction = declaration ? foreignMetadataLocation(declaration.overloads[0]?.metadata) : null;
    if (nativeFunction) return nativeFunction;
    if (module) {
      try {
        const contract = parseForeignDeclarationContracts(source, fileName).functions.find((candidate) => (
          containsDeclarationName(candidate.nameLocation.offset, candidate.name, word.start)
        ));
        const method = contract
          ? foreignDeclarationObjCMethods(module, contract.name, contract.parameters.length)
            .find(({ method }) => method.parameters.every((parameter, index) => (
              parameter.name === null || parameter.name === contract.parameters[index]?.name
            )))?.method
          : null;
        const nativeMethod = method ? foreignMetadataLocation(method.metadata) : null;
        if (nativeMethod) return nativeMethod;
      } catch {
        // Incomplete declaration files still fall through to ordinary recovery.
      }
    }
  }
  const context = safeAnalysis(source, fileName);
  if (context) {
    const memberNamespace = source.slice(0, word.start).match(/([A-Za-z_][A-Za-z0-9_]*)\.$/)?.[1];
    const namespaceImport = memberNamespace
      ? context.sourceProgram.imports.find((declaration) => (
        isLocalSourceModuleSpecifier(declaration.header)
        && !declaration.bindings
        && declaration.moduleName === memberNamespace
      ))
      : null;
    const namespaceModule = namespaceImport ? localSourceModule(context, namespaceImport) : null;
    if (namespaceModule?.exports.has(word.text)) return sourceExportLocation(namespaceModule, word.text);
    const binding = localSourceBinding(context, word.text);
    if (binding) return sourceExportLocation(binding.module, binding.importedName);
    const native = nativeDefinition(context, source, fileName, word);
    if (native) return native;
  }
  let tokens;
  try {
    tokens = lex(source, fileName);
  } catch {
    return null;
  }
  const candidates: SourceLocation[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.text !== word.text) continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const declarationKeyword = previous && (
      ["function", "struct", "class", "trait", "enum", "const", "let"].includes(previous.kind)
      || previous.text === "type"
    );
    const namedSlot = next?.kind === "colon";
    const importSlot = previous?.kind === "import" || previous?.kind === "leftBrace" || previous?.kind === "comma" || previous?.kind === "as";
    if (declarationKeyword || namedSlot || importSlot) candidates.push(token.location);
  }
  const preceding = candidates.filter((candidate) => candidate.offset <= word.start).at(-1);
  const target = preceding ?? candidates[0];
  if (!target) return null;
  const start = { line: target.line - 1, character: target.column - 1 };
  return { uri, range: { start, end: { line: start.line, character: start.character + word.text.length } } };
}

function nativeDefinition(
  context: AnalyzedSource,
  source: string,
  fileName: string,
  word: { readonly text: string; readonly start: number; readonly end: number },
): Location | null {
  const selectedForeign = context.semanticInfo.foreignFunctionDefinitions.get(word.start);
  const selectedLocation = foreignMetadataLocation(selectedForeign);
  if (selectedLocation) return selectedLocation;
  const nativeMethod = context.sourceProgram.structs
    .flatMap((declaration) => declaration.methods)
    .find((method) => (
      method.name === word.text
      && method.location.offset <= word.start
      && new RegExp(`^function\\s+${word.text}$`).test(source.slice(method.location.offset, word.end))
    ));
  if (nativeMethod) {
    for (const conformance of context.semanticInfo.objcProtocolConformances.values()) {
      const requirement = conformance.methods.get(nativeMethod.location.offset);
      const target = foreignMetadataLocation(requirement?.metadata);
      if (target) return target;
    }
  }
  const chainedSelector = objectiveCSelectorAt(context, word.start);
  if (chainedSelector) {
    for (const declaration of context.semanticInfo.foreignInterfaces.values()) {
      const method = declaration.methods.find((candidate) => (
        candidate.selector === chainedSelector && candidate.baseName === word.text
      ));
      const target = method ? foreignMetadataLocation(method.metadata) : null;
      if (target) return target;
    }
    if (resolved?.kind === "foreignValue") {
      const method = resolved.declaration.methods.find((candidate) => candidate.name === word.text);
      const target = foreignMetadataLocation(method?.overloads[0]?.metadata);
      if (target) return target;
    }
  }
  const memberPrefix = source.slice(0, word.start).match(/([A-Za-z_][A-Za-z0-9_]*(?:<[^<>]+>)?(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.$/);
  if (memberPrefix) {
    const resolved = resolveReceiver(context, memberPrefix[1], word.start - memberPrefix[1].length - 1);
    if (resolved?.kind === "module") {
      const declaration = resolveModuleFunction(resolved.module, resolved.namespacePath, word.text)
        ?? resolved.module.constants.get(word.text)
        ?? resolveModuleNamedType(resolved.module, resolved.namespacePath, word.text)
        ?? resolved.module.interfaces.get(word.text)
        ?? resolved.module.protocols.get(word.text);
      const metadata = declaration && "overloads" in declaration
        ? declaration.overloads[0]?.metadata
        : declaration?.metadata;
      const target = foreignMetadataLocation(metadata);
      if (target) return target;
    }
    if (resolved?.kind === "objc") {
      const property = collectObjCProperties(resolved.declaration, resolved.instance, context)
        .find((candidate) => candidate.name === word.text);
      const method = collectObjCMethods(resolved.declaration, resolved.instance, context)
        .find((candidate) => candidate.baseName === word.text);
      const target = foreignMetadataLocation((property ?? method)?.metadata);
      if (target) return target;
    }
  }
  if (sourceNameIsShadowed(context, word.text, word.start, fileName)) return null;
  for (const declaration of context.sourceProgram.imports) {
    if (isLocalSourceModuleSpecifier(declaration.header) || !declaration.bindings) continue;
    const binding = declaration.bindings.find((candidate) => candidate.localName === word.text);
    if (!binding) continue;
    const module = context.foreignModules.get(declaration.moduleName);
    const target = module ? resolveModuleFunction(module, [], binding.importedName)
      ?? module?.constants.get(binding.importedName)
      ?? resolveModuleNamedType(module, [], binding.importedName)
      ?? module?.interfaces.get(binding.importedName)
      ?? module?.protocols.get(binding.importedName) : null;
    const metadata = target && "overloads" in target ? target.overloads[0]?.metadata : target?.metadata;
    const location = foreignMetadataLocation(metadata);
    if (location) return location;
  }
  return null;
}

function foreignMetadataLocation(metadata: ForeignDeclarationMetadata | undefined): Location | null {
  if (!metadata?.source) return null;
  const start = { line: metadata.source.line - 1, character: metadata.source.column - 1 };
  return {
    uri: pathToFileURL(metadata.source.fileName).href,
    range: {
      start,
      end: { line: start.line, character: start.character + metadata.source.length },
    },
  };
}

export function offsetAt(source: string, position: Position): number {
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    const next = source.indexOf("\n", offset);
    if (next < 0) return source.length;
    offset = next + 1;
  }
  return Math.min(offset + position.character, source.length);
}

function importedTestBinding(
  source: string,
  localName: string,
): "expect" | "fail" | null {
  const pattern = /\bimport\s*\{([\s\S]*?)\}\s*from\s*["']std\/test["']\s*;/g;
  for (const match of source.matchAll(pattern)) {
    for (const item of match[1].split(",")) {
      const binding = /^\s*(expect|fail)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*$/.exec(item);
      if (binding && (binding[2] ?? binding[1]) === localName) {
        return binding[1] as "expect" | "fail";
      }
    }
  }
  return null;
}

function selectiveImportCompletions(
  source: string,
  fileName: string,
  offset: number,
): CompletionItem[] | null {
  const pattern = /\bimport\s*\{([\s\S]*?)\}\s*from\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;/g;
  for (const match of source.matchAll(pattern)) {
    const statementStart = match.index;
    const contentStart = statementStart + match[0].indexOf("{") + 1;
    const contentEnd = contentStart + match[1].length;
    if (offset < contentStart || offset > contentEnd) continue;
    const contentBefore = source.slice(contentStart, offset);
    if (/\bas\s+[A-Za-z_][A-Za-z0-9_]*$/.test(contentBefore)) return [];
    const prefix = contentBefore.match(/([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ?? "";
    const existing = new Set(
      match[1]
        .split(",")
        .map((part) => /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(part)?.[1])
        .filter((name): name is string => Boolean(name)),
    );
    if (prefix) existing.delete(prefix);
    const specifier = match[2].slice(1, -1);
    const candidates = selectiveImportCandidates(specifier, fileName);
    return filterCompletions(candidates.filter((item) => !existing.has(item.label)), prefix, 2500);
  }
  return null;
}

function selectiveImportCandidates(specifier: string, fileName: string): CompletionItem[] {
  if (specifier === "std") {
    return [{ label: "console", kind: completionKinds.module, detail: "standard console" }];
  }
  if (specifier === "std/time") {
    return (["sleep", "delay"] as const).map((name) => ({
      label: name,
      kind: completionKinds.function,
      detail: standardFunctionDetail(name, name),
    }));
  }
  if (specifier === "std/test") {
    return [
      {
        label: "expect",
        kind: completionKinds.function,
        detail: "expect<T>(value: in T): Expectation<T>",
      },
      {
        label: "fail",
        kind: completionKinds.function,
        detail: "fail(message: in String): void",
      },
    ];
  }
  if (specifier === "std/text") {
    return [{
      label: "TextBuffer",
      kind: completionKinds.struct,
      detail: "move-only UTF-8 text construction buffer",
    }];
  }
  if (specifier === "std/memory") {
    return [{
      label: "Arena",
      kind: completionKinds.struct,
      detail: "Arena(options?: { initialCapacity: usize })  // growable region storage",
    }];
  }
  if (specifier === "std/collections") {
    return [
      {
        label: "Map",
        kind: completionKinds.struct,
        detail: "Map<K, V>()  // owned associative storage",
      },
      {
        label: "Set",
        kind: completionKinds.struct,
        detail: "Set<T>()  // owned unique-value storage",
      },
    ];
  }
  if (specifier === "std/hash") {
    return [
      {
        label: "Hashable",
        kind: completionKinds.interface,
        detail: "trait Hashable  // nominal equality and hash contract",
      },
      {
        label: "Hasher",
        kind: completionKinds.struct,
        detail: "mutable hash-composition state",
      },
    ];
  }
  if (specifier === "std/iteration") {
    return [
      {
        label: "Iterator",
        kind: completionKinds.interface,
        detail: "trait Iterator<T>  // stateful next(inout this): Option<T>",
      },
      {
        label: "Generator",
        kind: completionKinds.struct,
        detail: "Generator<Yield, Return?, Error?>  // cold, move-only synchronous sequence",
      },
      {
        label: "AsyncGenerator",
        kind: completionKinds.struct,
        detail: "AsyncGenerator<Yield, Return?, Error?>  // cold, move-only asynchronous sequence",
      },
    ];
  }
  if (specifier === "std/thread") {
    return [{
      label: "thread",
      kind: completionKinds.module,
      detail: "native thread task launcher",
    }];
  }
  if (specifier === "std/async") {
    return [
      {
        label: "scheduler",
        kind: completionKinds.module,
        detail: "cooperative operations for the current async executor",
      },
      {
        label: "TaskScope",
        kind: completionKinds.class,
        detail: "thread-safe structured owner for dynamically submitted child work",
      },
      {
        label: "TaskControl",
        kind: completionKinds.class,
        detail: "non-joining per-operation cancellation control",
      },
    ];
  }
  if (specifier === "std/console" || specifier === "std/objc") return [];
  const alias = "__z_completion_module";
  let context: AnalyzedSource;
  try {
    context = analyzeSource(
      `import ${alias} from ${JSON.stringify(specifier)}; function main(): i32 { return 0; }`,
      fileName,
      { requireMain: false },
    );
  } catch {
    return [];
  }
  const declaration = context.sourceProgram.imports[0];
  if (isLocalSourceModuleSpecifier(specifier)) {
    const module = declaration ? localSourceModule(context, declaration) : null;
    if (!module) return [];
    return [...module.exports.keys()].map((name) => ({
      label: name,
      kind: sourceExportCompletionKind(module, name),
      detail: sourceExportDetail(module, name, context.typeDisplayNames),
    }));
  }
  const module = context.foreignModules.get(alias);
  return module ? moduleCompletions(module, "", [], true) : [];
}

type ObjectFieldShape = {
  readonly name: string;
  readonly type: string;
  readonly visibility: "public" | "private";
};

function objectFieldCompletions(
  source: string,
  fileName: string,
  offset: number,
): CompletionItem[] | null {
  const before = source.slice(0, offset);
  const bindingPattern = before.match(/\b(?:const|let)\s*\{([^{}]*)$/);
  if (bindingPattern && bindingPattern.index !== undefined) {
    const remainder = source.slice(offset);
    const close = remainder.indexOf("}");
    if (close >= 0) {
      const tail = remainder.slice(close);
      const prefix = bindingPattern[1].match(/([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ?? "";
      const used = new Set(
        [...bindingPattern[1].matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=:|,|$)/g)]
          .map((match) => match[1]),
      );
      if (prefix) used.delete(prefix);
      let fields: ObjectFieldShape[] | null = null;
      const iteration = tail.match(/^\}\s+of\s+(?:inout\s+)?([A-Za-z_][A-Za-z0-9_]*)/);
      if (iteration) {
        const iterableType = declaredBindingType(source, iteration[1], offset);
        const compactIterableType = iterableType?.replace(/\s+/g, "") ?? null;
        const sourceGeneric = compactIterableType ? parseSourceGenericType(compactIterableType) : null;
        const map = compactIterableType
          ? parseMapType(compactIterableType)
            ?? (sourceGeneric?.base === "Map" && sourceGeneric.arguments.length === 2
              ? { keyType: sourceGeneric.arguments[0], valueType: sourceGeneric.arguments[1] }
              : null)
          : null;
        if (map) {
          fields = [
            { name: "key", type: map.keyType, visibility: "public" },
            { name: "value", type: map.valueType, visibility: "public" },
          ];
        } else if (compactIterableType) {
          const analysis = safeAnalysis(source, fileName);
          const element = parseFixedArrayType(compactIterableType)?.elementType
            ?? parseSliceType(compactIterableType)?.elementType
            ?? parseDynamicArrayType(compactIterableType)?.elementType
            ?? parseSetType(compactIterableType)?.elementType
            ?? analysis?.semanticInfo.iteratorElementTypes.get(compactIterableType)
            ?? (sourceGeneric && ["Array", "Slice", "Set"].includes(sourceGeneric.base)
              ? sourceGeneric.arguments[0]
              : /^(.+)\[[0-9]+\]$/.exec(compactIterableType)?.[1]);
          if (element) fields = objectFieldsForType(source, safeAnalysis(source, fileName), element);
        }
      } else {
        const local = tail.match(/^\}\s*(?::\s*([^=;]+))?\s*=\s*(?:(?:copy|move)\s+)?([A-Za-z_][A-Za-z0-9_.]*(?:<[^;=(){}]+>)?)(\s*\()?/);
        if (local) {
          const annotated = local[1]?.trim();
          const sourceType = annotated
            ?? (local[3]
              ? local[2].trim()
              : declaredBindingType(source, local[2].trim(), offset));
          if (sourceType) fields = objectFieldsForType(source, safeAnalysis(source, fileName), sourceType);
        }
      }
      if (fields) {
        const items = fields
          .filter((field) => field.visibility === "public" && !used.has(field.name))
          .map((field) => ({
            label: field.name,
            kind: completionKinds.field,
            detail: `${field.name}: ${field.type}`,
            insertText: field.name,
            sortText: `0-${field.name}`,
          }));
        return filterCompletions(items, prefix, 1000);
      }
    }
  }
  const object = before.match(/(?:\bnew\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:<[^{}()]+>)?)\s*\(\s*\{([^{}]*)$/);
  if (!object) return null;
  const prefix = object[2].match(/([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ?? "";
  const used = new Set(
    [...object[2].matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=:|,|$)/g)]
      .map((match) => match[1]),
  );
  if (prefix) used.delete(prefix);
  const analysis = safeAnalysis(source, fileName) ?? importAnalysis(source, fileName);
  let payloadType = object[1];
  let patternBinding = false;
  let fields: ObjectFieldShape[] | null = analysis?.semanticInfo.standardTypeBindings.get(payloadType) === "Arena"
    ? [{ name: "initialCapacity", type: "usize", visibility: "public" }]
    : objectFieldsForType(source, analysis, payloadType);
  if (!fields && payloadType.includes(".")) {
    const separator = payloadType.lastIndexOf(".");
    const enumName = payloadType.slice(0, separator);
    const variantName = payloadType.slice(separator + 1);
    const variantPayload = enumPayloadType(source, analysis, enumName, variantName);
    if (variantPayload) {
      payloadType = variantPayload;
      fields = objectFieldsForType(source, analysis, payloadType);
    }
  }
  if (!fields) {
    const subject = matchSubjectBefore(source, before.length - object[0].length);
    const subjectType = subject ? declaredBindingType(source, subject, offset) : null;
    let variantPayload = subjectType
      ? enumPayloadType(source, analysis, subjectType, object[1])
      : null;
    if (!variantPayload && subjectType) {
      const option = /^Option<(.+)>$/.exec(subjectType);
      if (option && object[1] === "some") variantPayload = option[1];
    }
    if (!variantPayload) variantPayload = uniqueEnumVariantPayload(source, object[1]);
    if (variantPayload) {
      payloadType = variantPayload;
      fields = objectFieldsForType(source, analysis, payloadType);
      patternBinding = true;
    }
  }
  if (!fields) return null;
  const items = fields
    .filter((field) => !used.has(field.name))
    .map((field) => ({
      label: field.name,
      kind: completionKinds.field,
      detail: `${field.name}: ${field.type}`,
      insertText: patternBinding ? field.name : `${field.name}: `,
      sortText: `0-${field.name}`,
    }));
  return filterCompletions(items, prefix, 1000);
}

function objectFieldsForType(
  source: string,
  context: AnalyzedSource | null,
  typeName: string,
): ObjectFieldShape[] | null {
  if (context) {
    const aggregate = sourceAggregateForType(context, typeName);
    if (aggregate) {
      return aggregate.declaration.fields.map((field) => ({
        name: field.name,
        type: displaySubstitutedType(field.type.name, aggregate.substitutions, context.typeDisplayNames),
        visibility: field.visibility,
      }));
    }
    const foreign = resolveForeignNamedTypeForText(context, typeName);
    if (foreign?.kind === "record") {
      return foreign.fields.map((field) => ({ name: field.name, type: field.typeName, visibility: "public" }));
    }
  }
  return localAggregateFields(source, typeName);
}

function resolveForeignNamedTypeForText(
  context: Pick<AnalyzedSource, "foreignModules" | "sourceProgram" | "semanticInfo">,
  text: string,
): ForeignNamedType | null {
  const direct = context.semanticInfo.foreignNamedTypes.get(text);
  if (direct) return direct;
  const [moduleName, ...path] = text.split(".");
  const namespaceBinding = foreignNamespaceBindings(context).get(moduleName);
  const module = context.foreignModules.get(moduleName) ?? namespaceBinding?.module;
  if (!module || path.length === 0) return null;
  return resolveModuleNamedType(
    module,
    [...(namespaceBinding?.namespacePath ?? []), ...path.slice(0, -1)],
    path.at(-1)!,
  ) ?? null;
}

function localAggregateFields(source: string, typeName: string): ObjectFieldShape[] | null {
  const generic = parseGenericType(typeName) ?? parseSourceGenericType(typeName);
  const base = generic?.base ?? typeName;
  let tokens;
  try {
    tokens = lex(source, "completion.zs");
  } catch {
    return null;
  }
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if ((tokens[index].kind !== "struct" && tokens[index].kind !== "class")
      || tokens[index + 1]?.text !== base) continue;
    const parameters: string[] = [];
    let brace = index + 2;
    if (tokens[brace]?.kind === "less") {
      brace += 1;
      while (tokens[brace] && tokens[brace].kind !== "greater") {
        if (tokens[brace].kind === "identifier") parameters.push(tokens[brace].text);
        brace += 1;
      }
      brace += 1;
    }
    while (tokens[brace] && tokens[brace].kind !== "leftBrace") brace += 1;
    if (!tokens[brace]) return null;
    const substitutions = new Map(
      parameters.map((parameter, parameterIndex) => [parameter, generic?.arguments[parameterIndex] ?? parameter]),
    );
    const fields: ObjectFieldShape[] = [];
    let depth = 1;
    for (let cursor = brace + 1; cursor < tokens.length && depth > 0; cursor += 1) {
      if (tokens[cursor].kind === "leftBrace") {
        depth += 1;
        continue;
      }
      if (tokens[cursor].kind === "rightBrace") {
        depth -= 1;
        continue;
      }
      if (depth !== 1) continue;
      const visibility = tokens[cursor].kind === "private" ? "private" : "public";
      const nameIndex = tokens[cursor].kind === "private" || tokens[cursor].kind === "public"
        ? cursor + 1
        : cursor;
      if (tokens[nameIndex]?.kind !== "identifier" || tokens[nameIndex + 1]?.kind !== "colon") continue;
      let end = nameIndex + 2;
      while (tokens[end] && tokens[end].kind !== "semicolon") end += 1;
      if (!tokens[end]) continue;
      const startOffset = tokens[nameIndex + 1].location.offset + 1;
      let fieldType = source.slice(startOffset, tokens[end].location.offset).trim();
      for (const [parameter, argument] of substitutions) {
        fieldType = fieldType.replace(new RegExp(`\\b${parameter}\\b`, "g"), argument);
      }
      fields.push({ name: tokens[nameIndex].text, type: fieldType, visibility });
      cursor = end;
    }
    return fields;
  }
  return null;
}

function enumPayloadType(
  source: string,
  context: AnalyzedSource | null,
  enumName: string,
  variantName: string,
): string | null {
  const generic = parseGenericType(enumName) ?? parseSourceGenericType(enumName);
  const base = generic?.base ?? enumName;
  const declaration = context?.sourceProgram.enums.find((item) => item.name === base)
    ?? context?.program.enums.find((item) => item.name === enumName);
  const payload = declaration?.variants.find((variant) => variant.name === variantName)?.payload?.name;
  if (payload) return payload;
  return localEnumPayloads(source)
    .find((item) => item.enumName === base && item.variantName === variantName)?.payloadType ?? null;
}

function uniqueEnumVariantPayload(source: string, variantName: string): string | null {
  const payloads = new Set(
    localEnumPayloads(source)
      .filter((item) => item.variantName === variantName && item.payloadType)
      .map((item) => item.payloadType!),
  );
  return payloads.size === 1 ? [...payloads][0] : null;
}

function localEnumPayloads(source: string): Array<{
  readonly enumName: string;
  readonly variantName: string;
  readonly payloadType: string | null;
}> {
  let tokens;
  try {
    tokens = lex(source, "completion.zs");
  } catch {
    return [];
  }
  const payloads: Array<{ enumName: string; variantName: string; payloadType: string | null }> = [];
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index].kind !== "enum" || tokens[index + 1]?.kind !== "identifier") continue;
    const enumName = tokens[index + 1].text;
    let brace = index + 2;
    while (tokens[brace] && tokens[brace].kind !== "leftBrace") brace += 1;
    let depth = 1;
    for (let cursor = brace + 1; cursor < tokens.length && depth > 0; cursor += 1) {
      if (tokens[cursor].kind === "leftBrace") {
        depth += 1;
        continue;
      }
      if (tokens[cursor].kind === "rightBrace") {
        depth -= 1;
        continue;
      }
      if (depth !== 1 || tokens[cursor].kind !== "identifier") continue;
      const variant = tokens[cursor];
      let end = cursor + 1;
      let nested = 0;
      while (tokens[end]) {
        if (["less", "leftBracket", "leftParen"].includes(tokens[end].kind)) nested += 1;
        if (["greater", "rightBracket", "rightParen"].includes(tokens[end].kind)) nested -= 1;
        if (nested === 0 && (tokens[end].kind === "comma" || tokens[end].kind === "rightBrace")) break;
        end += 1;
      }
      const startOffset = variant.location.offset + variant.text.length;
      const payloadType = source.slice(startOffset, tokens[end]?.location.offset ?? startOffset).trim() || null;
      payloads.push({ enumName, variantName: variant.text, payloadType });
      cursor = end - 1;
    }
  }
  return payloads;
}

function matchSubjectBefore(source: string, beforeObjectOffset: number): string | null {
  const before = source.slice(0, beforeObjectOffset);
  return [...before.matchAll(/\bmatch\s*\(\s*(?:in\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*\{/g)].at(-1)?.[1] ?? null;
}

function declaredBindingType(source: string, name: string, offset: number): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = source.slice(0, offset);
  const annotations = [...before.matchAll(new RegExp(`\\b${escaped}\\s*:\\s*([A-Za-z_][A-Za-z0-9_.]*(?:<[^;=(){}]+>)?)`, "g"))];
  const annotated = annotations.at(-1)?.[1]?.trim();
  if (annotated) return annotated;
  const constructions = [...before.matchAll(new RegExp(
    `\\b(?:const|let)\\s+${escaped}\\s*=\\s*(?:new\\s+)?([A-Za-z_][A-Za-z0-9_.]*(?:<[^;=(){}]+>)?)\\s*\\(`,
    "g",
  ))];
  const constructed = constructions.at(-1)?.[1]?.trim();
  if (constructed) return constructed;
  const initializers = [...before.matchAll(new RegExp(`\\b(?:const|let)\\s+${escaped}\\s*=\\s*([A-Za-z_][A-Za-z0-9_.]*(?:<[^;=(){}]+>)?)\\.`, "g"))];
  return initializers.at(-1)?.[1]?.trim() ?? null;
}

function symbolCompletions(
  source: string,
  fileName: string,
  offset: number,
  allowEmptyPrefix = false,
): CompletionItem[] {
  const prefix = source.slice(0, offset).match(/([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ?? "";
  if (!prefix && !allowEmptyPrefix) return [];
  const builtIns: CompletionItem[] = [{
    label: "Option",
    kind: completionKinds.enum,
    detail: "compiler-provided enum Option<T>",
  }];
  try {
    const parsed = parse(lex(source, fileName), fileName);
    for (const declaration of parsed.imports) {
      if (declaration.header !== "std/text" && declaration.header !== "std/memory" && declaration.header !== "std/collections" && declaration.header !== "std/hash" && declaration.header !== "std/iteration" && declaration.header !== "std/async") continue;
      for (const binding of declaration.bindings ?? []) {
        if (binding.importedName !== "TextBuffer" && binding.importedName !== "Arena" && binding.importedName !== "Map" && binding.importedName !== "Set" && binding.importedName !== "Hashable" && binding.importedName !== "Hasher" && binding.importedName !== "Iterator" && binding.importedName !== "Generator" && binding.importedName !== "AsyncGenerator" && binding.importedName !== "TaskScope" && binding.importedName !== "TaskControl") continue;
        const detail = binding.importedName === "TextBuffer"
          ? "move-only UTF-8 construction storage"
          : binding.importedName === "Arena"
            ? "move-only growable region storage"
            : binding.importedName === "Map"
              ? "owned associative storage"
              : binding.importedName === "Set"
                ? "owned unique-value storage"
                : binding.importedName === "Hashable"
                  ? "nominal equality and hash contract"
                  : binding.importedName === "Iterator"
                    ? "stateful iteration contract"
                    : binding.importedName === "Generator"
                      ? "cold move-only synchronous sequence"
                      : binding.importedName === "AsyncGenerator"
                        ? "cold move-only asynchronous sequence"
                      : binding.importedName === "TaskScope"
                        ? "thread-safe structured child-work owner"
                        : binding.importedName === "TaskControl"
                          ? "non-joining per-operation cancellation control"
                    : "mutable hash-composition state";
        builtIns.push({
          label: binding.localName,
          kind: binding.importedName === "Hashable" || binding.importedName === "Iterator"
            ? completionKinds.interface
            : binding.importedName === "TaskScope" || binding.importedName === "TaskControl" ? completionKinds.class : completionKinds.struct,
          detail: binding.localName === binding.importedName
            ? `${binding.importedName}${binding.importedName === "Hashable" || binding.importedName === "Iterator" || binding.importedName === "Generator" || binding.importedName === "AsyncGenerator" || binding.importedName === "TaskScope" || binding.importedName === "TaskControl" ? "" : "()"}  // ${detail}`
            : `${binding.importedName}  // imported as ${binding.localName}`,
          sortText: `0-${binding.localName}`,
        });
      }
    }
  } catch {
    // The semantic recovery paths below still provide language-token fallback
    // while a surrounding declaration is syntactically incomplete.
  }
  const tokenItems = languageTokenCompletions(fileName);
  const start = offset - prefix.length;
  const tailOffset = source[offset] === ";" ? offset + 1 : offset;
  const context = safeAnalysis(source, fileName)
    ?? safeAnalysis(source.slice(0, start) + "0;" + source.slice(tailOffset), fileName)
    ?? completionRecoveryAnalysis(source, fileName, start, tailOffset, prefix);
  if (!context) return filterCompletions([...builtIns, ...tokenItems], prefix, 500);
  const items: CompletionItem[] = [...builtIns];
  for (const binding of collectBindings(context)) {
    if (binding.fileName && resolve(binding.fileName) !== resolve(fileName)) continue;
    if (binding.offset >= start) continue;
    items.push({
      label: binding.name,
      kind: completionKinds.variable,
      detail: `${binding.parameter ? "parameter" : binding.readonly ? "const" : "let"} ${binding.name}: ${
        (() => {
          const sourceType = sourceBindingTypeName(context.sourceProgram, binding.offset);
          return sourceType
            ? sourceAliasDisplayType(context, sourceType) ?? displayServiceType(binding.type, context)
            : displayServiceType(binding.type, context);
        })()
      }`,
      sortText: `0-${binding.name}`,
    });
  }
  for (const declaration of context.program.functions) {
    if (
      declaration.testName
      || declaration.name.startsWith("__z_mono_")
      || declaration.name.startsWith("__z_module_")
    ) continue;
    items.push({
      label: declaration.name,
      kind: completionKinds.function,
      detail: zFunctionDetail(
        declaration.name,
        declaration.parameters,
        declaration.returnType.name,
        declaration.typeParameters,
        context.typeDisplayNames,
        declaration.typeParameterConstraints,
        declaration.async,
        declaration.errorType?.name,
        Boolean(declaration.executorAffinity),
      ),
    });
  }
  for (const declaration of context.program.structs) {
    if (declaration.name.startsWith("__z_mono_") || declaration.name.startsWith("__z_module_")) continue;
    const executor = context.semanticInfo.aggregateExecutorAffinities.has(declaration.name)
      || declaration.executorAffinity
      ? " on thread.main"
      : "";
    items.push({
      label: declaration.name,
      kind: declaration.kind === "class" ? completionKinds.class : completionKinds.struct,
      detail: `${declaration.kind} ${declaration.name}${executor}`,
    });
  }
  for (const declaration of context.sourceProgram.typeAliases) {
    items.push({
      label: declaration.name,
      kind: completionKinds.typeParameter,
      detail: `type ${declaration.name} = ${displayType(declaration.target.name, context.typeDisplayNames)}`,
    });
  }
  for (const match of source.matchAll(/\b(function|struct|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*<([^>]+)>/g)) {
    const kind = match[1] === "function" ? completionKinds.function : match[1] === "class" ? completionKinds.class : completionKinds.struct;
    items.push({ label: match[2], kind, detail: `${match[1]} ${match[2]}<${match[3].trim()}>` });
  }
  for (const declaration of context.program.traits) {
    if (declaration.name.startsWith("__z_module_") || declaration.name.startsWith("__z_mono_")) continue;
    items.push({
      label: declaration.name,
      kind: completionKinds.interface,
      detail: `trait ${declaration.name}${formatTypeParameters(
        declaration.typeParameters ?? [],
        declaration.typeParameterConstraints ?? [],
        context.typeDisplayNames,
      )}`,
    });
  }
  for (const declaration of context.program.enums) {
    if (declaration.name.startsWith("__z_module_") || declaration.name.startsWith("__z_Result_") || declaration.name.startsWith("__z_Option_")) continue;
    items.push({ label: declaration.name, kind: completionKinds.enum, detail: `enum ${declaration.name}` });
  }
  for (const [name, module] of context.foreignModules) {
    if (!module.declaration.bindings) {
      items.push({ label: name, kind: completionKinds.module, detail: `import from ${JSON.stringify(module.declaration.header)}` });
      continue;
    }
    for (const binding of module.declaration.bindings) {
      if (!module.namespaces.has(binding.importedName)) continue;
      items.push({
        label: binding.localName,
        kind: completionKinds.module,
        detail: `native namespace ${binding.importedName} from ${JSON.stringify(module.declaration.header)}`,
      });
    }
  }
  for (const declaration of context.sourceProgram.imports) {
    if (!isLocalSourceModuleSpecifier(declaration.header)) continue;
    const module = localSourceModule(context, declaration);
    if (!module) continue;
    if (!declaration.bindings) {
      items.push({ label: declaration.moduleName, kind: completionKinds.module, detail: `Z module ${JSON.stringify(declaration.header)}` });
      continue;
    }
    for (const binding of declaration.bindings) {
      const detail = sourceExportDetail(
        module,
        binding.importedName,
        context.typeDisplayNames,
        binding.localName,
      );
      items.push({
        label: binding.localName,
        kind: sourceExportCompletionKind(module, binding.importedName),
        detail: binding.localName === binding.importedName
          ? detail
          : `${detail} — alias of ${binding.importedName} from ${JSON.stringify(declaration.header)}`,
      });
    }
  }
  for (const name of context.semanticInfo.consoleBindings) {
    items.push({ label: name, kind: completionKinds.module, detail: `standard console imported as ${name}` });
  }
  for (const [name, module] of context.semanticInfo.standardModuleBindings) {
    items.push({ label: name, kind: completionKinds.module, detail: `standard ${module} module imported as ${name}` });
  }
  for (const [name, standardFunction] of context.semanticInfo.standardFunctionBindings) {
    items.push({
      label: name,
      kind: completionKinds.function,
      detail: standardFunctionDetail(name, standardFunction),
      sortText: `0-${name}`,
    });
  }
  for (const [name, testBinding] of context.semanticInfo.testBindings) {
    items.push({
      label: name,
      kind: completionKinds.function,
      detail: testBinding === "expect"
        ? "expect<T>(value: in T): Expectation<T>"
        : "fail(message: in String): void",
      sortText: `0-${name}`,
    });
  }
  for (const [name, standardType] of context.semanticInfo.standardTypeBindings) {
    items.push({
      label: name,
      kind: standardType === "Hashable" || standardType === "Iterator"
        ? completionKinds.interface
        : standardType === "TaskScope" || standardType === "TaskControl" ? completionKinds.class : completionKinds.struct,
      detail: standardType === "TextBuffer"
        ? `${standardType}()  // move-only UTF-8 construction storage`
        : standardType === "Arena"
          ? `${standardType}(options?: { initialCapacity: usize })  // move-only growable region storage`
          : standardType === "Map"
            ? `${standardType}<K, V>()  // owned associative storage`
            : standardType === "Set"
              ? `${standardType}<T>()  // owned unique-value storage`
              : standardType === "Hashable"
                ? "trait Hashable  // equals and hash contract"
                : standardType === "Iterator"
                  ? "trait Iterator<T>  // next(inout this): Option<T>"
                  : standardType === "Generator"
                    ? "Generator<Yield, Return?, Error?>  // cold, move-only synchronous sequence"
                  : standardType === "AsyncGenerator"
                    ? "AsyncGenerator<Yield, Return?, Error?>  // cold, move-only asynchronous sequence"
                  : standardType === "TaskScope"
                    ? "new TaskScope()  // thread-safe structured child-work owner"
                  : standardType === "TaskControl"
                    ? "TaskControl  // returned by TaskScope.schedule; non-joining cancellation control"
                  : "Hasher  // mutable hash-composition state",
      sortText: `0-${name}`,
    });
  }
  const semanticLabels = new Set(items.map((item) => item.label));
  items.push(...tokenItems.filter((item) => !semanticLabels.has(item.label)));
  return filterCompletions(uniqueCompletions(items), prefix, 500);
}

function objcProtocolMethodCompletions(
  source: string,
  fileName: string,
  offset: number,
): CompletionItem[] | null {
  const prefix = source.slice(0, offset).match(/([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ?? "";
  const start = offset - prefix.length;
  const sanitized = source.slice(0, start) + source.slice(offset);
  const context = safeAnalysis(sanitized, fileName);
  if (!context) return null;
  const owner = enclosingAggregateAt(sanitized, fileName, start, context.sourceProgram);
  if (!owner || owner.kind !== "class" || owner.implements.length === 0) return null;
  const protocols = owner.implements.flatMap((reference) => {
    const protocol = context.semanticInfo.foreignProtocols.get(reference.name);
    return protocol ? [protocol] : [];
  });
  if (protocols.length === 0) return null;
  const implemented = new Set(owner.methods.flatMap((method) => method.nativeSelector ? [method.nativeSelector] : []));
  const requirements = uniqueObjCProtocolRequirements(protocols, context.semanticInfo.foreignProtocols)
    .filter((method) => method.instance && !implemented.has(method.selector));
  if (requirements.length === 0) return [];
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const indentation = source.slice(lineStart, start).match(/^\s*/)?.[0] ?? "";
  const items = requirements.map((method): CompletionItem => {
    const localName = objcProtocolLocalMethodName(method);
    return {
      label: localName,
      kind: completionKinds.method,
      detail: `${method.required ? "required" : "optional"} ${objCProtocolMethodDetail(method)}`,
      insertText: objcProtocolMethodScaffold(method, localName, indentation),
      insertTextFormat: 2,
      sortText: `${method.required ? "0" : "1"}-${localName}`,
    };
  });
  return filterCompletions(uniqueCompletions(items), prefix, 2500);
}

function enclosingAggregateAt(
  source: string,
  fileName: string,
  offset: number,
  program: Program,
): StructDeclaration | null {
  let tokens;
  try {
    tokens = lex(source, fileName);
  } catch {
    return null;
  }
  for (const declaration of program.structs) {
    const declarationIndex = tokens.findIndex((token, index) => (
      token.location.offset === declaration.location.offset
      && (token.kind === "class" || token.kind === "struct")
      && tokens[index + 1]?.text === declaration.name
    ));
    if (declarationIndex < 0) continue;
    let brace = declarationIndex + 2;
    while (brace < tokens.length && tokens[brace].kind !== "leftBrace") brace += 1;
    if (brace >= tokens.length || tokens[brace].location.offset >= offset) continue;
    let depth = 0;
    for (let cursor = brace; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token.location.offset >= offset) return depth === 1 ? declaration : null;
      if (token.kind === "leftBrace") depth += 1;
      if (token.kind === "rightBrace") depth -= 1;
      if (depth === 0) break;
    }
  }
  return null;
}

function uniqueObjCProtocolRequirements(
  roots: readonly ForeignObjCProtocol[],
  protocols: ReadonlyMap<string, ForeignObjCProtocol>,
): ForeignObjCProtocolMethod[] {
  const methods = new Map<string, ForeignObjCProtocolMethod>();
  const visited = new Set<string>();
  const visit = (protocol: ForeignObjCProtocol): void => {
    if (visited.has(protocol.typeName)) return;
    visited.add(protocol.typeName);
    for (const method of protocol.methods) {
      if (!methods.has(method.selector)) methods.set(method.selector, method);
    }
    const separator = protocol.typeName.lastIndexOf(".");
    const moduleName = separator < 0 ? "" : protocol.typeName.slice(0, separator);
    for (const inheritedName of protocol.inherited) {
      if (inheritedName === "NSObject") continue;
      const inherited = protocols.get(moduleName ? `${moduleName}.${inheritedName}` : inheritedName);
      if (inherited) visit(inherited);
    }
  };
  roots.forEach(visit);
  return [...methods.values()];
}

function objcProtocolLocalMethodName(method: ForeignObjCProtocolMethod): string {
  const labels = selectorParts(method.selector);
  if (labels.length < 2) return method.baseName;
  if (/^(?:tableView|outlineView|collectionView|control)$/.test(labels[0])) {
    let name = labels[1];
    name = name.replace(/For(?:TableColumn|Item|IndexPath)$/, "");
    if (labels.includes("row") && !/Row$/.test(name)) name += "Row";
    if (labels.includes("item") && !/Item$/.test(name)) name += "Item";
    return name;
  }
  return method.baseName;
}

function objCProtocolMethodDetail(method: ForeignObjCProtocolMethod): string {
  const parameters = method.parameters.map((parameter, index) => (
    `${parameter.type.kind === "object" ? "in " : ""}${parameter.name ?? `argument${index + 1}`}: ${foreignProtocolTypeName(parameter.type)}`
  ));
  return `${method.selector} — (${parameters.join(", ")}): ${foreignProtocolTypeName(method.returnType)}`;
}

function objcProtocolMethodScaffold(
  method: ForeignObjCProtocolMethod,
  localName: string,
  indentation: string,
): string {
  const parameters = method.parameters.map((parameter, index) => (
    `${parameter.type.kind === "object" ? "in " : ""}${parameter.name ?? `argument${index + 1}`}: ${foreignProtocolTypeName(parameter.type)}`
  ));
  const parameterBlock = parameters.length === 0
    ? "()"
    : `(\n${parameters.map((parameter) => `${indentation}  ${parameter}`).join(`,\n`)}\n${indentation})`;
  const result = foreignProtocolTypeName(method.returnType);
  const placeholder = result === "void" ? "" : `\n${indentation}  \${1:// TODO: return ${result}}`;
  return `function ${localName}${parameterBlock}: ${result} as ${JSON.stringify(method.selector)} {${placeholder}\n${indentation}}`;
}

function foreignProtocolTypeName(type: ForeignType): string {
  if (type.kind !== "object") return foreignTypeName(type);
  const publicName = type.typeName.replace(/^__z_objc:(?:nullable|nonnull):/, "");
  return `${publicName}${type.nullable ? " | null" : ""}`;
}

function languageTokenCompletions(fileName: string): CompletionItem[] {
  const keywords = fileName.endsWith(".zd") ? declarationKeywordTokens : sourceKeywordTokens;
  const items: CompletionItem[] = keywords.map((label) => ({
    label,
    kind: completionKinds.keyword,
    detail: fileName.endsWith(".zd") ? "Z declaration keyword" : "Z keyword",
    sortText: `8-${label}`,
  }));
  items.push(...primitiveTypeTokens.map((label) => ({
    label,
    kind: completionKinds.keyword,
    detail: "Z type",
    sortText: `7-${label}`,
  })));
  if (fileName.endsWith(".zd")) {
    items.push(
      { label: "_", kind: completionKinds.keyword, detail: "infer type from the native declaration", sortText: "6-_" },
      { label: "null", kind: completionKinds.constant, detail: "nullable foreign value", sortText: "7-null" },
      { label: "clong", kind: completionKinds.keyword, detail: "C `long` ABI type; projects to the target-width Z integer", sortText: "6-clong" },
    );
  }
  return items;
}

function foreignDeclarationObjCMethods(
  module: ForeignModule,
  qualifiedName: string,
  parameterCount?: number,
): readonly { readonly className: string; readonly method: ForeignObjCMethod }[] {
  const separator = qualifiedName.lastIndexOf(".");
  if (separator < 1 || separator === qualifiedName.length - 1) return [];
  const className = qualifiedName.slice(0, separator);
  const baseName = qualifiedName.slice(separator + 1);
  const declaration = module.interfaces.get(className);
  if (!declaration) return [];
  return declaration.methods
    .filter((method) => (
      method.baseName === baseName
      && (parameterCount === undefined || method.parameters.length === parameterCount)
    ))
    .map((method) => ({ className, method }));
}

function foreignDeclarationNativeSignatures(
  module: ForeignModule,
  qualifiedName: string,
  parameterCount?: number,
): readonly {
  readonly parameters: ForeignObjCMethod["parameters"];
  readonly returnType: ForeignType;
}[] {
  const declaration = module.functions.get(qualifiedName);
  if (declaration) return declaration.overloads;
  return foreignDeclarationObjCMethods(module, qualifiedName, parameterCount)
    .map(({ method }) => method);
}

function foreignDeclarationCompletions(source: string, fileName: string, offset: number): CompletionItem[] {
  const before = source.slice(0, offset);
  const prefix = before.match(/([A-Za-z_][A-Za-z0-9_.]*)$/)?.[1] ?? "";
  if (!prefix) return [];
  const executorPrefix = /\bon\s+thread\.([A-Za-z_]*)$/.exec(before)?.[1];
  if (executorPrefix !== undefined) {
    return "main".startsWith(executorPrefix)
      ? [{
          label: "main",
          kind: completionKinds.property,
          detail: "main-thread executor affinity",
          sortText: "0-main",
        }]
      : [];
  }
  const module = foreignDeclarationNativeModule(source, fileName);
  const contextual: CompletionItem[] = [];
  const ownerName = [...before.matchAll(/\bexport\s+function\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].at(-1)?.[1];
  const owner = ownerName ? module?.functions.get(ownerName) : null;
  const ownerSignatures = ownerName && module
    ? foreignDeclarationNativeSignatures(module, ownerName)
    : [];
  const activeCallbackName = [...before.matchAll(/\bcallback\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)].at(-1)?.[1];
  const activeCallbacks = activeCallbackName
    ? ownerSignatures.flatMap((signature) => signature.parameters
      .filter((parameter) => parameter.name === activeCallbackName && parameter.type.kind === "callback")
      .map((parameter) => parameter.type))
    : [];

  const typePrefix = /\bexport\s+type\s+([A-Za-z_][A-Za-z0-9_.]*)?$/.exec(before)?.[1];
  if (module && typePrefix !== undefined) {
    const declared = new Set([...source.matchAll(/\bexport\s+type\s+([A-Za-z_][A-Za-z0-9_.]*)\b/g)].map((match) => match[1]));
    for (const declaration of module.namedTypes.values()) {
      if ((declaration.kind !== "value" && declaration.kind !== "record")
        || declared.has(declaration.qualifiedName)
        || !declaration.qualifiedName.toLowerCase().startsWith(typePrefix.toLowerCase())) continue;
      contextual.push({
        label: declaration.qualifiedName,
        kind: completionKinds.struct,
        detail: foreignNamedTypeDetail(declaration),
        sortText: `0-${declaration.qualifiedName}`,
      });
    }
    for (const declaration of module.interfaces.values()) {
      if (declared.has(declaration.exportName)
        || !declaration.exportName.toLowerCase().startsWith(typePrefix.toLowerCase())) continue;
      contextual.push({
        label: declaration.exportName,
        kind: completionKinds.class,
        detail: `Objective-C class ${declaration.className}`,
        sortText: `0-${declaration.exportName}`,
      });
    }
  }

  const lifecycleContext = /\bexport\s+type\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\{[^}]*?([A-Za-z_]*)$/.exec(before);
  if (module && lifecycleContext) {
    const declaration = module.namedTypes.get(lifecycleContext[1]);
    if (declaration?.kind === "value") {
      const existing = new Set([...lifecycleContext[0].matchAll(/\b(copy|move|deinit)\s*;/g)].map((match) => match[1]));
      for (const capability of ["copy", "move", "deinit"] as const) {
        if (!declaration.lifecycle[capability]
          || existing.has(capability)
          || !capability.startsWith(lifecycleContext[2])) continue;
        contextual.push({
          label: capability,
          kind: completionKinds.keyword,
          detail: `native ${capability} capability for ${declaration.cName}`,
          insertText: `${capability};`,
          sortText: `0-${capability}`,
        });
      }
    } else if (declaration?.kind === "record") {
      const existing = new Set([...lifecycleContext[0].matchAll(/\b(move|deinit)\b/g)].map((match) => match[1]));
      for (const capability of ["move", "deinit"] as const) {
        if (existing.has(capability) || !capability.startsWith(lifecycleContext[2])) continue;
        contextual.push({
          label: capability,
          kind: completionKinds.keyword,
          detail: capability === "move"
            ? `classify ${declaration.cName} as a unique movable C value resource`
            : `name the C release function for ${declaration.cName}`,
          insertText: capability === "move" ? "move;" : "deinit ",
          sortText: `0-${capability}`,
        });
      }
    }
  }

  const threadContext = /\bthread\s*\{([^{}]*?)([A-Za-z_]*)$/.exec(before);
  if (threadContext) {
    const existing = new Set([...threadContext[1].matchAll(/\b(transfer|share|deinit)\s*;/g)].map((match) => match[1]));
    for (const capability of ["transfer", "share", "deinit"] as const) {
      if (existing.has(capability)
        || (capability === "transfer" && existing.has("share"))
        || (capability === "share" && existing.has("transfer"))
        || !capability.startsWith(threadContext[2])) continue;
      contextual.push({
        label: capability,
        kind: completionKinds.keyword,
        detail: capability === "transfer"
          ? "unique native ownership may move to another thread"
          : capability === "share"
            ? "reserved: native identity may be shared across threads"
            : "native destruction is safe on the receiving thread",
        insertText: `${capability};`,
        sortText: `0-${capability}`,
      });
    }
  }

  const functionPrefix = /\bexport\s+function\s+([A-Za-z_][A-Za-z0-9_.]*)?$/.exec(before)?.[1];
  if (module && functionPrefix !== undefined) {
    const declared = new Set([...source.matchAll(/\bexport\s+function\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].map((match) => match[1]));
    for (const [name, declaration] of module.functions) {
      if (declared.has(name) || !name.toLowerCase().startsWith(functionPrefix.toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.function,
        detail: foreignFunctionDetail(declaration),
        sortText: `0-${name}`,
      });
    }
    for (const declaration of module.interfaces.values()) {
      for (const method of declaration.methods) {
        if (method.instance) continue;
        const name = `${declaration.exportName}.${method.baseName}`;
        if (declared.has(name) || !name.toLowerCase().startsWith(functionPrefix.toLowerCase())) continue;
        contextual.push({
          label: name,
          kind: completionKinds.method,
          detail: `static ${declaration.exportName}.${objCMethodDetail(method)}`,
          sortText: `0-${name}`,
        });
      }
    }
  }

  const fixedContractPrefix = /:\s*_(?:\s*\|\s*null)?\s*\{[^{}]*\b([A-Za-z_]*)$/.exec(before)?.[1];
  if (fixedContractPrefix !== undefined && "fixed".startsWith(fixedContractPrefix)) {
    contextual.push({
      label: "fixed",
      kind: completionKinds.keyword,
      detail: "compiler-supplied header constant for this native ABI parameter",
      insertText: "fixed ",
      sortText: "0-fixed",
    });
  }

  const statusContractPrefix = /:\s*void\s+throws\s+_\s*\{[^{}]*\b([A-Za-z_]*)$/.exec(before)?.[1];
  if (statusContractPrefix !== undefined && "success".startsWith(statusContractPrefix)) {
    contextual.push({
      label: "success",
      kind: completionKinds.keyword,
      detail: "native integer status treated as successful void completion",
      insertText: "success ",
      sortText: "0-success",
    });
  }
  const resultOwnershipPrefix = /\bexport\s+function\s+[A-Za-z_][A-Za-z0-9_.]*\s*\([^)]*\)\s*:\s*_(?:\s*\|\s*null)?\s*\{[^{}]*\b([A-Za-z_]*)$/.exec(before)?.[1];
  if (resultOwnershipPrefix !== undefined) {
    for (const ownership of ["owned", "borrowed"] as const) {
      if (!ownership.startsWith(resultOwnershipPrefix)) continue;
      contextual.push({
        label: ownership,
        kind: completionKinds.keyword,
        detail: ownership === "owned"
          ? "caller receives unique native value-resource ownership"
          : "native runtime retains ownership; result is lexical and non-escaping",
        insertText: `${ownership};`,
        sortText: `0-${ownership}`,
      });
    }
  }
  const statusValuePrefix = /\bsuccess\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (module && statusValuePrefix !== undefined) {
    for (const constant of module.constants.values()) {
      if (!constant.name.toLowerCase().startsWith(statusValuePrefix.toLowerCase())) continue;
      contextual.push({
        label: constant.name,
        kind: completionKinds.enumMember,
        detail: `${foreignConstantDetail(constant)}; successful native status`,
        sortText: `0-${constant.name}`,
      });
    }
  }
  const parameterLiteralPrefix = /[,(]\s*(?:in\s+)?[A-Za-z_][A-Za-z0-9_]*\s*:\s*([A-Za-z_]*)$/.exec(before)?.[1];
  if (module && parameterLiteralPrefix !== undefined) {
    for (const constant of module.constants.values()) {
      if (!constant.name.toLowerCase().startsWith(parameterLiteralPrefix.toLowerCase())) continue;
      contextual.push({
        label: constant.name,
        kind: completionKinds.enumMember,
        detail: `${foreignConstantDetail(constant)}; exact native argument discriminant`,
        sortText: `0-${constant.name}`,
      });
    }
  }

  const deinitPrefix = /\bdeinit\s+([A-Za-z_][A-Za-z0-9_.]*)?$/.exec(before)?.[1];
  if (module && deinitPrefix !== undefined) {
    const returnTypes = new Set(owner?.overloads.map((overload) => foreignTypeName(overload.returnType).replace(/ \| null$/, "")) ?? []);
    const outputContext = /\bout\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*_(?:\s*\|\s*null)?\s*\{[^{}]*\bdeinit\s+[A-Za-z_][A-Za-z0-9_.]*$/.exec(before);
    const outputTypes = new Set(
      outputContext && owner
        ? owner.overloads.flatMap((overload) => overload.parameters
          .filter((parameter) => parameter.name === outputContext[1])
          .map((parameter) => normalizeOutputPointerSpelling(parameter.type.cName)))
        : [],
    );
    const candidates = [...module.functions].filter(([, declaration]) => declaration.overloads.some((overload) => (
      overload.parameters.length === 1
      && (outputTypes.size > 0
        ? outputTypes.has(normalizeNativeSpelling(overload.parameters[0].type.cName))
        : returnTypes.size === 0 || returnTypes.has(foreignTypeName(overload.parameters[0].type).replace(/ \| null$/, "")))
    )));
    for (const [name, declaration] of candidates) {
      if (!name.toLowerCase().startsWith(deinitPrefix.toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.function,
        detail: `${foreignFunctionDetail(declaration)}\ncleanup candidate for ${ownerName ?? "foreign result"}`,
        sortText: `0-${name}`,
      });
    }
  }

  const callbackDeinitPrefix = /\bcallback\s+[A-Za-z_][A-Za-z0-9_]*\s*\{(?:[^{}]|\{[^{}]*\})*\bdeinit\s+([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before)?.[1];
  if (ownerSignatures.length > 0 && callbackDeinitPrefix !== undefined) {
    const candidates = new Map<string, string>();
    for (const overload of ownerSignatures) {
      for (const parameter of overload.parameters) {
        if (parameter.name && parameter.type.kind === "callbackRelease") {
          candidates.set(parameter.name, foreignTypeName(parameter.type));
        }
      }
    }
    for (const [name, type] of candidates) {
      if (!name.toLowerCase().startsWith(callbackDeinitPrefix.toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.variable,
        detail: `native callback release parameter ${name}: ${type}`,
        sortText: `0-${name}`,
      });
    }
  }

  const callbackContractPrefix = /\bcallback\s+([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before)?.[1];
  if (ownerSignatures.length > 0 && callbackContractPrefix !== undefined) {
    const candidates = new Map<string, string>();
    for (const overload of ownerSignatures) {
      for (const parameter of overload.parameters) {
        if (parameter.name && (parameter.type.kind === "callback" || parameter.type.kind === "block")) {
          candidates.set(parameter.name, foreignTypeName(parameter.type));
        }
      }
    }
    for (const [name, type] of candidates) {
      if (!name.toLowerCase().startsWith(callbackContractPrefix.toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.variable,
        detail: `native callback parameter ${name}: ${type}`,
        sortText: `0-${name}`,
      });
    }
  }

  const callbackTypePrefix = /\bcallback\s+[A-Za-z_][A-Za-z0-9_]*\s*\{(?:[^{}]|\{[^{}]*\})*\btype\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (callbackTypePrefix !== undefined) {
    for (const callback of activeCallbacks) {
      if (!callback.cName.toLowerCase().startsWith(callbackTypePrefix.toLowerCase())) continue;
      contextual.push({
        label: callback.cName,
        kind: completionKinds.typeParameter,
        detail: `${callback.cName}: native callback typedef; projects to ${foreignTypeName(callback)}`,
        insertText: `${callback.cName};`,
        sortText: `0-${callback.cName}`,
      });
    }
  }
  const callbackFailureContractPrefix = /\bcallback\s+[A-Za-z_][A-Za-z0-9_]*\s*\{(?:[^{}]|\{[^{}]*\})*\b([A-Za-z_]*)$/.exec(before)?.[1];
  if (
    callbackFailureContractPrefix !== undefined
    && "failure".startsWith(callbackFailureContractPrefix)
  ) {
    contextual.push({
      label: "failure",
      kind: completionKinds.keyword,
      detail: "native callback return used when a Z callback throws",
      insertText: "failure ",
      sortText: "0-failure",
    });
  }
  const callbackFailureValuePrefix = /\bcallback\s+[A-Za-z_][A-Za-z0-9_]*\s*\{(?:[^{}]|\{[^{}]*\})*\bfailure\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (module && callbackFailureValuePrefix !== undefined) {
    for (const constant of module.constants.values()) {
      if (!constant.name.toLowerCase().startsWith(callbackFailureValuePrefix.toLowerCase())) continue;
      contextual.push({
        label: constant.name,
        kind: completionKinds.enumMember,
        detail: `${foreignConstantDetail(constant)}; native return when the Z callback throws`,
        insertText: `${constant.name};`,
        sortText: `0-${constant.name}`,
      });
    }
  }
  const invocationValuePrefix = /\bcallback\s+[A-Za-z_][A-Za-z0-9_]*\s*\{(?:[^{}]|\{[^{}]*\})*\binvoked\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (invocationValuePrefix !== undefined) {
    for (const value of ["once", "repeatedly"] as const) {
      if (!value.startsWith(invocationValuePrefix)) continue;
      contextual.push({
        label: value,
        kind: completionKinds.keyword,
        detail: value === "once"
          ? "exactly one native invocation; required for Task synthesis"
          : "zero or more native invocations",
        insertText: `${value};`,
        sortText: `0-${value}`,
      });
    }
  }

  const contextOptionPrefix = /\bcallback\s+[A-Za-z_][A-Za-z0-9_]*\s*\{(?:[^{}]|\{[^{}]*\})*\bcontext\s+option\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (module && contextOptionPrefix !== undefined) {
    for (const constant of module.constants.values()) {
      if (!constant.name.toLowerCase().startsWith(contextOptionPrefix.toLowerCase())) continue;
      contextual.push({
        label: constant.name,
        kind: completionKinds.enumMember,
        detail: `${foreignConstantDetail(constant)}; native option used to install the callback context`,
        insertText: `${constant.name};`,
        sortText: `0-${constant.name}`,
      });
    }
  }

  const connectionOwnerPrefix = /\bcallback\s+[A-Za-z_][A-Za-z0-9_]*\s*\{(?:[^{}]|\{[^{}]*\})*\bowner\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (connectionOwnerPrefix !== undefined) {
    const candidates = new Map<string, string>();
    for (const signature of ownerSignatures) {
      for (const parameter of signature.parameters) {
        if (parameter.name && parameter.type.kind !== "callback") {
          candidates.set(parameter.name, foreignTypeName(parameter.type));
        }
      }
    }
    for (const [name, type] of candidates) {
      if (!name.toLowerCase().startsWith(connectionOwnerPrefix.toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.variable,
        detail: `${name}: ${type}; owner whose lifetime contains the callback connection`,
        insertText: `${name};`,
        sortText: `0-${name}`,
      });
    }
  }

  const byteParameterPrefix = /\bcallback\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*\bproject\s+(?:inout\s+)?[A-Za-z_][A-Za-z0-9_]*\s*:\s*Slice\s*<\s*u8\s*>\s*\{[^}]*(?:(?:\bdata|\blength)\s+|\*\s*)([A-Za-z_]*)$/.exec(before)?.[1];
  if (byteParameterPrefix !== undefined) {
    const candidates = new Map<string, string>();
    for (const callback of activeCallbacks) {
      callback.nativeParameterNames?.forEach((name, index) => {
        candidates.set(name, callback.nativeParameters?.[index] ?? "_");
      });
    }
    for (const [name, type] of candidates) {
      if (!name.toLowerCase().startsWith(byteParameterPrefix.toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.variable,
        detail: `${name}: ${type}; native callback parameter`,
        sortText: `0-${name}`,
      });
    }
  }
  const ordinaryByteBufferPrefix = /\bexport\s+function\s+[A-Za-z_][A-Za-z0-9_.]*\s*\([^)]*\)\s*:[^{;]+\{[\s\S]*\bproject\s+(?:inout\s+)?[A-Za-z_][A-Za-z0-9_]*\s*:\s*Slice\s*<\s*u8\s*>\s*\{[^}]*\bdata\s+([A-Za-z_]*)$/.exec(before)?.[1];
  const ordinaryByteLengthPrefix = /\bexport\s+function\s+[A-Za-z_][A-Za-z0-9_.]*\s*\([^)]*\)\s*:[^{;]+\{[\s\S]*\bproject\s+(?:inout\s+)?[A-Za-z_][A-Za-z0-9_]*\s*:\s*Slice\s*<\s*u8\s*>\s*\{[^}]*(?:\blength\s+|\*\s*)([A-Za-z_]*)$/.exec(before)?.[1];
  if (ordinaryByteBufferPrefix !== undefined || ordinaryByteLengthPrefix !== undefined) {
    const wantedPrefix = ordinaryByteBufferPrefix ?? ordinaryByteLengthPrefix ?? "";
    const candidates = new Map<string, string>();
    for (const signature of ownerSignatures) {
      for (const parameter of signature.parameters) {
        if (!parameter.name) continue;
        candidates.set(parameter.name, foreignTypeName(parameter.type));
      }
    }
    for (const [name, type] of candidates) {
      if (!name.toLowerCase().startsWith(wantedPrefix.toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.variable,
        detail: ordinaryByteBufferPrefix !== undefined
          ? `${name}: ${type}; native pointer projected as Slice<u8>.data`
          : `${name}: ${type}; native length derived from Slice<u8>.length`,
        sortText: `0-${name}`,
      });
    }
  }

  const asyncContractPrefix = /\basync\s+([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before)?.[1];
  if (ownerSignatures.length > 0 && asyncContractPrefix !== undefined) {
    const candidates = new Map<string, string>();
    for (const overload of ownerSignatures) {
      for (const parameter of overload.parameters) {
        if (parameter.name && parameter.type.kind === "block" && parameter.type.escaping) {
          candidates.set(parameter.name, foreignTypeName(parameter.type));
        }
      }
    }
    for (const [name, type] of candidates) {
      if (!name.toLowerCase().startsWith(asyncContractPrefix.toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.variable,
        detail: `exactly-once terminal callback projected as async: ${type}`,
        sortText: `0-${name}`,
      });
    }
  }

  const asyncProjectionBinding = /\basync\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)\s*\{[\s\S]*\b(?:return|throw)\s+([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);
  if (asyncProjectionBinding?.[2] !== undefined) {
    const prefix = asyncProjectionBinding[2].toLowerCase();
    for (const binding of asyncProjectionBinding[1].split(",").map((item) => item.trim()).filter(Boolean)) {
      if (!binding.toLowerCase().startsWith(prefix)) continue;
      contextual.push({
        label: binding,
        kind: completionKinds.variable,
        detail: "async callback value binding",
        sortText: `0-${binding}`,
      });
    }
  }

  const contextContractPrefix = /\bcallback\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*context\s+([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);
  if (ownerSignatures.length > 0 && contextContractPrefix?.[2] !== undefined) {
    const candidates = new Map<string, string>();
    for (const overload of ownerSignatures) {
      for (const parameter of overload.parameters) {
        if (parameter.name && parameter.type.kind === "callbackContext") {
          candidates.set(parameter.name, foreignTypeName(parameter.type));
        }
      }
    }
    for (const [name, type] of candidates) {
      if (!name.toLowerCase().startsWith(contextContractPrefix[2].toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.variable,
        detail: `native callback context parameter ${name}: ${type}`,
        sortText: `0-${name}`,
      });
    }
  }

  const parameterContext = /\bexport\s+function\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(([^)]*)$/.exec(before);
  if (module && parameterContext) {
    const parameterIndex = topLevelCommaCount(parameterContext[2]);
    const names = new Map<string, string>();
    for (const overload of foreignDeclarationNativeSignatures(module, parameterContext[1])) {
      const parameter = overload.parameters[parameterIndex];
      if (parameter?.name) names.set(parameter.name, foreignTypeName(parameter.type));
    }
    for (const [name, type] of names) {
      contextual.push({
        label: name,
        kind: completionKinds.variable,
        detail: `native parameter ${name}: ${type}`,
        insertText: `${name}: _`,
        sortText: `1-${name}`,
      });
    }
  }

  const contextualLabels = new Set(contextual.map((item) => item.label));
  const tokens = languageTokenCompletions(fileName).filter((item) => !contextualLabels.has(item.label));
  return filterCompletions(uniqueCompletions([...contextual, ...tokens]), prefix, 500);
}

function foreignDeclarationNativeModule(source: string, fileName: string): ForeignModule | null {
  const moduleSpecifier = /\bdeclare\s+module\s+(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)')/.exec(source)?.slice(1).find(Boolean);
  if (!moduleSpecifier) return null;
  const suffix = `${moduleSpecifier}.zd`;
  const importer = fileName.endsWith(suffix)
    ? `${fileName.slice(0, -suffix.length)}__zd_editor.zs`
    : resolve(dirname(fileName), "__zd_editor.zs");
  try {
    const context = analyzeSource(
      `import declarationNative from ${JSON.stringify(moduleSpecifier)}; function main(): i32 { return 0; }`,
      importer,
      { requireMain: false },
    );
    return context.foreignModules.get("declarationNative") ?? null;
  } catch {
    return null;
  }
}

function foreignDeclarationHover(source: string, fileName: string, offset: number): Hover | null {
  const word = wordAt(source, offset);
  if (!word) return null;
  let contracts: ForeignDeclarationContracts;
  try {
    contracts = parseForeignDeclarationContracts(source, fileName);
  } catch {
    return null;
  }
  const module = foreignDeclarationNativeModule(source, fileName);
  if (!module) return null;

  for (const contract of contracts.types) {
    const declaration = module.namedTypes.get(contract.name);
    const interfaceDeclaration = module.interfaces.get(contract.name);
    if (!declaration && !interfaceDeclaration) continue;
    if (containsDeclarationName(contract.nameLocation.offset, contract.name, word.start)) {
      const detail = declaration
        ? `type ${foreignNamedTypeDetail(declaration)}`
        : `type ${interfaceDeclaration!.exportName}: Objective-C class ${interfaceDeclaration!.className}`;
      return markdownHover(`${detail}${contract.executorAffinity ? " on thread.main" : ""}`, source, word.start, word.end);
    }
    if (
      contract.executorAffinityLocation
      && word.start >= contract.executorAffinityLocation.offset
      && word.start < contract.executorAffinityLocation.offset + "on thread.main".length
    ) {
      return markdownHover(
        `on thread.main  // ${contract.name} is executor-isolated to the main thread`,
        source,
        word.start,
        word.end,
      );
    }
    if (!declaration || (declaration.kind !== "value" && declaration.kind !== "record")) continue;
    for (const [capability, location] of [
      ["copy", contract.copyLocation],
      ["move", contract.moveLocation],
      ["deinit", contract.deinitLocation],
    ] as const) {
      if (location?.offset === word.start) {
        const detail = declaration.kind === "record"
          ? capability === "deinit"
            ? `native C release contract of ${declaration.cName}`
            : `unique native C resource capability of ${declaration.cName}`
          : `native lifecycle capability of ${declaration.cName}`;
        return markdownHover(`${capability}: ${detail}`, source, word.start, word.end);
      }
    }
    if (
      declaration.kind === "record"
      && contract.deinitFunction
      && contract.deinitLocation
      && containsDeclarationName(
        contract.deinitLocation.offset + "deinit ".length,
        contract.deinitFunction,
        word.start,
      )
    ) {
      const release = module.functions.get(contract.deinitFunction);
      if (release) {
        return markdownHover(`${foreignFunctionDetail(release)}\n// releases owned ${declaration.cName} values`, source, word.start, word.end);
      }
    }
    for (const [capability, location, detail] of [
      ["thread", contract.threadLocations.location, `native thread contract for ${declaration.cName}`],
      ["transfer", contract.threadLocations.transfer, `unique ${declaration.cName} ownership may move to another thread`],
      ["share", contract.threadLocations.share, `reserved native sharing contract for ${declaration.cName}`],
      ["deinit", contract.threadLocations.deinit, `${declaration.cName} may be destroyed on the receiving thread`],
    ] as const) {
      if (location?.offset === word.start) {
        return markdownHover(`${capability}: ${detail}`, source, word.start, word.end);
      }
    }
  }

  for (const contract of contracts.functions) {
    const declaration = module.functions.get(contract.name);
    const methodMatch = foreignDeclarationObjCMethods(
      module,
      contract.name,
      contract.parameters.length,
    ).find(({ method }) => method.parameters.every((parameter, index) => (
      parameter.name === null || parameter.name === contract.parameters[index]?.name
    )));
    const nativeSignatures = declaration?.overloads ?? (methodMatch ? [methodMatch.method] : []);
    if (
      contract.executorAffinityLocation
      && word.start >= contract.executorAffinityLocation.offset
      && word.start < contract.executorAffinityLocation.offset + "on thread.main".length
    ) {
      return markdownHover(
        `on thread.main  // ${contract.name} may only be called on the main executor`,
        source,
        word.start,
        word.end,
      );
    }
    if (containsDeclarationName(contract.nameLocation.offset, contract.name, word.start)) {
      if (declaration) {
        return foreignFunctionHover(declaration, module, source, word.start, word.end);
      }
      if (methodMatch) {
        return markdownHover(
          `${methodMatch.method.instance ? "instance" : "static"} ${methodMatch.className}.${objCMethodDetail(methodMatch.method)}`,
          source,
          word.start,
          word.end,
        );
      }
    }
    const parameterIndex = contract.parameters.findIndex((parameter) => parameter.location.offset === word.start);
    if (parameterIndex >= 0) {
      const parameter = contract.parameters[parameterIndex];
      const types = new Set(nativeSignatures.map((overload) => overload.parameters[parameterIndex]).filter(Boolean).map((native) => foreignTypeName(native.type)));
      const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
      return markdownHover(`${capability}${parameter.name}: ${[...types].join(" | ") || "_"}  // inferred from native parameter`, source, word.start, word.end);
    }
    const parameterTypeIndex = contract.parameters.findIndex((parameter) => parameter.typeLocation.offset === word.start);
    if (parameterTypeIndex >= 0) {
      const parameter = contract.parameters[parameterTypeIndex];
      if (parameter.literal) {
        const constant = module.constants.get(parameter.literal);
        return markdownHover(
          `${constant ? foreignConstantDetail(constant) : parameter.literal}\n// exact native argument discriminant`,
          source,
          word.start,
          word.end,
        );
      }
      if (parameter.explicitType) {
        return markdownHover(`${parameter.explicitType}  // explicit safe type for a C variadic argument`, source, word.start, word.end);
      }
      if (parameter.nullOnly) {
        return markdownHover("null  // only the native null pointer is exposed to safe Z", source, word.start, word.end);
      }
      const types = new Set(nativeSignatures.map((overload) => overload.parameters[parameterTypeIndex]).filter(Boolean).map((native) => foreignTypeName(native.type)));
      return markdownHover(`_: ${[...types].join(" | ") || "unknown"}  // inferred native parameter type`, source, word.start, word.end);
    }
    const outputRelease = contract.parameters.find((parameter) => (
      parameter.release
      && parameter.releaseLocation
      && containsDeclarationName(parameter.releaseLocation.offset, parameter.release, word.start)
    ));
    if (outputRelease?.release) {
      const release = module.functions.get(outputRelease.release);
      if (release) {
        return markdownHover(`${foreignFunctionDetail(release)}\n// deinitializer for out ${outputRelease.name}`, source, word.start, word.end);
      }
    }
    const fixedParameter = contract.parameters.find((parameter) => (
      parameter.fixed
      && (parameter.fixedLocation?.offset === word.start
        || parameter.fixedValueLocation?.offset === word.start)
    ));
    if (fixedParameter?.fixed) {
      return markdownHover(
        `fixed ${fixedParameter.fixed}  // compiler supplies this header-defined value at the native ABI boundary`,
        source,
        word.start,
        word.end,
      );
    }
    if (contract.returnLocation.offset === word.start) {
      if (contract.returnSemanticType === "view-cstring") {
        return markdownHover(`view cstring${contract.returnNullable ? " | null" : ""}  // borrowed native text tied to the input owner`, source, word.start, word.end);
      }
      if (contract.returnSemanticType === "status-void") {
        const types = new Set(nativeSignatures.map((overload) => foreignTypeName(overload.returnType)));
        return markdownHover(
          `void throws ${[...types].join(" | ") || "_"}  // native integer status; success returns void and failure preserves the status`,
          source,
          word.start,
          word.end,
        );
      }
      if (contract.returnSemanticType === "connection-status") {
        const types = new Set(nativeSignatures.map((overload) => foreignTypeName(overload.returnType)));
        return markdownHover(
          `connection throws ${[...types].join(" | ") || "_"}  // returns a move-only native.Connection on success`,
          source,
          word.start,
          word.end,
        );
      }
      const types = new Set(nativeSignatures.map((overload) => foreignTypeName(overload.returnType)));
      const lifecycle = contract.release ? `; deinit ${contract.release}` : "";
      return markdownHover(`_: ${[...types].join(" | ") || "unknown"}${lifecycle}  // inferred native return type`, source, word.start, word.end);
    }
    if (contract.throwsLocation?.offset === word.start) {
      const types = new Set(nativeSignatures.map((overload) => foreignTypeName(overload.returnType)));
      return markdownHover(
        `throws ${[...types].join(" | ") || "_"}  // error type inferred from the native integer status`,
        source,
        word.start,
        word.end,
      );
    }
    if (contract.resultOwnershipLocation?.offset === word.start && contract.resultOwnership) {
      return markdownHover(
        contract.resultOwnership === "owned"
          ? "owned  // caller receives unique native value-resource ownership and deterministic cleanup"
          : "borrowed  // native runtime retains ownership; this result is lexical and non-escaping",
        source,
        word.start,
        word.end,
      );
    }
    const successIndex = contract.statusSuccessLocations.findIndex((location) => location.offset === word.start);
    if (successIndex >= 0) {
      const successfulValue = contract.returnSemanticType === "connection-status"
        ? "a live native.Connection"
        : "successful void completion";
      return markdownHover(
        `success ${contract.statusSuccessValues[successIndex]}  // this native status produces ${successfulValue}`,
        source,
        word.start,
        word.end,
      );
    }
    const successValueIndex = contract.statusSuccessValueLocations.findIndex((location) => location.offset === word.start);
    if (successValueIndex >= 0) {
      const value = contract.statusSuccessValues[successValueIndex];
      const constant = typeof value === "string" ? module.constants.get(value) : null;
      const successfulValue = contract.returnSemanticType === "connection-status"
        ? "a live native.Connection"
        : "successful void completion";
      return markdownHover(
        `${constant ? foreignConstantDetail(constant) : value}\n// this native status produces ${successfulValue}`,
        source,
        word.start,
        word.end,
      );
    }
    if (contract.release && contract.releaseLocation
      && containsDeclarationName(contract.releaseLocation.offset, contract.release, word.start)) {
      const release = module.functions.get(contract.release);
      if (release) {
        return markdownHover(`${foreignFunctionDetail(release)}\n// deinitializer for ${contract.name} result`, source, word.start, word.end);
      }
    }
    for (const [capability, location, detail] of [
      ["thread", contract.threadLocations.location, `native thread contract for the ${contract.name} result`],
      ["transfer", contract.threadLocations.transfer, `unique ${contract.name} result ownership may move to another thread`],
      ["share", contract.threadLocations.share, `reserved native sharing contract for the ${contract.name} result`],
      ["deinit", contract.threadLocations.deinit, `${contract.name} result may be destroyed on the receiving thread`],
    ] as const) {
      if (location?.offset === word.start) {
        return markdownHover(`${capability}: ${detail}`, source, word.start, word.end);
      }
    }
    for (const buffer of contract.buffers) {
      const bufferIndex = contract.parameters.findIndex((parameter) => parameter.name === buffer.buffer);
      const nativeBufferTypes = new Set(
        nativeSignatures
          .map((overload) => overload.parameters[bufferIndex])
          .filter(Boolean)
          .map((native) => foreignTypeName(native.type)),
      );
      if (
        buffer.location.offset === word.start
        || buffer.nameLocation.offset === word.start
        || buffer.typeLocation.offset === word.start
        || buffer.accessLocation?.offset === word.start
      ) {
        const capability = buffer.access === "inout" ? "inout " : "";
        return markdownHover(
          `${capability}${buffer.name}: Slice<u8>  // one named borrowed argument projects to native ${buffer.buffer} plus ${buffer.factors.join(" * ")}`,
          source,
          word.start,
          word.end,
        );
      }
      if (buffer.dataLocation.offset === word.start || buffer.bufferLocation.offset === word.start) {
        return markdownHover(
          `${buffer.buffer}: ${[...nativeBufferTypes].join(" | ") || "_"}  // native pointer supplied by ${buffer.name}.data`,
          source,
          word.start,
          word.end,
        );
      }
      if (buffer.lengthLocation.offset === word.start) {
        return markdownHover(
          `${buffer.name}.length  // supplies native ${buffer.factors.join(" * ")}`,
          source,
          word.start,
          word.end,
        );
      }
      const factorIndex = buffer.factorLocations.findIndex((location) => location.offset === word.start);
      if (factorIndex >= 0) {
        const factor = buffer.factors[factorIndex];
        const parameterIndex = contract.parameters.findIndex((parameter) => parameter.name === factor);
        const types = new Set(
          nativeSignatures
            .map((overload) => overload.parameters[parameterIndex])
            .filter(Boolean)
            .map((native) => foreignTypeName(native.type)),
        );
        return markdownHover(
          `${factor}: ${[...types].join(" | ") || "_"}  // hidden native length supplied by ${buffer.name}.length`,
          source,
          word.start,
          word.end,
        );
      }
    }
    for (const callback of contract.callbacks) {
      const callbackIndex = contract.parameters.findIndex((parameter) => parameter.name === callback.parameter);
      const callbackTypes = nativeSignatures
        .map((overload) => overload.parameters[callbackIndex]?.type)
        .filter((type): type is Extract<ForeignType, { kind: "callback" }> => type?.kind === "callback");
      const nativeCallback = callbackTypes[0];
      const contextIndex = callback.context === null
        ? -1
        : contract.parameters.findIndex((parameter) => parameter.name === callback.context);
      const releaseIndex = callback.release
        ? contract.parameters.findIndex((parameter) => parameter.name === callback.release)
        : -1;
      if (callback.parameterLocation.offset === word.start) {
        const types = new Set(
          nativeSignatures
            .map((overload) => overload.parameters[callbackIndex])
            .filter(Boolean)
            .map((native) => foreignTypeName(native.type)),
        );
        const mode = contract.parameters[callbackIndex]?.mode ?? "in";
        const lifetime = mode === "move" ? "escaping retained callback" : "call-scoped callback";
        const ownership = callback.context
          ? `${lifetime} using native context ${callback.context}`
          : `${lifetime}; owned by the Objective-C block under ARC`;
        return markdownHover(
          `${mode} ${callback.parameter}: ${[...types].join(" | ") || "_"}  // ${ownership}`,
          source,
          word.start,
          word.end,
        );
      }
      if (callback.context && callback.contextLocation?.offset === word.start) {
        const types = new Set(
          nativeSignatures
            .map((overload) => overload.parameters[contextIndex])
            .filter(Boolean)
            .map((native) => foreignTypeName(native.type)),
        );
        return markdownHover(
          `${callback.context}: ${[...types].join(" | ") || "_"}  // native context for callback ${callback.parameter}`,
          source,
          word.start,
          word.end,
        );
      }
      if (callback.nativeType && callback.nativeTypeLocation?.offset === word.start) {
        const nativeSignature = nativeCallback?.nativeParameters
          ? `${nativeCallback.cName}(${nativeCallback.nativeParameters.join(", ")})`
          : callback.nativeType;
        return markdownHover(
          `${nativeSignature}\n// header callback typedef projected to ${nativeCallback ? foreignTypeName(nativeCallback) : "(bytes: Slice<u8>) => usize"}`,
          source,
          word.start,
          word.end,
        );
      }
      if (callback.contextOption && callback.contextOptionLocation?.offset === word.start) {
        const constant = module.constants.get(callback.contextOption);
        return markdownHover(
          `${constant ? foreignConstantDetail(constant) : callback.contextOption}\n// native option used to install the retained callback context`,
          source,
          word.start,
          word.end,
        );
      }
      if (callback.owner && callback.ownerLocation?.offset === word.start) {
        const ownerIndex = contract.parameters.findIndex((parameter) => parameter.name === callback.owner);
        const types = new Set(
          nativeSignatures
            .map((overload) => overload.parameters[ownerIndex])
            .filter(Boolean)
            .map((native) => foreignTypeName(native.type)),
        );
        return markdownHover(
          `in ${callback.owner}: ${[...types].join(" | ") || "_"}  // the callback connection cannot outlive this native owner`,
          source,
          word.start,
          word.end,
        );
      }
      if (callback.failureLocation?.offset === word.start) {
        return markdownHover(
          `failure ${callback.failure}  // a thrown Z callback error is destroyed here and narrowed to this native callback return value`,
          source,
          word.start,
          word.end,
        );
      }
      if (callback.failureValueLocation?.offset === word.start) {
        const constant = typeof callback.failure === "string"
          ? module.constants.get(callback.failure)
          : null;
        return markdownHover(
          `${constant ? foreignConstantDetail(constant) : callback.failure}\n// returned through the native callback ABI after destroying the thrown Z error payload`,
          source,
          word.start,
          word.end,
        );
      }
      if (
        callback.bytes
        && (
          callback.bytes.location.offset === word.start
          || callback.bytes.nameLocation.offset === word.start
          || callback.bytes.typeLocation.offset === word.start
          || callback.bytes.accessLocation?.offset === word.start
        )
      ) {
        const capability = callback.bytes.access === "inout" ? "inout " : "";
        return markdownHover(
          `${capability}${callback.bytes.name}: Slice<u8>  // named borrowed callback projection; length is ${callback.bytes.factors.join(" * ")}`,
          source,
          word.start,
          word.end,
        );
      }
      if (
        callback.bytes
        && (
          callback.bytes.dataLocation.offset === word.start
          || callback.bytes.bufferLocation.offset === word.start
        )
      ) {
        const index = nativeCallback?.nativeParameterNames?.indexOf(callback.bytes.buffer) ?? -1;
        return markdownHover(
          `${callback.bytes.buffer}: ${index >= 0 ? nativeCallback?.nativeParameters?.[index] ?? "_" : "_"}  // native buffer projected as ${callback.bytes.name}.data`,
          source,
          word.start,
          word.end,
        );
      }
      if (callback.bytes?.lengthLocation.offset === word.start) {
        return markdownHover(
          `${callback.bytes.name}.length  // derived from native ${callback.bytes.factors.join(" * ")}`,
          source,
          word.start,
          word.end,
        );
      }
      const byteFactorIndex = callback.bytes?.factorLocations.findIndex((location) => location.offset === word.start) ?? -1;
      if (callback.bytes && byteFactorIndex >= 0) {
        const factor = callback.bytes.factors[byteFactorIndex];
        const index = nativeCallback?.nativeParameterNames?.indexOf(factor) ?? -1;
        return markdownHover(
          `${factor}: ${index >= 0 ? nativeCallback?.nativeParameters?.[index] ?? "_" : "_"}  // multiplied into ${callback.bytes.name}.length`,
          source,
          word.start,
          word.end,
        );
      }
      if (callback.release && callback.releaseLocation?.offset === word.start) {
        const types = new Set(
          nativeSignatures
            .map((overload) => overload.parameters[releaseIndex])
            .filter(Boolean)
            .map((native) => foreignTypeName(native.type)),
        );
        return markdownHover(
          `${callback.release}: ${[...types].join(" | ") || "_"}  // exactly-once native release for callback ${callback.parameter}`,
          source,
          word.start,
          word.end,
        );
      }
      if (callback.threadLocation?.offset === word.start) {
        const detail = callback.thread === "any"
          ? "any  // native code may invoke and release this callback from arbitrary threads, including concurrent invocations"
          : "caller  // native code invokes and releases this callback only on the registering thread";
        return markdownHover(
          detail,
          source,
          word.start,
          word.end,
        );
      }
      if (
        callback.invokedLocation.offset === word.start
        || callback.cardinalityLocation.offset === word.start
      ) {
        const detail = callback.cardinality === "once"
          ? "exactly one native invocation; duplicate async completion traps deterministically"
          : "zero or more native invocations; this does not imply an escaping connection";
        return markdownHover(
          `invoked ${callback.cardinality}  // ${detail}`,
          source,
          word.start,
          word.end,
        );
      }
    }
    if (
      contract.asyncCallback
      && (
        contract.asyncLocation?.offset === word.start
        || contract.asyncCallbackLocation?.offset === word.start
        || contract.asyncBindings.some((binding) => binding.location.offset === word.start)
      )
    ) {
      const callbackIndex = contract.parameters.findIndex((parameter) => parameter.name === contract.asyncCallback);
      const callbackType = nativeSignatures
        .map((signature) => signature.parameters[callbackIndex]?.type)
        .find((type) => type?.kind === "block");
      const resultIndex = contract.asyncReturnBinding === null
        ? contract.asyncBindings.length === 0 && callbackType?.kind === "block" && callbackType.parameters.length === 1 ? 0 : null
        : contract.asyncBindings.findIndex((binding) => binding.name === contract.asyncReturnBinding);
      const errorIndex = contract.asyncThrowBinding === null
        ? null
        : contract.asyncBindings.findIndex((binding) => binding.name === contract.asyncThrowBinding);
      const result = callbackType?.kind === "block" && resultIndex !== null && resultIndex >= 0
        ? foreignTypeName(callbackType.parameters[resultIndex]).replaceAll("declarationNative.", "")
        : resultIndex === null ? "void" : "_";
      const errorType = callbackType?.kind === "block" && errorIndex !== null && errorIndex >= 0
        ? callbackType.parameters[errorIndex]
        : null;
      const throws = errorType?.kind === "object"
        ? ` throws ${publicObjCTypeName(errorType.typeName).replaceAll("declarationNative.", "")}`
        : "";
      const bindings = contract.asyncBindings.length > 0
        ? `(${contract.asyncBindings.map((binding) => binding.name).join(", ")})`
        : "";
      return markdownHover(
        `async ${contract.asyncCallback}${bindings}: ${result}${throws}  // exactly-once terminal callback synthesized as an awaitable overload`,
        source,
        word.start,
        word.end,
      );
    }
  }
  return null;
}

function containsDeclarationName(start: number, name: string, offset: number): boolean {
  return offset >= start && offset < start + name.length;
}

function standardFunctionDetail(localName: string, name: StandardFunctionName): string {
  const signature = standardFunctionSignature(name);
  const displayStandardType = (type: string): string => (
    type === fsLockTypeName ? "fs.Lock" : displayArrayType(type)
  );
  const parameters = signature.parameters.map((parameter) => {
    const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
    return `${capability}${parameter.name}: ${displayStandardType(parameter.type)}`;
  }).join(", ");
  const asynchronous = signature.async ? "async " : "";
  const throws = signature.errorType ? ` throws ${displayStandardType(signature.errorType)}` : "";
  const behavior = name === "delay"
    ? "  // suspends the current task"
    : name === "scheduler.yield"
    ? "  // cooperatively requeues the current task on its existing executor"
    : name === "sleep"
    ? "  // blocks the current thread"
    : name === "fs.replace"
    ? "  // atomically replaces a same-filesystem destination"
    : name === "process.executablePath"
    ? "  // canonical path of the current native executable"
    : "";
  const detail = `${asynchronous}${localName}(${parameters}): ${displayStandardType(signature.returnType)}${throws}${behavior}`;
  return localName === name || name.includes(".")
    ? detail
    : `${detail} — alias of ${name} from "std/time"`;
}

function completionRecoveryAnalysis(
  source: string,
  fileName: string,
  start: number,
  tailOffset: number,
  prefix: string,
): AnalyzedSource | null {
  const candidates = lex(source.slice(0, start), fileName)
    .filter((token) => token.kind === "identifier" && token.text.startsWith(prefix))
    .map((token) => token.text)
    .reverse();
  for (const candidate of new Set(candidates)) {
    const context = safeAnalysis(source.slice(0, start) + candidate + source.slice(tailOffset), fileName);
    if (context) return context;
  }
  return null;
}

type Binding = {
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly readonly: boolean;
  readonly parameter: boolean;
  readonly fileName?: string;
};

function sourceBindingTypeName(program: Program, offset: number): string | null {
  let result: string | null = null;
  const visit = (value: unknown): void => {
    if (result || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as {
      readonly nameLocation?: SourceLocation;
      readonly location?: SourceLocation;
      readonly name?: string;
      readonly type?: TypeReference | null;
    };
    if (
      record.type
      && (
        record.nameLocation?.offset === offset
        || (record.name !== undefined && record.location?.offset === offset)
      )
    ) {
      result = record.type.name;
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(program);
  return result;
}

function sourceAliasDisplayType(context: AnalyzedSource, typeName: string): string | null {
  if (context.sourceProgram.typeAliases.some((declaration) => declaration.name === typeName)) return typeName;
  const selective = localSourceBinding(context, typeName);
  if (selective && sourceExportDeclaration(selective.module, selective.importedName)?.kind === "type") {
    return typeName;
  }
  const separator = typeName.indexOf(".");
  if (separator < 0) return null;
  const namespace = typeName.slice(0, separator);
  const member = typeName.slice(separator + 1);
  const declaration = context.sourceProgram.imports.find((candidate) => (
    isLocalSourceModuleSpecifier(candidate.header)
    && !candidate.bindings
    && candidate.moduleName === namespace
  ));
  const module = declaration ? localSourceModule(context, declaration) : null;
  return module && sourceExportDeclaration(module, member)?.kind === "type" ? typeName : null;
}

function localViewOwnerAt(context: AnalyzedSource, operatorOffset: number): string | null {
  let owner: string | null = null;
  const visit = (value: unknown): void => {
    if (owner || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as {
      readonly kind?: string;
      readonly initializer?: Expression;
      readonly nameLocation?: SourceLocation;
    };
    if (
      node.kind === "variable"
      && node.initializer?.kind === "unary"
      && node.initializer.operator === "view"
      && node.initializer.location.offset === operatorOffset
    ) {
      owner = node.nameLocation
        ? context.semanticInfo.viewBindingOwners.get(node.nameLocation.offset) ?? null
        : null;
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(context.sourceProgram);
  return owner;
}

function collectBindings(context: AnalyzedSource): Binding[] {
  const bindings: Binding[] = [];
  const seenClosures = new Set<number>();
  const seenExpressionBlocks = new Set<number>();
  const visitClosure = (expression: Extract<Expression, { kind: "closure" }>): void => {
    if (seenClosures.has(expression.location.offset)) return;
    seenClosures.add(expression.location.offset);
    for (const parameter of expression.parameters) {
      bindings.push({
        name: parameter.name,
        type: context.semanticInfo.bindingTypes.get(parameter.location.offset) ?? parameter.type?.name ?? "unknown",
        offset: parameter.location.offset,
        readonly: parameter.mode === "value" || parameter.mode === "in",
        parameter: true,
        fileName: parameter.location.fileName,
      });
    }
    if (expression.body.kind === "block") visitStatements(expression.body.statements);
  };
  const visitExpressionBlocks = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visitExpressionBlocks(child);
      return;
    }
    const node = value as Partial<Expression>;
    if (node.kind === "closure") {
      visitClosure(node as Extract<Expression, { kind: "closure" }>);
      return;
    }
    if (
      node.kind === "executorPlacement"
      || node.kind === "ifExpression"
      || node.kind === "unsafeExpression"
      || node.kind === "whileExpression"
      || node.kind === "forExpression"
      || node.kind === "matchExpression"
    ) {
      const location = (node as { readonly location?: SourceLocation }).location;
      if (location && seenExpressionBlocks.has(location.offset)) return;
      if (location) seenExpressionBlocks.add(location.offset);
      if (node.kind === "executorPlacement") {
        const placement = node as Extract<Expression, { kind: "executorPlacement" }>;
        if (placement.call) visitExpressionBlocks(placement.call);
        visitStatements(placement.body.statements);
        return;
      }
      if (node.kind === "ifExpression") {
        const expression = node as Extract<Expression, { kind: "ifExpression" }>;
        visitExpressionBlocks(expression.condition);
        visitStatements(expression.thenBranch.statements);
        if (expression.elseBranch.kind === "ifExpression") visitExpressionBlocks(expression.elseBranch);
        else visitStatements(expression.elseBranch.statements);
        return;
      }
      if (node.kind === "unsafeExpression") {
        visitStatements((node as Extract<Expression, { kind: "unsafeExpression" }>).body.statements);
        return;
      }
      if (node.kind === "whileExpression" || node.kind === "forExpression") {
        const expression = node as Extract<Expression, { kind: "whileExpression" | "forExpression" }>;
        visitExpressionBlocks(expression.kind === "whileExpression" ? expression.condition : expression.iterable);
        visitStatements(expression.body.statements);
        visitStatements(expression.elseBranch.statements);
        return;
      }
      const expression = node as Extract<Expression, { kind: "matchExpression" }>;
      visitExpressionBlocks(expression.expression);
      for (const arm of expression.arms) visitStatements([arm.body]);
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) visitExpressionBlocks(child);
  };
  const visitStatements = (statements: readonly Statement[]): void => {
    for (const statement of statements) {
      visitExpressionBlocks(statement);
      if (statement.kind === "variable") {
        bindings.push({
          name: statement.name,
          type: context.semanticInfo.bindingTypes.get(statement.nameLocation.offset) ?? statement.type?.name ?? "unknown",
          offset: statement.nameLocation.offset,
          readonly: !statement.mutable,
          parameter: false,
          fileName: statement.nameLocation.fileName,
        });
      }
      if (statement.kind === "destructure") {
        for (const binding of statement.objectBindings) {
          bindings.push({
            name: binding.bindingName,
            type: context.semanticInfo.bindingTypes.get(binding.bindingLocation.offset) ?? "unknown",
            offset: binding.bindingLocation.offset,
            readonly: !statement.mutable,
            parameter: false,
            fileName: binding.bindingLocation.fileName,
          });
        }
      }
      if (statement.kind === "block") visitStatements(statement.statements);
      if (statement.kind === "unsafe") visitStatements(statement.body.statements);
      if (statement.kind === "if") {
        visitStatements(statement.thenBranch.statements);
        if (statement.elseBranch?.kind === "block") visitStatements(statement.elseBranch.statements);
        if (statement.elseBranch?.kind === "if") visitStatements([statement.elseBranch]);
      }
      if (statement.kind === "while") visitStatements(statement.body.statements);
      if (statement.kind === "asyncScope") {
        if (statement.name && statement.nameLocation) {
          bindings.push({
            name: statement.name,
            type: context.semanticInfo.bindingTypes.get(statement.nameLocation.offset) ?? "TaskScope",
            offset: statement.nameLocation.offset,
            readonly: true,
            parameter: false,
            fileName: statement.nameLocation.fileName,
          });
        }
        visitStatements(statement.body.statements);
      }
      if (statement.kind === "for") {
        if (statement.binding && statement.bindingLocation) {
          bindings.push({
            name: statement.binding,
            type: context.semanticInfo.bindingTypes.get(statement.bindingLocation.offset) ?? "unknown",
            offset: statement.bindingLocation.offset,
            readonly: true,
            parameter: false,
            fileName: statement.bindingLocation.fileName,
          });
        }
        for (const binding of statement.objectBindings ?? []) {
          bindings.push({
            name: binding.bindingName,
            type: context.semanticInfo.bindingTypes.get(binding.bindingLocation.offset) ?? "unknown",
            offset: binding.bindingLocation.offset,
            readonly: true,
            parameter: false,
            fileName: binding.bindingLocation.fileName,
          });
        }
        visitStatements(statement.body.statements);
      }
      if (statement.kind === "match") {
        for (const arm of statement.arms) visitStatements([arm.body]);
      }
    }
  };
  const visitFunction = (declaration: Program["functions"][number]): void => {
    for (const parameter of declaration.parameters) {
      bindings.push({
        name: parameter.name,
        type: context.semanticInfo.bindingTypes.get(parameter.location.offset) ?? parameter.type.name,
        offset: parameter.location.offset,
        readonly: parameter.mode === "value" || parameter.mode === "in",
        parameter: true,
        fileName: parameter.location.fileName,
      });
    }
    visitStatements(declaration.body);
  };
  for (const declaration of context.program.functions) visitFunction(declaration);
  for (const declaration of context.program.structs) {
    for (const method of declaration.methods) visitFunction(method);
    if (declaration.deinitializer) visitStatements(declaration.deinitializer.body);
  }
  const visitClosures = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visitClosures(child);
      return;
    }
    const node = value as Partial<Expression>;
    if (node.kind === "closure") visitClosure(node as Extract<Expression, { kind: "closure" }>);
    for (const child of Object.values(value as Record<string, unknown>)) visitClosures(child);
  };
  visitClosures(context.program);
  for (const arm of collectMatchArmInfos(context)) {
    if (!arm.binding || arm.bindingOffset === null || !arm.payloadType) continue;
    bindings.push({
      name: arm.binding,
      type: context.semanticInfo.bindingTypes.get(arm.bindingOffset) ?? arm.payloadType,
      offset: arm.bindingOffset,
      readonly: true,
      parameter: false,
      fileName: arm.bindingFileName,
    });
  }
  return bindings;
}

type MatchArmInfo = {
  readonly variantName: string;
  readonly variantOffset: number;
  readonly binding: string | null;
  readonly bindingOffset: number | null;
  readonly bindingFileName?: string;
  readonly enumName: string;
  readonly payloadType: string | null;
  readonly borrowed: boolean;
};

function collectMatchArmInfos(context: AnalyzedSource): MatchArmInfo[] {
  const collected: MatchArmInfo[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as Record<string, unknown>;
    if ((node.kind === "match" || node.kind === "matchExpression") && node.expression && Array.isArray(node.arms)) {
      const matchLocation = (node.location as SourceLocation | undefined)?.offset;
      const borrowed = matchLocation !== undefined && context.semanticInfo.borrowedMatches.has(matchLocation);
      const subject = node.expression as { readonly location?: SourceLocation };
      const enumName = subject.location
        ? context.semanticInfo.expressionTypes.get(subject.location.offset)
        : null;
      const declaration = enumName ? context.program.enums.find((item) => item.name === enumName) : null;
      if (enumName && declaration) {
        for (const armValue of node.arms) {
          const arm = armValue as {
            readonly variantName: string;
            readonly binding: string | null;
            readonly bindingLocation: SourceLocation | null;
            readonly objectBindings: readonly {
              readonly fieldName: string;
              readonly bindingName: string;
              readonly bindingLocation: SourceLocation;
            }[] | null;
            readonly location: SourceLocation;
          };
          const variant = declaration.variants.find((item) => item.name === arm.variantName);
          if (!variant) continue;
          collected.push({
            variantName: arm.variantName,
            variantOffset: arm.location.offset,
            binding: arm.binding,
            bindingOffset: arm.bindingLocation?.offset ?? null,
            bindingFileName: arm.bindingLocation?.fileName,
            enumName,
            payloadType: variant.payload?.name ?? null,
            borrowed: Boolean(borrowed && variant.payload && editorTypeHasCleanup(variant.payload.name, context.program)),
          });
          const payload = variant.payload
            ? context.program.structs.find((item) => item.name === variant.payload!.name)
            : null;
          for (const fieldBinding of arm.objectBindings ?? []) {
            const field = payload?.fields.find((item) => item.name === fieldBinding.fieldName);
            if (!field) continue;
            collected.push({
              variantName: arm.variantName,
              variantOffset: arm.location.offset,
              binding: fieldBinding.bindingName,
              bindingOffset: fieldBinding.bindingLocation.offset,
              bindingFileName: fieldBinding.bindingLocation.fileName,
              enumName,
              payloadType: field.type.name,
              borrowed: editorTypeHasCleanup(field.type.name, context.program),
            });
          }
        }
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(context.sourceProgram);
  return collected;
}

function editorTypeHasCleanup(type: string, program: Program, visiting = new Set<string>()): boolean {
  if (type === "String" || type.startsWith("Weak<") || type.startsWith("Array<") || type.startsWith("__z_closure_")) return true;
  if (visiting.has(type)) return false;
  visiting.add(type);
  const aggregate = program.structs.find((item) => item.name === type);
  if (aggregate) {
    const cleanup = aggregate.kind === "class"
      || Boolean(aggregate.deinitializer)
      || aggregate.fields.some((field) => editorTypeHasCleanup(field.type.name, program, visiting));
    visiting.delete(type);
    return cleanup;
  }
  const enumDeclaration = program.enums.find((item) => item.name === type);
  const cleanup = Boolean(enumDeclaration?.variants.some((variant) => (
    variant.payload && editorTypeHasCleanup(variant.payload.name, program, visiting)
  )));
  visiting.delete(type);
  return cleanup;
}

function memberCompletions(
  source: string,
  fileName: string,
  offset: number,
  receiverText: string,
  prefix: string,
): CompletionItem[] {
  if (receiverText === "Option" || /^Option<[^<>]+>$/.test(receiverText)) {
    const explicit = receiverText.startsWith("Option<") ? receiverText.slice(7, -1) : "T";
    return filterCompletions([
      {
        label: "some",
        kind: completionKinds.enumMember,
        detail: `some(value: ${explicit}): Option<${explicit}>`,
        insertText: "some()",
      },
      {
        label: "none",
        kind: completionKinds.enumMember,
        detail: `none: Option<${explicit}>`,
      },
      {
        label: "fromNullable",
        kind: completionKinds.method,
        detail: `fromNullable(value: ${explicit} | null): Option<${explicit}>`,
        insertText: "fromNullable()",
      },
    ], prefix, 100);
  }
  if (receiverText === "String") {
    return filterCompletions([{
      label: "from",
      kind: completionKinds.method,
      detail: "from(value: cstring): String  // copies borrowed C bytes",
      insertText: "from()",
    }], prefix, 100);
  }
  const importContext = importAnalysis(source, fileName);
  if (!importContext) return [];
  if (importContext.semanticInfo.consoleBindings.has(receiverText)) {
    return filterCompletions(consoleCompletions(), prefix, 100);
  }
  const standardModule = importContext.semanticInfo.standardModuleBindings.get(receiverText);
  if (standardModule) {
    return filterCompletions(standardModuleMemberNames(standardModule).map((member) => {
      const name = standardModuleFunction(standardModule, member);
      if (standardModule === "objc" && (member === "Connection" || member === "Binding")) {
        return {
          label: member,
          kind: completionKinds.class,
          detail: member === "Connection"
            ? "owned Objective-C target/action lifetime"
            : "owned Objective-C protocol-binding lifetime",
          insertText: member,
        };
      }
      if (standardModule === "fs" && member === "Lock") {
        return {
          label: member,
          kind: completionKinds.struct,
          detail: "move-only exclusive interprocess filesystem lock",
          insertText: member,
        };
      }
      if (standardModule === "thread" && member === "main") {
        return {
          label: member,
          kind: completionKinds.property,
          detail: "main-thread execution target",
        };
      }
      return {
        label: member,
        kind: completionKinds.method,
        detail: standardModule === "thread" && member === "spawn"
          ? "spawn<T, E?>(operation: () => T throws E?): Task<T, E?>  // starts one native thread; sync or worker-affine async closure"
          : standardModule === "objc" && member === "connect"
            ? "connect(control: Objective-C target/action object, operation: move () => void): objc.Connection"
            : standardModule === "objc" && member === "bind"
              ? "bind(object: Objective-C object, protocols: { property: ZController }): objc.Binding"
            : standardFunctionDetail(member, name!),
        insertText: `${member}()`,
      };
    }), prefix, 100);
  }
  const sourceImport = importContext.sourceProgram.imports.find((declaration) => (
    isLocalSourceModuleSpecifier(declaration.header)
    && !declaration.bindings
    && declaration.moduleName === receiverText
  ));
  const sourceModule = sourceImport ? localSourceModule(importContext, sourceImport) : null;
  if (sourceModule) {
    return filterCompletions([...sourceModule.exports.keys()].map((name) => ({
      label: name,
      kind: sourceExportCompletionKind(sourceModule, name),
      detail: sourceExportDetail(sourceModule, name, importContext.typeDisplayNames),
    })), prefix, 1000);
  }
  const nativeNamespace = resolveForeignModuleNamespace(importContext, receiverText);
  if (nativeNamespace) return moduleCompletions(nativeNamespace.module, prefix, nativeNamespace.namespacePath);
  const nativeType = resolveForeignValueType(importContext, receiverText);
  if (nativeType) {
    return filterCompletions(nativeType.staticMethods.map((method) => ({
      label: method.name,
      kind: completionKinds.method,
      detail: foreignCxxStaticMethodDetail(method),
      insertText: `${method.name}()`,
    })), prefix, 1000);
  }

  const [moduleName, className, extra] = receiverText.split(".");
  if (!extra && moduleName && className) {
    const declaration = importContext.foreignModules.get(moduleName)?.interfaces.get(className);
    if (declaration) return filterCompletions(objcCompletions(declaration, false, importContext), prefix, 1000);
  }

  const receiverOffset = offset - receiverText.length - prefix.length - 1;
  const fullContext = safeAnalysis(source, fileName);
  const directReceiver = fullContext ? resolveReceiver(fullContext, receiverText, receiverOffset) : null;
  if (directReceiver?.kind === "arena") {
    return filterCompletions([
      {
        label: "create",
        kind: completionKinds.method,
        detail: "create<T>(value: T): view T  // transfers into stable region storage",
        insertText: "create()",
      },
      {
        label: "reset",
        kind: completionKinds.method,
        detail: "reset(): void  // requires no live views",
        insertText: "reset()",
      },
    ], prefix, 1000);
  }
  if (directReceiver?.kind === "hasher") {
    return filterCompletions([{
      label: "add",
      kind: completionKinds.method,
      detail: "add<T>(in value: T): void  // feeds one hash component",
      insertText: "add()",
    }], prefix, 1000);
  }
  if (directReceiver?.kind === "map") {
    return filterCompletions(mapCompletions(
      directReceiver.keyType,
      directReceiver.valueType,
      importContext.typeDisplayNames,
      mapValueHasReferenceIdentity(importContext, directReceiver.valueType),
    ), prefix, 1000);
  }
  if (directReceiver?.kind === "set") {
    return filterCompletions(setCompletions(directReceiver.elementType, importContext.typeDisplayNames), prefix, 1000);
  }
  if (directReceiver?.kind === "generator") {
    return filterCompletions([{
      label: "next",
      kind: completionKinds.method,
      detail: `next(): ${generatorNextDisplayType(directReceiver, importContext.typeDisplayNames)}  // advances the suspended frame`,
      insertText: "next()",
    }], prefix, 1000);
  }
  if (directReceiver?.kind === "asyncGenerator") {
    return filterCompletions([{
      label: "next",
      kind: completionKinds.method,
      detail: `async next(): ${asyncGeneratorNextDisplayType(directReceiver, importContext.typeDisplayNames)}  // resumes until yield or return`,
      insertText: "next()",
    }], prefix, 1000);
  }
  const dotOffset = receiverOffset + receiverText.length;
  const tailOffset = completionTailOffset(source, offset);
  const sanitized = source.slice(0, dotOffset) + source.slice(tailOffset);
  const lengthSanitized = source.slice(0, dotOffset) + ".length" + source.slice(tailOffset);
  const byteLengthSanitized = source.slice(0, dotOffset) + ".byteLength" + source.slice(tailOffset);
  const selectorSanitized = source.slice(0, dotOffset) + ".selector" + source.slice(tailOffset);
  const upgradeSanitized = source.slice(0, dotOffset) + ".upgrade()" + source.slice(tailOffset);
  const nextSanitized = source.slice(0, dotOffset) + ".next()" + source.slice(tailOffset);
  const statementTailOffset = source[tailOffset] === ";" ? tailOffset + 1 : tailOffset;
  const statementStart = Math.max(
    source.lastIndexOf(";", receiverOffset - 1),
    source.lastIndexOf("{", receiverOffset - 1),
    source.lastIndexOf("}", receiverOffset - 1),
  ) + 1;
  const iterationProbe = source.slice(0, statementStart) + source.slice(statementTailOffset);
  const iterationContext = safeAnalysis(iterationProbe, fileName);
  const iterationBinding = iterationContext
    ? collectBindings(iterationContext)
      .filter((binding) => binding.name === receiverText && binding.offset <= statementStart)
      .at(-1)
    : null;
  if (iterationContext && iterationBinding) {
    const map = parseMapType(iterationBinding.type);
    if (map) {
      return filterCompletions(mapCompletions(
        map.keyType,
        map.valueType,
        iterationContext.typeDisplayNames,
        mapValueHasReferenceIdentity(iterationContext, map.valueType),
      ), prefix, 1000);
    }
    const set = parseSetType(iterationBinding.type);
    if (set) {
      return filterCompletions(setCompletions(set.elementType, iterationContext.typeDisplayNames), prefix, 1000);
    }
    const generator = parseGeneratorType(iterationBinding.type);
    if (generator) {
      return filterCompletions([{
        label: "next",
        kind: completionKinds.method,
        detail: `next(): ${generatorNextDisplayType(generator, iterationContext.typeDisplayNames)}  // advances the suspended frame`,
        insertText: "next()",
      }], prefix, 1000);
    }
    const asyncGenerator = parseAsyncGeneratorType(iterationBinding.type);
    if (asyncGenerator) {
      return filterCompletions([{
        label: "next",
        kind: completionKinds.method,
        detail: `async next(): ${asyncGeneratorNextDisplayType(asyncGenerator, iterationContext.typeDisplayNames)}  // resumes until yield or return`,
        insertText: "next()",
      }], prefix, 1000);
    }
    if (iterationBinding.type === "String") {
      return filterCompletions(stringValueCompletions(), prefix, 1000);
    }
    if (isIntegerSourceType(iterationBinding.type)) {
      return filterCompletions(integerCompletions(iterationBinding.type), prefix, 1000);
    }
    const aggregate = iterationContext.program.structs.find((item) => item.name === iterationBinding.type);
    if (aggregate) {
      return filterCompletions(
        structCompletions(aggregate, iterationContext.typeDisplayNames, false),
        prefix,
        1000,
      );
    }
  }
  const staticProbe = `${source.slice(0, statementStart)}${source.slice(statementTailOffset)}`
    .replace(/(?:[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*<[^;{}]+>)\.\s*;/g, "");
  const staticContext = safeAnalysis(staticProbe, fileName);
  const staticOwner = staticContext ? sourceAggregateForType(staticContext, receiverText) : null;
  if (staticOwner) {
    const includePrivate = insideAggregateBody(source, fileName, offset, staticOwner.declaration.name);
    return filterCompletions(
      staticCompletions(staticOwner.declaration, staticContext.typeDisplayNames, staticOwner.substitutions, includePrivate),
      prefix,
      1000,
    );
  }
  const statementSanitized = source.slice(0, dotOffset) + ";" + source.slice(statementTailOffset);
  const lengthStatementSanitized = source.slice(0, dotOffset) + ".length;" + source.slice(statementTailOffset);
  const byteLengthStatementSanitized = source.slice(0, dotOffset) + ".byteLength;" + source.slice(statementTailOffset);
  const selectorStatementSanitized = source.slice(0, dotOffset) + ".selector;" + source.slice(statementTailOffset);
  const nextStatementSanitized = source.slice(0, dotOffset) + ".next();" + source.slice(statementTailOffset);
  let context = safeAnalysis(sanitized, fileName)
    ?? safeAnalysis(statementSanitized, fileName)
    ?? safeAnalysis(lengthSanitized, fileName)
    ?? safeAnalysis(byteLengthSanitized, fileName)
    ?? safeAnalysis(selectorSanitized, fileName)
    ?? safeAnalysis(upgradeSanitized, fileName)
    ?? safeAnalysis(nextSanitized, fileName)
    ?? safeAnalysis(lengthStatementSanitized, fileName)
    ?? safeAnalysis(byteLengthStatementSanitized, fileName)
    ?? safeAnalysis(selectorStatementSanitized, fileName);
  context ??= safeAnalysis(nextStatementSanitized, fileName);
  let resolvedOffset = receiverOffset;
  if (!context) {
    const probePrefix = `${source.slice(0, statementStart)}const completionProbe = `;
    const probeSource = `${probePrefix}${receiverText};${source.slice(statementTailOffset)}`;
    context = safeAnalysis(probeSource, fileName);
    resolvedOffset = probePrefix.length;
  }
  if (!context && prefix.length > 0) {
    const completionStart = offset - prefix.length;
    const methodProbes = new Set<string>();
    for (const declaration of importContext.semanticInfo.foreignNamedTypes.values()) {
      if (declaration.kind !== "value") continue;
      for (const method of declaration.methods) {
        if (
          method.name.startsWith(prefix)
          && method.overloads.some((overload) => overload.parameters.length === 0)
        ) methodProbes.add(method.name);
      }
    }
    for (const candidate of [...methodProbes].sort((left, right) => left.length - right.length || left.localeCompare(right))) {
      const probeSource = source.slice(0, completionStart) + `${candidate}()` + source.slice(tailOffset);
      context = safeAnalysis(probeSource, fileName);
      if (context) {
        resolvedOffset = receiverOffset;
        break;
      }
    }
  }
  if (!context && prefix.length > 0) {
    const completionStart = offset - prefix.length;
    const propertyProbes = new Set<string>();
    for (const declaration of importContext.semanticInfo.foreignInterfaces.values()) {
      for (const property of declaration.properties) {
        if (property.name.startsWith(prefix)) propertyProbes.add(property.name);
      }
    }
    for (const candidate of [...propertyProbes].sort((left, right) => left.length - right.length || left.localeCompare(right))) {
      const probeSource = source.slice(0, completionStart) + candidate + source.slice(tailOffset);
      context = safeAnalysis(probeSource, fileName);
      if (context) {
        resolvedOffset = receiverOffset;
        break;
      }
    }
  }
  if (!context && prefix.length > 0) {
    const completionStart = offset - prefix.length;
    const fieldProbes = new Set<string>();
    for (const declaration of importContext.semanticInfo.foreignNamedTypes.values()) {
      if (declaration.kind !== "record") continue;
      for (const field of declaration.fields) {
        if (field.name.startsWith(prefix)) fieldProbes.add(field.name);
      }
    }
    for (const candidate of [...fieldProbes].sort((left, right) => left.length - right.length || left.localeCompare(right))) {
      const probeSource = source.slice(0, completionStart) + candidate + source.slice(tailOffset);
      context = safeAnalysis(probeSource, fileName);
      if (context) {
        resolvedOffset = receiverOffset;
        break;
      }
    }
  }
  if (!context) {
    const declaredType = declaredBindingType(source, receiverText, receiverOffset);
    if (declaredType) {
      const imported = sourceAggregateForType(importContext, declaredType)?.declaration ?? null;
      let local: StructDeclaration | null = null;
      if (!imported) {
        try {
          const parsed = parse(lex(sanitized, fileName), fileName);
          const generic = parseSourceGenericType(declaredType);
          local = parsed.structs.find((declaration) => declaration.name === (generic?.base ?? declaredType)) ?? null;
        } catch {
          local = null;
        }
      }
      const declaration = imported ?? local;
      if (declaration) {
        const includePrivate = insideAggregateBody(source, fileName, offset, declaration.name);
        return filterCompletions(
          structCompletions(declaration, importContext.typeDisplayNames, includePrivate, declaration),
          prefix,
          1000,
        );
      }
    }
    return [];
  }
  const resolved = resolveReceiver(context, receiverText, resolvedOffset);
  if (resolved?.kind === "objc") return filterCompletions(objcCompletions(resolved.declaration, resolved.instance, context), prefix, 1000);
  if (resolved?.kind === "struct") {
    const includePrivate = insideAggregateBody(source, fileName, offset, resolved.declaration.name);
    return filterCompletions(
      structCompletions(resolved.declaration, context.typeDisplayNames, includePrivate, resolved.sourceDeclaration),
      prefix,
      1000,
    );
  }
  if (resolved?.kind === "foreignRecord") {
    return filterCompletions(resolved.declaration.fields.map((field) => ({
      label: field.name,
      kind: completionKinds.field,
      detail: `${field.name}: ${field.typeName}${resolved.declaration.layout === "union" ? "  // active-member read requires unsafe" : ""}`,
    })), prefix, 1000);
  }
  if (resolved?.kind === "foreignValue") {
    return filterCompletions(resolved.declaration.methods.map((method) => ({
      label: method.name,
      kind: completionKinds.method,
      detail: foreignCxxMethodDetail(method),
      insertText: `${method.name}()`,
    })), prefix, 1000);
  }
  if (resolved?.kind === "array") {
    const items: CompletionItem[] = [{ label: "length", kind: completionKinds.property, detail: "usize" }];
    const dynamic = parseDynamicArrayType(resolved.type);
    if (dynamic) {
      items.push(
        { label: "capacity", kind: completionKinds.property, detail: "usize" },
        {
          label: "push",
          kind: completionKinds.method,
          detail: `push(value: ${displayType(dynamic.elementType, context.typeDisplayNames)}): void`,
          insertText: "push()",
        },
      );
    }
    return filterCompletions(items, prefix, 1000);
  }
  if (resolved?.kind === "string") {
    return filterCompletions(stringValueCompletions(), prefix, 1000);
  }
  if (resolved?.kind === "textBuffer") {
    return filterCompletions([
      { label: "byteLength", kind: completionKinds.property, detail: "usize" },
      { label: "isEmpty", kind: completionKinds.property, detail: "boolean" },
      { label: "append", kind: completionKinds.method, detail: "append(in text: String): void", insertText: "append()" },
      {
        label: "appendBytes",
        kind: completionKinds.method,
        detail: "appendBytes(in text: String, start: usize, end: usize): void",
        insertText: "appendBytes()",
      },
      { label: "appendAscii", kind: completionKinds.method, detail: "appendAscii(byte: u8): void", insertText: "appendAscii()" },
      { label: "finish", kind: completionKinds.method, detail: "finish(): String  // consumes the TextBuffer", insertText: "finish()" },
    ], prefix, 1000);
  }
  if (resolved?.kind === "arena") {
    return filterCompletions([
      {
        label: "create",
        kind: completionKinds.method,
        detail: "create<T>(value: T): view T  // transfers into stable region storage",
        insertText: "create()",
      },
      {
        label: "reset",
        kind: completionKinds.method,
        detail: "reset(): void  // requires no live views",
        insertText: "reset()",
      },
    ], prefix, 1000);
  }
  if (resolved?.kind === "hasher") {
    return filterCompletions([{
      label: "add",
      kind: completionKinds.method,
      detail: "add<T>(in value: T): void  // feeds one hash component",
      insertText: "add()",
    }], prefix, 1000);
  }
  if (resolved?.kind === "map") {
    return filterCompletions(mapCompletions(
      resolved.keyType,
      resolved.valueType,
      context.typeDisplayNames,
      mapValueHasReferenceIdentity(context, resolved.valueType),
    ), prefix, 1000);
  }
  if (resolved?.kind === "set") {
    return filterCompletions(setCompletions(resolved.elementType, context.typeDisplayNames), prefix, 1000);
  }
  if (resolved?.kind === "generator") {
    return filterCompletions([{
      label: "next",
      kind: completionKinds.method,
      detail: `next(): ${generatorNextDisplayType(resolved, context.typeDisplayNames)}  // advances the suspended frame`,
      insertText: "next()",
    }], prefix, 1000);
  }
  if (resolved?.kind === "asyncGenerator") {
    return filterCompletions([{
      label: "next",
      kind: completionKinds.method,
      detail: `async next(): ${asyncGeneratorNextDisplayType(resolved, context.typeDisplayNames)}  // resumes until yield or return`,
      insertText: "next()",
    }], prefix, 1000);
  }
  if (resolved?.kind === "integer") {
    return filterCompletions(integerCompletions(resolved.type), prefix, 1000);
  }
  if (resolved?.kind === "weak") {
    return filterCompletions([{
      label: "upgrade",
      kind: completionKinds.method,
      detail: `upgrade(): ${displayType(resolved.target, context.typeDisplayNames)} throws WeakExpired`,
      insertText: "upgrade()",
    }], prefix, 1000);
  }
  if (resolved?.kind === "task") {
    return filterCompletions([{
      label: "cancel",
      kind: completionKinds.method,
      detail: "async cancel(): void  // consumes the Task; requests cancellation and joins cleanup",
      insertText: "cancel()",
    }], prefix, 1000);
  }
  if (resolved?.kind === "taskScope") {
    return filterCompletions([
      {
        label: "schedule",
        kind: completionKinds.method,
        detail: "schedule(thread.main, operation: () => void | async () => void): TaskControl",
        insertText: "schedule()",
      },
      {
        label: "close",
        kind: completionKinds.method,
        detail: "async close(): void  // rejects new work and joins",
        insertText: "close()",
      },
      {
        label: "cancel",
        kind: completionKinds.method,
        detail: "async cancel(): void  // rejects new work, cancels pending children, and joins",
        insertText: "cancel()",
      },
    ], prefix, 1000);
  }
  if (resolved?.kind === "taskControl") {
    return filterCompletions([
      {
        label: "accepted",
        kind: completionKinds.property,
        detail: "boolean  // false when scope closing won the scheduling race",
      },
      {
        label: "isCancellationRequested",
        kind: completionKinds.property,
        detail: "boolean",
      },
      {
        label: "requestCancel",
        kind: completionKinds.method,
        detail: "requestCancel(): boolean  // requests cancellation once; scope still joins",
        insertText: "requestCancel()",
      },
    ], prefix, 1000);
  }
  if (resolved?.kind === "fsLock") {
    return filterCompletions([{
      label: "unlock",
      kind: completionKinds.method,
      detail: "unlock(): void  // consumes and releases the lock",
      insertText: "unlock()",
    }], prefix, 1000);
  }
  return [];
}

function completionTailOffset(source: string, offset: number): number {
  if (source[offset] !== "(") return offset;
  let depth = 0;
  let quote: string | null = null;
  for (let index = offset; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character !== ")") continue;
    depth -= 1;
    if (depth === 0) return index + 1;
  }
  return offset;
}

function consoleCompletions(): CompletionItem[] {
  return ["log", "write", "error", "debug"].map((name) => ({
    label: name,
    kind: completionKinds.method,
    detail: consoleMethodDetail(name)!,
    insertText: `${name}()`,
  }));
}

function consoleMethodDetail(name: string): string | null {
  if (name === "log") return "log(...values): void  // stdout with newline";
  if (name === "write") return "write(...values): void  // stdout";
  if (name === "error") return "error(...values): void  // stderr with newline";
  if (name === "debug") return "debug(...values): void  // debug stream";
  return null;
}

function localSourceModule(context: AnalyzedSource, declaration: Program["imports"][number]): SourceModuleInfo | null {
  const importer = declaration.location.fileName;
  if (!importer) return null;
  const target = resolve(dirname(importer), declaration.header);
  const canonical = existsSync(target) ? realpathSync(target) : target;
  return context.sourceModules.get(canonical)
    ?? context.sourceModules.get(target)
    ?? [...context.sourceModules.values()].find((module) => resolve(module.fileName) === canonical)
    ?? null;
}

function localSourceBinding(
  context: AnalyzedSource,
  localName: string,
): {
  readonly module: SourceModuleInfo;
  readonly importedName: string;
  readonly localName: string;
  readonly specifier: string;
} | null {
  for (const declaration of context.sourceProgram.imports) {
    if (!isLocalSourceModuleSpecifier(declaration.header) || !declaration.bindings) continue;
    const binding = declaration.bindings.find((item) => item.localName === localName);
    if (!binding) continue;
    const module = localSourceModule(context, declaration);
    if (module) {
      return {
        module,
        importedName: binding.importedName,
        localName: binding.localName,
        specifier: declaration.header,
      };
    }
  }
  return null;
}

function sourceNameIsShadowed(context: AnalyzedSource, name: string, offset: number, fileName: string): boolean {
  return collectBindings(context).some((binding) => (
    binding.name === name
    && binding.offset <= offset
    && (!binding.fileName || resolve(binding.fileName) === resolve(fileName))
  ));
}

function sourceExportDeclaration(module: SourceModuleInfo, name: string):
  | Program["functions"][number]
  | Program["structs"][number]
  | Program["traits"][number]
  | Program["enums"][number]
  | Program["typeAliases"][number]
  | null {
  return module.program.functions.find((item) => item.name === name)
    ?? module.program.structs.find((item) => item.name === name)
    ?? module.program.traits.find((item) => item.name === name)
    ?? module.program.enums.find((item) => item.name === name)
    ?? module.program.typeAliases.find((item) => item.name === name)
    ?? null;
}

function sourceExportDetail(
  module: SourceModuleInfo,
  name: string,
  typeDisplayNames: ReadonlyMap<string, string>,
  displayName = name,
): string {
  const declaration = sourceExportDeclaration(module, name);
  if (!declaration) return `export ${displayName}`;
  if (declaration.kind === "function") {
    return zFunctionDetail(
      displayName,
      declaration.parameters,
      declaration.returnType.name,
      declaration.typeParameters,
      typeDisplayNames,
      declaration.typeParameterConstraints,
      declaration.async,
      declaration.errorType?.name,
      Boolean(declaration.executorAffinity),
    );
  }
  if (declaration.kind === "struct" || declaration.kind === "class") {
    const affinity = sourceProgramExecutorAffinity(module.program, declaration.name);
    const executor = affinity ? " on thread.main" : "";
    return `${declaration.kind} ${displayName}${formatTypeParameters(
      declaration.typeParameters ?? [],
      declaration.typeParameterConstraints ?? [],
      typeDisplayNames,
    )}${executor}${executorAffinityHover(affinity)}`;
  }
  if (declaration.kind === "trait") {
    return `trait ${displayName}${formatTypeParameters(
      declaration.typeParameters ?? [],
      declaration.typeParameterConstraints ?? [],
      typeDisplayNames,
    )}`;
  }
  if (declaration.kind === "type") {
    return `type ${displayName} = ${displayType(declaration.target.name, typeDisplayNames)}`;
  }
  return `${declaration.kind} ${displayName}`;
}

function sourceProgramExecutorAffinity(
  program: Program,
  name: string,
  visiting = new Set<string>(),
): ExecutorAffinityInfo | undefined {
  const declaration = program.structs.find((candidate) => candidate.name === name);
  if (!declaration || visiting.has(name)) return undefined;
  if (declaration.executorAffinity) {
    return {
      executor: "main",
      declared: true,
      originType: name,
      fieldPath: [],
    };
  }
  visiting.add(name);
  for (const field of declaration.fields) {
    const inherited = sourceProgramExecutorAffinity(program, field.type.name, visiting);
    if (!inherited) continue;
    visiting.delete(name);
    return {
      ...inherited,
      declared: false,
      fieldPath: [field.name, ...inherited.fieldPath],
    };
  }
  visiting.delete(name);
  return undefined;
}

function sourceImportHover(
  detail: string,
  binding: { readonly importedName: string; readonly localName: string; readonly specifier: string },
  source: string,
  start: number,
  end: number,
): Hover {
  if (binding.localName === binding.importedName) return markdownHover(detail, source, start, end);
  return {
    contents: {
      kind: "markdown",
      value: `\`\`\`z\n${detail}\n\`\`\`\n\nAlias of \`${binding.importedName}\` from \`${JSON.stringify(binding.specifier)}\`.`,
    },
    range: { start: positionAt(source, start), end: positionAt(source, end) },
  };
}

function sourceExportTokenType(module: SourceModuleInfo, name: string): (typeof semanticTokenTypes)[number] {
  const declaration = sourceExportDeclaration(module, name);
  if (declaration?.kind === "function") return "function";
  if (declaration?.kind === "class") return "class";
  if (declaration?.kind === "trait") return "interface";
  if (declaration?.kind === "enum") return "enum";
  return "type";
}

function sourceExportCompletionKind(module: SourceModuleInfo, name: string): number {
  const declaration = sourceExportDeclaration(module, name);
  if (declaration?.kind === "function") return completionKinds.function;
  if (declaration?.kind === "class") return completionKinds.class;
  if (declaration?.kind === "trait") return completionKinds.interface;
  if (declaration?.kind === "enum") return completionKinds.enum;
  if (declaration?.kind === "type") return completionKinds.typeParameter;
  return completionKinds.struct;
}

function sourceExportLocation(module: SourceModuleInfo, name: string): Location | null {
  const declaration = sourceExportDeclaration(module, name);
  if (!declaration) return null;
  try {
    const source = readFileSync(module.fileName, "utf8");
    const tokens = lex(source, module.fileName);
    const declarationIndex = tokens.findIndex((token) => token.location.offset === declaration.location.offset);
    const nameToken = tokens.slice(Math.max(0, declarationIndex + 1)).find((token) => token.text === name);
    if (!nameToken) return null;
    const start = { line: nameToken.location.line - 1, character: nameToken.location.column - 1 };
    return {
      uri: pathToFileURL(module.fileName).href,
      range: { start, end: { line: start.line, character: start.character + name.length } },
    };
  } catch {
    return null;
  }
}

function labelCompletions(source: string, fileName: string, offset: number): CompletionItem[] {
  const open = unmatchedOpenParen(source, offset);
  if (open < 0) return [];
  const methodMatch = source.slice(0, open).match(/\.([A-Za-z_][A-Za-z0-9_]*)\s*$/);
  if (!methodMatch) return [];
  const argumentIndex = topLevelCommaCount(source.slice(open + 1, offset));
  if (argumentIndex === 0) return [];
  const context = importAnalysis(source, fileName);
  if (!context) return [];
  const labels = new Map<string, string>();
  for (const module of context.foreignModules.values()) {
    for (const declaration of module.interfaces.values()) {
      for (const method of declaration.methods) {
        if (method.baseName !== methodMatch[1] || method.parameters.length <= argumentIndex) continue;
        const component = selectorParts(method.selector)[argumentIndex];
        if (!component) continue;
        labels.set(component, foreignTypeName(method.parameters[argumentIndex].type));
      }
    }
  }
  return [...labels].map(([label, detail]) => ({
    label: `${label}:`,
    kind: completionKinds.field,
    detail,
    insertText: `${label}: `,
    sortText: `0-${label}`,
  }));
}

function importAnalysis(source: string, fileName: string): AnalyzedSource | null {
  const imports = [...source.matchAll(/\bimport\b[\s\S]*?;/g)].map((match) => match[0]).join("\n");
  try {
    return analyzeSource(`${imports}\nfunction main(): i32 { return 0; }`, fileName, { requireMain: false });
  } catch {
    return null;
  }
}

function safeAnalysis(source: string, fileName: string): AnalyzedSource | null {
  try {
    return analyzeSource(source, fileName, { requireMain: false });
  } catch {
    return null;
  }
}

type ResolvedReceiver =
  | { readonly kind: "module"; readonly module: ForeignModule; readonly namespacePath: readonly string[] }
  | { readonly kind: "objc"; readonly declaration: ForeignObjCInterface; readonly instance: boolean }
  | {
    readonly kind: "struct";
    readonly declaration: StructDeclaration;
    readonly sourceDeclaration: StructDeclaration | null;
  }
  | { readonly kind: "foreignRecord"; readonly declaration: Extract<ForeignNamedType, { kind: "record" }> }
  | { readonly kind: "foreignValue"; readonly declaration: Extract<ForeignNamedType, { kind: "value" }> }
  | { readonly kind: "integer"; readonly type: string }
  | { readonly kind: "array"; readonly type: string }
  | { readonly kind: "string" }
  | { readonly kind: "textBuffer" }
  | { readonly kind: "arena" }
  | { readonly kind: "hasher" }
  | { readonly kind: "map"; readonly keyType: string; readonly valueType: string }
  | { readonly kind: "set"; readonly elementType: string }
  | {
    readonly kind: "generator";
    readonly elementType: string;
    readonly returnType: string | null;
    readonly errorType: string | null;
  }
  | {
    readonly kind: "asyncGenerator";
    readonly elementType: string;
    readonly returnType: string | null;
    readonly errorType: string | null;
  }
  | { readonly kind: "weak"; readonly target: string }
  | { readonly kind: "task"; readonly successType: string; readonly errorType: string | null }
  | { readonly kind: "taskScope" }
  | { readonly kind: "taskControl" }
  | { readonly kind: "fsLock" }
  | { readonly kind: "objcConnection" };

function mapValueHasReferenceIdentity(context: AnalyzedSource, type: string): boolean {
  return context.program.structs.some((declaration) => declaration.name === type && declaration.kind === "class")
    || context.semanticInfo.foreignNamedTypes.get(type)?.kind === "object";
}

function resolveReceiver(context: AnalyzedSource, text: string, offset: number): ResolvedReceiver | null {
  const nativeNamespace = resolveForeignModuleNamespace(context, text);
  if (nativeNamespace) return { kind: "module", ...nativeNamespace };
  const [moduleName, className, extra] = text.split(".");
  if (!extra && moduleName && className) {
    const declaration = context.foreignModules.get(moduleName)?.interfaces.get(className);
    if (declaration) return { kind: "objc", declaration, instance: false };
  }
  const finalSegment = text.lastIndexOf(".");
  const expressionOffset = finalSegment === -1 ? offset : offset + finalSegment + 1;
  const type = context.semanticInfo.expressionTypes.get(expressionOffset)
    ?? context.semanticInfo.expressionTypes.get(offset);
  if (!type) return null;
  const view = parseViewType(type);
  const receiverType = view?.target ?? type;
  if (receiverType === objcConnectionTypeName) return { kind: "objcConnection" };
  if (receiverType === "TextBuffer") return { kind: "textBuffer" };
  if (receiverType === "Arena") return { kind: "arena" };
  if (receiverType === "Hasher") return { kind: "hasher" };
  if (receiverType === "TaskScope") return { kind: "taskScope" };
  if (receiverType === "TaskControl") return { kind: "taskControl" };
  if (receiverType === fsLockTypeName || receiverType === "fs.Lock") {
    return { kind: "fsLock" };
  }
  if (receiverType === "String") return { kind: "string" };
  const map = parseMapType(receiverType);
  if (map) return { kind: "map", ...map };
  const set = parseSetType(receiverType);
  if (set) return { kind: "set", ...set };
  const generator = parseGeneratorType(receiverType);
  if (generator) return { kind: "generator", ...generator };
  const asyncGenerator = parseAsyncGeneratorType(receiverType);
  if (asyncGenerator) return { kind: "asyncGenerator", ...asyncGenerator };
  if (parseFixedArrayType(receiverType) || parseSliceType(receiverType) || parseDynamicArrayType(receiverType)) return { kind: "array", type: receiverType };
  const weak = parseWeakType(receiverType);
  if (weak) return { kind: "weak", target: weak.target };
  const task = parseTaskType(receiverType);
  if (task) return { kind: "task", successType: task.successType, errorType: task.errorType };
  if (isIntegerSourceType(receiverType)) return { kind: "integer", type: receiverType };
  const interfaceName = receiverType.replace(/^__z_objc:(?:nullable|nonnull):/, "");
  const objc = context.semanticInfo.foreignInterfaces.get(interfaceName);
  if (objc) return { kind: "objc", declaration: objc, instance: true };
  const declaration = context.program.structs.find((item) => item.name === receiverType);
  if (declaration) {
    const sourceType = context.typeDisplayNames.get(receiverType) ?? receiverType;
    const sourceDeclaration = sourceAggregateForType(context, sourceType)?.declaration ?? null;
    return { kind: "struct", declaration, sourceDeclaration };
  }
  const foreign = context.semanticInfo.foreignNamedTypes.get(receiverType);
  if (foreign?.kind === "record") return { kind: "foreignRecord", declaration: foreign };
  return foreign?.kind === "value" ? { kind: "foreignValue", declaration: foreign } : null;
}

function isIntegerSourceType(type: string): boolean {
  return /^(?:i8|u8|i16|u16|i32|u32|i64|u64|isize|usize)$/.test(type);
}

function stringValueCompletions(): CompletionItem[] {
  return [
    { label: "byteLength", kind: completionKinds.property, detail: "usize  // UTF-8 storage bytes" },
    { label: "isEmpty", kind: completionKinds.property, detail: "boolean" },
    {
      label: "byteAt",
      kind: completionKinds.method,
      detail: "byteAt(index: usize): u8  // checked UTF-8 byte access",
      insertText: "byteAt()",
    },
    {
      label: "copyBytes",
      kind: completionKinds.method,
      detail: "copyBytes(start: usize, end: usize): String  // checked owned copy",
      insertText: "copyBytes()",
    },
  ];
}

function integerMethodDetail(name: string, type: string): string | null {
  const descriptions: Readonly<Record<string, string>> = {
    wrappingAdd: "wraps modulo the integer width",
    wrappingSubtract: "wraps modulo the integer width",
    wrappingMultiply: "wraps modulo the integer width",
    saturatingAdd: "clamps to the nearest representable value",
    saturatingSubtract: "clamps to the nearest representable value",
    saturatingMultiply: "clamps to the nearest representable value",
  };
  const description = descriptions[name];
  return description ? `${name}(other: ${type}): ${type}  // ${description}` : null;
}

function mapMemberDetail(
  name: string,
  keyType: string,
  valueType: string,
  typeDisplayNames: ReadonlyMap<string, string>,
  identityValue = false,
): string | null {
  const key = displayType(keyType, typeDisplayNames);
  const value = displayType(valueType, typeDisplayNames);
  const details: Readonly<Record<string, string>> = {
    length: "length: usize",
    has: `has(in key: ${key}): boolean`,
    get: `get(in key: ${key}): Option<${identityValue ? value : `view ${value}`}>`,
    set: `set(key: ${key}, value: ${value}): void  // ${identityValue ? "retains shared identity" : "transfers owned values"}`,
    remove: `remove(in key: ${key}): Option<${value}>  // transfers the removed value`,
    delete: `delete(in key: ${key}): boolean  // destroys the removed entry`,
    clear: "clear(): void  // destroys all entries",
  };
  return details[name] ?? null;
}

function mapCompletions(
  keyType: string,
  valueType: string,
  typeDisplayNames: ReadonlyMap<string, string>,
  identityValue = false,
): CompletionItem[] {
  return ["length", "has", "get", "set", "remove", "delete", "clear"].map((name) => ({
    label: name,
    kind: name === "length" ? completionKinds.property : completionKinds.method,
    detail: mapMemberDetail(name, keyType, valueType, typeDisplayNames, identityValue)!,
    ...(name === "length" ? {} : { insertText: `${name}()` }),
  }));
}

function setMemberDetail(
  name: string,
  elementType: string,
  typeDisplayNames: ReadonlyMap<string, string>,
): string | null {
  const element = displayType(elementType, typeDisplayNames);
  const details: Readonly<Record<string, string>> = {
    length: "length: usize",
    has: `has(in value: ${element}): boolean`,
    add: `add(value: ${element}): boolean  // transfers the owned value`,
    remove: `remove(in value: ${element}): Option<${element}>  // transfers the removed value`,
    delete: `delete(in value: ${element}): boolean  // destroys the removed value`,
    clear: "clear(): void  // destroys all values",
  };
  return details[name] ?? null;
}

function setCompletions(
  elementType: string,
  typeDisplayNames: ReadonlyMap<string, string>,
): CompletionItem[] {
  return ["length", "has", "add", "remove", "delete", "clear"].map((name) => ({
    label: name,
    kind: name === "length" ? completionKinds.property : completionKinds.method,
    detail: setMemberDetail(name, elementType, typeDisplayNames)!,
    ...(name === "length" ? {} : { insertText: `${name}()` }),
  }));
}

function integerCompletions(type: string): CompletionItem[] {
  return [
    "wrappingAdd",
    "wrappingSubtract",
    "wrappingMultiply",
    "saturatingAdd",
    "saturatingSubtract",
    "saturatingMultiply",
  ].map((name) => ({
    label: name,
    kind: completionKinds.method,
    detail: integerMethodDetail(name, type)!,
    insertText: `${name}()`,
  }));
}

function moduleCompletions(
  module: ForeignModule,
  prefix: string,
  namespacePath: readonly string[] = [],
  unfiltered = false,
): CompletionItem[] {
  const items: CompletionItem[] = [];
  if (namespacePath.length === 0) {
    const aliases = collectForeignHandleTypeAliases(new Map([[module.declaration.moduleName, module]]));
    const prefix = `${module.declaration.moduleName}.`;
    for (const [sourceName, canonical] of aliases.canonicalBySourceName) {
      if (!sourceName.startsWith(prefix)) continue;
      const pointer = module.types.get(canonical);
      if (!pointer || pointer.nullable) continue;
      items.push({
        label: sourceName.slice(prefix.length),
        kind: completionKinds.struct,
        detail: `owned opaque native handle ${pointer.cName}; deinit ${pointer.release}`,
      });
    }
    for (const declaration of module.interfaces.values()) {
      const executor = declaration.metadata.executorAffinity === "main" ? " on thread.main" : "";
      items.push({ label: declaration.exportName, kind: completionKinds.class, detail: `Objective-C class ${declaration.className}${executor}` });
    }
    for (const declaration of module.protocols.values()) {
      items.push({
        label: declaration.exportName,
        kind: completionKinds.interface,
        detail: `Objective-C protocol ${declaration.protocolName}`,
      });
    }
    for (const declaration of module.constants.values()) {
      items.push({
        label: declaration.name,
        kind: completionKinds.constant,
        detail: foreignConstantDetail(declaration),
      });
    }
  }
  const namespaceName = namespacePath.join(".");
  for (const declaration of module.namedTypes.values()) {
    if (declaration.namespacePath.join(".") !== namespaceName) continue;
    items.push({
      label: declaration.exportName,
      kind: declaration.kind === "enum" ? completionKinds.enum : completionKinds.struct,
      detail: declaration.cName,
    });
  }
  if (namespacePath.length === 0) {
    for (const [alias, qualifiedName] of module.namedTypeAliases) {
      const declaration = module.namedTypes.get(qualifiedName);
      if (declaration?.namespacePath.length) {
        items.push({
          label: alias,
          kind: declaration.kind === "enum" ? completionKinds.enum : completionKinds.struct,
          detail: declaration.cName,
        });
      }
    }
  }
  for (const declaration of module.functions.values()) {
    if (declaration.namespacePath.join(".") !== namespaceName) continue;
    items.push({ label: declaration.name, kind: completionKinds.function, detail: foreignFunctionDetail(declaration, module) });
  }
  if (namespacePath.length === 0) {
    for (const [alias, qualifiedName] of module.functionAliases) {
      const declaration = module.functions.get(qualifiedName);
      if (declaration?.namespacePath.length) {
        items.push({ label: alias, kind: completionKinds.function, detail: foreignFunctionDetail(declaration, module) });
      }
    }
  }
  for (const namespace of module.namespaces) {
    const parts = namespace.split(".");
    if (parts.length !== namespacePath.length + 1) continue;
    if (parts.slice(0, -1).join(".") !== namespaceName) continue;
    items.push({ label: parts.at(-1)!, kind: completionKinds.module, detail: `native namespace ${namespace}` });
  }
  const unique = uniqueCompletions(items);
  if (prefix) return filterCompletions(unique, prefix, 1500);
  if (unfiltered || module.cPlusPlus) return unique.slice(0, 2500);
  return unique.filter((item) => (
    item.kind === completionKinds.class
    || ((item.kind === completionKinds.struct || item.kind === completionKinds.enum) && /^(?:NS|CG)/.test(item.label))
    || (item.kind === completionKinds.function && /^(?:NS|CG)/.test(item.label))
  )).slice(0, 2500);
}

function resolveModuleHandleType(
  module: ForeignModule,
  name: string,
) {
  const aliases = collectForeignHandleTypeAliases(new Map([[module.declaration.moduleName, module]]));
  const canonical = aliases.canonicalBySourceName.get(`${module.declaration.moduleName}.${name}`);
  return canonical ? module.types.get(canonical) ?? null : null;
}

function objcCompletions(declaration: ForeignObjCInterface, instance: boolean, context: AnalyzedSource): CompletionItem[] {
  const mainIsolated = foreignObjCRequiresMain(declaration, context);
  const properties = collectObjCProperties(declaration, instance, context);
  const accessors = new Set(properties.flatMap((property) => [property.getter, property.setter].filter(Boolean)));
  const items: CompletionItem[] = properties.map((property) => ({
    label: property.name,
    kind: completionKinds.property,
    detail: objcPropertyDetail(property, mainIsolated),
  }));
  for (const method of collectObjCMethods(declaration, instance, context)) {
    if (accessors.has(method.selector)) continue;
    items.push({
      label: method.baseName,
      kind: completionKinds.method,
      detail: objCMethodDetail(method, mainIsolated),
      insertText: objCMethodSnippet(method),
      insertTextFormat: 2,
    });
  }
  return uniqueCompletions(items);
}

function structCompletions(
  declaration: StructDeclaration,
  typeDisplayNames: ReadonlyMap<string, string>,
  includePrivate: boolean,
  sourceDeclaration: StructDeclaration | null = null,
): CompletionItem[] {
  const methods = [
    ...declaration.methods.filter((method) => !method.name.startsWith("__z_mono_")),
    ...(sourceDeclaration && sourceDeclaration !== declaration
      ? sourceDeclaration.methods.filter((method) => method.typeParameters?.length)
      : []),
  ];
  return [
    ...declaration.fields
      .filter((field) => field.visibility === "public" || includePrivate)
      .map((field) => ({
        label: field.name,
        kind: completionKinds.field,
        detail: `${field.visibility === "private" ? "private " : ""}${field.readonly ? "readonly " : ""}${displayType(field.type.name, typeDisplayNames)}`,
      })),
    ...methods
      .filter((method) => !method.static && ((method.visibility ?? "public") === "public" || includePrivate))
      .map((method) => ({
      label: method.name,
      kind: completionKinds.method,
      detail: methodDetail(method, typeDisplayNames),
      insertText: `${method.name}()`,
    })),
  ];
}

function fieldDetail(field: StructDeclaration["fields"][number], typeDisplayNames: ReadonlyMap<string, string>): string {
  const visibility = field.visibility === "private" ? "private " : "";
  const readonly = field.readonly ? "readonly " : "";
  return `${visibility}${readonly}${field.name}: ${displayType(field.type.name, typeDisplayNames)}`;
}

function staticCompletions(
  declaration: StructDeclaration,
  typeDisplayNames: ReadonlyMap<string, string>,
  substitutions: ReadonlyMap<string, string>,
  includePrivate: boolean,
): CompletionItem[] {
  return declaration.methods
    .filter((method) => method.static && ((method.visibility ?? "public") === "public" || includePrivate))
    .map((method) => ({
      label: method.name,
      kind: completionKinds.method,
      detail: methodDetail(method, typeDisplayNames, substitutions),
      insertText: `${method.name}()`,
    }));
}

function sourceAggregateForType(
  context: AnalyzedSource,
  typeName: string,
): { readonly declaration: StructDeclaration; readonly substitutions: ReadonlyMap<string, string> } | null {
  const generic = parseGenericType(typeName) ?? parseSourceGenericType(typeName);
  const base = generic?.base ?? typeName;
  const selective = localSourceBinding(context, base);
  const selectiveDeclaration = selective
    ? sourceExportDeclaration(selective.module, selective.importedName)
    : null;
  const namespaceParts = base.split(".");
  const namespaceImport = namespaceParts.length === 2
    ? context.sourceProgram.imports.find((item) => (
      isLocalSourceModuleSpecifier(item.header) && !item.bindings && item.moduleName === namespaceParts[0]
    ))
    : null;
  const namespaceModule = namespaceImport ? localSourceModule(context, namespaceImport) : null;
  const namespaceDeclaration = namespaceModule && namespaceParts[1]
    ? sourceExportDeclaration(namespaceModule, namespaceParts[1])
    : null;
  const importedDeclaration = selectiveDeclaration?.kind === "struct" || selectiveDeclaration?.kind === "class"
    ? selectiveDeclaration
    : namespaceDeclaration?.kind === "struct" || namespaceDeclaration?.kind === "class"
      ? namespaceDeclaration
      : null;
  const declaration = importedDeclaration
    ?? context.sourceProgram.structs.find((item) => item.name === base)
    ?? context.program.structs.find((item) => item.name === typeName);
  if (!declaration) return null;
  const substitutions = new Map(
    declaration.typeParameters?.map((parameter, index) => [parameter, generic?.arguments[index] ?? parameter]) ?? [],
  );
  return { declaration, substitutions };
}

function parseSourceGenericType(typeName: string): { readonly base: string; readonly arguments: string[] } | null {
  const opening = typeName.indexOf("<");
  if (opening < 1 || !typeName.endsWith(">")) return null;
  const arguments_: string[] = [];
  let depth = 0;
  let start = opening + 1;
  for (let index = start; index < typeName.length - 1; index += 1) {
    const character = typeName[index];
    if (character === "<") depth += 1;
    else if (character === ">") depth -= 1;
    else if (character === "," && depth === 0) {
      arguments_.push(typeName.slice(start, index).trim());
      start = index + 1;
    }
  }
  arguments_.push(typeName.slice(start, -1).trim());
  return { base: typeName.slice(0, opening), arguments: arguments_ };
}

function insideAggregateBody(source: string, fileName: string, offset: number, name: string): boolean {
  let tokens;
  try {
    tokens = lex(source, fileName);
  } catch {
    return false;
  }
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if ((tokens[index].kind !== "class" && tokens[index].kind !== "struct") || tokens[index + 1].text !== name) continue;
    let brace = index + 2;
    while (brace < tokens.length && tokens[brace].kind !== "leftBrace") brace += 1;
    if (brace >= tokens.length || tokens[brace].location.offset >= offset) continue;
    let depth = 0;
    for (let cursor = brace; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].kind === "leftBrace") depth += 1;
      if (tokens[cursor].kind === "rightBrace") depth -= 1;
      if (depth === 0) return offset < tokens[cursor].location.offset;
    }
    return true;
  }
  return false;
}

function collectObjCMethods(declaration: ForeignObjCInterface, instance: boolean, context: AnalyzedSource): ForeignObjCMethod[] {
  const methods: ForeignObjCMethod[] = [];
  let current: ForeignObjCInterface | undefined = declaration;
  while (current) {
    methods.push(...current.methods.filter((method) => method.instance === instance));
    if (!current.superName) break;
    const moduleName = current.typeName.slice(0, current.typeName.lastIndexOf("."));
    current = context.semanticInfo.foreignInterfaces.get(`${moduleName}.${current.superName}`);
  }
  return methods;
}

function foreignObjCRequiresMain(declaration: ForeignObjCInterface, context: AnalyzedSource): boolean {
  let current: ForeignObjCInterface | undefined = declaration;
  while (current) {
    if (current.metadata.executorAffinity === "main") return true;
    if (!current.superName) break;
    const moduleName = current.typeName.slice(0, current.typeName.lastIndexOf("."));
    current = context.semanticInfo.foreignInterfaces.get(`${moduleName}.${current.superName}`);
  }
  return false;
}

function foreignTypeExecutorAffinity(
  typeName: string,
  context: AnalyzedSource,
): ExecutorAffinityInfo | undefined {
  const publicName = typeName.replace(/^__z_objc:(?:nullable|nonnull):/, "");
  const objc = context.semanticInfo.foreignInterfaces.get(publicName);
  if (objc && foreignObjCRequiresMain(objc, context)) {
    return {
      executor: "main",
      declared: true,
      originType: objc.typeName,
      fieldPath: [],
    };
  }
  const named = context.semanticInfo.foreignNamedTypes.get(typeName)
    ?? context.semanticInfo.foreignNamedTypes.get(publicName);
  return named?.metadata.executorAffinity === "main"
    ? {
        executor: "main",
        declared: true,
        originType: named.typeName,
        fieldPath: [],
      }
    : undefined;
}

function collectObjCProperties(declaration: ForeignObjCInterface, instance: boolean, context: AnalyzedSource): ForeignObjCProperty[] {
  const properties: ForeignObjCProperty[] = [];
  let current: ForeignObjCInterface | undefined = declaration;
  while (current) {
    properties.push(...current.properties.filter((property) => property.classProperty === !instance));
    if (!current.superName) break;
    const moduleName = current.typeName.slice(0, current.typeName.lastIndexOf("."));
    current = context.semanticInfo.foreignInterfaces.get(`${moduleName}.${current.superName}`);
  }
  return properties;
}

function objcPropertyDetail(property: ForeignObjCProperty, inheritedMain: boolean | number = false): string {
  const referenceOwnership = property.type.kind === "object" || property.type.kind === "block";
  const qualifiers = [
    property.readonly ? "readonly" : null,
    !referenceOwnership || property.ownership === "unspecified" ? null : property.ownership,
  ].filter((value): value is string => value !== null);
  const executor = property.metadata.executorAffinity === "main" || inheritedMain === true
    ? "  // executor-isolated to thread.main"
    : "";
  return `${qualifiers.length > 0 ? `${qualifiers.join(" ")} ` : ""}${property.name}: ${foreignTypeName(property.type)}${executor}`;
}

function objCPropertyHover(
  property: ForeignObjCProperty,
  inheritedMain: boolean,
  source: string,
  start: number,
  end: number,
): Hover {
  const sections = [foreignAvailabilityMarkdown([property.metadata])]
    .filter((section): section is string => Boolean(section));
  return structuredMarkdownHover(
    objcPropertyDetail(property, inheritedMain),
    sections,
    source,
    start,
    end,
  );
}

function objCMethodSnippet(method: ForeignObjCMethod): string {
  const parameters = method.asyncCallbackParameter === null
    ? method.parameters
    : method.parameters.filter((_, index) => index !== method.asyncCallbackParameter);
  if (parameters.length === 0) return `${method.baseName}()`;
  const parts = selectorParts(method.selector);
  const args = parameters.map((parameter, visibleIndex) => {
    const index = method.parameters.indexOf(parameter);
    const placeholder = `\${${index + 1}:${parameter.name ?? "value"}}`;
    return visibleIndex === 0 ? placeholder : `${parts[index]}: ${placeholder}`;
  });
  return `${method.baseName}(${args.join(", ")})`;
}

function objCMethodDetail(method: ForeignObjCMethod, inheritedMain: boolean | number = false): string {
  const signature = (parameters: readonly ForeignObjCMethod["parameters"][number][]): string => parameters.map((parameter) => {
    const index = method.parameters.indexOf(parameter);
    const label = selectorParts(method.selector)[index];
    const sourceName = index === 0 ? parameter.name ?? "value" : label;
    return `${sourceName}: ${foreignTypeName(parameter.type)}`;
  }).join(", ");
  const executor = method.metadata.executorAffinity === "main" || inheritedMain === true ? " on thread.main" : "";
  const raw = `${method.baseName}(${signature(method.parameters)}): ${foreignTypeName(method.returnType)}${executor}  // ${method.selector}${foreignAvailabilityDetail(method.metadata)}`;
  if (method.asyncCallbackParameter === null) return raw;
  const callback = method.parameters[method.asyncCallbackParameter].type;
  const result = callback.kind === "block" && method.asyncResultParameter !== null
    ? foreignTypeName(callback.parameters[method.asyncResultParameter])
    : callback.kind === "block"
      ? "void"
    : "_";
  const error = callback.kind === "block" && method.asyncErrorParameter !== null
    ? callback.parameters[method.asyncErrorParameter]
    : null;
  const throws = error?.kind === "object" ? ` throws ${publicObjCTypeName(error.typeName)}` : "";
  const visible = method.parameters.filter((_, index) => index !== method.asyncCallbackParameter);
  return `async ${method.baseName}(${signature(visible)}): ${result}${throws}${executor}  // synthesized from exactly-once callback\n${raw}`;
}

function objCMethodHover(
  method: ForeignObjCMethod,
  inheritedMain: boolean,
  source: string,
  start: number,
  end: number,
): Hover {
  return objCMethodsHover([method], inheritedMain, source, start, end);
}

function objCMethodsHover(
  methods: readonly ForeignObjCMethod[],
  inheritedMain: boolean,
  source: string,
  start: number,
  end: number,
): Hover {
  const signatures = new Set<string>();
  for (const method of methods) {
    const detail = objCMethodDetail(method, inheritedMain);
    const availabilityStart = detail.indexOf("\n\nAvailability:");
    const signatureDetail = availabilityStart >= 0 ? detail.slice(0, availabilityStart) : detail;
    for (const line of signatureDetail.split("\n")) {
      const signature = line.replace(/\s+\/\/.*$/, "").trim();
      if (signature) signatures.add(signature);
    }
  }
  const selectors = [...new Set(methods.map((method) => method.selector))];
  const sections = [
    selectors.length === 1
      ? `**Objective-C selector:** \`${selectors[0]}\``
      : `**Objective-C selectors**\n\n${selectors.map((selector) => `- \`${selector}\``).join("\n")}`,
    foreignAvailabilityMarkdown(methods.map((method) => method.metadata)),
  ].filter((section): section is string => Boolean(section));
  return structuredMarkdownHover([...signatures].join("\n"), sections, source, start, end);
}

function foreignFunctionHover(
  declaration: ForeignFunction,
  module: ForeignModule,
  source: string,
  start: number,
  end: number,
): Hover {
  const signatures = foreignFunctionDetail(declaration, module)
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("Availability:"))
    .map((line) => line.replace(/\s+\/\/ C:.*$/, "").trim());
  const nativeSignatures = [...new Set(declaration.overloads.map((overload) => overload.cSignature))];
  const ownership = [...new Set(declaration.overloads.flatMap((overload) => (
    overload.returnType.kind === "named"
    && overload.returnType.type.kind === "record"
    && overload.returnType.type.resource
    && overload.returnType.ownership
      ? [overload.returnType.ownership]
      : []
  )))];
  const sections = [
    ownership.length
      ? `**Resource ownership:** ${ownership.map((fact) => fact === "owned"
        ? "`owned` — caller receives unique ownership and deterministic cleanup"
        : "`borrowed` — native runtime retains ownership; result is non-escaping").join("; ")}`
      : null,
    `**Native ABI**\n\n${nativeSignatures.map((signature) => `- \`${signature}\``).join("\n")}`,
    foreignAvailabilityMarkdown(declaration.overloads.map((overload) => overload.metadata)),
  ].filter((section): section is string => Boolean(section));
  return structuredMarkdownHover([...new Set(signatures)].join("\n"), sections, source, start, end);
}

function foreignAvailabilityMarkdown(
  metadata: readonly ForeignDeclarationMetadata[],
): string | null {
  const details = new Set<string>();
  const platformNames: Readonly<Record<string, string>> = {
    macos: "macOS",
    ios: "iOS",
    watchos: "watchOS",
    tvos: "tvOS",
  };
  for (const item of metadata) {
    for (const availability of item.availability) {
      const platform = platformNames[availability.platform ?? ""] ?? availability.platform ?? "All targets";
      const message = availability.message ? ` — ${availability.message}` : "";
      if (availability.unavailable) {
        details.add(`${platform}: unavailable${message}`);
        continue;
      }
      const facts = [
        availability.introduced ? `${availability.introduced}+` : null,
        availability.deprecated
          ? `deprecated${availability.deprecatedVersion ? ` ${availability.deprecatedVersion}` : ""}`
          : null,
        availability.obsoleted ? `obsoleted ${availability.obsoleted}` : null,
      ].filter((value): value is string => Boolean(value));
      if (facts.length > 0) details.add(`${platform}: ${facts.join("; ")}${message}`);
    }
  }
  return details.size > 0
    ? `**Availability**\n\n${[...details].map((detail) => `- ${detail}`).join("\n")}`
    : null;
}

function resolveForeignModuleNamespace(
  context: Pick<AnalyzedSource, "foreignModules" | "sourceProgram">,
  text: string,
): { readonly module: ForeignModule; readonly namespacePath: readonly string[] } | null {
  const [moduleName, ...namespacePath] = text.split(".");
  const binding = foreignNamespaceBindings(context).get(moduleName);
  const module = context.foreignModules.get(moduleName) ?? binding?.module;
  if (!module) return null;
  const resolvedPath = [...(binding?.namespacePath ?? []), ...namespacePath];
  if (resolvedPath.length > 0 && !module.namespaces.has(resolvedPath.join("."))) return null;
  return { module, namespacePath: resolvedPath };
}

function resolveForeignValueType(
  context: Pick<AnalyzedSource, "foreignModules" | "sourceProgram">,
  text: string,
): Extract<ForeignNamedType, { readonly kind: "value" }> | null {
  const [moduleName, ...path] = text.split(".");
  const namespaceBinding = foreignNamespaceBindings(context).get(moduleName);
  const module = context.foreignModules.get(moduleName) ?? namespaceBinding?.module;
  if (module && path.length > 0) {
    const named = resolveModuleNamedType(module, [...(namespaceBinding?.namespacePath ?? []), ...path.slice(0, -1)], path.at(-1)!);
    return named?.kind === "value" ? named : null;
  }
  if (path.length > 0) return null;
  for (const declaration of context.sourceProgram.imports) {
    if (isLocalSourceModuleSpecifier(declaration.header) || !declaration.bindings) continue;
    const binding = declaration.bindings.find((candidate) => candidate.localName === text);
    if (!binding) continue;
    const importedModule = context.foreignModules.get(declaration.moduleName);
    const named = importedModule ? resolveModuleNamedType(importedModule, [], binding.importedName) : null;
    if (named?.kind === "value") return named;
  }
  return null;
}

function foreignNamespaceBindings(
  context: Pick<AnalyzedSource, "foreignModules" | "sourceProgram">,
): Map<string, { readonly module: ForeignModule; readonly namespacePath: readonly string[] }> {
  const bindings = new Map<string, { readonly module: ForeignModule; readonly namespacePath: readonly string[] }>();
  for (const declaration of context.sourceProgram.imports) {
    if (isLocalSourceModuleSpecifier(declaration.header) || !declaration.bindings) continue;
    const module = context.foreignModules.get(declaration.moduleName);
    if (!module) continue;
    for (const binding of declaration.bindings) {
      if (!module.namespaces.has(binding.importedName)) continue;
      bindings.set(binding.localName, { module, namespacePath: binding.importedName.split(".") });
    }
  }
  return bindings;
}

function resolveModuleFunction(
  module: ForeignModule,
  namespacePath: readonly string[],
  name: string,
): ForeignFunction | null {
  const qualifiedName = [...namespacePath, name].join(".");
  const direct = module.functions.get(qualifiedName);
  if (direct) return direct;
  if (namespacePath.length > 0) return null;
  const alias = module.functionAliases.get(name);
  return alias ? module.functions.get(alias) ?? null : null;
}

function resolveModuleNamedType(
  module: ForeignModule,
  namespacePath: readonly string[],
  name: string,
) {
  const qualifiedName = [...namespacePath, name].join(".");
  const direct = module.namedTypes.get(qualifiedName);
  if (direct) return direct;
  if (namespacePath.length > 0) return null;
  const alias = module.namedTypeAliases.get(name);
  return alias ? module.namedTypes.get(alias) ?? null : null;
}

function describeModuleMember(module: ForeignModule, namespacePath: readonly string[], name: string): string | null {
  const fn = resolveModuleFunction(module, namespacePath, name);
  if (fn) return foreignFunctionDetail(fn, module);
  const named = resolveModuleNamedType(module, namespacePath, name);
  if (named) return `${foreignNamedTypeDetail(named)}${foreignAvailabilityDetail(named.metadata)}`;
  const namespaceName = [...namespacePath, name].join(".");
  if (module.namespaces.has(namespaceName)) return `native namespace ${namespaceName}`;
  if (namespacePath.length > 0) return null;
  const constant = module.constants.get(name);
  if (constant) return `${foreignConstantDetail(constant)}${foreignAvailabilityDetail(constant.metadata)}`;
  const objc = module.interfaces.get(name);
  if (objc) {
    const executor = objc.metadata.executorAffinity === "main" ? " on thread.main" : "";
    return `Objective-C class ${objc.className}${executor}${foreignAvailabilityDetail(objc.metadata)}`;
  }
  const protocol = module.protocols.get(name);
  return protocol ? `Objective-C protocol ${protocol.protocolName}${foreignAvailabilityDetail(protocol.metadata)}` : null;
}

function foreignConstantDetail(constant: ForeignConstant): string {
  const source = constant.sourceKind === "macro"
    ? "C object-like macro"
    : constant.sourceKind === "enum"
      ? "native enum constant"
      : "native global constant";
  return `${constant.name}: ${constant.typeName}  // ${source}`;
}

function foreignNamedTypeDetail(named: ForeignNamedType): string {
  const executor = named.metadata.executorAffinity === "main" ? " on thread.main" : "";
  if (named.kind === "record" && named.layout === "union") {
    return `${named.exportName}: ${named.cName}${executor}  // native union; scalar member reads require unsafe`;
  }
  if (named.kind === "record" && named.resource) {
    return `${named.exportName}: ${named.cName}${executor}  // move-only native C resource; deinit ${named.resource.release}`;
  }
  if (named.kind !== "value") return `${named.exportName}: ${named.cName}${executor}`;
  const available = (["copy", "move", "deinit"] as const).filter((capability) => named.lifecycle[capability]);
  const unavailable = (["copy", "move", "deinit"] as const).filter((capability) => !named.lifecycle[capability]);
  const missing = unavailable.length ? `; unavailable: ${unavailable.join(", ")}` : "";
  const threadCapabilities = (["transfer", "share", "deinit"] as const)
    .filter((capability) => named.thread[capability]);
  const thread = threadCapabilities.length ? `; thread: ${threadCapabilities.join(", ")}` : "";
  const constructors = named.constructors.map((overload) => {
    const parameters = overload.parameters.map((parameter, index) => (
      foreignParameterDetail(parameter, index)
    ));
    return `${named.exportName}(${parameters.join(", ")}): ${named.typeName}  // C++ constructor`;
  });
  const constructorDetail = constructors.length ? `\n${constructors.join("\n")}` : "";
  return `${named.exportName}: ${named.cName}${executor}  // native value: ${available.join(", ")}${missing}${thread}${constructorDetail}`;
}

function foreignFunctionDetail(declaration: ForeignFunction, module?: ForeignModule): string {
  return declaration.overloads.map((overload) => {
    const buffers = overload.buffers ?? [];
    const projectedBuffers = new Map(buffers.map((buffer) => [buffer.bufferParameter, buffer]));
    const projectedLengths = new Set(buffers.flatMap((buffer) => buffer.lengthParameters));
    const parameters = overload.parameters
      .map((parameter, nativeIndex) => ({ parameter, nativeIndex }))
      .filter(({ parameter, nativeIndex }) => parameter.type.kind !== "callbackContext"
        && parameter.type.kind !== "callbackRelease"
        && parameter.type.kind !== "fixedNative"
        && !projectedLengths.has(nativeIndex))
      .map(({ parameter, nativeIndex }, index) => (
        projectedBuffers.has(nativeIndex)
          ? `${projectedBuffers.get(nativeIndex)!.access === "inout" ? "inout " : ""}${projectedBuffers.get(nativeIndex)!.name}: Slice<${projectedBuffers.get(nativeIndex)!.elementType}>`
          : foreignParameterDetail(parameter, index, module)
      ));
    if (overload.variadic) parameters.push("...arguments");
    const result = overload.status
      ? `${overload.connection ? "native.Connection" : "void"} throws ${foreignTypeName(overload.returnType, module)}`
      : foreignTypeName(overload.returnType, module);
    const executor = overload.metadata.executorAffinity === "main" ? " on thread.main" : "";
    const callbackError = overload.parameters.some((parameter) => (
      parameter.type.kind === "callback" && parameter.type.failure !== null
    ));
    const resourceOwnership = overload.returnType.kind === "named"
      && overload.returnType.type.kind === "record"
      && overload.returnType.type.resource
      && overload.returnType.ownership
      ? `; ${overload.returnType.ownership} native resource`
      : "";
    return `${declaration.name}${callbackError ? "<E>" : ""}(${parameters.join(", ")}): ${result}${executor}  // C: ${overload.cSignature}${resourceOwnership}${foreignAvailabilityDetail(overload.metadata)}`;
  }).join("\n");
}

function foreignCxxMethodDetail(method: ForeignCxxMethod): string {
  return method.overloads.map((overload) => {
    const parameters = overload.parameters.map((parameter, index) => (
      foreignParameterDetail(parameter, index)
    ));
    if (overload.receiverAccess !== "in") parameters.unshift(`${overload.receiverAccess} this`);
    if (overload.variadic) parameters.push("...arguments");
    const receiver = overload.receiverAccess === "in"
      ? "C++ const borrow"
      : overload.receiverAccess === "inout" ? "C++ mutable borrow" : "C++ consuming receiver";
    const executor = overload.metadata.executorAffinity === "main" ? " on thread.main" : "";
    return `${method.name}(${parameters.join(", ")}): ${foreignTypeName(overload.returnType)}${executor}  // ${receiver}; ${overload.cSignature}${foreignAvailabilityDetail(overload.metadata)}`;
  }).join("\n");
}

function foreignCxxStaticMethodDetail(method: ForeignCxxStaticMethod): string {
  return method.overloads.map((overload) => {
    const parameters = overload.parameters.map((parameter, index) => (
      foreignParameterDetail(parameter, index)
    ));
    if (overload.variadic) parameters.push("...arguments");
    const executor = overload.metadata.executorAffinity === "main" ? " on thread.main" : "";
    return `${method.name}(${parameters.join(", ")}): ${foreignTypeName(overload.returnType)}${executor}  // C++ static; ${overload.cSignature}${foreignAvailabilityDetail(overload.metadata)}`;
  }).join("\n");
}

function foreignAvailabilityDetail(metadata: ForeignDeclarationMetadata): string {
  const details = metadata.availability.map((availability) => {
    const platform = availability.platform ?? "all targets";
    const message = availability.message ? ` — ${availability.message}` : "";
    if (availability.unavailable) return `unavailable on ${platform}${message}`;
    const parts = [
      availability.introduced ? `introduced ${availability.introduced}` : null,
      availability.deprecated
        ? `deprecated${availability.deprecatedVersion ? ` ${availability.deprecatedVersion}` : ""}`
        : null,
      availability.obsoleted ? `obsoleted ${availability.obsoleted}` : null,
    ].filter(Boolean);
    return parts.length > 0 ? `${platform}: ${parts.join(", ")}${message}` : null;
  }).filter((detail): detail is string => Boolean(detail));
  return details.length > 0 ? `\n\nAvailability: ${details.join("; ")}` : "";
}

function structLiteralFieldHover(context: AnalyzedSource, offset: number): string | null {
  const item = collectStructLiteralFields(context.sourceProgram).find((candidate) => candidate.location.offset === offset);
  if (!item) return null;
  const typeName = item.expression.kind === "structExpression"
    ? item.expression.typeName
    : context.semanticInfo.expressionTypes.get(item.expression.location.offset);
  if (!typeName) return null;
  const generic = parseGenericType(typeName);
  const declaration = context.sourceProgram.structs.find((candidate) => candidate.name === (generic?.base ?? typeName));
  if (!declaration) {
    const concrete = context.program.structs.find((candidate) => candidate.name === typeName);
    const concreteField = concrete?.fields.find((candidate) => candidate.name === item.name);
    if (concreteField) {
      return `${concreteField.name}: ${displayType(concreteField.type.name, context.typeDisplayNames)}`;
    }
    const foreign = context.semanticInfo.foreignNamedTypes.get(typeName);
    const field = foreign?.kind === "record" ? foreign.fields.find((candidate) => candidate.name === item.name) : null;
    return field ? `${field.name}: ${field.typeName}` : null;
  }
  const field = declaration.fields.find((candidate) => candidate.name === item.name);
  if (!field) return null;
  const substitutions = new Map(
    declaration.typeParameters?.map((parameter, index) => [parameter, generic?.arguments[index] ?? parameter]) ?? [],
  );
  return `${field.name}: ${displaySubstitutedType(field.type.name, substitutions, context.typeDisplayNames)}`;
}

function collectStructLiteralFields(program: Program): Array<{
  readonly expression: StructExpression | ObjectExpression;
  readonly name: string;
  readonly location: SourceLocation;
}> {
  const fields: Array<{ expression: StructExpression | ObjectExpression; name: string; location: SourceLocation }> = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { readonly kind?: string };
    if (node.kind === "structExpression" || node.kind === "objectExpression") {
      const expression = value as StructExpression | ObjectExpression;
      for (const field of expression.fields) fields.push({ expression, name: field.name, location: field.location });
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(program);
  return fields;
}

function declarationHover(
  source: string,
  program: Program | null,
  name: string,
  start: number,
  end: number,
  typeDisplayNames: ReadonlyMap<string, string> = new Map(),
  executorAffinities: ReadonlyMap<string, ExecutorAffinityInfo> = new Map(),
): Hover | null {
  if (program) {
    const fn = program.functions.find((item) => item.name === name);
    if (fn) {
      return markdownHover(
        zFunctionDetail(
          fn.name,
          fn.parameters,
          fn.returnType.name,
          fn.typeParameters,
          typeDisplayNames,
          fn.typeParameterConstraints,
          fn.async,
          fn.errorType?.name,
          Boolean(fn.executorAffinity),
        ),
        source,
        start,
        end,
      );
    }
    const struct = program.structs.find((item) => item.name === name);
    if (struct) {
      const parameters = formatTypeParameters(
        struct.typeParameters ?? [],
        struct.typeParameterConstraints ?? [],
        typeDisplayNames,
      );
      const info = executorAffinities.get(struct.name);
      const executor = info || struct.executorAffinity ? " on thread.main" : "";
      return markdownHover(
        `${struct.kind} ${struct.name}${parameters}${executor}${executorAffinityHover(info)}`,
        source,
        start,
        end,
      );
    }
    const trait = program.traits.find((item) => item.name === name);
    if (trait) {
      return markdownHover(
        `trait ${trait.name}${formatTypeParameters(
          trait.typeParameters ?? [],
          trait.typeParameterConstraints ?? [],
          typeDisplayNames,
        )}`,
        source,
        start,
        end,
      );
    }
    const alias = program.typeAliases.find((item) => item.name === name);
    if (alias) {
      return markdownHover(
        `type ${alias.name} = ${displayType(alias.target.name, typeDisplayNames)}`,
        source,
        start,
        end,
      );
    }
    const enumeration = program.enums.find((item) => item.name === name);
    if (enumeration) return markdownHover(`enum ${enumeration.name}`, source, start, end);
  }
  const alias = new RegExp(`\\btype\\s+${name}\\s*=\\s*([^;]+);`).exec(source);
  if (alias) return markdownHover(`type ${name} = ${alias[1].trim()}`, source, start, end);
  const generic = new RegExp(`\\b(function|struct|class|trait)\\s+${name}\\s*<([^>]+)>`).exec(source);
  if (generic) return markdownHover(`${generic[1]} ${name}<${generic[2].trim()}>`, source, start, end);
  return null;
}

function objectiveCCallAt(context: AnalyzedSource, memberOffset: number): ObjCCallInfo | null {
  let result: ObjCCallInfo | null = null;
  const visit = (value: unknown): void => {
    if (result || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as {
      readonly kind?: string;
      readonly location?: SourceLocation;
      readonly callee?: { readonly kind?: string; readonly location?: SourceLocation };
    };
    if (node.kind === "call" && node.location && node.callee?.kind === "member"
      && node.callee.location?.offset === memberOffset) {
      result = context.semanticInfo.objcCalls.get(node.location.offset) ?? null;
      if (result) return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(context.program);
  return result;
}

function objectiveCSelectorAt(context: AnalyzedSource, memberOffset: number): string | null {
  return objectiveCCallAt(context, memberOffset)?.selector ?? null;
}

type ObjCArgumentLabelInfo = {
  readonly offset: number;
  readonly label: string;
  readonly selector: string;
  readonly parameterType: ForeignType;
};

function collectObjCArgumentLabelInfos(
  context: AnalyzedSource,
  tokens: readonly ReturnType<typeof lex>[number][],
): ObjCArgumentLabelInfo[] {
  const result: ObjCArgumentLabelInfo[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as Partial<Expression>;
    if (node.kind === "call") {
      const call = node as Extract<Expression, { kind: "call" }>;
      const callInfo = context.semanticInfo.objcCalls.get(call.location.offset);
      if (callInfo) {
        const candidateMethods = [...context.semanticInfo.foreignInterfaces.values()]
          .flatMap((declaration) => declaration.methods)
          .filter((candidate) => candidate.selector === callInfo.selector);
        const method = callInfo.async?.method
          ?? [...context.semanticInfo.foreignInterfaces.values()]
            .filter((declaration) => declaration.className === callInfo.className)
            .flatMap((declaration) => declaration.methods)
            .find((candidate) => candidate.selector === callInfo.selector)
          ?? candidateMethods[0];
        if (method) {
          const parameters = callInfo.async
            ? method.parameters.filter((_, index) => index !== callInfo.async!.callbackParameter)
            : method.parameters;
          call.argumentLabels.forEach((label, index) => {
            if (!label || !call.arguments[index] || !parameters[index]) return;
            const argumentOffset = call.arguments[index].location.offset;
            const labelToken = tokens
              .filter((token, tokenIndex) => (
                token.location.offset > call.location.offset
                && token.location.offset < argumentOffset
                && token.text === label
                && tokens[tokenIndex + 1]?.kind === "colon"
              ))
              .at(-1);
            if (!labelToken) return;
            result.push({
              offset: labelToken.location.offset,
              label,
              selector: callInfo.selector,
              parameterType: parameters[index].type,
            });
          });
        }
      }
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(context.sourceProgram);
  return result;
}

function zFunctionDetail(
  name: string,
  parameters: readonly { readonly name: string; readonly type: { readonly name: string } }[],
  returnType: string,
  typeParameters: readonly string[] = [],
  typeDisplayNames: ReadonlyMap<string, string> = new Map(),
  typeParameterConstraints: readonly TypeParameterConstraint[] = [],
  isAsync = false,
  errorType: string | undefined = undefined,
  mainIsolated = false,
): string {
  const generic = formatTypeParameters(typeParameters, typeParameterConstraints, typeDisplayNames);
  const asyncPrefix = isAsync ? "async " : "";
  const throws = errorType ? ` throws ${displayType(errorType, typeDisplayNames)}` : "";
  const executor = mainIsolated ? " on thread.main" : "";
  return `${asyncPrefix}function ${name}${generic}(${parameters.map((item) => `${item.name}: ${displayType(item.type.name, typeDisplayNames)}`).join(", ")}): ${displayType(returnType, typeDisplayNames)}${throws}${executor}`;
}

function methodDetail(
  method: StructDeclaration["methods"][number],
  typeDisplayNames: ReadonlyMap<string, string>,
  substitutions: ReadonlyMap<string, string> = new Map(),
): string {
  const visibility = method.visibility ?? "public";
  const staticPrefix = method.static ? " static" : "";
  const asyncPrefix = method.async ? " async" : "";
  const inferredOwnerParameters = method.static
    ? [...substitutions].filter(([parameter, value]) => parameter === value).map(([parameter]) => parameter)
    : [];
  const genericParameters = [...inferredOwnerParameters, ...(method.typeParameters ?? [])];
  const generic = genericParameters.length ? `<${genericParameters.join(", ")}>` : "";
  const parameters = method.parameters.map((parameter) => {
    const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
    return `${capability}${parameter.name}: ${displaySubstitutedType(parameter.type.name, substitutions, typeDisplayNames)}`;
  });
  const result = displaySubstitutedType(method.returnType.name, substitutions, typeDisplayNames);
  const throws = method.errorType
    ? ` throws ${displaySubstitutedType(method.errorType.name, substitutions, typeDisplayNames)}`
    : "";
  const executor = method.executorAffinity ? " on thread.main" : "";
  return `${visibility}${staticPrefix}${asyncPrefix} function ${method.name}${generic}(${parameters.join(", ")}): ${result}${throws}${executor}`;
}

function executorAffinityHover(info: ExecutorAffinityInfo | undefined): string {
  if (!info) return "";
  if (info.declared) return "\n// executor-isolated to thread.main";
  const path = info.fieldPath.length ? ` through ${info.fieldPath.join(".")}` : "";
  return `\n// executor-isolated to thread.main (inherited from ${info.originType}${path})`;
}

function formatTypeParameters(
  parameters: readonly string[],
  constraints: readonly TypeParameterConstraint[],
  typeDisplayNames: ReadonlyMap<string, string>,
): string {
  if (parameters.length === 0) return "";
  const constrained = new Map(constraints.map((constraint) => [constraint.parameter, constraint.traits]));
  return `<${parameters.map((parameter) => {
    const traits = constrained.get(parameter) ?? [];
    return traits.length
      ? `${parameter}: ${traits.map((trait) => displayType(trait.name, typeDisplayNames)).join(" & ")}`
      : parameter;
  }).join(", ")}>`;
}

function foreignTypeName(type: ForeignType, module?: ForeignModule): string {
  if (type.kind === "z") return displayArrayType(type.name);
  if (type.kind === "nullPointer") return "null";
  if (type.kind === "fixedNative") return `fixed ${type.expression}`;
  if (type.kind === "selector") return "objc.Selector";
  if (type.kind === "swiftString") return "String";
  if (type.kind === "named") return type.type.typeName;
  if (type.kind === "reference") return type.type.kind === "scalar" ? type.type.underlying : type.type.typeName;
  if (type.kind === "object") return `${type.className ?? "id"}${type.nullable ? " | null" : ""}`;
  if (type.kind === "pointer") {
    if (type.stringView) return `view cstring${type.nullable ? " | null" : ""}`;
    const sourceName = module ? foreignPointerSourceName(type, module) : null;
    return sourceName ?? `${type.cName}${type.nullable ? " | null" : ""}`;
  }
  if (type.kind === "pointerOut") return `${type.pointer.cName}${type.pointer.nullable ? " | null" : ""}`;
  if (type.kind === "scalarPointer") return type.typeName;
  if (type.kind === "callback" || type.kind === "block") {
    const parameters = type.parameters.map((parameter, index) => (
      `${type.kind === "callback" ? type.parameterNames?.[index] ?? `argument${index + 1}` : `argument${index + 1}`}: ${foreignTypeName(parameter, module)}`
    ));
    const throws = type.kind === "callback" && type.failure !== null ? " throws E" : "";
    return `(${parameters.join(", ")}) => ${foreignTypeName(type.returnType, module)}${throws}`;
  }
  return type.cName;
}

function foreignPointerSourceName(
  pointer: Extract<ForeignType, { readonly kind: "pointer" }>,
  module: ForeignModule,
): string | null {
  if (module.declaration.moduleName === "declarationNative") return null;
  const aliases = collectForeignHandleTypeAliases(new Map([[module.declaration.moduleName, module]]));
  const direct = aliases.displayByCanonicalName.get(pointer.typeName);
  if (direct) return direct;
  for (const [sourceName, canonical] of aliases.canonicalBySourceName) {
    if (sourceName.startsWith("__z_objc:")) continue;
    const candidate = module.types.get(canonical);
    if (candidate?.kind !== "pointer" || candidate.identity !== pointer.identity) continue;
    return `${sourceName}${pointer.nullable ? " | null" : ""}`;
  }
  return null;
}

function foreignParameterDetail(
  parameter: { readonly name: string | null; readonly type: ForeignType; readonly literal?: string | number },
  index: number,
  module?: ForeignModule,
): string {
  const name = parameter.name ?? `argument${index + 1}`;
  if (parameter.literal !== undefined) {
    const literal = typeof parameter.literal === "string" && module
      ? `${module.declaration.moduleName}.${parameter.literal}`
      : String(parameter.literal);
    return `${name}: ${literal}`;
  }
  if (parameter.type.kind === "callback" && parameter.type.lifetime === "escape") {
    return `move ${name}: ${foreignTypeName(parameter.type, module)}`;
  }
  if (parameter.type.kind === "pointerOut") return `out ${name}: ${foreignTypeName(parameter.type, module)}`;
  if (parameter.type.kind === "scalarPointer") {
    const capability = parameter.type.access === "in" ? "" : `${parameter.type.access} `;
    return `${capability}${name}: ${foreignTypeName(parameter.type, module)}`;
  }
  if (
    parameter.type.kind === "named"
    && parameter.type.type.kind === "record"
    && parameter.type.type.resource
  ) {
    const capability = parameter.type.ownership === "consuming"
      ? "move "
      : parameter.type.ownership === "borrowed" ? "in " : "";
    return `${capability}${name}: ${foreignTypeName(parameter.type, module)}`;
  }
  if (parameter.type.kind !== "reference") return `${name}: ${foreignTypeName(parameter.type, module)}`;
  const capability = parameter.type.access === "move" ? "" : `${parameter.type.access} `;
  return `${capability}${name}: ${foreignTypeName(parameter.type, module)}`;
}

function normalizeNativeSpelling(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s*\*\s*/g, " *").trim();
}

function normalizeOutputPointerSpelling(value: string): string {
  return normalizeNativeSpelling(value).replace(/\s*\*$/, "").trim();
}

function generatorNextDisplayType(
  generator: {
    readonly elementType: string;
    readonly returnType: string | null;
    readonly errorType: string | null;
  },
  typeDisplayNames: ReadonlyMap<string, string>,
): string {
  const element = displayType(generator.elementType, typeDisplayNames);
  const success = generator.returnType
    ? `GeneratorStep<${element}, ${displayType(generator.returnType, typeDisplayNames)}>`
    : `Option<${element}>`;
  return generator.errorType
    ? `Result<${success}, ${displayType(generator.errorType, typeDisplayNames)}>`
    : success;
}

function asyncGeneratorNextDisplayType(
  generator: {
    readonly elementType: string;
    readonly returnType: string | null;
    readonly errorType: string | null;
  },
  typeDisplayNames: ReadonlyMap<string, string>,
): string {
  const element = displayType(generator.elementType, typeDisplayNames);
  const success = generator.returnType
    ? `GeneratorStep<${element}, ${displayType(generator.returnType, typeDisplayNames)}>`
    : `Option<${element}>`;
  return generator.errorType
    ? `Task<${success}, ${displayType(generator.errorType, typeDisplayNames)}>`
    : `Task<${success}>`;
}

function displayType(type: string, typeDisplayNames: ReadonlyMap<string, string> = new Map()): string {
  if (type.startsWith("__z_borrowed:")) {
    return displayType(type.slice("__z_borrowed:".length), typeDisplayNames);
  }
  const known = typeDisplayNames.get(type);
  if (known) return known;
  const unsafeNative = displayUnsafeNativeType(type);
  if (unsafeNative) return `${unsafeNative} — unsafe pass-through only`;
  const view = parseViewType(type);
  if (view) return `view ${displayType(view.target, typeDisplayNames)}`;
  const nullableObjC = /^__z_objc:nullable:(.+)$/.exec(type);
  if (nullableObjC) return `${displayType(nullableObjC[1], typeDisplayNames)} | null`;
  const nonnullObjC = /^__z_objc:nonnull:(.+)$/.exec(type);
  if (nonnullObjC) return displayType(nonnullObjC[1], typeDisplayNames);
  const functionType = displayFunctionType(type, (nested) => displayType(nested, typeDisplayNames));
  if (functionType) return functionType;
  const weak = parseWeakType(type);
  if (weak) return `Weak<${displayType(weak.target, typeDisplayNames)}>`;
  const task = parseTaskType(type);
  if (task) return displayTaskType(task, (nested) => displayType(nested, typeDisplayNames));
  const generic = parseGenericType(type);
  if (generic) return `${generic.base}<${generic.arguments.map((argument) => displayType(argument, typeDisplayNames)).join(", ")}>`;
  const array = parseFixedArrayType(type);
  if (array) return `${displayType(array.elementType, typeDisplayNames)}[${array.length}]`;
  const slice = parseSliceType(type);
  if (slice) return `Slice<${displayType(slice.elementType, typeDisplayNames)}>`;
  const dynamic = parseDynamicArrayType(type);
  if (dynamic) return `Array<${displayType(dynamic.elementType, typeDisplayNames)}>`;
  return type;
}

function displayServiceType(type: string, context: AnalyzedSource): string {
  const pointer = context.semanticInfo.foreignTypes.get(type);
  if (pointer) {
    if (pointer.stringView) return `view cstring${pointer.nullable ? " | null" : ""}`;
    const named = context.typeDisplayNames.get(type);
    if (named) return named;
    return `${pointer.cName}${pointer.nullable ? " | null" : ""}`;
  }
  const displayNames = new Map(context.typeDisplayNames);
  for (const name of context.semanticInfo.foreignNamedTypes.keys()) {
    const visible = visibleSelectiveImportType(name, context);
    if (visible !== name) displayNames.set(name, visible);
  }
  const closure = [...context.semanticInfo.closures.values()].find((item) => item.type === type);
  if (!closure) return displayType(type, displayNames);
  const parameters = closure.declaration.parameters.slice(closure.captures.length).map((parameter) => {
    const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
    return `${capability}${parameter.name}: ${displayType(parameter.type.name, displayNames)}`;
  });
  const throws = closure.declaration.errorType
    ? ` throws ${displayType(closure.declaration.errorType.name, displayNames)}`
    : "";
  return `(${parameters.join(", ")}) => ${displayType(closure.declaration.returnType.name, displayNames)}${throws}`;
}

function explicitCopyHover(
  plan: ExplicitCopyPlan,
  context: AnalyzedSource,
): string {
  const type = displayServiceType(plan.type, context);
  const source = plan.sourceIsView ? `view ${type}` : type;
  const capability = plan.kind === "trivial"
    ? "built-in cleanup-free value copy"
    : plan.kind === "string"
      ? "built-in owned String copy"
      : plan.kind === "native"
        ? "native copy construction proven by the `.zd` contract"
        : "compiler-synthesized from copyable fields and payloads";
  const cost = plan.kind === "trivial"
    ? "ordinary by-value copy; no allocation"
    : plan.kind === "string"
      ? "allocates and copies UTF-8 storage"
      : plan.kind === "native"
        ? "invokes the native copy operation; its internal cost is library-defined"
        : aggregateCopyMayAllocate(plan.type, context)
          ? "recursive value copy; allocates for owned strings or growable buffers"
          : "recursive by-value copy; no Z allocation";
  const materialization = plan.sourceIsView
    ? `\n// materializes an owned ${type} from borrowed storage`
    : "";
  return `copy ${source} -> ${type}\n// ${capability}\n// source remains available${materialization}\n// cost: ${cost}`;
}

function explicitMoveHover(typeName: string, context: AnalyzedSource): string {
  const type = displayServiceType(typeName, context);
  const foreign = context.semanticInfo.foreignNamedTypes.get(typeName);
  const aggregate = context.program.structs.find((candidate) => candidate.name === typeName);
  const cost = foreign?.kind === "value"
    ? "invokes native move construction proven by the `.zd` contract"
    : aggregate?.kind === "class"
      ? "transfers the ARC owner without retaining the identity"
      : typeName === "String"
        || typeName === "TextBuffer"
        || typeName === "Arena"
        || Boolean(parseDynamicArrayType(typeName))
        ? "constant-time owned-storage transfer; no allocation"
        : "whole-value ownership transfer; owned fields are not cloned";
  return `move ${type} -> ${type}\n// transfers unique ownership; a named source becomes unavailable\n// cost: ${cost}`;
}

function integerConversionHover(conversion: IntegerConversion): string {
  const behavior = conversion.checked
    ? "runtime range check; traps if the source value is not representable"
    : "source range is fully representable; lowers to a direct value-preserving cast";
  const representation = conversion.sourceDisplayType
    ? `\n// native enum representation: ${conversion.sourceType}`
    : "";
  return `${conversion.targetType}(value: ${conversion.sourceDisplayType ?? conversion.sourceType}): ${conversion.targetType}\n// explicit integer conversion${representation}\n// ${behavior}`;
}

function aggregateCopyMayAllocate(
  type: string,
  context: AnalyzedSource,
  visiting = new Set<string>(),
): boolean {
  if (type === "String" || parseDynamicArrayType(type)) return true;
  if (visiting.has(type)) return false;
  const fixed = parseFixedArrayType(type);
  if (fixed) return aggregateCopyMayAllocate(fixed.elementType, context, visiting);
  const aggregate = context.program.structs.find((candidate) => candidate.name === type);
  const enumeration = context.program.enums.find((candidate) => candidate.name === type);
  if (!aggregate && !enumeration) return false;
  visiting.add(type);
  const result = aggregate
    ? aggregate.fields.some((field) => aggregateCopyMayAllocate(field.type.name, context, visiting))
    : enumeration!.variants.some((variant) => (
      Boolean(variant.payload) && aggregateCopyMayAllocate(variant.payload!.name, context, visiting)
    ));
  visiting.delete(type);
  return result;
}

function visibleSelectiveImportType(type: string, context: AnalyzedSource): string {
  for (const declaration of context.sourceProgram.imports) {
    if (!declaration.bindings) continue;
    const prefix = `${declaration.moduleName}.`;
    if (!type.startsWith(prefix)) continue;
    const importedType = type.slice(prefix.length);
    for (const binding of declaration.bindings) {
      if (importedType === binding.importedName) return binding.localName;
      if (importedType.startsWith(`${binding.importedName}.`)) {
        return `${binding.localName}${importedType.slice(binding.importedName.length)}`;
      }
    }
  }
  return type;
}

function displaySubstitutedType(
  type: string,
  substitutions: ReadonlyMap<string, string>,
  typeDisplayNames: ReadonlyMap<string, string>,
): string {
  const substituted = substitutions.get(type);
  if (substituted) return displayType(substituted, typeDisplayNames);
  const functionType = parseFunctionType(type);
  if (functionType) {
    return displayFunctionType(
      functionTypeName(
        functionType.parameters.map((parameter) => ({
          ...parameter,
          type: substitutions.get(parameter.type) ?? parameter.type,
        })),
        substitutions.get(functionType.returnType) ?? functionType.returnType,
        functionType.errorType
          ? substitutions.get(functionType.errorType) ?? functionType.errorType
          : null,
      ),
      (nested) => displayType(nested, typeDisplayNames),
    )!;
  }
  const generic = parseGenericType(type);
  if (generic) {
    return `${generic.base}<${generic.arguments.map((argument) => (
      displaySubstitutedType(argument, substitutions, typeDisplayNames)
    )).join(", ")}>`;
  }
  const array = parseFixedArrayType(type);
  if (array) return `${displaySubstitutedType(array.elementType, substitutions, typeDisplayNames)}[${array.length}]`;
  const slice = parseSliceType(type);
  if (slice) return `Slice<${displaySubstitutedType(slice.elementType, substitutions, typeDisplayNames)}>`;
  return displayType(type, typeDisplayNames);
}

function selectorParts(selector: string): string[] {
  return selector.includes(":") ? selector.split(":").slice(0, -1) : [selector];
}

function uniqueCompletions(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.label}\0${item.detail ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function filterCompletions(items: CompletionItem[], prefix: string, limit: number): CompletionItem[] {
  const filtered = prefix
    ? items.filter((item) => item.label.toLowerCase().startsWith(prefix.toLowerCase()))
    : items;
  return filtered.slice(0, limit);
}

function unmatchedOpenParen(source: string, offset: number): number {
  let depth = 0;
  for (let index = offset - 1; index >= 0; index -= 1) {
    const character = source[index];
    if (character === ")") depth += 1;
    if (character === "(") {
      if (depth === 0) return index;
      depth -= 1;
    }
    if (depth === 0 && character === ";") return -1;
  }
  return -1;
}

function topLevelCommaCount(text: string): number {
  let depth = 0;
  let count = 0;
  for (const character of text) {
    if (character === "(" || character === "{" ) depth += 1;
    else if (character === ")" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) count += 1;
  }
  return count;
}

function wordAt(source: string, offset: number): { readonly text: string; readonly start: number; readonly end: number } | null {
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(source[start - 1])) start -= 1;
  while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
  return start === end ? null : { text: source.slice(start, end), start, end };
}

function markdownHover(value: string, source: string, start: number, end: number): Hover {
  return {
    contents: { kind: "markdown", value: `\`\`\`z\n${value}\n\`\`\`` },
    range: { start: positionAt(source, start), end: positionAt(source, end) },
  };
}

function structuredMarkdownHover(
  code: string,
  sections: readonly string[],
  source: string,
  start: number,
  end: number,
): Hover {
  const detail = sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
  return {
    contents: { kind: "markdown", value: `\`\`\`z\n${code}\n\`\`\`${detail}` },
    range: { start: positionAt(source, start), end: positionAt(source, end) },
  };
}

function positionAt(source: string, offset: number): Position {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

function diagnosticUri(fileName: string): string {
  return pathToFileURL(resolve(fileName)).href;
}

function uriToFileName(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  return decodeURIComponent(new URL(uri).pathname);
}
