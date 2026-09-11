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
import { genericTypeName, parseGenericType } from "./generic-types.ts";
import { pathToFileURL } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  isLocalSourceModuleSpecifier,
  loadSourceModuleBatch,
  type SourceModuleInfo,
} from "./modules.ts";
import { prepareProject } from "./project.ts";
import { displayFunctionType, functionTypeName, parseFunctionType } from "./function-types.ts";
import { displayTaskType, parseTaskType } from "./async-types.ts";
import { parseWeakType } from "./weak-types.ts";
import { parseViewType, viewTypeName } from "./view-types.ts";
import { parseOptionType } from "./option-types.ts";
import { parseMapType } from "./map-types.ts";
import { parseSetType } from "./set-types.ts";
import { parseReadonlyType, readonlyTypeName } from "./readonly-types.ts";
import { parseAsyncGeneratorType, parseGeneratorType } from "./generator-types.ts";
import { parseOnceLifetimeType, parseOnceType } from "./once-types.ts";
import { parseMutexType } from "./mutex-types.ts";
import { parseChannelHandleType, type ChannelHandleType } from "./channel-types.ts";
import { parseObjCProtocolType, publicObjCTypeName } from "./objc-types.ts";
import { displayUnsafeNativeType } from "./unsafe-types.ts";
import type { ExecutorAffinityInfo, ExplicitCopyPlan, NumericConversion, ObjCCallInfo } from "./sema.ts";
import { collectForeignHandleTypeAliases } from "./foreign-handle-types.ts";
import {
  parseForeignDeclarationContracts,
  type ForeignDeclarationContracts,
} from "./foreign-declarations.ts";
import {
  fsLockTypeName,
  objcConnectionTypeName,
  objcRegistrationTypeName,
  standardFunctionSignature,
  standardModuleFunction,
  standardModuleMemberNames,
  type StandardFunctionName,
} from "./standard-library.ts";
import { isStaticBytesType } from "./static-bytes.ts";

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
  "continue", "declare", "deinit", "else", "enum", "export", "internal", "for", "from",
  "function", "if", "implements", "import", "in", "inout", "instanceof", "let", "match", "module",
  "copy", "move", "mut", "new", "of", "on", "out", "private", "public", "return", "scope", "select",
  "readonly", "static", "struct", "task", "test", "throw", "throws", "trait", "type", "try", "unsafe", "view",
  "using", "weak", "while", "yield", "raw",
] as const;

// Declaration keywords keep their TextMate storage/entity scopes so themes can
// distinguish `function` from control-flow keywords. Visibility words are
// semantic modifiers because their meaning survives formatting and nesting.
const sourceDeclarationKeywordTokens = [
  "function", "struct", "class", "enum", "trait", "constructor",
] as const;

const sourceModifierTokens = [
  "public", "internal", "private", "readonly", "static",
] as const;

const primitiveTypeTokens = [
  "void", "boolean", "String", "cstring", "Slice", "Array", "Option", "Result", "Task", "Weak",
  "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "usize", "isize",
] as const;

type LanguageAnalysisDependency = {
  readonly fileName: string;
  readonly exists: boolean;
  readonly size: number;
  readonly modified: number;
};

type LanguageAnalysisCacheEntry = {
  readonly source: string;
  readonly analysis: AnalyzedSource | null;
  readonly error: unknown;
  readonly dependencies: readonly LanguageAnalysisDependency[];
};

// Diagnostics, semantic tokens, hover, and completion all ask the same
// question for one document version. Keep only two complete graphs because an
// AppKit/WebKit project analysis is intentionally rich and therefore large.
const languageAnalysisCache = new Map<string, LanguageAnalysisCacheEntry>();
const importLanguageAnalysisCache = new Map<string, LanguageAnalysisCacheEntry>();
const lastSuccessfulLanguageAnalyses = new Map<string, {
  readonly source: string;
  readonly analysis: AnalyzedSource;
}>();
const maximumCachedLanguageAnalyses = 2;
const maximumLastSuccessfulLanguageAnalyses = 8;

function languageAnalysisKey(fileName: string): string {
  try {
    return realpathSync(fileName);
  } catch {
    return resolve(fileName);
  }
}

function languageAnalysisDependencies(
  analysis: AnalyzedSource,
  entryFileName: string,
): LanguageAnalysisDependency[] {
  const entry = resolve(entryFileName);
  const dependencies = new Map<string, LanguageAnalysisDependency>();
  const includeDirectories = [
    ...analysis.projectBuild.includeDirectories,
    ...analysis.moduleIncludeDirectories,
  ];
  const add = (fileName: string): void => {
    const resolved = resolve(fileName);
    if (resolved === entry || dependencies.has(resolved)) return;
    dependencies.set(resolved, languageAnalysisDependency(resolved));
  };
  for (const module of analysis.sourceModules.values()) {
    const fileName = resolve(module.fileName);
    add(fileName);
    addForeignAnalysisDependencies(
      module.program,
      fileName,
      includeDirectories,
      add,
    );
  }
  if (analysis.projectBuild.manifestPath) add(analysis.projectBuild.manifestPath);
  if (analysis.projectBuild.generatedBuild) add(analysis.projectBuild.generatedBuild.fileName);
  return [...dependencies.values()];
}

function languageAnalysisDependency(fileName: string): LanguageAnalysisDependency {
  try {
    const status = statSync(fileName);
    return {
      fileName,
      exists: true,
      size: status.size,
      modified: status.mtimeMs,
    };
  } catch {
    return { fileName, exists: false, size: -1, modified: -1 };
  }
}

function addForeignAnalysisDependencies(
  program: Program,
  sourceFileName: string,
  includeDirectories: readonly string[],
  add: (fileName: string) => void,
): void {
  for (const declaration of program.imports) {
    if (
      declaration.header.startsWith("std/")
      || isLocalSourceModuleSpecifier(declaration.header)
      || declaration.header.endsWith(".zs")
    ) continue;
    const declarationDirectory = dirname(
      resolve(declaration.location.fileName ?? sourceFileName),
    );
    const directories = [...new Set([
      declarationDirectory,
      dirname(resolve(sourceFileName)),
      ...includeDirectories.map((directory) => resolve(directory)),
    ])];
    for (const directory of directories) {
      add(resolve(directory, declaration.header));
      add(resolve(directory, `${declaration.header}.zd`));
      add(resolve(directory, `${basename(declaration.header)}.zd`));
    }
  }
}

function failedLanguageAnalysisDependencies(
  source: string,
  fileName: string,
  error: unknown,
): LanguageAnalysisDependency[] {
  const entry = resolve(fileName);
  const dependencies = new Map<string, LanguageAnalysisDependency>();
  const add = (candidate: string): void => {
    const resolved = resolve(candidate);
    if (resolved === entry || dependencies.has(resolved)) return;
    dependencies.set(resolved, languageAnalysisDependency(resolved));
  };
  const inspect = (candidateSource: string, candidateFileName: string): void => {
    try {
      const program = parse(lex(candidateSource, candidateFileName), candidateFileName);
      addForeignAnalysisDependencies(program, candidateFileName, [], add);
    } catch {
      // The original diagnostic remains authoritative.
    }
  };
  inspect(source, fileName);
  try {
    const sourceProgram = parse(lex(source, fileName), fileName);
    const project = prepareProject(fileName);
    if (project.manifestPath) add(project.manifestPath);
    if (project.generatedBuild) add(project.generatedBuild.fileName);
    const batch = loadSourceModuleBatch(source, sourceProgram, fileName, {
      sourceImports: project.sourceImports,
      packages: project.packages,
      generatedModulePackages: project.generatedModulePackages,
      generatedCallAdapters: project.generatedBuild?.callAdapters,
    });
    for (const module of batch.modules) {
      add(module.fileName);
      addForeignAnalysisDependencies(
        module.program,
        module.fileName,
        project.includeDirectories,
        add,
      );
    }
  } catch {
    // A parse/module failure is already represented by the primary diagnostic.
  }
  if (error instanceof DiagnosticError) {
    const diagnosticFileName = resolve(error.fileName);
    if (
      diagnosticFileName !== entry
      && diagnosticFileName.endsWith(".zs")
      && existsSync(diagnosticFileName)
    ) {
      add(diagnosticFileName);
      inspect(readFileSync(diagnosticFileName, "utf8"), diagnosticFileName);
    }
  }
  let directory = dirname(entry);
  while (true) {
    const manifest = resolve(directory, "z.json");
    if (existsSync(manifest)) {
      add(manifest);
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return [...dependencies.values()];
}

function languageAnalysisDependenciesAreCurrent(
  dependencies: readonly LanguageAnalysisDependency[],
): boolean {
  return dependencies.every((dependency) => {
    try {
      const status = statSync(dependency.fileName);
      return dependency.exists
        && status.size === dependency.size
        && status.mtimeMs === dependency.modified;
    } catch {
      return !dependency.exists;
    }
  });
}

function cacheLanguageAnalysis(key: string, entry: LanguageAnalysisCacheEntry): void {
  languageAnalysisCache.delete(key);
  languageAnalysisCache.set(key, entry);
  while (languageAnalysisCache.size > maximumCachedLanguageAnalyses) {
    const oldest = languageAnalysisCache.keys().next().value;
    if (oldest === undefined) break;
    languageAnalysisCache.delete(oldest);
  }
}

function cacheImportLanguageAnalysis(key: string, entry: LanguageAnalysisCacheEntry): void {
  importLanguageAnalysisCache.delete(key);
  importLanguageAnalysisCache.set(key, entry);
  while (importLanguageAnalysisCache.size > maximumLastSuccessfulLanguageAnalyses) {
    const oldest = importLanguageAnalysisCache.keys().next().value;
    if (oldest === undefined) break;
    importLanguageAnalysisCache.delete(oldest);
  }
}

function rememberSuccessfulLanguageAnalysis(
  key: string,
  source: string,
  analysis: AnalyzedSource,
): void {
  lastSuccessfulLanguageAnalyses.delete(key);
  lastSuccessfulLanguageAnalyses.set(key, { source, analysis });
  while (lastSuccessfulLanguageAnalyses.size > maximumLastSuccessfulLanguageAnalyses) {
    const oldest = lastSuccessfulLanguageAnalyses.keys().next().value;
    if (oldest === undefined) break;
    lastSuccessfulLanguageAnalyses.delete(oldest);
  }
}

function lastSuccessfulLanguageAnalysis(
  source: string,
  fileName: string,
): AnalyzedSource | null {
  const key = languageAnalysisKey(fileName);
  const cached = lastSuccessfulLanguageAnalyses.get(key);
  if (!cached || cached.source !== source) return null;
  lastSuccessfulLanguageAnalyses.delete(key);
  lastSuccessfulLanguageAnalyses.set(key, cached);
  return cached.analysis;
}

function languageAnalysis(source: string, fileName: string): AnalyzedSource {
  const key = languageAnalysisKey(fileName);
  const cached = languageAnalysisCache.get(key);
  if (cached?.source === source) {
    languageAnalysisCache.delete(key);
    languageAnalysisCache.set(key, cached);
    if (cached.analysis && languageAnalysisDependenciesAreCurrent(cached.dependencies)) {
      return cached.analysis;
    }
    if (
      !cached.analysis
      && languageAnalysisDependenciesAreCurrent(cached.dependencies)
    ) {
      throw cached.error;
    }
  }
  try {
    const analysis = analyzeSource(source, fileName, {
      requireMain: false,
      deferUnsupportedRawSymbolValidation: true,
    });
    cacheLanguageAnalysis(key, {
      source,
      analysis,
      error: null,
      dependencies: languageAnalysisDependencies(analysis, fileName),
    });
    rememberSuccessfulLanguageAnalysis(key, source, analysis);
    return analysis;
  } catch (error) {
    cacheLanguageAnalysis(key, {
      source,
      analysis: null,
      error,
      dependencies: failedLanguageAnalysisDependencies(source, fileName, error),
    });
    throw error;
  }
}

const declarationKeywordTokens = [
  "declare", "module", "export", "function", "type", "copy", "in", "inout", "out", "move", "deinit",
  "async", "callback", "context", "thread", "caller", "any", "transfer", "share", "fixed", "throws", "success", "failure",
  "owned", "borrowed", "invalidates", "lifetime",
  "connection", "option", "owner", "target", "project", "data", "length", "from", "return", "throw", "invoked", "once", "repeatedly",
  "discriminant", "variant", "member", "when", "fallback",
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
    return languageAnalysis(source, fileName).semanticInfo.warnings
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
  const memberSuffix = before.match(/([A-Za-z_][A-Za-z0-9_]*)?$/)?.[1] ?? "";
  const memberDot = offset - memberSuffix.length - 1;
  const memberReceiver = source[memberDot] === "."
    ? memberReceiverBeforeDot(source, memberDot)
    : null;
  if (memberReceiver) {
    return memberCompletions(
      source,
      fileName,
      offset,
      memberReceiver.text,
      memberSuffix,
      memberReceiver.start,
      memberDot,
    );
  }
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
  "keyword",
  "modifier",
  "typeParameter",
] as const;

export const semanticTokenModifiers = ["declaration", "readonly", "defaultLibrary"] as const;

export function semanticTokens(source: string, fileName: string): { readonly data: number[] } {
  const context = safeAnalysis(source, fileName)
    ?? lastSuccessfulLanguageAnalysis(source, fileName);
  if (!context) return syntacticSemanticTokens(source, fileName);
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
  const sourceTypeParameterNames = new Set([
    ...context.sourceProgram.functions.flatMap((declaration) => declaration.typeParameters ?? []),
    ...context.sourceProgram.structs.flatMap((declaration) => [
      ...(declaration.typeParameters ?? []),
      ...declaration.methods.flatMap((method) => method.typeParameters ?? []),
    ]),
    ...context.sourceProgram.traits.flatMap((declaration) => [
      ...(declaration.typeParameters ?? []),
      ...declaration.methods.flatMap((method) => method.typeParameters ?? []),
    ]),
  ]);
  const enumVariantDeclarations = new Set(
    context.sourceProgram.enums.flatMap((declaration) => declaration.variants.map((variant) => variant.location.offset)),
  );
  const matchArmInfos = collectMatchArmInfos(context, bindings);
  const matchVariants = new Set(
    matchArmInfos.filter((item) => item.variantName !== "_").map((item) => item.variantOffset),
  );
  const matchWildcards = new Set(
    matchArmInfos.filter((item) => item.variantName === "_").map((item) => item.variantOffset),
  );
  const modules = new Map([...context.foreignModules.keys()].map((name) => [name, context.foreignModules.get(name)!]));
  const nativeNamespaceBindings = foreignNamespaceBindings(context);
  const nativeSelectiveBindings = foreignSelectiveBindings(context);
  const localNamespaces = new Map(
    context.sourceProgram.imports
      .map((declaration) => [declaration.moduleName, localSourceModule(context, declaration)] as const)
      .filter((entry): entry is [string, SourceModuleInfo] => Boolean(entry[0] && entry[1])),
  );
  const localBindings = new Map(
    context.sourceProgram.imports
      .filter((declaration) => declaration.bindings)
      .flatMap((declaration) => declaration.bindings!.map((binding) => [binding.localName, {
        module: localSourceModule(context, declaration),
        importedName: binding.importedName,
      }] as const))
      .filter((entry): entry is [string, { module: SourceModuleInfo; importedName: string }] => Boolean(entry[1].module)),
  );
  const importedBindingDeclarations = new Map<number, (typeof semanticTokenTypes)[number]>();
  for (const declaration of context.sourceProgram.imports) {
    for (const binding of declaration.bindings ?? []) {
      const sourceModule = localSourceModule(context, declaration);
      if (sourceModule) {
        importedBindingDeclarations.set(
          binding.location.offset,
          sourceExportTokenType(sourceModule, binding.importedName),
        );
        continue;
      }
      const foreignModule = context.foreignModules.get(declaration.moduleName);
      const tokenType = foreignModule
        ? foreignModuleMemberTokenType(foreignModule, binding.importedName)
        : null;
      if (tokenType) importedBindingDeclarations.set(binding.location.offset, tokenType);
    }
  }
  const consoleBindings = context.semanticInfo.consoleBindings;
  const tokens = lex(source, fileName);
  const objcArgumentLabels = new Map(
    collectObjCArgumentLabelInfos(context, tokens)
      .map((info) => [info.offset, info] as const),
  );
  const arrayDiscardOffsets = new Set<number>();
  const collectArrayDiscards = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collectArrayDiscards(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.kind === "destructure" && Array.isArray(node.arrayBindings)) {
      for (const binding of node.arrayBindings as Array<{
        readonly kind: string;
        readonly location: SourceLocation;
      }>) {
        if (binding.kind === "discard") arrayDiscardOffsets.add(binding.location.offset);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "location" && key !== "nameLocation" && key !== "bindingLocation") {
        collectArrayDiscards(child);
      }
    }
  };
  collectArrayDiscards(context.sourceProgram);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (
      token.kind === "question"
      && previous?.kind === "identifier"
      && next?.kind === "colon"
      && fieldDeclarations.has(previous.location.offset)
    ) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("keyword"),
        modifiers: 0,
      });
      continue;
    }
    const keywordMember = previous?.kind === "dot" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.text);
    const reservedModifier = token.kind !== "identifier"
      && sourceModifierTokens.some((modifier) => modifier === token.text);
    if (reservedModifier && !keywordMember) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("modifier"),
        modifiers: 0,
      });
      continue;
    }
    const reservedKeyword = token.kind !== "identifier"
      && sourceKeywordTokens.some((keyword) => keyword === token.text);
    if (reservedKeyword && !keywordMember) {
      if (sourceDeclarationKeywordTokens.some((keyword) => keyword === token.text)) continue;
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("keyword"),
        modifiers: 0,
      });
      continue;
    }
    if (token.kind !== "identifier" && !keywordMember) continue;
    if (token.text === "_" && arrayDiscardOffsets.has(token.location.offset)) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("keyword"),
        modifiers: 0,
      });
      continue;
    }
    if (token.text === "this" || (token.text === "super" && next?.kind === "dot" && sourceAggregateAtOffset(context, token.location.offset)?.nativeBase)) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("keyword"),
        modifiers: 0,
      });
      continue;
    }
    const contextualTypeDeclaration = token.text === "type"
      && next?.kind === "identifier"
      && tokens[index + 2]?.kind === "equal";
    const contextualTestDeclaration = token.text === "test" && next?.kind === "string";
    const contextualRawBoundary = token.text === "raw"
      && next?.kind === "identifier"
      && (next.text === "c" || next.text === "cpp" || next.text === "objc");
    const contextualNativeLanguage = (token.text === "c" || token.text === "cpp" || token.text === "objc")
      && (previous?.text === "raw" || previous?.kind === "export");
    const contextualNativeSubclass = !keywordMember && (
      (token.text === "extends" && next?.kind === "identifier" && previous?.kind === "identifier")
      || (token.text === "override" && (next?.kind === "function" || next?.kind === "async" || next?.kind === "static"))
    );
    if (
      contextualTypeDeclaration
      || contextualTestDeclaration
      || contextualRawBoundary
      || contextualNativeLanguage
      || contextualNativeSubclass
    ) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("keyword"),
        modifiers: 0,
      });
      continue;
    }
    const callableAliasParameter = next?.kind === "colon"
      && /(?:^|\n)\s*(?:(?:export|internal)\s+)?type\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:async\s+)?\([^;]*$/.test(
        source.slice(Math.max(0, token.location.offset - 1000), token.location.offset),
      );
    if (callableAliasParameter) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("parameter"),
        modifiers: 1,
      });
      continue;
    }
    const contextualTask = token.text === "task"
      && (next?.kind === "on" || next?.kind === "identifier");
    const contextualOwnership = (token.text === "copy" || token.text === "move" || token.text === "view")
      && (next?.kind === "identifier" || next?.kind === "ellipsis");
    const contextualCapture = token.text === "move"
      && next?.kind === "leftParen"
      && /\bmove\s*\([^)]*\)\s*(?:(?::|throws\b)[^=]*)?=>/.test(source.slice(token.location.offset));
    if (contextualTask || contextualOwnership || contextualCapture) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf(contextualCapture ? "modifier" : "keyword"),
        modifiers: 0,
      });
      continue;
    }
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
    const enumVariantMember = previous?.kind === "dot"
      && (() => {
        const owner = tokens[index - 2]?.text;
        if (!owner) return false;
        const declaration = [...context.sourceProgram.enums, ...context.program.enums]
          .find((candidate) => candidate.name === owner);
        return Boolean(declaration?.variants.some((variant) => variant.name === token.text));
      })();
    if (matchWildcards.has(token.location.offset)) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("keyword"),
        modifiers: 0,
      });
      continue;
    }
    if (
      enumVariantDeclarations.has(token.location.offset)
      || matchVariants.has(token.location.offset)
      || optionVariantMember
      || enumVariantMember
    ) {
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
    const binding = namedBindings.filter((candidate) => candidate.offset <= token.location.offset).at(-1);
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
    if (context.semanticInfo.memoryReplaceBindings.has(token.text)) {
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
    const importedBindingDeclaration = importedBindingDeclarations.get(token.location.offset);
    if (importedBindingDeclaration) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf(importedBindingDeclaration),
        modifiers: 4,
      });
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
    const nativeImport = nativeSelectiveBindings.get(token.text);
    if (nativeImport) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf(nativeImport.tokenType),
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
      const embeddedType = owner === "embed" && token.text === "StaticBytes";
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf(
          standardType || embeddedType
            ? "type"
            : objcType
              ? "class"
              : owner === "thread" && (token.text === "main" || token.text === "any")
                ? "property"
                : "method",
        ),
        modifiers: owner === "thread" && (token.text === "main" || token.text === "any") ? 6 : 4,
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
    if (sourceTypeParameterNames.has(token.text)) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("typeParameter"),
        modifiers: 0,
      });
      continue;
    }
    if (primitiveTypeTokens.some((primitive) => primitive === token.text)) {
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
  const context = safeAnalysis(source, fileName)
    ?? lastSuccessfulLanguageAnalysis(source, fileName);
  if (!context) return syntacticHover(source, fileName, word.text, word.start, word.end);
  const nativeOwner = sourceAggregateAtOffset(context, word.start);
  if (nativeOwner?.nativeBase && ["extends", "override", "super"].includes(word.text)) {
    const details = {
      extends: `extends ${nativeOwner.nativeBase.name}  // real Objective-C subclass identity, managed by native ARC`,
      override: "override function  // compiler-checked inherited Objective-C selector and ABI; native entry requires thread.main\n// calls the superclass during construction and destruction, not the Z override body\n// ready entry permits nested in this reads; reentry conflicting with inout this traps",
      super: `super: ${nativeOwner.nativeBase.name}  // calls the superclass implementation on this same native object`,
    };
    return markdownHover(details[word.text as keyof typeof details], source, word.start, word.end);
  }
  const nativeClass = context.sourceProgram.structs.find((declaration) => declaration.nativeBase && declaration.name === word.text);
  if (nativeClass?.nativeBase) return markdownHover(`class ${nativeClass.name} extends ${nativeClass.nativeBase.name} on thread.main\n// native Objective-C ARC identity with private inline stored fields\n// Z overrides become active after constructor cleanup; construction and destruction call the superclass\n// deinit runs before automatic field cleanup; stored field access stays inside the guarded receiver body`, source, word.start, word.end);
  const immediateMemberOwner = source.slice(0, word.start)
    .match(/([A-Za-z_][A-Za-z0-9_]*(?:<[^<>]+>)?)\.$/)?.[1];
  const immediateChannel = immediateMemberOwner
    ? channelTypeFromSourceSpelling(context, immediateMemberOwner)
    : null;
  if (immediateChannel?.kind === "factory") {
    const detail = channelMemberDetail(immediateChannel, word.text, context.typeDisplayNames);
    if (detail) return markdownHover(detail, source, word.start, word.end);
  }
  const sourceBindings = collectBindings(context);
  const directBinding = sourceBindings
    .filter((candidate) => (
      candidate.name === word.text
      && candidate.offset <= word.start
      && (!candidate.fileName || resolve(candidate.fileName) === resolve(fileName))
    ))
    .sort((left, right) => left.offset - right.offset)
    .at(-1);
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
  if (word.text === "internal") {
    return markdownHover(
      "internal  // visible only inside the exact manifest package; omitted from downstream imports, completion, and callable metadata",
      source,
      word.start,
      word.end,
    );
  }
  const typeParameter = sourceTypeParameterHover(context, word.text, word.start);
  if (typeParameter) return markdownHover(typeParameter, source, word.start, word.end);
  const callableParameter = sourceCallableAliasParameterHover(context, source, word.text, word.start);
  if (callableParameter) return markdownHover(callableParameter, source, word.start, word.end);
  if (word.text === "instanceof") {
    return markdownHover(
      "value instanceof NativeClass  // runtime Objective-C class check; the true branch narrows the value to NativeClass",
      source,
      word.start,
      word.end,
    );
  }
  if (
    word.text === "move"
    && /^\s+this\b/.test(source.slice(word.end))
  ) {
    return markdownHover(
      "move this  // consumes this value-struct receiver; the caller binding is unavailable after the call",
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
  const numericConversion = conversionSuffix
    ? context.semanticInfo.numericConversions.get(word.end + conversionSuffix.lastIndexOf("("))
    : undefined;
  if (numericConversion) {
    return markdownHover(numericConversionHover(numericConversion), source, word.start, word.end);
  }
  if (primitiveTypeTokens.some((primitive) => primitive === word.text)) {
    return markdownHover(primitiveTypeHover(word.text), source, word.start, word.end);
  }
  const directWordType = context.semanticInfo.bindingTypes.get(word.start)
    ?? context.semanticInfo.numericLiteralTypes.get(word.start)
    ?? context.semanticInfo.expressionTypes.get(word.start)
    ?? directBinding?.type;
  const moduleConstant = context.sourceProgram.constants.find((declaration) => (
    declaration.name === word.text
    && (
      declaration.nameLocation.offset === word.start
      || context.semanticInfo.moduleConstantReferences.get(word.start)
        === declaration.name
    )
  ));
  if (moduleConstant) {
    const type = context.semanticInfo.bindingTypes.get(
      moduleConstant.nameLocation.offset
    ) ?? moduleConstant.type?.name ?? "unknown";
    const affinity = onceExecutorAffinity(type, context);
    return markdownHover(
      `const ${moduleConstant.name}: ${displayServiceType(type, context)}${executorAffinityHover(affinity)}`,
      source,
      word.start,
      word.end,
    );
  }

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
    const operand = ownershipOperandBinding(source, word.end, sourceBindings, fileName);
    if (operand) {
      const type = displayServiceType(operand.type, context);
      return markdownHover(
        `copy ${type} -> ${type}\n// explicitly duplicates the value; the source remains available\n// the concrete specialization must prove Copy support`,
        source,
        word.start,
        word.end,
      );
    }
  }
  if (
    word.text === "move"
    && /^\s+[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(word.end))
  ) {
    const type = context.semanticInfo.expressionTypes.get(word.start)
      ?? ownershipOperandBinding(source, word.end, sourceBindings, fileName)?.type;
    if (type) return markdownHover(explicitMoveHover(type, context), source, word.start, word.end);
  }
  if (
    word.text === "view"
    && /^\s+[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(word.end))
  ) {
    const rawType = context.semanticInfo.expressionTypes.get(word.start)
      ?? ownershipOperandBinding(source, word.end, sourceBindings, fileName)?.type;
    if (!rawType) return null;
    const type = displayType(rawType, context.typeDisplayNames);
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
    return markdownHover(
      `${fieldDetail(declaredField, context.typeDisplayNames, true)}${executorBoundClassTransportHover(
        declaredField.type.name,
        context,
      )}`,
      source,
      word.start,
      word.end,
    );
  }
  const declaredVariant = context.sourceProgram.enums.flatMap((declaration) => (
    declaration.variants.map((variant) => ({ declaration, variant }))
  )).find(({ variant }) => (
    variant.location.offset === word.start && variant.name === word.text
  ));
  if (declaredVariant) {
    const payload = declaredVariant.variant.payload
      ? `(${displayType(declaredVariant.variant.payload.name, context.typeDisplayNames)})`
      : "";
    return markdownHover(
      `${declaredVariant.declaration.name}.${declaredVariant.variant.name}${payload}`,
      source,
      word.start,
      word.end,
    );
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
    if (matchVariant.variantName === "_") {
      return markdownHover(
        `_  // wildcard match arm; matches every remaining case`,
        source,
        word.start,
        word.end,
      );
    }
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
    !declaration.bindings
    && declaration.moduleName === word.text
    && localSourceModule(context, declaration)
  ));
  const sourceNamespaceShadowed = sourceNameIsShadowed(context, word.text, word.start, fileName);
  if (sourceNamespace && !sourceNamespaceShadowed) {
    return markdownHover(`import ${word.text} from ${JSON.stringify(sourceNamespace.header)}  // Z module`, source, word.start, word.end);
  }
  const sourceBinding = localSourceBinding(context, word.text);
  if (
    sourceBinding
    && !sourceNameIsShadowed(context, word.text, word.start, fileName)
  ) {
    const detail = sourceExportDetail(
      sourceBinding.module,
      sourceBinding.importedName,
      context.typeDisplayNames,
      sourceBinding.localName,
    );
    return sourceImportHover(detail, sourceBinding, source, word.start, word.end);
  }
  const importedBindingDeclaration = context.sourceProgram.imports
    .flatMap((declaration) => (declaration.bindings ?? []).map((binding) => ({ declaration, binding })))
    .find(({ binding }) => binding.location.offset === word.start);
  if (importedBindingDeclaration) {
    const sourceModule = localSourceModule(context, importedBindingDeclaration.declaration);
    if (sourceModule) {
      const detail = sourceExportDetail(
        sourceModule,
        importedBindingDeclaration.binding.importedName,
        context.typeDisplayNames,
      );
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
    const foreignModule = context.foreignModules.get(importedBindingDeclaration.declaration.moduleName);
    const detail = foreignModule
      ? describeModuleMember(foreignModule, [], importedBindingDeclaration.binding.importedName)
      : null;
    if (detail) return markdownHover(detail, source, word.start, word.end);
  }
  const nativeBinding = foreignSelectiveBindings(context).get(word.text);
  if (nativeBinding && !sourceNameIsShadowed(context, word.text, word.start, fileName)) {
    const detail = describeModuleMember(nativeBinding.module, [], nativeBinding.importedName);
    if (detail) return markdownHover(detail, source, word.start, word.end);
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
  if (context.semanticInfo.memoryReplaceBindings.has(word.text)) {
    return markdownHover(
      `${word.text}<T>(inout target: T, replacement: T): T  // transfers the previous owner out and leaves target initialized`,
      source,
      word.start,
      word.end,
    );
  }
  const testBinding = context.semanticInfo.testBindings.get(word.text);
  if (testBinding === "expect") {
    return markdownHover("expect<T>(value: in T): Expectation<T>  // borrows for one expectation statement", source, word.start, word.end);
  }
  if (testBinding === "fail") {
    return markdownHover("fail(message: in String): void  // ends the current test with a cleanup-preserving failure", source, word.start, word.end);
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
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "Once") {
    return markdownHover("Once<T>()  // synchronized one-time root for a main-lifecycle class; state() and get() work on any Z-managed thread", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "OnceLifetime") {
    return markdownHover("OnceLifetime<T>  // move-only guard for one initialized Once<T> interval", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "OnceState") {
    return markdownHover("enum OnceState { empty, initialized, closed }  // synchronized Once<T> lifecycle snapshot", source, word.start, word.end);
  }
  if (context.semanticInfo.standardTypeBindings.get(word.text) === "Mutex") {
    return markdownHover(
      "Mutex<T>(value: T): Mutex<T>  // move-only handle to retained synchronized storage with a synchronous scoped lock; safely shareable when T is thread-transferable",
      source,
      word.start,
      word.end,
    );
  }
  const channelType = context.semanticInfo.standardTypeBindings.get(word.text);
  if (channelType === "Channel") {
    return markdownHover("Channel<T>  // bounded MPSC channel factory with split async endpoints", source, word.start, word.end);
  }
  if (channelType === "Sender") {
    return markdownHover("Sender<T>  // shareable asynchronous sending endpoint", source, word.start, word.end);
  }
  if (channelType === "Receiver") {
    return markdownHover("Receiver<T>  // unique asynchronous receiving endpoint", source, word.start, word.end);
  }
  if (channelType === "SyncSender") {
    return markdownHover("SyncSender<T>  // shareable blocking sending endpoint", source, word.start, word.end);
  }
  if (channelType === "SyncReceiver") {
    return markdownHover("SyncReceiver<T>  // unique blocking receiving endpoint", source, word.start, word.end);
  }
  if (channelType === "ChannelClosed") {
    return markdownHover("ChannelClosed<T>  // typed send failure that preserves ownership of the unsent value", source, word.start, word.end);
  }
  if (word.text === "next") {
    const receiver = source.slice(0, word.start).match(/([A-Za-z_][A-Za-z0-9_]*)\.$/)?.[1];
    const binding = receiver
      ? sourceBindings.filter((candidate) => candidate.name === receiver && candidate.offset < word.start).at(-1)
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
    if (chainedCall.bridge === "dataCopy" || chainedCall.bridge === "dataBorrow") {
      const declaration = [...context.semanticInfo.foreignInterfaces.values()]
        .find((candidate) => candidate.className === "NSData");
      const typeName = declaration?.typeName ?? "Foundation.NSData";
      return chainedCall.bridge === "dataCopy"
        ? objCDataCopyHover(typeName, source, word.start, word.end)
        : objCDataBorrowHover(typeName, source, word.start, word.end);
    }
    const declaration = [...context.semanticInfo.foreignInterfaces.values()]
      .find((candidate) => candidate.className === chainedCall.className);
    const protocol = [...context.semanticInfo.foreignProtocols.values()]
      .find((candidate) => `id<${candidate.protocolName}>` === chainedCall.className);
    const protocolMethod = protocol
      ? uniqueObjCProtocolRequirements([protocol], context.semanticInfo.foreignProtocols)
        .find((candidate) => candidate.selector === chainedCall.selector)
      : null;
    const method = chainedCall.async?.method
      ?? declaration?.methods.find((candidate) => (
        candidate.selector === chainedCall.selector
        && candidate.instance === chainedCall.instance
      ))
      ?? protocolMethod;
    if (method) {
      return objCMethodHover(
        method,
        declaration
          ? foreignObjCRequiresMain(declaration, context)
          : protocol?.metadata.executorAffinity === "main",
        source,
        word.start,
        word.end,
      );
    }
  }

  // Generic type syntax can place the namespace immediately after `<`, which
  // is intentionally outside the expression receiver grammar. Preserve native
  // type/protocol hover by recognizing the adjacent imported namespace.
  const adjacentPrefix = source.slice(0, word.start);
  const adjacentMatch = adjacentPrefix.match(/([A-Za-z_][A-Za-z0-9_]*)\.$/);
  const adjacentNamespace = adjacentMatch
    && adjacentPrefix.slice(0, adjacentMatch.index).trimEnd().endsWith("<")
    ? adjacentMatch[1]
    : null;
  const adjacentModule = adjacentNamespace
    && !sourceNameIsShadowed(context, adjacentNamespace, word.start, fileName)
    ? context.foreignModules.get(adjacentNamespace)
    : null;
  if (adjacentModule) {
    const detail = describeModuleMember(adjacentModule, [], word.text);
    if (detail) return markdownHover(detail, source, word.start, word.end);
  }

  const memberReceiver = memberReceiverBeforeMember(source, word.start);
  if (memberReceiver) {
    const memberText = memberReceiver.text;
    if (memberText === "Option" || /^Option<[^<>]+>$/.test(memberText)) {
      const explicit = memberText.startsWith("Option<") ? memberText.slice(7, -1) : "T";
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
    const sourceEnum = sourceEnumForType(context, memberText);
    const sourceVariant = sourceEnum?.variants.find((variant) => variant.name === word.text);
    if (sourceEnum && sourceVariant) {
      const payload = sourceVariant.payload
        ? `(value: ${displayType(sourceVariant.payload.name, context.typeDisplayNames)})`
        : "";
      return markdownHover(
        `${word.text}${payload}: ${memberText}`,
        source,
        word.start,
        word.end,
      );
    }
    const staticChannel = channelTypeFromSourceSpelling(context, memberText);
    if (staticChannel?.kind === "factory") {
      const detail = channelMemberDetail(staticChannel, word.text, context.typeDisplayNames);
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
    if (context.semanticInfo.consoleBindings.has(memberText)) {
      const detail = consoleMethodDetail(word.text);
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
    const standardOwner = context.semanticInfo.standardModuleBindings.get(memberText);
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
    if (standardOwner === "thread" && word.text === "any") {
      return markdownHover(
        "thread.any: CallableThread  // callable may be invoked concurrently on arbitrary registered threads; does not schedule or hop",
        source,
        word.start,
        word.end,
      );
    }
    if (standardOwner === "fs" && word.text === "Lock") {
      return markdownHover(
        "fs.Lock  // move-only exclusive interprocess filesystem lock; released on scope exit",
        source,
        word.start,
        word.end,
      );
    }
    if (standardOwner === "embed" && word.text === "bytes") {
      return markdownHover(
        "bytes(path: compile-time String): embed.StaticBytes  // embeds immutable process-lifetime file bytes",
        source,
        word.start,
        word.end,
      );
    }
    if (standardOwner === "embed" && word.text === "StaticBytes") {
      return markdownHover(
        "embed.StaticBytes  // immutable process-lifetime byte storage; cleanup-free and thread-shareable",
        source,
        word.start,
        word.end,
      );
    }
    if (standardOwner === "objc" && word.text === "pool") {
      return markdownHover(
        "pool<T, E?>(operation: () => T throws E?): T throws E?  // runs synchronously inside a lexical Objective-C autorelease pool",
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
    if (standardOwner === "objc" && word.text === "register") {
      return markdownHover(
        "register({ add: Objective-C protocol registration call, remove: matching teardown call }): objc.Registration  // installs now and unregisters exactly once during cleanup",
        source,
        word.start,
        word.end,
      );
    }
    if (standardOwner === "objc" && word.text === "adapt") {
      return markdownHover(
        "adapt<P>(controller: ZClass implements P): objc.Adapter<P>  // creates one owned, storable Objective-C protocol adapter",
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
    if (standardOwner === "objc" && word.text === "Registration") {
      return markdownHover(
        "objc.Registration  // owned add/remove Objective-C protocol registration lifetime",
        source,
        word.start,
        word.end,
      );
    }
    if (standardOwner === "objc" && word.text === "Adapter") {
      return markdownHover(
        "objc.Adapter<P>  // ARC-owned protocol carrier that retains its Z controller",
        source,
        word.start,
        word.end,
      );
    }
    if (standardOwner === "math" && word.text === "trunc") {
      return markdownHover(
        "trunc(value: f32): f32\ntrunc(value: f64): f64\n// rounds toward zero; numeric construction remains separately checked",
        source,
        word.start,
        word.end,
      );
    }
    const standardName = standardOwner ? standardModuleFunction(standardOwner, word.text) : null;
    if (standardName) {
      return markdownHover(standardFunctionDetail(word.text, standardName), source, word.start, word.end);
    }
    if (memberText === "String" && word.text === "from") {
      return markdownHover("from(value: cstring): String  // copies borrowed C bytes", source, word.start, word.end);
    }
    const foreignStaticOwner = resolveForeignValueType(context, memberText);
    const foreignStaticMethod = foreignStaticOwner?.staticMethods.find((item) => item.name === word.text);
    if (foreignStaticMethod) {
      return markdownHover(foreignCxxStaticMethodDetail(foreignStaticMethod), source, word.start, word.end);
    }
    const staticOwner = sourceAggregateForType(context, memberText);
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
    const handleModule = context.foreignModules.get(memberText);
    const handleType = handleModule ? resolveModuleHandleType(handleModule, word.text) : null;
    if (handleType) {
      return markdownHover(
        `${memberText}.${word.text}  // owned opaque native handle; deinit ${handleType.release}`,
        source,
        word.start,
        word.end,
      );
    }
    const sourceImport = context.sourceProgram.imports.find((declaration) => (
      !declaration.bindings
      && declaration.moduleName === memberText
      && localSourceModule(context, declaration)
    ));
    const sourceModule = sourceImport ? localSourceModule(context, sourceImport) : null;
    if (sourceModule?.exports.has(word.text)
      && !sourceNameIsShadowed(context, memberText, word.start, fileName)) {
      return markdownHover(sourceExportDetail(sourceModule, word.text, context.typeDisplayNames), source, word.start, word.end);
    }
    const resolved = resolveReceiver(context, memberText, memberReceiver.start);
    if (resolved?.kind === "module") {
      const declaration = resolveModuleFunction(resolved.module, resolved.namespacePath, word.text);
      if (declaration) {
        return foreignFunctionHover(declaration, resolved.module, source, word.start, word.end);
      }
      const item = describeModuleMember(resolved.module, resolved.namespacePath, word.text);
      if (item) return markdownHover(item, source, word.start, word.end);
    }
    if (resolved?.kind === "objc") {
      if (!resolved.instance && resolved.declaration.className === "NSData" && (word.text === "copy" || word.text === "borrow")) {
        return word.text === "copy"
          ? objCDataCopyHover(resolved.declaration.typeName, source, word.start, word.end)
          : objCDataBorrowHover(resolved.declaration.typeName, source, word.start, word.end);
      }
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
      const field = resolved.declaration.fields.find((item) => item.name === word.text);
      if (field) {
        const affinity = resolved.declaration.executorAffinity
          ? context.semanticInfo.aggregateExecutorAffinities.get(resolved.declaration.name)
          : context.semanticInfo.fieldExecutorAffinities.get(`${resolved.declaration.name}.${field.name}`);
        return markdownHover(
          `${fieldDetail(field, context.typeDisplayNames)}${executorAffinityHover(affinity)}${
            affinity ? "" : executorBoundClassTransportHover(field.type.name, context)
          }`,
          source,
          word.start,
          word.end,
        );
      }
      const method = resolved.declaration.methods.find((item) => item.name === word.text)
        ?? resolved.sourceDeclaration?.methods.find((item) => item.name === word.text);
      if (method) {
        const affinity = resolved.declaration.executorAffinity
          ? context.semanticInfo.aggregateExecutorAffinities.get(resolved.declaration.name)
          : undefined;
        return markdownHover(
          `${methodDetail(method, context.typeDisplayNames)}${executorAffinityHover(affinity)}`,
          source,
          word.start,
          word.end,
        );
      }
    }
    if (resolved?.kind === "trait") {
      for (const owner of resolved.declarations) {
        const method = owner.declaration.methods.find((item) => item.name === word.text);
        if (method) {
          return markdownHover(
            methodDetail(method, context.typeDisplayNames, owner.substitutions),
            source,
            word.start,
            word.end,
          );
        }
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
    if (resolved?.kind === "once") {
      const value = displayType(resolved.valueType, context.typeDisplayNames);
      const detail = word.text === "initialize"
        ? `initialize(move value: ${value}): OnceLifetime<${value}> on thread.main\n// publishes exactly once; the returned move-only guard owns the initialized interval`
        : word.text === "get"
          ? `get(): ${value}\n// synchronized retrieval from any Z-managed thread; member executor contracts still govern use`
          : word.text === "state"
            ? "state(): OnceState\n// synchronized lifecycle snapshot; do not use for general check-then-act synchronization"
          : null;
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
    if (resolved?.kind === "mutex" && word.text === "withLock") {
      const value = displayType(resolved.valueType, context.typeDisplayNames);
      return markdownHover(
        [
          `withLock<R>((in value: ${value}) => R): R`,
          `withLock<R>((inout value: ${value}) => R): R`,
          "// blocks the current OS thread; the protected borrow cannot escape or suspend",
          "// invokes this inline callback once; an explicit move closure may consume owned captures",
        ].join("\n"),
        source,
        word.start,
        word.end,
      );
    }
    if (resolved?.kind === "channel") {
      const detail = channelMemberDetail(resolved.channel, word.text, context.typeDisplayNames);
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
      const dynamic = parseDynamicArrayType(resolved.type)!;
      if (word.text === "capacity") return markdownHover("capacity: usize", source, word.start, word.end);
      if (!dynamic.readonly && word.text === "push") {
        const element = dynamic.elementType;
        return markdownHover(`push(value: ${displayType(element, context.typeDisplayNames)}): void`, source, word.start, word.end);
      }
      if (!dynamic.readonly && word.text === "clear") {
        return markdownHover(
          "clear(): void  // destroys all elements and retains capacity",
          source,
          word.start,
          word.end,
        );
      }
      if (!dynamic.readonly && word.text === "freeze") {
        return markdownHover(
          `freeze(): readonly Array<${displayType(dynamic.elementType, context.typeDisplayNames)}>  // consumes without copying`,
          source,
          word.start,
          word.end,
        );
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
      if (word.text === "appendCodePoint") {
        return markdownHover("appendCodePoint(codePoint: u32): void  // checked Unicode scalar encoded as UTF-8", source, word.start, word.end);
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
        resolved.readonly,
      );
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
    if (resolved?.kind === "set") {
      const detail = setMemberDetail(word.text, resolved.elementType, context.typeDisplayNames, resolved.readonly);
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
  }

  const type = directWordType;
  if (type) {
    const binding = directBinding;
    const owner = context.semanticInfo.viewBindingOwners.get(binding?.offset ?? word.start);
    const borrowedResource = String(type).startsWith("__z_borrowed:")
      || context.semanticInfo.foreignTypes.get(String(type))?.ownership === "borrowed";
    const provenance = owner
      ? `  // view of ${owner}`
      : borrowedResource ? "  // borrowed native resource; non-escaping" : "";
    const sourceType = binding ? sourceBindingTypeName(context.sourceProgram, binding.offset) : null;
    const aliasType = sourceType ? sourceAliasDisplayType(context, sourceType) : null;
    const affinity = onceExecutorAffinity(String(type), context)
      ?? context.semanticInfo.aggregateExecutorAffinities.get(String(type))
      ?? (sourceType ? context.semanticInfo.aggregateExecutorAffinities.get(sourceType) : undefined)
      ?? foreignTypeExecutorAffinity(type, context);
    const affinityDeclaration = context.program.structs.find((item) => (
      item.name === String(type) || item.name === sourceType
    ));
    const affinityDetail = affinityDeclaration?.kind === "class"
      && !affinityDeclaration.executorAffinity
      && affinity
      ? mixedClassLifecycleHover(affinity)
      : executorAffinityHover(affinity);
    const callable = parseFunctionType(String(type));
    const callableContract = aliasType && callable?.thread === "any"
      ? `\n// ${displayServiceType(type, context)}; callable concurrently from arbitrary registered threads`
      : aliasType && callable?.thread === "main"
        ? `\n// ${displayServiceType(type, context)}; callable only with thread.main executor proof`
        : "";
    return markdownHover(
      `${word.text}: ${aliasType ?? displayServiceType(type, context)}${provenance}${affinityDetail}${callableContract}`,
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
    const importedModule = sourceImportModuleAtOffset(
      context,
      source,
      word.start
    );
    if (importedModule) return sourceModuleLocation(importedModule);
    const memberNamespace = source.slice(0, word.start).match(/([A-Za-z_][A-Za-z0-9_]*)\.$/)?.[1];
    const namespaceImport = memberNamespace
      ? context.sourceProgram.imports.find((declaration) => (
        !declaration.bindings
        && declaration.moduleName === memberNamespace
        && localSourceModule(context, declaration)
      ))
      : null;
    const namespaceModule = namespaceImport ? localSourceModule(context, namespaceImport) : null;
    if (namespaceModule?.exports.has(word.text)) return sourceExportLocation(namespaceModule, word.text);
    const directNamespaceImport = !sourceNameIsShadowed(
      context,
      word.text,
      word.start,
      fileName,
    )
      ? context.sourceProgram.imports.find((declaration) => (
          !declaration.bindings
          && declaration.moduleName === word.text
          && localSourceModule(context, declaration)
        ))
      : null;
    const directNamespaceModule = directNamespaceImport
      ? localSourceModule(context, directNamespaceImport)
      : null;
    if (directNamespaceModule) return sourceModuleLocation(directNamespaceModule);
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

function sourceImportModuleAtOffset(
  context: AnalyzedSource,
  source: string,
  offset: number,
): SourceModuleInfo | null {
  let tokens: ReturnType<typeof lex>;
  try {
    tokens = lex(source, context.sourceModuleBatch.entryFileName);
  } catch {
    return null;
  }
  for (let importIndex = 0; importIndex < context.sourceProgram.imports.length; importIndex += 1) {
    const declaration = context.sourceProgram.imports[importIndex];
    const nextOffset = context.sourceProgram.imports[importIndex + 1]?.location.offset
      ?? source.length;
    const header = tokens.find((token) => (
      token.kind === "string"
      && token.text === declaration.header
      && token.location.offset > declaration.location.offset
      && token.location.offset < nextOffset
    ));
    if (!header) continue;
    const headerEnd = header.location.offset + declaration.header.length + 2;
    if (offset < header.location.offset || offset >= headerEnd) continue;
    return localSourceModule(context, declaration);
  }
  return null;
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
  const memberReceiver = memberReceiverBeforeMember(source, word.start);
  if (memberReceiver) {
    const resolved = resolveReceiver(context, memberReceiver.text, memberReceiver.start);
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
  const pattern = /\bimport\s*\{([^}]*)\}\s*from\s*["']std\/test["']\s*;/g;
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
    return [
      {
        label: "Arena",
        kind: completionKinds.struct,
        detail: "Arena(options?: { initialCapacity: usize })  // growable region storage",
      },
      {
        label: "replace",
        kind: completionKinds.function,
        detail: "replace<T>(inout target: T, replacement: T): T  // ownership-preserving exchange",
      },
    ];
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
  if (specifier === "std/sync") {
    return [
      {
        label: "Mutex",
        kind: completionKinds.struct,
        detail: "Mutex<T>(value: T)  // move-only handle to retained synchronized storage",
      },
      {
        label: "Once",
        kind: completionKinds.struct,
        detail: "Once<T>()  // synchronized main-lifecycle root; state() and get() are cross-thread",
      },
      {
        label: "OnceLifetime",
        kind: completionKinds.struct,
        detail: "OnceLifetime<T>  // inferred move-only initialized-interval guard",
      },
      {
        label: "OnceState",
        kind: completionKinds.enum,
        detail: "enum OnceState { empty, initialized, closed }  // synchronized lifecycle snapshot",
      },
    ];
  }
  if (specifier === "std/channel") {
    return [
      {
        label: "Channel",
        kind: completionKinds.struct,
        detail: "Channel<T>.bounded(capacity: usize)  // bounded MPSC channel factory",
      },
      {
        label: "Sender",
        kind: completionKinds.struct,
        detail: "Sender<T>  // shareable asynchronous sending endpoint",
      },
      {
        label: "Receiver",
        kind: completionKinds.struct,
        detail: "Receiver<T>  // unique asynchronous receiving endpoint",
      },
      {
        label: "SyncSender",
        kind: completionKinds.struct,
        detail: "SyncSender<T>  // shareable blocking sending endpoint",
      },
      {
        label: "SyncReceiver",
        kind: completionKinds.struct,
        detail: "SyncReceiver<T>  // unique blocking receiving endpoint",
      },
      {
        label: "ChannelClosed",
        kind: completionKinds.struct,
        detail: "ChannelClosed<T>  // typed send failure preserving the unsent value",
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
  const sourceModule = declaration ? localSourceModule(context, declaration) : null;
  if (sourceModule) {
    return visibleSourceModuleNames(context, sourceModule).map((name) => ({
      label: name,
      kind: sourceExportCompletionKind(sourceModule, name),
      detail: sourceExportDetail(sourceModule, name, context.typeDisplayNames),
    }));
  }
  const module = context.foreignModules.get(alias);
  return module ? moduleCompletions(module, "", [], true) : [];
}

type ObjectFieldShape = {
  readonly name: string;
  readonly type: string;
  readonly visibility: "public" | "internal" | "private";
  readonly defaulted?: boolean;
  readonly optional?: boolean;
};

function objectFieldCompletionDetail(field: ObjectFieldShape): string {
  if (!field.optional) return `${field.name}: ${field.type}${field.defaulted ? " (defaulted)" : ""}`;
  const payload = /^Option<(.+)>$/.exec(field.type)?.[1] ?? field.type;
  return `${field.name}?: ${payload} (optional/defaulted; accepts ${payload} or Option<${payload}>; omitted → none)`;
}

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
          .filter((field) => field.visibility !== "private" && !used.has(field.name))
          .map((field) => ({
            label: field.name,
            kind: completionKinds.field,
            detail: objectFieldCompletionDetail(field),
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
      detail: objectFieldCompletionDetail(field),
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
      const includeInternal = canAccessInternalMembers(context, aggregate.declaration);
      return aggregate.declaration.fields
        .filter((field) => field.visibility === "public" || (field.visibility === "internal" && includeInternal))
        .map((field) => ({
        name: field.name,
        type: displaySubstitutedType(field.type.name, aggregate.substitutions, context.typeDisplayNames),
        visibility: field.visibility,
        defaulted: Boolean(field.defaultValue) || Boolean(field.optional),
        optional: Boolean(field.optional),
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
      const visibility = tokens[cursor].kind === "private"
        ? "private"
        : tokens[cursor].kind === "internal"
        ? "internal"
        : "public";
      const nameIndex = tokens[cursor].kind === "private" || tokens[cursor].kind === "public" || tokens[cursor].kind === "internal"
        ? cursor + 1
        : cursor;
      const optional = tokens[nameIndex + 1]?.kind === "question";
      const colonIndex = optional ? nameIndex + 2 : nameIndex + 1;
      if (tokens[nameIndex]?.kind !== "identifier" || tokens[colonIndex]?.kind !== "colon") continue;
      let end = colonIndex + 1;
      while (tokens[end] && tokens[end].kind !== "semicolon") end += 1;
      if (!tokens[end]) continue;
      let equal = -1;
      for (let tokenIndex = nameIndex + 2; tokenIndex < end; tokenIndex += 1) {
        if (tokens[tokenIndex].kind === "equal") {
          equal = tokenIndex;
          break;
        }
      }
      const startOffset = tokens[colonIndex].location.offset + 1;
      const typeEnd = equal >= 0 ? tokens[equal].location.offset : tokens[end].location.offset;
      let fieldType = source.slice(startOffset, typeEnd).trim();
      for (const [parameter, argument] of substitutions) {
        fieldType = fieldType.replace(new RegExp(`\\b${parameter}\\b`, "g"), argument);
      }
      fields.push({
        name: tokens[nameIndex].text,
        type: optional ? `Option<${fieldType}>` : fieldType,
        visibility,
        defaulted: optional || equal >= 0,
        optional,
      });
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

function recoveredMutexBindingType(source: string, name: string, offset: number): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = source.slice(0, offset);
  const explicit = [...before.matchAll(new RegExp(
    `\\b(?:const|let)\\s+${escaped}\\s*=\\s*Mutex\\s*<\\s*([^;{}]+?)\\s*>\\s*\\(`,
    "g",
  ))].at(-1)?.[1]?.trim();
  if (explicit) return explicit;
  const constructed = [...before.matchAll(new RegExp(
    `\\b(?:const|let)\\s+${escaped}\\s*=\\s*Mutex\\s*\\(\\s*(?:move\\s+)?(?:new\\s+)?([A-Za-z_][A-Za-z0-9_.]*(?:<[^;=(){}]+>)?)\\s*\\(`,
    "g",
  ))].at(-1)?.[1]?.trim();
  if (constructed) return constructed;
  const annotated = parseMutexType(declaredBindingType(source, name, offset) ?? "");
  return annotated?.valueType ?? null;
}

function recoveredOnceBindingType(source: string, name: string, offset: number): string | null {
  const declared = declaredBindingType(source, name, offset) ?? "";
  const canonical = parseOnceType(declared);
  if (canonical) return canonical.valueType;
  const sourceGeneric = parseSourceGenericType(declared);
  return sourceGeneric?.base === "Once" && sourceGeneric.arguments.length === 1
    ? sourceGeneric.arguments[0]
    : null;
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
      if (declaration.header !== "std/text" && declaration.header !== "std/memory" && declaration.header !== "std/collections" && declaration.header !== "std/hash" && declaration.header !== "std/iteration" && declaration.header !== "std/sync" && declaration.header !== "std/channel" && declaration.header !== "std/async") continue;
      for (const binding of declaration.bindings ?? []) {
        if (binding.importedName !== "TextBuffer" && binding.importedName !== "Arena" && binding.importedName !== "replace" && binding.importedName !== "Map" && binding.importedName !== "Set" && binding.importedName !== "Hashable" && binding.importedName !== "Hasher" && binding.importedName !== "Iterator" && binding.importedName !== "Generator" && binding.importedName !== "AsyncGenerator" && binding.importedName !== "Once" && binding.importedName !== "OnceLifetime" && binding.importedName !== "OnceState" && binding.importedName !== "Mutex" && binding.importedName !== "Channel" && binding.importedName !== "Sender" && binding.importedName !== "Receiver" && binding.importedName !== "SyncSender" && binding.importedName !== "SyncReceiver" && binding.importedName !== "ChannelClosed" && binding.importedName !== "TaskScope" && binding.importedName !== "TaskControl") continue;
        const detail = binding.importedName === "TextBuffer"
          ? "move-only UTF-8 construction storage"
          : binding.importedName === "Arena"
            ? "move-only growable region storage"
            : binding.importedName === "replace"
              ? "ownership-preserving exchange"
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
                        : binding.importedName === "Once"
                          ? "synchronized one-time root with Z-managed cross-thread retrieval"
                        : binding.importedName === "OnceLifetime"
                          ? "move-only initialized-interval guard"
                        : binding.importedName === "OnceState"
                          ? "synchronized Once lifecycle snapshot"
                        : binding.importedName === "Mutex"
                          ? "move-only synchronized storage"
                        : binding.importedName === "Channel"
                          ? "bounded MPSC channel factory"
                        : binding.importedName === "Sender"
                          ? "shareable asynchronous sending endpoint"
                        : binding.importedName === "Receiver"
                          ? "unique asynchronous receiving endpoint"
                        : binding.importedName === "SyncSender"
                          ? "shareable blocking sending endpoint"
                        : binding.importedName === "SyncReceiver"
                          ? "unique blocking receiving endpoint"
                        : binding.importedName === "ChannelClosed"
                          ? "typed send failure preserving the unsent value"
                    : "mutable hash-composition state";
        builtIns.push({
          label: binding.localName,
          kind: binding.importedName === "replace"
            ? completionKinds.function
            : binding.importedName === "Hashable" || binding.importedName === "Iterator"
            ? completionKinds.interface
            : binding.importedName === "TaskScope" || binding.importedName === "TaskControl"
              ? completionKinds.class
              : binding.importedName === "OnceState"
                ? completionKinds.enum
                : completionKinds.struct,
          detail: binding.localName === binding.importedName
            ? binding.importedName === "replace"
              ? "replace<T>(inout target: T, replacement: T): T  // ownership-preserving exchange"
              : `${binding.importedName}${binding.importedName === "Hashable" || binding.importedName === "Iterator" || binding.importedName === "Generator" || binding.importedName === "AsyncGenerator" || binding.importedName === "OnceLifetime" || binding.importedName === "OnceState" || binding.importedName === "Sender" || binding.importedName === "Receiver" || binding.importedName === "SyncSender" || binding.importedName === "SyncReceiver" || binding.importedName === "ChannelClosed" || binding.importedName === "TaskScope" || binding.importedName === "TaskControl" ? "" : "()"}  // ${detail}`
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
  for (const declaration of context.sourceProgram.constants) {
    const type = context.semanticInfo.bindingTypes.get(declaration.nameLocation.offset)
      ?? declaration.type?.name
      ?? context.semanticInfo.expressionTypes.get(declaration.initializer.location.offset)
      ?? "unknown";
    items.push({
      label: declaration.name,
      kind: completionKinds.variable,
      detail: `const ${declaration.name}: ${displayServiceType(type, context)}`,
      sortText: `0-${declaration.name}`,
    });
  }
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
        Boolean(declaration.threadContract),
      ),
    });
  }
  for (const declaration of context.program.structs) {
    if (declaration.name.startsWith("__z_mono_") || declaration.name.startsWith("__z_module_")) continue;
    const affinity = context.semanticInfo.aggregateExecutorAffinities.get(declaration.name);
    const mixedClass = declaration.kind === "class"
      && !declaration.executorAffinity
      && Boolean(affinity);
    const executor = !mixedClass && (affinity || declaration.executorAffinity)
      ? " on thread.main"
      : "";
    items.push({
      label: declaration.name,
      kind: declaration.kind === "class" ? completionKinds.class : completionKinds.struct,
      detail: `${declaration.kind} ${declaration.name}${declaration.nativeBase ? ` extends ${displayType(declaration.nativeBase.name, context.typeDisplayNames)}` : ""}${executor}${
        mixedClass && affinity ? mixedClassLifecycleHover(affinity) : ""
      }`,
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
  for (const name of context.semanticInfo.memoryReplaceBindings) {
    items.push({
      label: name,
      kind: completionKinds.function,
      detail: `${name}<T>(inout target: T, replacement: T): T  // ownership-preserving exchange`,
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
        : standardType === "TaskScope" || standardType === "TaskControl"
          ? completionKinds.class
          : standardType === "OnceState"
            ? completionKinds.enum
            : completionKinds.struct,
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
                  : standardType === "Once"
                    ? "Once<T>()  // synchronized main-lifecycle root; state() and get() are cross-thread"
                  : standardType === "OnceLifetime"
                    ? "OnceLifetime<T>  // move-only initialized-interval guard"
                  : standardType === "OnceState"
                    ? "enum OnceState { empty, initialized, closed }  // synchronized lifecycle snapshot"
                  : standardType === "Mutex"
                    ? "Mutex<T>(value: T)  // move-only handle; retained when safely captured by a native worker"
                  : standardType === "Channel"
                    ? "Channel<T>.bounded(capacity: usize)  // bounded MPSC channel factory"
                  : standardType === "Sender"
                    ? "Sender<T>  // shareable asynchronous sending endpoint"
                  : standardType === "Receiver"
                    ? "Receiver<T>  // unique asynchronous receiving endpoint"
                  : standardType === "SyncSender"
                    ? "SyncSender<T>  // shareable blocking sending endpoint"
                  : standardType === "SyncReceiver"
                    ? "SyncReceiver<T>  // unique blocking receiving endpoint"
                  : standardType === "ChannelClosed"
                    ? "ChannelClosed<T>  // typed send failure preserving the unsent value"
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
  const context = safeAnalysis(sanitized, fileName) ?? importAnalysis(sanitized, fileName);
  if (!context) return null;
  let sourceProgram: Program;
  try {
    sourceProgram = parse(lex(sanitized, fileName), fileName);
  } catch {
    return null;
  }
  const owner = enclosingAggregateAt(sanitized, fileName, start, sourceProgram);
  if (!owner || owner.kind !== "class" || owner.implements.length === 0) return null;
  const protocols = owner.implements.flatMap((reference) => {
    const protocolName = parseObjCProtocolType(reference.name)?.protocol ?? reference.name;
    const protocol = context.semanticInfo.foreignProtocols.get(protocolName);
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
      detail: `${method.required ? "required" : "optional"} ${objCProtocolMethodDetail(method, context.semanticInfo.foreignProtocols)}`,
      insertText: objcProtocolMethodScaffold(method, localName, indentation, context.semanticInfo.foreignProtocols),
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
  if (/^(?:tableView|outlineView|collectionView|control|webView)$/.test(labels[0])) {
    let name = labels[1];
    name = name.replace(/For(?:TableColumn|Item|IndexPath)$/, "");
    if (labels.includes("row") && !/Row$/.test(name)) name += "Row";
    if (labels.includes("item") && !/Item$/.test(name)) name += "Item";
    return name;
  }
  return method.baseName;
}

function objCProtocolMethodDetail(
  method: ForeignObjCProtocolMethod,
  protocols: ReadonlyMap<string, ForeignObjCProtocol>,
): string {
  const parameters = method.parameters.map((parameter, index) => (
    `${parameter.type.kind === "object" || parameter.type.kind === "block" ? "in " : ""}${parameter.name ?? `argument${index + 1}`}: ${foreignProtocolParameterTypeName(parameter, protocols)}`
  ));
  return `${method.selector} — (${parameters.join(", ")}): ${foreignProtocolTypeName(method.returnType)}`;
}

function objcProtocolMethodScaffold(
  method: ForeignObjCProtocolMethod,
  localName: string,
  indentation: string,
  protocols: ReadonlyMap<string, ForeignObjCProtocol>,
): string {
  const parameters = method.parameters.map((parameter, index) => (
    `${parameter.type.kind === "object" || parameter.type.kind === "block" ? "in " : ""}${parameter.name ?? `argument${index + 1}`}: ${foreignProtocolParameterTypeName(parameter, protocols)}`
  ));
  const parameterBlock = parameters.length === 0
    ? "()"
    : `(\n${parameters.map((parameter) => `${indentation}  ${parameter}`).join(`,\n`)}\n${indentation})`;
  const result = foreignProtocolTypeName(method.returnType);
  const placeholder = result === "void" ? "" : `\n${indentation}  \${1:// TODO: return ${result}}`;
  return `function ${localName}${parameterBlock}: ${result} as ${JSON.stringify(method.selector)} {${placeholder}\n${indentation}}`;
}

function foreignProtocolParameterTypeName(
  parameter: ForeignObjCMethod["parameters"][number],
  protocols: ReadonlyMap<string, ForeignObjCProtocol>,
): string {
  if (parameter.type.kind !== "object" || parameter.type.nullable || parameter.protocols.length !== 1) {
    return foreignProtocolTypeName(parameter.type);
  }
  const matches = [...protocols.values()].filter((protocol) => (
    protocol.protocolName === parameter.protocols[0]
  ));
  return matches.length === 1 ? matches[0].typeName : foreignProtocolTypeName(parameter.type);
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
  const lifetimeNames = [...source.matchAll(/\blifetime\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g)]
    .map((match) => match[1]);
  const ownerName = [...before.matchAll(/\bexport\s+function\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].at(-1)?.[1];
  const owner = ownerName ? module?.functions.get(ownerName) : null;
  const ownerSignatures = ownerName && module
    ? foreignDeclarationNativeSignatures(module, ownerName)
    : [];
  const borrowedFactPrefix = /\bborrowed\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (borrowedFactPrefix !== undefined && "from".startsWith(borrowedFactPrefix)) {
    contextual.push({
      label: "from",
      kind: completionKinds.keyword,
      detail: "tie this borrowed native result to one immutable input owner",
      insertText: "from ",
      sortText: "0-from",
    });
  }
  const borrowedOwnerPrefix = /\bborrowed\s+from\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (borrowedOwnerPrefix !== undefined) {
    const parameters = new Map<string, ForeignType>();
    for (const signature of ownerSignatures) {
      for (const parameter of signature.parameters) {
        if (parameter.name) parameters.set(parameter.name, parameter.type);
      }
    }
    for (const [name, type] of parameters) {
      if (!name.toLowerCase().startsWith(borrowedOwnerPrefix.toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.variable,
        detail: `${foreignTypeName(type)} native owner parameter`,
        insertText: `${name};`,
        sortText: `0-${name}`,
      });
    }
    for (const name of lifetimeNames) {
      if (!name.toLowerCase().startsWith(borrowedOwnerPrefix.toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.variable,
        detail: "foreign runtime lifetime identity",
        insertText: `${name};`,
        sortText: `0-${name}`,
      });
    }
  }
  const invalidatedOwnerPrefix = /\binvalidates\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (invalidatedOwnerPrefix !== undefined) {
    const parameters = new Map<string, ForeignType>();
    for (const signature of ownerSignatures) {
      for (const parameter of signature.parameters) {
        if (parameter.name) parameters.set(parameter.name, parameter.type);
      }
    }
    for (const [name, type] of parameters) {
      if (!name.toLowerCase().startsWith(invalidatedOwnerPrefix.toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.variable,
        detail: `${foreignTypeName(type)} native owner whose outstanding views are invalidated`,
        insertText: `${name};`,
        sortText: `0-${name}`,
      });
    }
    for (const name of lifetimeNames) {
      if (!name.toLowerCase().startsWith(invalidatedOwnerPrefix.toLowerCase())) continue;
      contextual.push({
        label: name,
        kind: completionKinds.variable,
        detail: "foreign runtime lifetime invalidated by this call",
        insertText: `${name};`,
        sortText: `0-${name}`,
      });
    }
  }
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
      if (
        declaration.layout === "union"
        && !/\bdiscriminant\b/.test(lifecycleContext[0])
        && "discriminant".startsWith(lifecycleContext[2])
      ) {
        contextual.push({
          label: "discriminant",
          kind: completionKinds.keyword,
          detail: `describe checked tag-to-member matching for native union ${declaration.cName}`,
          insertText: "discriminant ",
          sortText: "0-discriminant",
        });
      }
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

  const activeTypeName = [...before.matchAll(/\bexport\s+type\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\{/g)].at(-1)?.[1];
  const activeType = activeTypeName ? module?.namedTypes.get(activeTypeName) : null;
  const fieldProjectionPrefix = /\bproject\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (activeType?.kind === "record" && fieldProjectionPrefix !== undefined) {
    for (const field of activeType.nativeFields) {
      const normalized = field.cName.replace(/\s+/g, " ").trim();
      if (!/^const (?:signed |unsigned )?char \*$/.test(normalized)
        || !field.name.toLowerCase().startsWith(fieldProjectionPrefix.toLowerCase())) continue;
      contextual.push({
        label: field.name,
        kind: completionKinds.field,
        detail: `${field.name}: ${field.cName}; project as a native-lifetime-bound text view`,
        insertText: `${field.name}: view cstring | null {\n  borrowed from ;\n}`,
        sortText: `0-${field.name}`,
      });
    }
  }
  const discriminantMemberPrefix = /\bdiscriminant\s+([A-Za-z_]*)$/.exec(before)?.[1];
  const unionMemberPrefix = /\bmember\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (activeType?.kind === "record" && activeType.layout === "union") {
    const wanted = discriminantMemberPrefix ?? unionMemberPrefix;
    if (wanted !== undefined) {
      for (const field of activeType.fields) {
        if (!field.name.toLowerCase().startsWith(wanted.toLowerCase())) continue;
        contextual.push({
          label: field.name,
          kind: completionKinds.field,
          detail: `${field.name}: ${field.typeName}; native union member`,
          insertText: discriminantMemberPrefix !== undefined ? `${field.name} {` : `${field.name};`,
          sortText: `0-${field.name}`,
        });
      }
    }
  }
  const unionTagPrefix = /\bwhen\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (module && unionTagPrefix !== undefined) {
    for (const constant of module.constants.values()) {
      if (!constant.name.toLowerCase().startsWith(unionTagPrefix.toLowerCase())) continue;
      contextual.push({
        label: constant.name,
        kind: completionKinds.enumMember,
        detail: `${foreignConstantDetail(constant)}; native union discriminator value`,
        insertText: `${constant.name};`,
        sortText: `0-${constant.name}`,
      });
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
        if (parameter.name && (parameter.type.kind === "callback" || parameter.type.kind === "block" || parameter.type.kind === "selector")) {
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
  const selectorTargetPrefix = /\bcallback\s+[A-Za-z_][A-Za-z0-9_]*\s*\{(?:[^{}]|\{[^{}]*\})*\btarget\s+([A-Za-z_]*)$/.exec(before)?.[1];
  if (selectorTargetPrefix !== undefined) {
    const candidates = new Map<string, string>();
    for (const signature of ownerSignatures) {
      for (const parameter of signature.parameters) {
        if (parameter.name && parameter.type.kind === "object") candidates.set(parameter.name, foreignTypeName(parameter.type));
      }
    }
    for (const [name, type] of candidates) {
      if (!name.toLowerCase().startsWith(selectorTargetPrefix.toLowerCase())) continue;
      contextual.push({ label: name, kind: completionKinds.variable,
        detail: `${name}: ${type}; native receiver paired with this SEL callback`, insertText: `${name};`, sortText: `0-${name}` });
    }
  }
  const selectorTypePrefix = /\btype\s*\([^;{}]*:\s*([A-Za-z_]*)$/.exec(before)?.[1];
  if (module && selectorTypePrefix !== undefined) {
    for (const declaration of module.interfaces.values()) {
      if (!declaration.exportName.toLowerCase().startsWith(selectorTypePrefix.toLowerCase())) continue;
      contextual.push({ label: declaration.exportName, kind: completionKinds.class,
        detail: `in ${declaration.exportName}: borrowed native callback object; callback shape is asserted by this contract`,
        sortText: `0-${declaration.exportName}` });
    }
  }
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

  for (const lifetime of contracts.lifetimes) {
    if (lifetime.location.offset === word.start || lifetime.nameLocation.offset === word.start) {
      return markdownHover(
        `lifetime ${lifetime.name}  // compile-time identity for native-managed borrowed storage`,
        source,
        word.start,
        word.end,
      );
    }
  }

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
    if (declaration?.kind === "record") {
      for (const projection of contract.fieldProjections) {
        if (projection.location.offset === word.start || projection.nameLocation.offset === word.start) {
          const nativeField = declaration.nativeFields.find((field) => field.name === projection.name);
          return markdownHover(
            `project ${projection.name}: ${projection.typeName}  // direct borrowed projection of ${nativeField?.cName ?? "native field"}`,
            source,
            word.start,
            word.end,
          );
        }
        if (projection.lifetimeLocation.offset === word.start) {
          return markdownHover(
            `borrowed from ${projection.lifetime}  // view ends before any call that invalidates this native lifetime`,
            source,
            word.start,
            word.end,
          );
        }
      }
    }
    if (declaration?.kind === "record" && contract.discriminant) {
      const discriminant = contract.discriminant;
      if (discriminant.location.offset === word.start) {
        return markdownHover(
          `discriminant ${discriminant.member}  // checked borrowed matching for native union ${declaration.cName}`,
          source,
          word.start,
          word.end,
        );
      }
      if (discriminant.memberLocation.offset === word.start) {
        const field = declaration.fields.find((candidate) => candidate.name === discriminant.member);
        return markdownHover(
          `${discriminant.member}: ${field?.typeName ?? "_"}  // native union tag member`,
          source,
          word.start,
          word.end,
        );
      }
      for (const variant of discriminant.variants) {
        if (variant.location.offset === word.start || variant.nameLocation.offset === word.start) {
          const payload = variant.member ? `(${variant.member})` : "";
          return markdownHover(
            `${variant.name}${payload}  // Z match variant for ${variant.values.join(" | ")}`,
            source,
            word.start,
            word.end,
          );
        }
        if (variant.member && variant.memberLocation?.offset === word.start) {
          const field = declaration.fields.find((candidate) => candidate.name === variant.member);
          return markdownHover(
            `${variant.member}: ${field?.typeName ?? "_"}  // borrowed active-union payload`,
            source,
            word.start,
            word.end,
          );
        }
        const valueIndex = variant.valueLocations.findIndex((location) => location.offset === word.start);
        if (valueIndex >= 0) {
          const constant = module.constants.get(variant.values[valueIndex]);
          return markdownHover(
            `${constant ? foreignConstantDetail(constant) : variant.values[valueIndex]}\n// selects ${variant.name}`,
            source,
            word.start,
            word.end,
          );
        }
      }
      if (discriminant.fallbackLocation.offset === word.start) {
        return markdownHover(
          `${discriminant.fallback}(type: ${declaration.fields.find((field) => field.name === discriminant.member)?.typeName ?? "_"})  // every unlisted native tag`,
          source,
          word.start,
          word.end,
        );
      }
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
          : contract.resultBorrowedFrom
            ? `borrowed from ${contract.resultBorrowedFrom}  // non-owning result remains valid only while this input owner is live`
            : "borrowed  // native runtime retains ownership; this result is lexical and non-escaping",
        source,
        word.start,
        word.end,
      );
    }
    if (contract.resultBorrowedFromLocation?.offset === word.start && contract.resultBorrowedFrom) {
      return markdownHover(
        `${contract.resultBorrowedFrom}: owner  // lifetime source for this borrowed native result`,
        source,
        word.start,
        word.end,
      );
    }
    const invalidation = contract.invalidates.find((candidate) => (
      candidate.location.offset === word.start || candidate.parameterLocation.offset === word.start
    ));
    if (invalidation) {
      const lifetime = contracts.lifetimes.some((candidate) => candidate.name === invalidation.parameter);
      return markdownHover(
        lifetime
          ? `invalidates ${invalidation.parameter}  // this native call ends every outstanding view tied to the foreign lifetime`
          : `invalidates ${invalidation.parameter}  // this native call may invalidate every outstanding view derived from the owner`,
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
      if (callback.signature) {
        const signature = `(${callback.signature.parameters.map((parameter) => `${parameter.mode === "in" ? "in " : ""}${parameter.name}: ${parameter.typeName}`).join(", ")}) => ${callback.signature.returnType} on thread.main`;
        if (callback.parameterLocation.offset === word.start || callback.signature.location.offset === word.start) {
          return markdownHover(`${callback.parameter}: ${signature}\n// SEL callback paired with target ${callback.target}; signature asserted by .zd, not encoded by SEL\n// main-thread requirement, not an automatic hop or delivery guarantee`, source, word.start, word.end);
        }
        if (callback.targetLocation?.offset === word.start) {
          return markdownHover(`${callback.target}: Objective-C object\n// native target receiving ${callback.parameter}; no closure capture or generated adapter\n// native retention and explicit invalidation still govern lifetime`, source, word.start, word.end);
        }
        const parameter = callback.signature.parameters.find((entry) => entry.typeLocation.offset === word.start || entry.location.offset === word.start);
        if (parameter) return markdownHover(`${parameter.mode === "in" ? "in " : ""}${parameter.name}: ${parameter.typeName}\n// asserted native selector callback parameter`, source, word.start, word.end);
      }
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
    !candidate.bindings
    && candidate.moduleName === namespace
    && localSourceModule(context, candidate)
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

function collectBindings(context: AnalyzedSource, includeMatchBindings = true): Binding[] {
  const bindings: Binding[] = context.sourceProgram.constants.map((declaration) => ({
    name: declaration.name,
    type: context.semanticInfo.bindingTypes.get(declaration.nameLocation.offset)
      ?? declaration.type?.name
      ?? context.semanticInfo.expressionTypes.get(declaration.initializer.location.offset)
      ?? "unknown",
    offset: declaration.nameLocation.offset,
    readonly: true,
    parameter: false,
    fileName: declaration.nameLocation.fileName,
  }));
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
        for (const binding of statement.arrayBindings ?? []) {
          if (!binding.bindingName || !binding.bindingLocation) continue;
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
  // Editor bindings must come from authored syntax. The linked/materialized
  // program intentionally removes generic declarations and may synthesize
  // constructor parameters at field locations, neither of which describes the
  // document the user is editing.
  for (const declaration of context.sourceProgram.functions) visitFunction(declaration);
  for (const declaration of context.sourceProgram.structs) {
    if (declaration.constructor) {
      for (const parameter of declaration.constructor.parameters) {
        bindings.push({
          name: parameter.name,
          type: context.semanticInfo.bindingTypes.get(parameter.location.offset) ?? parameter.type.name,
          offset: parameter.location.offset,
          readonly: parameter.mode === "value" || parameter.mode === "in",
          parameter: true,
          fileName: parameter.location.fileName,
        });
      }
      visitStatements(declaration.constructor.body);
    }
    for (const method of declaration.methods) visitFunction(method);
    if (declaration.deinitializer) visitStatements(declaration.deinitializer.body);
  }
  for (const declaration of context.sourceProgram.traits) {
    for (const method of declaration.methods) visitFunction(method);
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
  visitClosures(context.sourceProgram);
  if (includeMatchBindings) {
    for (const arm of collectMatchArmInfos(context, bindings)) {
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

function collectMatchArmInfos(
  context: AnalyzedSource,
  sourceBindings: readonly Binding[] = collectBindings(context, false),
): MatchArmInfo[] {
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
      const subject = node.expression as {
        readonly kind?: string;
        readonly name?: string;
        readonly location?: SourceLocation;
      };
      const sourceBinding = subject.kind === "identifier" && subject.name && subject.location
        ? sourceBindings
          .filter((candidate) => candidate.name === subject.name && candidate.offset <= subject.location!.offset)
          .sort((left, right) => left.offset - right.offset)
          .at(-1)
        : null;
      const inferredEnumName = (subject.location
        ? context.semanticInfo.expressionTypes.get(subject.location.offset)
        : null) ?? sourceBinding?.type ?? null;
      const enumName = inferredEnumName
        ? parseViewType(inferredEnumName)?.target ?? inferredEnumName
        : null;
      const sourceImport = enumName ? localSourceBinding(context, enumName) : null;
      const linkedEnumName = sourceImport
        ? sourceImport.module.exports.get(sourceImport.importedName)?.linkedName
          ?? sourceImport.module.internals.get(sourceImport.importedName)?.linkedName
        : null;
      const declaration = enumName
        ? context.program.enums.find((item) => item.name === enumName || item.name === linkedEnumName)
        : null;
      const foreignUnion = matchLocation === undefined
        ? null
        : context.semanticInfo.foreignUnionMatches.get(matchLocation) ?? null;
      if (enumName && (declaration || foreignUnion)) {
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
          const declaredVariant = declaration?.variants.find((item) => item.name === arm.variantName);
          const nativeVariant = foreignUnion?.variants.find((item) => item.name === arm.variantName);
          const variant = declaredVariant
            ? { payloadType: declaredVariant.payload?.name ?? null }
            : nativeVariant
              ? { payloadType: nativeVariant.payloadType }
              : arm.variantName === foreignUnion?.fallback
                ? { payloadType: foreignUnion.discriminantType }
                : arm.variantName === "_"
                  ? { payloadType: null }
                : null;
          if (!variant) continue;
          collected.push({
            variantName: arm.variantName,
            variantOffset: arm.location.offset,
            binding: arm.binding,
            bindingOffset: arm.bindingLocation?.offset ?? null,
            bindingFileName: arm.bindingLocation?.fileName,
            enumName,
            payloadType: variant.payloadType,
            borrowed: Boolean(
              borrowed
              && variant.payloadType
              && (foreignUnion || editorTypeHasCleanup(variant.payloadType, context.program)),
            ),
          });
          const payload = declaredVariant?.payload
            ? context.program.structs.find((item) => item.name === declaredVariant.payload!.name)
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
  receiverStart: number,
  receiverDot: number,
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
  if (receiverText === "OnceState") {
    return filterCompletions([
      { label: "empty", kind: completionKinds.enumMember, detail: "OnceState.empty" },
      { label: "initialized", kind: completionKinds.enumMember, detail: "OnceState.initialized" },
      { label: "closed", kind: completionKinds.enumMember, detail: "OnceState.closed" },
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
  const staticChannel = channelTypeFromSourceSpelling(importContext, receiverText);
  if (staticChannel?.kind === "factory") {
    return filterCompletions(
      channelCompletions(staticChannel, importContext.typeDisplayNames),
      prefix,
      100,
    );
  }
  if (importContext.semanticInfo.consoleBindings.has(receiverText)) {
    return filterCompletions(consoleCompletions(), prefix, 100);
  }
  const standardModule = importContext.semanticInfo.standardModuleBindings.get(receiverText);
  if (standardModule) {
    return filterCompletions(standardModuleMemberNames(standardModule).map((member) => {
      const name = standardModuleFunction(standardModule, member);
      if (standardModule === "objc" && (member === "Connection" || member === "Binding" || member === "Registration")) {
        return {
          label: member,
          kind: completionKinds.class,
          detail: member === "Connection"
            ? "owned Objective-C target/action lifetime"
            : member === "Binding"
              ? "owned Objective-C protocol-binding lifetime"
              : "owned Objective-C add/remove registration lifetime",
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
      if (standardModule === "embed" && member === "StaticBytes") {
        return {
          label: member,
          kind: completionKinds.struct,
          detail: "immutable process-lifetime byte storage",
          insertText: member,
        };
      }
      if (standardModule === "embed" && member === "bytes") {
        return {
          label: member,
          kind: completionKinds.method,
          detail: "bytes(path: compile-time String): embed.StaticBytes",
          insertText: "bytes()",
        };
      }
      if (standardModule === "math" && member === "trunc") {
        return {
          label: member,
          kind: completionKinds.method,
          detail: "trunc(value: f32): f32 | trunc(value: f64): f64  // rounds toward zero",
          insertText: "trunc()",
        };
      }
      if (standardModule === "thread" && member === "main") {
        return {
          label: member,
          kind: completionKinds.property,
          detail: "main-thread execution target",
        };
      }
      if (standardModule === "thread" && member === "any") {
        return {
          label: member,
          kind: completionKinds.property,
          detail: "arbitrary-thread callable contract; does not schedule or hop",
        };
      }
      return {
        label: member,
        kind: standardModule === "objc" && member === "Adapter"
          ? completionKinds.class
          : completionKinds.method,
        detail: standardModule === "thread" && member === "spawn"
          ? "spawn<T, E?>(operation: () => T throws E?): Task<T, E?>  // starts one native thread; sync or worker-affine async closure"
          : standardModule === "objc" && member === "pool"
            ? "pool<T, E?>(operation: () => T throws E?): T throws E?  // synchronous lexical autorelease pool"
          : standardModule === "objc" && member === "connect"
            ? "connect(control: Objective-C target/action object, operation: move () => void): objc.Connection"
            : standardModule === "objc" && member === "bind"
              ? "bind(object: Objective-C object, protocols: { property: ZController }): objc.Binding"
              : standardModule === "objc" && member === "register"
                ? "register({ add: protocol registration call, remove: teardown call }): objc.Registration"
                : standardModule === "objc" && member === "adapt"
                  ? "adapt<P>(controller: ZClass implements P): objc.Adapter<P>"
                  : standardModule === "objc" && member === "Adapter"
                    ? "objc.Adapter<P>  // owned Objective-C protocol carrier"
                : standardFunctionDetail(member, name!),
        insertText: standardModule === "objc" && member === "adapt"
          ? "adapt<>()"
          : standardModule === "objc" && member === "Adapter"
            ? "Adapter<>"
            : `${member}()`,
      };
    }), prefix, 100);
  }
  const sourceImport = importContext.sourceProgram.imports.find((declaration) => (
    !declaration.bindings
    && declaration.moduleName === receiverText
    && localSourceModule(importContext, declaration)
  ));
  const sourceModule = sourceImport ? localSourceModule(importContext, sourceImport) : null;
  if (sourceModule) {
    return filterCompletions(visibleSourceModuleNames(importContext, sourceModule).map((name) => ({
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

  const receiverOffset = receiverStart;
  const sourceBinding = localSourceBinding(importContext, receiverText);
  const sourceConstant = sourceBinding
    ? sourceExportDeclaration(sourceBinding.module, sourceBinding.importedName)
    : null;
  const sourceOnce = sourceConstant?.kind === "constant" && sourceConstant.type
    ? parseOnceType(sourceConstant.type.name)
    : null;
  const recoveredOnceValue = sourceOnce?.valueType
    ?? recoveredOnceBindingType(source, receiverText, receiverOffset);
  if (recoveredOnceValue) {
    return filterCompletions(
      onceCompletions(recoveredOnceValue, importContext.typeDisplayNames),
      prefix,
      1000,
    );
  }
  const recoveredMutex = recoveredMutexBindingType(source, receiverText, receiverOffset);
  if (recoveredMutex) {
    return filterCompletions(
      mutexCompletions(recoveredMutex, importContext.typeDisplayNames),
      prefix,
      1000,
    );
  }
  const recoveredChannel = channelTypeFromSourceSpelling(
    importContext,
    declaredBindingType(source, receiverText, receiverOffset) ?? "",
  );
  if (recoveredChannel) {
    return filterCompletions(
      channelCompletions(recoveredChannel, importContext.typeDisplayNames),
      prefix,
      1000,
    );
  }
  const fullContext = safeAnalysis(source, fileName);
  const directReceiver = fullContext ? resolveReceiver(fullContext, receiverText, receiverOffset) : null;
  if (directReceiver?.kind === "objc" && fullContext) {
    return filterCompletions(objcCompletions(directReceiver.declaration, directReceiver.instance, fullContext), prefix, 1000);
  }
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
      directReceiver.readonly,
    ), prefix, 1000);
  }
  if (directReceiver?.kind === "set") {
    return filterCompletions(setCompletions(
      directReceiver.elementType,
      importContext.typeDisplayNames,
      directReceiver.readonly,
    ), prefix, 1000);
  }
  if (directReceiver?.kind === "mutex") {
    return filterCompletions(
      mutexCompletions(directReceiver.valueType, importContext.typeDisplayNames),
      prefix,
      1000,
    );
  }
  if (directReceiver?.kind === "channel") {
    return filterCompletions(
      channelCompletions(directReceiver.channel, importContext.typeDisplayNames),
      prefix,
      1000,
    );
  }
  if (directReceiver?.kind === "trait") {
    return filterCompletions(
      traitCompletions(directReceiver.declarations, importContext.typeDisplayNames),
      prefix,
      1000,
    );
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
  const dotOffset = receiverDot;
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
        map.readonly,
      ), prefix, 1000);
    }
    const set = parseSetType(iterationBinding.type);
    if (set) {
      return filterCompletions(setCompletions(
        set.elementType,
        iterationContext.typeDisplayNames,
        set.readonly,
      ), prefix, 1000);
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
        structCompletions(aggregate, iterationContext.typeDisplayNames, false, canAccessInternalMembers(iterationContext, aggregate)),
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
      staticCompletions(staticOwner.declaration, staticContext.typeDisplayNames, staticOwner.substitutions, includePrivate, canAccessInternalMembers(staticContext, staticOwner.declaration)),
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
    for (const protocol of importContext.semanticInfo.foreignProtocols.values()) {
      for (const method of uniqueObjCProtocolRequirements([protocol], importContext.semanticInfo.foreignProtocols)) {
        if (method.baseName.startsWith(prefix) && method.parameters.length === 0) {
          methodProbes.add(method.baseName);
        }
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
          structCompletions(declaration, importContext.typeDisplayNames, includePrivate, canAccessInternalMembers(importContext, declaration), declaration),
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
      structCompletions(resolved.declaration, context.typeDisplayNames, includePrivate, canAccessInternalMembers(context, resolved.declaration), resolved.sourceDeclaration),
      prefix,
      1000,
    );
  }
  if (resolved?.kind === "trait") {
    return filterCompletions(
      traitCompletions(resolved.declarations, context.typeDisplayNames),
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
      );
      if (!dynamic.readonly) {
        items.push({
          label: "push",
          kind: completionKinds.method,
          detail: `push(value: ${displayType(dynamic.elementType, context.typeDisplayNames)}): void`,
          insertText: "push()",
        }, {
          label: "clear",
          kind: completionKinds.method,
          detail: "clear(): void  // destroys all elements and retains capacity",
          insertText: "clear()",
        }, {
          label: "freeze",
          kind: completionKinds.method,
          detail: `freeze(): readonly Array<${displayType(dynamic.elementType, context.typeDisplayNames)}>  // consumes without copying`,
          insertText: "freeze()",
        });
      }
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
      {
        label: "appendCodePoint",
        kind: completionKinds.method,
        detail: "appendCodePoint(codePoint: u32): void  // checked Unicode scalar encoded as UTF-8",
        insertText: "appendCodePoint()",
      },
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
      resolved.readonly,
    ), prefix, 1000);
  }
  if (resolved?.kind === "set") {
    return filterCompletions(setCompletions(
      resolved.elementType,
      context.typeDisplayNames,
      resolved.readonly,
    ), prefix, 1000);
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
  if (resolved?.kind === "once") {
    return filterCompletions(
      onceCompletions(resolved.valueType, context.typeDisplayNames),
      prefix,
      1000,
    );
  }
  if (resolved?.kind === "mutex") {
    return filterCompletions(
      mutexCompletions(resolved.valueType, context.typeDisplayNames),
      prefix,
      1000,
    );
  }
  if (resolved?.kind === "channel") {
    return filterCompletions(
      channelCompletions(resolved.channel, context.typeDisplayNames),
      prefix,
      1000,
    );
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
  const canonicalImporter = existsSync(importer) ? realpathSync(importer) : resolve(importer);
  const batchModule = context.sourceModuleBatch.modules.find((module) => (
    module.fileName === canonicalImporter
    || resolve(module.fileName) === resolve(importer)
  ));
  const dependency = batchModule?.dependencies.get(declaration.location.offset);
  if (dependency) {
    const canonicalDependency = existsSync(dependency) ? realpathSync(dependency) : resolve(dependency);
    const sourceModule = context.sourceModules.get(canonicalDependency)
      ?? context.sourceModules.get(dependency)
      ?? [...context.sourceModules.values()].find((module) => (
        resolve(module.fileName) === canonicalDependency
      ));
    if (sourceModule) return sourceModule;
  }
  const target = resolve(dirname(importer), declaration.header);
  const canonical = existsSync(target) ? realpathSync(target) : target;
  return context.sourceModules.get(canonical)
    ?? context.sourceModules.get(target)
    ?? [...context.sourceModules.values()].find((module) => resolve(module.fileName) === canonical)
    ?? null;
}

function visibleSourceModuleNames(
  context: AnalyzedSource,
  module: SourceModuleInfo,
): readonly string[] {
  const entry = context.sourceModuleBatch.modules.find((candidate) => (
    candidate.fileName === context.sourceModuleBatch.entryFileName
  ));
  const includeInternal = entry?.packageId !== null
    && entry?.packageId !== undefined
    && entry.packageId === module.packageId;
  return [...new Set([
    ...module.exports.keys(),
    ...(includeInternal ? module.internals.keys() : []),
  ])];
}

function canAccessInternalMembers(
  context: AnalyzedSource,
  declaration: StructDeclaration,
): boolean {
  const current = context.sourceModuleBatch.modules.find((candidate) => (
    candidate.fileName === context.sourceModuleBatch.entryFileName
  ));
  const declarationFile = declaration.location.fileName;
  if (!current?.packageId || !declarationFile) return false;
  const owner = context.sourceModuleBatch.modules.find((candidate) => (
    candidate.fileName === declarationFile || resolve(candidate.fileName) === resolve(declarationFile)
  ));
  return owner?.packageId === current.packageId;
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
  return sourceBindingInProgram(context, context.sourceProgram, localName);
}

function sourceBindingInProgram(
  context: AnalyzedSource,
  program: Program,
  localName: string,
): {
  readonly module: SourceModuleInfo;
  readonly importedName: string;
  readonly localName: string;
  readonly specifier: string;
} | null {
  for (const declaration of program.imports) {
    if (!declaration.bindings) continue;
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
  | Program["constants"][number]
  | Program["functions"][number]
  | Program["structs"][number]
  | Program["traits"][number]
  | Program["enums"][number]
  | Program["typeAliases"][number]
  | null {
  return module.program.constants.find((item) => item.name === name)
    ?? module.program.functions.find((item) => item.name === name)
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
  const access = module.internals.has(name) ? "internal " : "";
  if (!declaration) return `${access || "export "}${displayName}`;
  if (declaration.kind === "constant") {
    const type = declaration.type?.name ?? "inferred";
    const once = parseOnceType(type);
    const affinity = once
      ? sourceProgramExecutorAffinity(module.program, once.valueType)
      : undefined;
    return `${access}const ${displayName}: ${displayType(type, typeDisplayNames)}${executorAffinityHover(affinity)}`;
  }
  if (declaration.kind === "function") {
    return `${access}${zFunctionDetail(
      displayName,
      declaration.parameters,
      declaration.returnType.name,
      declaration.typeParameters,
      typeDisplayNames,
      declaration.typeParameterConstraints,
      declaration.async,
      declaration.errorType?.name,
      Boolean(declaration.executorAffinity),
      Boolean(declaration.threadContract),
    )}`;
  }
  if (declaration.kind === "struct" || declaration.kind === "class") {
    const affinity = sourceProgramExecutorAffinity(module.program, declaration.name);
    const executor = affinity && (declaration.kind !== "class" || declaration.executorAffinity)
      ? " on thread.main"
      : "";
    const affinityDetail = declaration.kind === "class"
      && !declaration.executorAffinity
      && affinity
      ? mixedClassLifecycleHover(affinity)
      : executorAffinityHover(affinity);
    return `${access}${declaration.kind} ${displayName}${formatTypeParameters(
      declaration.typeParameters ?? [],
      declaration.typeParameterConstraints ?? [],
      typeDisplayNames,
    )}${executor}${affinityDetail}`;
  }
  if (declaration.kind === "trait") {
    return `${access}trait ${displayName}${formatTypeParameters(
      declaration.typeParameters ?? [],
      declaration.typeParameterConstraints ?? [],
      typeDisplayNames,
    )}`;
  }
  if (declaration.kind === "type") {
    return `${access}type ${displayName} = ${displayType(declaration.target.name, typeDisplayNames)}`;
  }
  return `${access}${declaration.kind} ${displayName}`;
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
    if (field.executorAffinity) {
      visiting.delete(name);
      return {
        executor: "main",
        declared: false,
        originType: name,
        fieldPath: [field.name],
      };
    }
    const fieldDeclaration = program.structs.find((candidate) => (
      candidate.name === field.type.name
    ));
    if (fieldDeclaration?.kind === "class") continue;
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

function onceExecutorAffinity(
  type: string,
  context: AnalyzedSource,
): ExecutorAffinityInfo | undefined {
  const once = parseOnceType(type) ?? parseOnceLifetimeType(type);
  if (!once) return undefined;
  return context.semanticInfo.aggregateExecutorAffinities.get(once.valueType)
    ?? {
      executor: "main",
      declared: false,
      originType: once.valueType,
      fieldPath: [],
    };
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
  if (declaration?.kind === "constant") return "variable";
  if (declaration?.kind === "function") return "function";
  if (declaration?.kind === "class") return "class";
  if (declaration?.kind === "trait") return "interface";
  if (declaration?.kind === "enum") return "enum";
  return "type";
}

function sourceExportCompletionKind(module: SourceModuleInfo, name: string): number {
  const declaration = sourceExportDeclaration(module, name);
  if (declaration?.kind === "constant") return completionKinds.variable;
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

function sourceModuleLocation(module: SourceModuleInfo): Location {
  const start = { line: 0, character: 0 };
  return {
    uri: pathToFileURL(module.fileName).href,
    range: { start, end: start },
  };
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
  const probe = `${imports}\nfunction main(): i32 { return 0; }`;
  const key = languageAnalysisKey(fileName);
  const cached = importLanguageAnalysisCache.get(key);
  if (
    cached?.source === probe
    && languageAnalysisDependenciesAreCurrent(cached.dependencies)
  ) {
    importLanguageAnalysisCache.delete(key);
    importLanguageAnalysisCache.set(key, cached);
    return cached.analysis;
  }
  try {
    const analysis = analyzeSource(probe, fileName, {
      requireMain: false,
      deferUnsupportedRawSymbolValidation: true,
    });
    cacheImportLanguageAnalysis(key, {
      source: probe,
      analysis,
      error: null,
      dependencies: languageAnalysisDependencies(analysis, fileName),
    });
    return analysis;
  } catch (error) {
    cacheImportLanguageAnalysis(key, {
      source: probe,
      analysis: null,
      error,
      dependencies: failedLanguageAnalysisDependencies(probe, fileName, error),
    });
    return null;
  }
}

function safeAnalysis(source: string, fileName: string): AnalyzedSource | null {
  try {
    return languageAnalysis(source, fileName);
  } catch {
    return null;
  }
}

/**
 * Keep the document readable while semantic analysis is reporting an error.
 * This intentionally derives only facts that are present in authored syntax;
 * it must never invent a successful semantic proof for an invalid program.
 */
function syntacticSemanticTokens(source: string, fileName: string): { readonly data: number[] } {
  let tokens: ReturnType<typeof lex>;
  try {
    tokens = lex(source, fileName);
  } catch {
    return { data: [] };
  }
  let program: Program | null = null;
  try {
    program = parse(tokens, fileName);
  } catch {
    // Lexer-level classifications still survive an incomplete declaration.
  }
  const importContext = importAnalysis(source, fileName);
  const classifications = new Map<number, { readonly type: number; readonly modifiers: number }>();
  const classify = (
    offset: number,
    type: (typeof semanticTokenTypes)[number],
    modifiers = 0,
  ): void => {
    classifications.set(offset, { type: semanticTokenTypes.indexOf(type), modifiers });
  };
  const functions = new Set(program?.functions.map((item) => item.name) ?? []);
  const structs = new Set(program?.structs.filter((item) => item.kind === "struct").map((item) => item.name) ?? []);
  const classes = new Set(program?.structs.filter((item) => item.kind === "class").map((item) => item.name) ?? []);
  const traits = new Set(program?.traits.map((item) => item.name) ?? []);
  const enums = new Set(program?.enums.map((item) => item.name) ?? []);
  const aliases = new Set(program?.typeAliases.map((item) => item.name) ?? []);
  const typeParameters = new Set([
    ...(program?.functions.flatMap((item) => item.typeParameters ?? []) ?? []),
    ...(program?.structs.flatMap((item) => [
      ...(item.typeParameters ?? []),
      ...item.methods.flatMap((method) => method.typeParameters ?? []),
    ]) ?? []),
    ...(program?.traits.flatMap((item) => [
      ...(item.typeParameters ?? []),
      ...item.methods.flatMap((method) => method.typeParameters ?? []),
    ]) ?? []),
  ]);
  const fieldOffsets = new Set(program?.structs.flatMap((item) => item.fields.map((field) => field.location.offset)) ?? []);
  const readonlyFields = new Set(program?.structs.flatMap((item) => (
    item.fields.filter((field) => field.readonly).map((field) => field.location.offset)
  )) ?? []);
  const enumVariantOffsets = new Set(program?.enums.flatMap((item) => item.variants.map((variant) => variant.location.offset)) ?? []);
  const methodNames = new Set(program?.structs.flatMap((item) => item.methods.map((method) => method.name)) ?? []);
  const bindings = program ? syntacticBindings(program) : [];
  const bindingsByName = new Map<string, Binding[]>();
  for (const binding of bindings) {
    const named = bindingsByName.get(binding.name) ?? [];
    named.push(binding);
    bindingsByName.set(binding.name, named);
  }
  const namespaceImports = new Set(program?.imports.filter((item) => !item.bindings).map((item) => item.moduleName) ?? []);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const keywordMember = previous?.kind === "dot" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.text);
    if (
      token.kind !== "identifier"
      && sourceModifierTokens.some((modifier) => modifier === token.text)
      && !keywordMember
    ) {
      classify(token.location.offset, "modifier");
      continue;
    }
    if (
      token.kind !== "identifier"
      && sourceKeywordTokens.some((keyword) => keyword === token.text)
      && !keywordMember
    ) {
      // Declaration words deliberately retain their TextMate entity/storage
      // scope so themes can distinguish them from control flow.
      if (!sourceDeclarationKeywordTokens.some((keyword) => keyword === token.text)) {
        classify(token.location.offset, "keyword");
      }
      continue;
    }
    if (token.kind !== "identifier" && !keywordMember) continue;
    if (token.text === "this") {
      classify(token.location.offset, "keyword");
      continue;
    }
    const contextualOwnership = (token.text === "copy" || token.text === "move" || token.text === "view")
      && (next?.kind === "identifier" || next?.kind === "ellipsis" || next?.kind === "leftParen");
    const contextualDeclaration = token.text === "type" && next?.kind === "identifier";
    const contextualTask = token.text === "task" && (next?.kind === "identifier" || next?.kind === "on");
    if (contextualOwnership || contextualDeclaration || contextualTask || token.text === "test") {
      classify(token.location.offset, contextualOwnership && next?.kind === "leftParen" ? "modifier" : "keyword");
      continue;
    }
    if (primitiveTypeTokens.some((primitive) => primitive === token.text)) {
      classify(token.location.offset, "type", 4);
      continue;
    }
    if (token.text === "thread" && next?.kind === "dot") {
      classify(token.location.offset, "namespace", 4);
      continue;
    }
    if (previous?.kind === "dot" && tokens[index - 2]?.text === "thread" && (token.text === "main" || token.text === "any")) {
      classify(token.location.offset, "property", 6);
      continue;
    }
    if (fieldOffsets.has(token.location.offset)) {
      classify(token.location.offset, "property", 1 | (readonlyFields.has(token.location.offset) ? 2 : 0));
      continue;
    }
    if (enumVariantOffsets.has(token.location.offset)) {
      classify(token.location.offset, "enumMember", 1);
      continue;
    }
    const binding = (bindingsByName.get(token.text) ?? [])
      .filter((candidate) => candidate.offset <= token.location.offset)
      .at(-1);
    if (binding) {
      classify(
        token.location.offset,
        binding.parameter ? "parameter" : "variable",
        (binding.offset === token.location.offset ? 1 : 0) | (binding.readonly ? 2 : 0),
      );
      continue;
    }
    const sourceImport = importContext ? localSourceBinding(importContext, token.text) : null;
    if (sourceImport) {
      classify(token.location.offset, sourceExportTokenType(sourceImport.module, sourceImport.importedName), 4);
      continue;
    }
    if (importContext?.semanticInfo.standardModuleBindings.has(token.text) || namespaceImports.has(token.text)) {
      classify(token.location.offset, "namespace", 4);
      continue;
    }
    if (importContext?.semanticInfo.standardFunctionBindings.has(token.text)) {
      classify(token.location.offset, "function", 4);
      continue;
    }
    if (importContext?.semanticInfo.standardTypeBindings.has(token.text)) {
      classify(token.location.offset, "type", 4);
      continue;
    }
    if (typeParameters.has(token.text)) {
      classify(token.location.offset, "typeParameter");
      continue;
    }
    if (aliases.has(token.text) || structs.has(token.text)) {
      classify(token.location.offset, "type", previous?.text === "type" || previous?.kind === "struct" ? 1 : 0);
      continue;
    }
    if (classes.has(token.text)) {
      classify(token.location.offset, "class", previous?.kind === "class" ? 1 : 0);
      continue;
    }
    if (traits.has(token.text)) {
      classify(token.location.offset, "interface", previous?.kind === "trait" ? 1 : 0);
      continue;
    }
    if (enums.has(token.text)) {
      classify(token.location.offset, "enum", previous?.kind === "enum" ? 1 : 0);
      continue;
    }
    if (functions.has(token.text)) {
      classify(token.location.offset, "function", previous?.kind === "function" ? 1 : 0);
      continue;
    }
    if (previous?.kind === "function") {
      classify(token.location.offset, methodNames.has(token.text) ? "method" : "function", 1);
      continue;
    }
    if (previous?.kind === "struct" || previous?.kind === "class" || previous?.kind === "trait" || previous?.kind === "enum") {
      classify(token.location.offset, previous.kind === "class" ? "class" : previous.kind === "trait" ? "interface" : previous.kind === "enum" ? "enum" : "type", 1);
      continue;
    }
    if (previous?.kind === "dot") {
      classify(token.location.offset, next?.kind === "leftParen" ? "method" : "property");
      continue;
    }
    if (next?.kind === "leftParen") {
      classify(token.location.offset, "function");
      continue;
    }
    if (/^[A-Z]/.test(token.text)) classify(token.location.offset, "type");
  }

  if (fileName.endsWith(".zd")) {
    try {
      for (const contract of parseForeignDeclarationContracts(source, fileName).functions) {
        for (const callback of contract.callbacks) {
          if (!callback.signature) continue;
          classify(callback.signature.location.offset, "keyword");
          classify(callback.parameterLocation.offset, "function");
          classify(callback.signature.returnLocation.offset, "type");
          if (callback.targetLocation) {
            classify(callback.targetLocation.offset, "parameter");
            const index = tokens.findIndex((token) => token.location.offset === callback.targetLocation!.offset);
            if (tokens[index - 1]?.text === "target") classify(tokens[index - 1].location.offset, "keyword");
          }
          for (const parameter of callback.signature.parameters) {
            classify(parameter.typeLocation.offset, "type");
            const binding = tokens.find((token) => token.text === parameter.name
              && token.location.offset >= parameter.location.offset && token.location.offset < parameter.typeLocation.offset);
            if (binding) classify(binding.location.offset, "parameter", 1);
          }
        }
      }
    } catch {
      // Incomplete contracts retain lexical/TextMate highlighting while typing.
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

function syntacticBindings(program: Program): Binding[] {
  const bindings: Binding[] = [];
  const seen = new Set<number>();
  const add = (binding: Binding): void => {
    if (seen.has(binding.offset)) return;
    seen.add(binding.offset);
    bindings.push(binding);
  };
  for (const declaration of program.constants) {
    add({
      name: declaration.name,
      type: declaration.type?.name ?? syntacticExpressionType(declaration.initializer),
      offset: declaration.nameLocation.offset,
      readonly: true,
      parameter: false,
      fileName: declaration.nameLocation.fileName,
    });
  }
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, any>;
    if ((node.kind === "function" || node.kind === "constructor" || node.kind === "closure") && Array.isArray(node.parameters)) {
      for (const parameter of node.parameters) {
        add({
          name: parameter.name,
          type: parameter.type?.name ?? "unknown",
          offset: parameter.location.offset,
          readonly: parameter.mode === "value" || parameter.mode === "in",
          parameter: true,
          fileName: parameter.location.fileName,
        });
      }
    }
    if (node.kind === "variable") {
      add({
        name: node.name,
        type: node.type?.name ?? syntacticExpressionType(node.initializer),
        offset: node.nameLocation.offset,
        readonly: !node.mutable,
        parameter: false,
        fileName: node.nameLocation.fileName,
      });
    }
    if (node.kind === "destructure") {
      for (const binding of [...(node.objectBindings ?? []), ...(node.arrayBindings ?? [])]) {
        if (!binding.bindingName || !binding.bindingLocation) continue;
        add({
          name: binding.bindingName,
          type: "unknown",
          offset: binding.bindingLocation.offset,
          readonly: !node.mutable,
          parameter: false,
          fileName: binding.bindingLocation.fileName,
        });
      }
    }
    if (node.kind === "for" && node.binding && node.bindingLocation) {
      add({
        name: node.binding,
        type: "unknown",
        offset: node.bindingLocation.offset,
        readonly: true,
        parameter: false,
        fileName: node.bindingLocation.fileName,
      });
    }
    if (node.kind === "asyncScope" && node.name && node.nameLocation) {
      add({
        name: node.name,
        type: "TaskScope",
        offset: node.nameLocation.offset,
        readonly: true,
        parameter: false,
        fileName: node.nameLocation.fileName,
      });
    }
    if ((node.kind === "match" || node.kind === "matchExpression") && Array.isArray(node.arms)) {
      for (const arm of node.arms) {
        if (arm.binding && arm.bindingLocation) {
          add({
            name: arm.binding,
            type: "unknown",
            offset: arm.bindingLocation.offset,
            readonly: true,
            parameter: false,
            fileName: arm.bindingLocation.fileName,
          });
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "location" && key !== "nameLocation" && key !== "bindingLocation") visit(child);
    }
  };
  visit(program);
  return bindings.sort((left, right) => left.offset - right.offset);
}

function syntacticExpressionType(expression: any): string {
  if (!expression) return "unknown";
  if (expression.kind === "string" || expression.kind === "template") return "String";
  if (expression.kind === "boolean") return "boolean";
  if (expression.kind === "number" || expression.kind === "unary") return "i32";
  if (expression.kind === "new") return expression.typeName;
  if (expression.kind === "structExpression") return expression.typeName;
  return "unknown";
}

function syntacticHover(
  source: string,
  fileName: string,
  name: string,
  start: number,
  end: number,
): Hover | null {
  if (primitiveTypeTokens.some((primitive) => primitive === name)) {
    return markdownHover(primitiveTypeHover(name), source, start, end);
  }
  if (name === "Option") return markdownHover("compiler-provided enum Option<T>", source, start, end);
  if (name === "internal") {
    return markdownHover(
      "internal  // visible only inside the exact manifest package; omitted from downstream imports, completion, and callable metadata",
      source,
      start,
      end,
    );
  }
  if (name === "raw") {
    return markdownHover(
      "raw c | raw cpp | raw objc  // isolated native-source boundary; prefer checked header import plus .zd when representable",
      source,
      start,
      end,
    );
  }
  if (name === "unsafe") {
    return markdownHover(
      "unsafe { ... }  // local unverified native assertions remain in Z syntax and types; prefer reusable checked .zd contracts",
      source,
      start,
      end,
    );
  }
  if (name === "instanceof") {
    return markdownHover(
      "value instanceof NativeClass  // runtime Objective-C class check; the true branch narrows the value to NativeClass",
      source,
      start,
      end,
    );
  }
  if (name === "thread" && /^\s*\./.test(source.slice(end))) {
    return markdownHover("thread  // standard executor and native-thread namespace", source, start, end);
  }
  if ((name === "main" || name === "any") && /thread\.\s*$/.test(source.slice(Math.max(0, start - 16), start))) {
    return markdownHover(
      name === "main"
        ? "thread.main: Executor  // main-thread execution target"
        : "thread.any: CallableThread  // callable may run concurrently on arbitrary registered threads",
      source,
      start,
      end,
    );
  }
  let program: Program | null = null;
  try {
    program = parse(lex(source, fileName), fileName);
  } catch {
    // Declaration regex fallback below still helps during incomplete syntax.
  }
  if (program) {
    const typeParameter = syntacticTypeParameterHover(program, name, start);
    if (typeParameter) return markdownHover(typeParameter, source, start, end);
    const binding = syntacticBindings(program)
      .filter((candidate) => candidate.name === name && candidate.offset <= start)
      .at(-1);
    if (binding) {
      const capability = binding.parameter && !binding.readonly ? "inout " : "";
      const declaration = binding.parameter ? `${capability}${binding.name}` : `${binding.readonly ? "const" : "let"} ${binding.name}`;
      return markdownHover(`${declaration}: ${binding.type}`, source, start, end);
    }
    for (const declaration of program.structs) {
      const field = declaration.fields.find((candidate) => candidate.name === name);
      if (field) return markdownHover(`${field.readonly ? "readonly " : ""}${field.name}: ${field.type.name}`, source, start, end);
      const method = declaration.methods.find((candidate) => candidate.name === name);
      if (method) {
        return markdownHover(
          methodDetail(method, new Map()),
          source,
          start,
          end,
        );
      }
    }
    for (const declaration of program.enums) {
      const variant = declaration.variants.find((candidate) => candidate.name === name);
      if (variant) {
        const payload = variant.payload ? `(${variant.payload.name})` : "";
        return markdownHover(`${declaration.name}.${variant.name}${payload}`, source, start, end);
      }
    }
    const local = declarationHover(source, program, name, start, end);
    if (local) return local;
  }
  const imports = importAnalysis(source, fileName);
  if (imports) {
    const memberOwner = source.slice(0, start).match(/([A-Za-z_][A-Za-z0-9_]*)\.$/)?.[1];
    const standardOwner = memberOwner
      ? imports.semanticInfo.standardModuleBindings.get(memberOwner)
      : null;
    if (
      (memberOwner && imports.semanticInfo.consoleBindings.has(memberOwner))
      || standardOwner === "console"
    ) {
      const detail = consoleMethodDetail(name);
      if (detail) return markdownHover(detail, source, start, end);
    }
    if (standardOwner === "thread" && name === "main") {
      return markdownHover("thread.main: Executor  // main-thread execution target", source, start, end);
    }
    if (standardOwner === "thread" && name === "any") {
      return markdownHover(
        "thread.any: CallableThread  // callable may run concurrently on arbitrary registered threads",
        source,
        start,
        end,
      );
    }
    const binding = localSourceBinding(imports, name);
    if (binding) {
      const detail = sourceExportDetail(binding.module, binding.importedName, imports.typeDisplayNames, binding.localName);
      return sourceImportHover(detail, binding, source, start, end);
    }
    if (imports.semanticInfo.standardModuleBindings.has(name)) {
      return markdownHover(`import ${name} from a Z standard-library module`, source, start, end);
    }
    if (imports.semanticInfo.consoleBindings.has(name)) {
      return markdownHover("console  // typed immediate stdout/stderr logging namespace", source, start, end);
    }
    if (imports.semanticInfo.standardTypeBindings.has(name)) {
      return markdownHover(`${name}  // Z standard-library type`, source, start, end);
    }
  }
  return declarationHover(source, null, name, start, end);
}

function syntacticTypeParameterHover(program: Program, name: string, offset: number): string | null {
  const declarations = [
    ...program.functions,
    ...program.structs,
    ...program.structs.flatMap((declaration) => declaration.methods),
    ...program.traits,
    ...program.traits.flatMap((declaration) => declaration.methods),
  ].filter((declaration) => (
    declaration.location.offset <= offset
    && declaration.typeParameters?.includes(name)
  )).sort((left, right) => left.location.offset - right.location.offset);
  const declaration = declarations.at(-1);
  if (!declaration) return null;
  const constraints = declaration.typeParameterConstraints
    ?.find((constraint) => constraint.parameter === name)
    ?.traits.map((trait) => trait.name) ?? [];
  return `${name}${constraints.length ? `: ${constraints.join(" & ")}` : ""}  // type parameter`;
}

type ResolvedReceiver =
  | { readonly kind: "module"; readonly module: ForeignModule; readonly namespacePath: readonly string[] }
  | { readonly kind: "objc"; readonly declaration: ForeignObjCInterface; readonly instance: boolean }
  | {
    readonly kind: "struct";
    readonly declaration: StructDeclaration;
    readonly sourceDeclaration: StructDeclaration | null;
  }
  | {
    readonly kind: "trait";
    readonly declarations: readonly {
      readonly declaration: Program["traits"][number];
      readonly substitutions: ReadonlyMap<string, string>;
    }[];
  }
  | { readonly kind: "foreignRecord"; readonly declaration: Extract<ForeignNamedType, { kind: "record" }> }
  | { readonly kind: "foreignValue"; readonly declaration: Extract<ForeignNamedType, { kind: "value" }> }
  | { readonly kind: "integer"; readonly type: string }
  | { readonly kind: "array"; readonly type: string }
  | { readonly kind: "string" }
  | { readonly kind: "textBuffer" }
  | { readonly kind: "arena" }
  | { readonly kind: "hasher" }
  | { readonly kind: "map"; readonly keyType: string; readonly valueType: string; readonly readonly: boolean }
  | { readonly kind: "set"; readonly elementType: string; readonly readonly: boolean }
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
  | { readonly kind: "once"; readonly valueType: string }
  | { readonly kind: "mutex"; readonly valueType: string }
  | { readonly kind: "channel"; readonly channel: ChannelHandleType }
  | { readonly kind: "fsLock" }
  | { readonly kind: "objcConnection" };

function mapValueHasReferenceIdentity(context: AnalyzedSource, type: string): boolean {
  return Boolean(parseFunctionType(type))
    || context.program.structs.some((declaration) => declaration.name === type && declaration.kind === "class")
    || context.semanticInfo.foreignNamedTypes.get(type)?.kind === "object";
}

function onceCompletions(
  valueType: string,
  typeDisplayNames: ReadonlyMap<string, string>,
): CompletionItem[] {
  const value = displayType(valueType, typeDisplayNames);
  return [
    {
      label: "initialize",
      kind: completionKinds.method,
      detail: `initialize(move value: ${value}): OnceLifetime<${value}> on thread.main`,
      insertText: "initialize()",
    },
    {
      label: "get",
      kind: completionKinds.method,
      detail: `get(): ${value}  // synchronized Z-managed cross-thread retrieval`,
      insertText: "get()",
    },
    {
      label: "state",
      kind: completionKinds.method,
      detail: "state(): OnceState  // synchronized lifecycle snapshot",
      insertText: "state()",
    },
  ];
}

function mutexCompletions(
  valueType: string,
  typeDisplayNames: ReadonlyMap<string, string>,
): CompletionItem[] {
  const value = displayType(valueType, typeDisplayNames);
  return [{
    label: "withLock",
    kind: completionKinds.method,
    detail: `withLock<R>((in value: ${value}) => R | (inout value: ${value}) => R): R`,
    insertText: "withLock()",
  }];
}

function channelTypeFromSourceSpelling(
  context: AnalyzedSource,
  sourceType: string,
): ChannelHandleType | null {
  const direct = parseChannelHandleType(sourceType);
  if (direct) return direct;
  const generic = parseGenericType(sourceType) ?? parseSourceGenericType(sourceType);
  if (!generic || generic.arguments.length !== 1) return null;
  const standard = context.semanticInfo.standardTypeBindings.get(generic.base);
  if (
    standard !== "Channel"
    && standard !== "Sender"
    && standard !== "Receiver"
    && standard !== "SyncSender"
    && standard !== "SyncReceiver"
    && standard !== "ChannelClosed"
  ) return null;
  return parseChannelHandleType(genericTypeName(standard, generic.arguments));
}

function channelCompletions(
  channel: ChannelHandleType,
  typeDisplayNames: ReadonlyMap<string, string>,
): CompletionItem[] {
  const value = displayType(channel.valueType, typeDisplayNames);
  if (channel.kind === "factory") {
    return [{
      label: "bounded",
      kind: completionKinds.method,
      detail: `bounded(capacity: usize): { sender: Sender<${value}>, receiver: Receiver<${value}> }`,
      insertText: "bounded()",
    }];
  }
  if (channel.kind === "sender") {
    return [
      {
        label: "send",
        kind: completionKinds.method,
        detail: `async send(move value: ${value}): void throws ChannelClosed<${value}>`,
        insertText: "send()",
      },
      {
        label: "close",
        kind: completionKinds.method,
        detail: "close(): void  // closes the channel and wakes blocked operations",
        insertText: "close()",
      },
      {
        label: "sync",
        kind: completionKinds.method,
        detail: `sync(): SyncSender<${value}>  // retains a blocking sending endpoint`,
        insertText: "sync()",
      },
    ];
  }
  if (channel.kind === "receiver") {
    return [
      {
        label: "receive",
        kind: completionKinds.method,
        detail: `async receive(): Option<${value}>  // none after close and buffer drain`,
        insertText: "receive()",
      },
      {
        label: "sync",
        kind: completionKinds.method,
        detail: `sync(move this): SyncReceiver<${value}>  // consumes the unique async receiver`,
        insertText: "sync()",
      },
    ];
  }
  if (channel.kind === "syncSender") {
    return [
      {
        label: "send",
        kind: completionKinds.method,
        detail: `send(move value: ${value}): void throws ChannelClosed<${value}>  // blocks while full`,
        insertText: "send()",
      },
      {
        label: "close",
        kind: completionKinds.method,
        detail: "close(): void  // closes the channel and wakes blocked operations",
        insertText: "close()",
      },
    ];
  }
  if (channel.kind === "syncReceiver") {
    return [{
      label: "receive",
      kind: completionKinds.method,
      detail: `receive(): Option<${value}>  // blocks while empty; none after close and drain`,
      insertText: "receive()",
    }];
  }
  return [];
}

function channelMemberDetail(
  channel: ChannelHandleType,
  member: string,
  typeDisplayNames: ReadonlyMap<string, string>,
): string | null {
  return channelCompletions(channel, typeDisplayNames)
    .find((completion) => completion.label === member)?.detail ?? null;
}

function resolveReceiver(context: AnalyzedSource, text: string, offset: number): ResolvedReceiver | null {
  const compactText = text.replace(/\s+/g, "");
  if (compactText === "super") {
    const owner = sourceAggregateAtOffset(context, offset);
    const base = owner?.nativeBase ? resolveReceiver(context, owner.nativeBase.name, offset) : null;
    return base?.kind === "objc" ? { ...base, instance: true } : null;
  }
  const nativeNamespace = resolveForeignModuleNamespace(context, compactText);
  if (nativeNamespace) return { kind: "module", ...nativeNamespace };
  const [moduleName, className, extra] = compactText.split(".");
  if (!extra && moduleName && className) {
    const declaration = context.foreignModules.get(moduleName)?.interfaces.get(className);
    if (declaration) return { kind: "objc", declaration, instance: false };
  }
  const expressionOffsets = receiverSemanticOffsets(text, offset);
  const sourceType = sourceReceiverFallbackType(context, text, offset);
  const semanticTypes = expressionOffsets
      .toReversed()
      .map((candidate) => context.semanticInfo.expressionTypes.get(candidate))
      .filter((candidate): candidate is string => candidate !== undefined);
  const authoredPostfixChain = text.includes("[") || (text.match(/\./g)?.length ?? 0) > 1;
  const candidateTypes = authoredPostfixChain
    ? [...(sourceType ? [sourceType] : []), ...semanticTypes]
    : [...semanticTypes, ...(sourceType ? [sourceType] : [])];
  for (const candidate of [...new Set(candidateTypes)]) {
    const traits = sourceTraitConstraintsAtOffset(context, candidate, offset);
    if (traits.length) return { kind: "trait", declarations: traits };
    const resolved = resolveReceiverType(context, candidate);
    if (resolved) return resolved;
  }
  return null;
}

function resolveReceiverType(context: AnalyzedSource, type: string): ResolvedReceiver | null {
  const view = parseViewType(type);
  const receiverType = view?.target ?? type;
  if (receiverType === objcConnectionTypeName || receiverType === objcRegistrationTypeName) {
    return { kind: "objcConnection" };
  }
  if (receiverType === "TextBuffer") return { kind: "textBuffer" };
  if (receiverType === "Arena") return { kind: "arena" };
  if (receiverType === "Hasher") return { kind: "hasher" };
  if (receiverType === "TaskScope") return { kind: "taskScope" };
  if (receiverType === "TaskControl") return { kind: "taskControl" };
  const once = parseOnceType(receiverType);
  if (once) return { kind: "once", valueType: once.valueType };
  const mutex = parseMutexType(receiverType);
  if (mutex) return { kind: "mutex", valueType: mutex.valueType };
  const channel = parseChannelHandleType(receiverType);
  if (channel) return { kind: "channel", channel };
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
  if (parseFixedArrayType(receiverType) || parseSliceType(receiverType) || parseDynamicArrayType(receiverType) || isStaticBytesType(receiverType)) return { kind: "array", type: receiverType };
  const weak = parseWeakType(receiverType);
  if (weak) return { kind: "weak", target: weak.target };
  const task = parseTaskType(receiverType);
  if (task) return { kind: "task", successType: task.successType, errorType: task.errorType };
  if (isIntegerSourceType(receiverType)) return { kind: "integer", type: receiverType };
  const interfaceName = receiverType.replace(/^__z_objc:(?:nullable|nonnull):/, "");
  const objc = context.semanticInfo.foreignInterfaces.get(interfaceName);
  if (objc) return { kind: "objc", declaration: objc, instance: true };
  const protocolType = parseObjCProtocolType(receiverType);
  const protocol = protocolType
    ? context.semanticInfo.foreignProtocols.get(protocolType.protocol)
    : null;
  if (protocol) {
    return {
      kind: "objc",
      instance: true,
      declaration: {
        exportName: protocol.exportName,
        typeName: protocol.typeName,
        className: `id<${protocol.protocolName}>`,
        superName: null,
        methods: uniqueObjCProtocolRequirements([protocol], context.semanticInfo.foreignProtocols),
        properties: [],
        metadata: protocol.metadata,
      },
    };
  }
  const sourceAggregate = sourceAggregateForType(context, receiverType);
  const declaration = context.program.structs.find((item) => item.name === receiverType)
    ?? sourceAggregate?.declaration;
  if (declaration) {
    const sourceType = context.typeDisplayNames.get(receiverType) ?? receiverType;
    const sourceDeclaration = sourceAggregateForType(context, sourceType)?.declaration
      ?? sourceAggregate?.declaration
      ?? null;
    return { kind: "struct", declaration, sourceDeclaration };
  }
  const sourceTrait = sourceTraitForType(context, receiverType);
  if (sourceTrait) {
    return {
      kind: "trait",
      declarations: [{
        declaration: sourceTrait.declaration,
        substitutions: sourceTrait.substitutions,
      }],
    };
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
  readonly = false,
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
    freeze: `freeze(): readonly Map<${key}, ${value}>  // consumes without copying`,
  };
  if (readonly && !["length", "has", "get"].includes(name)) return null;
  return details[name] ?? null;
}

function mapCompletions(
  keyType: string,
  valueType: string,
  typeDisplayNames: ReadonlyMap<string, string>,
  identityValue = false,
  readonly = false,
): CompletionItem[] {
  const names = readonly
    ? ["length", "has", "get"]
    : ["length", "has", "get", "set", "remove", "delete", "clear", "freeze"];
  return names.map((name) => ({
    label: name,
    kind: name === "length" ? completionKinds.property : completionKinds.method,
    detail: mapMemberDetail(name, keyType, valueType, typeDisplayNames, identityValue, readonly)!,
    ...(name === "length" ? {} : { insertText: `${name}()` }),
  }));
}

function setMemberDetail(
  name: string,
  elementType: string,
  typeDisplayNames: ReadonlyMap<string, string>,
  readonly = false,
): string | null {
  const element = displayType(elementType, typeDisplayNames);
  const details: Readonly<Record<string, string>> = {
    length: "length: usize",
    has: `has(in value: ${element}): boolean`,
    add: `add(value: ${element}): boolean  // transfers the owned value`,
    remove: `remove(in value: ${element}): Option<${element}>  // transfers the removed value`,
    delete: `delete(in value: ${element}): boolean  // destroys the removed value`,
    clear: "clear(): void  // destroys all values",
    freeze: `freeze(): readonly Set<${element}>  // consumes without copying`,
  };
  if (readonly && !["length", "has"].includes(name)) return null;
  return details[name] ?? null;
}

function setCompletions(
  elementType: string,
  typeDisplayNames: ReadonlyMap<string, string>,
  readonly = false,
): CompletionItem[] {
  const names = readonly
    ? ["length", "has"]
    : ["length", "has", "add", "remove", "delete", "clear", "freeze"];
  return names.map((name) => ({
    label: name,
    kind: name === "length" ? completionKinds.property : completionKinds.method,
    detail: setMemberDetail(name, elementType, typeDisplayNames, readonly)!,
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
  if (!instance && declaration.className === "NSData") {
    items.push({
      label: "copy",
      kind: completionKinds.method,
      detail: `copy(bytes: Slice<u8>): ${declaration.typeName}  // copies borrowed bytes into ARC-managed NSData`,
      insertText: "copy(${1:bytes})",
      insertTextFormat: 2,
    });
    items.push({
      label: "borrow",
      kind: completionKinds.method,
      detail: `borrow(bytes: embed.StaticBytes): ${declaration.typeName}  // zero-copy process-lifetime NSData view`,
      insertText: "borrow(${1:bytes})",
      insertTextFormat: 2,
    });
  }
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

function objCDataCopyHover(
  typeName: string,
  source: string,
  start: number,
  end: number,
): Hover {
  return structuredMarkdownHover(
    `copy(bytes: Slice<u8>): ${typeName}`,
    ["Copies the borrowed byte range into independently owned ARC-managed `NSData`; the source storage is not retained."],
    source,
    start,
    end,
  );
}

function objCDataBorrowHover(
  typeName: string,
  source: string,
  start: number,
  end: number,
): Hover {
  return structuredMarkdownHover(
    `borrow(bytes: embed.StaticBytes): ${typeName}`,
    ["Creates an ARC-managed zero-copy `NSData` view over immutable process-lifetime bytes; `NSData` does not free the storage."],
    source,
    start,
    end,
  );
}

function structCompletions(
  declaration: StructDeclaration,
  typeDisplayNames: ReadonlyMap<string, string>,
  includePrivate: boolean,
  includeInternal: boolean,
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
      .filter((field) => field.visibility === "public" || (field.visibility === "internal" && includeInternal) || includePrivate)
      .map((field) => ({
        label: field.name,
        kind: completionKinds.field,
        detail: memberFieldCompletionDetail(field, typeDisplayNames),
      })),
    ...methods
      .filter((method) => !method.static && ((method.visibility ?? "public") === "public" || ((method.visibility ?? "public") === "internal" && includeInternal) || includePrivate))
      .map((method) => ({
      label: method.name,
      kind: completionKinds.method,
      detail: methodDetail(method, typeDisplayNames),
      insertText: `${method.name}()`,
    })),
  ];
}

function traitCompletions(
  declarations: Extract<ResolvedReceiver, { kind: "trait" }>["declarations"],
  typeDisplayNames: ReadonlyMap<string, string>,
): CompletionItem[] {
  return uniqueCompletions(declarations.flatMap((owner) => (
    owner.declaration.methods.map((method) => ({
      label: method.name,
      kind: completionKinds.method,
      detail: methodDetail(method, typeDisplayNames, owner.substitutions),
      insertText: `${method.name}()`,
    }))
  )));
}

function memberFieldCompletionDetail(
  field: StructDeclaration["fields"][number],
  typeDisplayNames: ReadonlyMap<string, string>,
): string {
  const visibility = field.visibility === "private" ? "private " : field.visibility === "internal" ? "internal " : "";
  const readonly = field.readonly ? "readonly " : "";
  const storedType = displayType(field.type.name, typeDisplayNames);
  const executor = field.executorAffinity ? " on thread.main" : "";
  if (field.optional) return `${visibility}${readonly}${storedType}${executor} (optional presence; omitted → none)`;
  return `${visibility}${readonly}${storedType}${executor}${field.defaultValue ? " (defaulted)" : ""}`;
}

function fieldDetail(
  field: StructDeclaration["fields"][number],
  typeDisplayNames: ReadonlyMap<string, string>,
  sourceSpelling = false,
): string {
  const visibility = field.visibility === "private" ? "private " : field.visibility === "internal" ? "internal " : "";
  const readonly = field.readonly ? "readonly " : "";
  const defaulted = field.defaultValue ? " = default" : "";
  const storedType = displayType(field.type.name, typeDisplayNames);
  const executor = field.executorAffinity ? " on thread.main" : "";
  if (!field.optional) return `${visibility}${readonly}${field.name}: ${storedType}${executor}${defaulted}`;
  const payload = /^Option<(.+)>$/.exec(storedType)?.[1] ?? storedType;
  if (sourceSpelling) {
    return `${visibility}${readonly}${field.name}?: ${payload}${executor}  // stored as ${storedType}; omission initializes Option.none`;
  }
  return `${visibility}${readonly}${field.name}: ${storedType}${executor}  // optional presence; match some/none`;
}

function staticCompletions(
  declaration: StructDeclaration,
  typeDisplayNames: ReadonlyMap<string, string>,
  substitutions: ReadonlyMap<string, string>,
  includePrivate: boolean,
  includeInternal: boolean,
): CompletionItem[] {
  return declaration.methods
    .filter((method) => method.static && ((method.visibility ?? "public") === "public" || ((method.visibility ?? "public") === "internal" && includeInternal) || includePrivate))
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
  scopeProgram: Program = context.sourceProgram,
): {
  readonly declaration: StructDeclaration;
  readonly substitutions: ReadonlyMap<string, string>;
  readonly module: SourceModuleInfo | null;
} | null {
  const view = parseViewType(typeName);
  const readonly = parseReadonlyType(view?.target ?? typeName);
  typeName = readonly?.target ?? view?.target ?? typeName;
  const generic = parseGenericType(typeName) ?? parseSourceGenericType(typeName);
  const base = generic?.base ?? typeName;
  const selective = sourceBindingInProgram(context, scopeProgram, base);
  const selectiveDeclaration = selective
    ? sourceExportDeclaration(selective.module, selective.importedName)
    : null;
  const namespaceParts = base.split(".");
  const namespaceImport = namespaceParts.length === 2
    ? scopeProgram.imports.find((item) => (
      !item.bindings
      && item.moduleName === namespaceParts[0]
      && localSourceModule(context, item)
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
  const localDeclaration = scopeProgram.structs.find((item) => item.name === base) ?? null;
  const graphMatches = importedDeclaration || localDeclaration
    ? []
    : [...context.sourceModules.values()].flatMap((module) => {
        const candidate = sourceExportDeclaration(module, base);
        return candidate?.kind === "struct" || candidate?.kind === "class"
          ? [{ declaration: candidate, module }]
          : [];
      });
  const graphMatch = graphMatches.length === 1 ? graphMatches[0] : null;
  const declaration = importedDeclaration
    ?? localDeclaration
    ?? graphMatch?.declaration
    ?? context.program.structs.find((item) => item.name === typeName);
  if (!declaration) return null;
  const module = importedDeclaration && selectiveDeclaration === importedDeclaration
    ? selective?.module ?? null
    : importedDeclaration && namespaceDeclaration === importedDeclaration
      ? namespaceModule
      : graphMatch?.declaration === declaration
        ? graphMatch.module
      : [...context.sourceModules.values()].find((candidate) => (
          candidate.program === scopeProgram
          || (declaration.location.fileName
            && resolve(candidate.fileName) === resolve(declaration.location.fileName))
        )) ?? null;
  const substitutions = new Map(
    declaration.typeParameters?.map((parameter, index) => [parameter, generic?.arguments[index] ?? parameter]) ?? [],
  );
  return { declaration, substitutions, module };
}

function sourceTraitForType(
  context: AnalyzedSource,
  typeName: string,
  scopeProgram: Program = context.sourceProgram,
): {
  readonly declaration: Program["traits"][number];
  readonly substitutions: ReadonlyMap<string, string>;
  readonly module: SourceModuleInfo | null;
} | null {
  const generic = parseGenericType(typeName) ?? parseSourceGenericType(typeName);
  const base = generic?.base ?? typeName;
  const selective = sourceBindingInProgram(context, scopeProgram, base);
  const selectiveDeclaration = selective
    ? sourceExportDeclaration(selective.module, selective.importedName)
    : null;
  const namespaceParts = base.split(".");
  const namespaceImport = namespaceParts.length === 2
    ? scopeProgram.imports.find((item) => (
        !item.bindings
        && item.moduleName === namespaceParts[0]
        && localSourceModule(context, item)
      ))
    : null;
  const namespaceModule = namespaceImport ? localSourceModule(context, namespaceImport) : null;
  const namespaceDeclaration = namespaceModule && namespaceParts[1]
    ? sourceExportDeclaration(namespaceModule, namespaceParts[1])
    : null;
  const importedDeclaration = selectiveDeclaration?.kind === "trait"
    ? selectiveDeclaration
    : namespaceDeclaration?.kind === "trait"
      ? namespaceDeclaration
      : null;
  const localDeclaration = scopeProgram.traits.find((item) => item.name === base) ?? null;
  const graphMatches = importedDeclaration || localDeclaration
    ? []
    : [...context.sourceModules.values()].flatMap((module) => {
        const candidate = sourceExportDeclaration(module, base);
        return candidate?.kind === "trait" ? [{ declaration: candidate, module }] : [];
      });
  const graphMatch = graphMatches.length === 1 ? graphMatches[0] : null;
  const declaration = importedDeclaration
    ?? localDeclaration
    ?? graphMatch?.declaration
    ?? context.program.traits.find((item) => item.name === typeName);
  if (!declaration) return null;
  const module = importedDeclaration && selectiveDeclaration === importedDeclaration
    ? selective?.module ?? null
    : importedDeclaration && namespaceDeclaration === importedDeclaration
      ? namespaceModule
      : graphMatch?.declaration === declaration
        ? graphMatch.module
        : [...context.sourceModules.values()].find((candidate) => (
            candidate.program === scopeProgram
            || (declaration.location.fileName
              && resolve(candidate.fileName) === resolve(declaration.location.fileName))
          )) ?? null;
  const substitutions = new Map(
    declaration.typeParameters?.map((parameter, index) => [parameter, generic?.arguments[index] ?? parameter]) ?? [],
  );
  return { declaration, substitutions, module };
}

function sourceCallableAtOffset(
  context: AnalyzedSource,
  offset: number,
): Program["functions"][number] | null {
  return [
    ...context.sourceProgram.functions,
    ...context.sourceProgram.structs.flatMap((declaration) => declaration.methods),
  ]
    .filter((declaration) => (
      declaration.location.offset <= offset
      && maximumSourceOffset(declaration) >= offset
    ))
    .sort((left, right) => left.location.offset - right.location.offset)
    .at(-1) ?? null;
}

function sourceTraitConstraintsAtOffset(
  context: AnalyzedSource,
  typeName: string,
  offset: number,
): readonly {
  readonly declaration: Program["traits"][number];
  readonly substitutions: ReadonlyMap<string, string>;
}[] {
  const callable = sourceCallableAtOffset(context, offset);
  const constraint = callable?.typeParameterConstraints?.find((item) => item.parameter === typeName);
  if (!constraint) return [];
  return constraint.traits.flatMap((reference) => {
    const trait = sourceTraitForType(context, reference.name);
    return trait ? [{ declaration: trait.declaration, substitutions: trait.substitutions }] : [];
  });
}

function sourceEnumForType(context: AnalyzedSource, typeName: string): Program["enums"][number] | null {
  const direct = context.sourceProgram.enums.find((item) => item.name === typeName);
  if (direct) return direct;
  const selective = localSourceBinding(context, typeName);
  const selectiveDeclaration = selective
    ? sourceExportDeclaration(selective.module, selective.importedName)
    : null;
  if (selectiveDeclaration?.kind === "enum") return selectiveDeclaration;
  const [namespace, member, extra] = typeName.split(".");
  if (extra || !namespace || !member) return null;
  const namespaceImport = context.sourceProgram.imports.find((item) => (
    !item.bindings
    && item.moduleName === namespace
    && localSourceModule(context, item)
  ));
  const module = namespaceImport ? localSourceModule(context, namespaceImport) : null;
  const declaration = module ? sourceExportDeclaration(module, member) : null;
  return declaration?.kind === "enum" ? declaration : null;
}

function substituteEditorType(type: string, substitutions: ReadonlyMap<string, string>): string {
  const direct = substitutions.get(type);
  if (direct) return direct;
  const readonly = parseReadonlyType(type);
  if (readonly) return readonlyTypeName(substituteEditorType(readonly.target, substitutions));
  const view = parseViewType(type);
  if (view) return viewTypeName(substituteEditorType(view.target, substitutions));
  const callable = parseFunctionType(type);
  if (callable) {
    return functionTypeName(
      callable.parameters.map((parameter) => ({
        ...parameter,
        type: substituteEditorType(parameter.type, substitutions),
      })),
      substituteEditorType(callable.returnType, substitutions),
      callable.errorType ? substituteEditorType(callable.errorType, substitutions) : null,
      callable.thread,
      callable.async,
    );
  }
  const generic = parseGenericType(type) ?? parseSourceGenericType(type);
  return generic
    ? genericTypeName(generic.base, generic.arguments.map((argument) => substituteEditorType(argument, substitutions)))
    : type;
}

function maximumSourceOffset(value: unknown): number {
  let maximum = -1;
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.offset === "number" && typeof record.line === "number") {
      maximum = Math.max(maximum, record.offset);
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return maximum;
}

function sourceAggregateAtOffset(context: AnalyzedSource, offset: number): StructDeclaration | null {
  return context.sourceProgram.structs
    .filter((declaration) => (
      declaration.location.offset <= offset
      && maximumSourceOffset(declaration) >= offset
    ))
    .sort((left, right) => left.location.offset - right.location.offset)
    .at(-1) ?? null;
}

function sourceFunctionForName(
  context: AnalyzedSource,
  name: string,
): Program["functions"][number] | null {
  const direct = context.sourceProgram.functions.find((item) => item.name === name);
  if (direct) return direct;
  const imported = localSourceBinding(context, name);
  const declaration = imported
    ? sourceExportDeclaration(imported.module, imported.importedName)
    : null;
  return declaration?.kind === "function" ? declaration : null;
}

function sourceVariableAtOffset(
  context: AnalyzedSource,
  name: string,
  offset: number,
): Extract<Statement, { kind: "variable" }> | null {
  const candidates: Extract<Statement, { kind: "variable" }>[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === "variable") {
      const declaration = value as Extract<Statement, { kind: "variable" }>;
      if (declaration.name === name && declaration.nameLocation.offset <= offset) {
        candidates.push(declaration);
      }
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(context.sourceProgram);
  return candidates.sort((left, right) => left.nameLocation.offset - right.nameLocation.offset).at(-1) ?? null;
}

function sourceExpressionText(expression: Expression): string | null {
  if (expression.kind === "identifier") return expression.name;
  if (expression.kind === "member") {
    const object = sourceExpressionText(expression.object);
    return object ? `${object}.${expression.property}` : null;
  }
  return null;
}

function sourceInitializerType(
  context: AnalyzedSource,
  expression: Expression,
  offset: number,
): string | null {
  if (expression.kind === "new" || expression.kind === "structExpression") return expression.typeName;
  if (expression.kind === "dynamicArrayExpression") return `Array<${expression.elementType}>`;
  if (expression.kind === "identifier" && expression.name === "this") {
    const aggregate = sourceAggregateAtOffset(context, offset);
    return aggregate
      ? aggregate.typeParameters?.length
        ? genericTypeName(aggregate.name, aggregate.typeParameters)
        : aggregate.name
      : null;
  }
  if (expression.kind !== "call") return null;
  if (expression.callee.kind === "identifier") {
    return sourceFunctionForName(context, expression.callee.name)?.returnType.name ?? null;
  }
  if (expression.callee.kind !== "member") return null;
  const receiverText = sourceExpressionText(expression.callee.object);
  const receiverType = receiverText
    ? sourceReceiverFallbackType(context, receiverText, offset)
    : null;
  if (!receiverType) return null;
  const owner = sourceAggregateForType(context, receiverType);
  const method = owner?.declaration.methods.find((candidate) => candidate.name === expression.callee.property);
  return method ? substituteEditorType(method.returnType.name, owner!.substitutions) : null;
}

function sourceClosureParameterTypeAtOffset(
  context: AnalyzedSource,
  name: string,
  offset: number,
): string | null {
  let inferred: string | null = null;
  const visit = (value: unknown): void => {
    if (inferred || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === "call") {
      const call = value as Extract<Expression, { kind: "call" }>;
      if (call.callee.kind === "member" && call.callee.property === "withLock") {
        const receiverText = sourceExpressionText(call.callee.object);
        const receiverType = receiverText
          ? sourceReceiverFallbackType(context, receiverText, offset, false)
          : null;
        const mutex = receiverType ? parseMutexType(receiverType) : null;
        if (mutex) {
          for (const argument of call.arguments) {
            if (
              argument.kind === "closure"
              && argument.location.offset <= offset
              && maximumSourceOffset(argument) >= offset
              && argument.parameters.some((parameter) => parameter.name === name)
            ) {
              inferred = mutex.valueType;
              return;
            }
          }
        }
      }
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(context.sourceProgram);
  return inferred;
}

function sourceReceiverFallbackType(
  context: AnalyzedSource,
  text: string,
  offset: number,
  inferClosureParameters = true,
): string | null {
  let tokens;
  try {
    tokens = lex(text, "<editor-receiver>").filter((token) => token.kind !== "eof");
  } catch {
    return null;
  }
  if (tokens.length === 0 || tokens[0].kind !== "identifier") return null;
  let index = 1;
  const root = tokens[0].text;
  let type: string | null;
  if (root === "this") {
    const aggregate = sourceAggregateAtOffset(context, offset);
    type = aggregate
      ? aggregate.typeParameters?.length
        ? genericTypeName(aggregate.name, aggregate.typeParameters)
        : aggregate.name
      : null;
  } else {
    const entryFile = context.sourceModuleBatch.entryFileName;
    const contextualClosureType = inferClosureParameters
      ? sourceClosureParameterTypeAtOffset(context, root, offset)
      : null;
    type = contextualClosureType ?? collectBindings(context)
      .filter((binding) => (
        binding.name === root
        && binding.offset <= offset
        && (!binding.fileName || resolve(binding.fileName) === resolve(entryFile))
      ))
      .sort((left, right) => left.offset - right.offset)
      .at(-1)?.type ?? null;
    type ??= sourceCallableAtOffset(context, offset)?.parameters
      .find((parameter) => parameter.name === root)?.type.name ?? null;
    const variable = sourceVariableAtOffset(context, root, offset);
    if (variable?.type) type = variable.type.name;
    else if (variable?.initializer) type = sourceInitializerType(context, variable.initializer, offset) ?? type;
    if (!type && tokens[index]?.kind === "leftParen") {
      type = sourceFunctionForName(context, root)?.returnType.name ?? null;
    }
  }
  if (!type) return null;
  let scopeProgram = context.sourceProgram;

  const skipDelimited = (opening: string, closing: string): void => {
    if (tokens[index]?.kind !== opening) return;
    let depth = 0;
    for (; index < tokens.length; index += 1) {
      if (tokens[index].kind === opening) depth += 1;
      else if (tokens[index].kind === closing) depth -= 1;
      if (depth === 0) { index += 1; return; }
    }
  };

  if (tokens[index]?.kind === "leftParen") skipDelimited("leftParen", "rightParen");
  while (index < tokens.length) {
    if (tokens[index].kind === "leftBracket") {
      const target = parseViewType(type)?.target ?? parseReadonlyType(type)?.target ?? type;
      const collection = parseFixedArrayType(target) ?? parseSliceType(target) ?? parseDynamicArrayType(target);
      if (!collection) return null;
      type = collection.elementType;
      skipDelimited("leftBracket", "rightBracket");
      continue;
    }
    if (tokens[index].kind !== "dot" || tokens[index + 1]?.kind !== "identifier") return null;
    const member = tokens[index + 1].text;
    index += 2;
    const owner = sourceAggregateForType(context, type, scopeProgram);
    const traitOwners = owner ? [] : sourceTraitConstraintsAtOffset(context, type, offset);
    const field = owner?.declaration.fields.find((candidate) => candidate.name === member);
    const traitMethod = traitOwners.flatMap((candidate) => (
      candidate.declaration.methods
        .filter((method) => method.name === member)
        .map((method) => ({ method, substitutions: candidate.substitutions }))
    ))[0];
    const method = owner?.declaration.methods.find((candidate) => candidate.name === member)
      ?? traitMethod?.method;
    if (tokens[index]?.kind === "leftParen") {
      if (!method) return null;
      type = substituteEditorType(
        method.returnType.name,
        owner?.substitutions ?? traitMethod!.substitutions,
      );
      scopeProgram = owner?.module?.program ?? scopeProgram;
      skipDelimited("leftParen", "rightParen");
      continue;
    }
    if (!field) return null;
    type = substituteEditorType(field.type.name, owner!.substitutions);
    scopeProgram = owner!.module?.program ?? scopeProgram;
  }
  return type;
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
    current = context.semanticInfo.objcSubclasses.get(current.typeName)?.base
      ?? context.semanticInfo.foreignInterfaces.get(`${moduleName}.${current.superName}`);
  }
  return methods;
}

function foreignObjCRequiresMain(declaration: ForeignObjCInterface, context: AnalyzedSource): boolean {
  let current: ForeignObjCInterface | undefined = declaration;
  while (current) {
    if (current.metadata.executorAffinity === "main") return true;
    if (!current.superName) break;
    const moduleName = current.typeName.slice(0, current.typeName.lastIndexOf("."));
    current = context.semanticInfo.objcSubclasses.get(current.typeName)?.base
      ?? context.semanticInfo.foreignInterfaces.get(`${moduleName}.${current.superName}`);
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
    current = context.semanticInfo.objcSubclasses.get(current.typeName)?.base
      ?? context.semanticInfo.foreignInterfaces.get(`${moduleName}.${current.superName}`);
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

function foreignSelectiveBindings(
  context: Pick<AnalyzedSource, "foreignModules" | "sourceProgram">,
): Map<string, {
  readonly module: ForeignModule;
  readonly importedName: string;
  readonly tokenType: (typeof semanticTokenTypes)[number];
}> {
  const bindings = new Map<string, {
    readonly module: ForeignModule;
    readonly importedName: string;
    readonly tokenType: (typeof semanticTokenTypes)[number];
  }>();
  for (const declaration of context.sourceProgram.imports) {
    if (isLocalSourceModuleSpecifier(declaration.header) || !declaration.bindings) continue;
    const module = context.foreignModules.get(declaration.moduleName);
    if (!module) continue;
    for (const binding of declaration.bindings) {
      const tokenType = foreignModuleMemberTokenType(module, binding.importedName);
      if (tokenType) {
        bindings.set(binding.localName, {
          module,
          importedName: binding.importedName,
          tokenType,
        });
      }
    }
  }
  return bindings;
}

function foreignModuleMemberTokenType(
  module: ForeignModule,
  name: string,
): (typeof semanticTokenTypes)[number] | null {
  if (module.namespaces.has(name)) return "namespace";
  if (resolveModuleFunction(module, [], name)) return "function";
  const named = resolveModuleNamedType(module, [], name);
  if (named) return named.kind === "enum" ? "enum" : "type";
  if (module.interfaces.has(name)) return "class";
  if (module.protocols.has(name)) return "interface";
  if (module.constants.has(name)) return "property";
  return null;
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
  if (named.kind === "record" && named.viewOnly) {
    return `${named.exportName}: view ${named.cName}${executor}  // native record; pointer-bearing fields are hidden`;
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
      return concreteField.optional
        ? optionalLiteralFieldDetail(
            concreteField.name,
            displayType(concreteField.type.name, context.typeDisplayNames),
          )
        : `${concreteField.name}: ${displayType(concreteField.type.name, context.typeDisplayNames)}`;
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
  const fieldType = displaySubstitutedType(field.type.name, substitutions, context.typeDisplayNames);
  return field.optional
    ? optionalLiteralFieldDetail(field.name, fieldType)
    : `${field.name}: ${fieldType}`;
}

function optionalLiteralFieldDetail(name: string, storedType: string): string {
  const payload = /^Option<(.+)>$/.exec(storedType)?.[1] ?? storedType;
  return `${name}?: ${payload}  // accepts ${payload} or ${storedType}; omission initializes Option.none`;
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
    const constant = program.constants.find((item) => item.name === name);
    if (constant) {
      const type = constant.type?.name ?? (
        constant.initializer.kind === "string"
          ? "String"
          : constant.initializer.kind === "boolean"
            ? "boolean"
            : constant.initializer.kind === "number" || constant.initializer.kind === "unary"
              ? "i32"
              : "unknown"
      );
      return markdownHover(
        `const ${constant.name}: ${displayType(type, typeDisplayNames)}`,
        source,
        start,
        end,
      );
    }
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
          Boolean(fn.threadContract),
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
      const mixedClass = struct.kind === "class" && !struct.executorAffinity && Boolean(info);
      const executor = !mixedClass && (info || struct.executorAffinity) ? " on thread.main" : "";
      const affinityDetail = mixedClass && info
        ? mixedClassLifecycleHover(info)
        : executorAffinityHover(info);
      return markdownHover(
        `${struct.kind} ${struct.name}${parameters}${executor}${affinityDetail}`,
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
  parameters: readonly {
    readonly name: string;
    readonly mode?: "value" | "in" | "inout" | "out";
    readonly type: { readonly name: string };
  }[],
  returnType: string,
  typeParameters: readonly string[] = [],
  typeDisplayNames: ReadonlyMap<string, string> = new Map(),
  typeParameterConstraints: readonly TypeParameterConstraint[] = [],
  isAsync = false,
  errorType: string | undefined = undefined,
  mainIsolated = false,
  anyThread = false,
): string {
  const generic = formatTypeParameters(typeParameters, typeParameterConstraints, typeDisplayNames);
  const asyncPrefix = isAsync ? "async " : "";
  const throws = errorType ? ` throws ${displayType(errorType, typeDisplayNames)}` : "";
  const executor = mainIsolated ? " on thread.main" : anyThread ? " on thread.any" : "";
  return `${asyncPrefix}function ${name}${generic}(${parameters.map((item) => {
    const capability = item.mode && item.mode !== "value" ? `${item.mode} ` : "";
    return `${capability}${item.name}: ${displayType(item.type.name, typeDisplayNames)}`;
  }).join(", ")}): ${displayType(returnType, typeDisplayNames)}${throws}${executor}`;
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
  const generic = formatTypeParameters(
    genericParameters,
    method.typeParameterConstraints ?? [],
    typeDisplayNames,
  );
  const receiver = !method.static && method.receiverMode
    ? [`${method.receiverMode} this`]
    : [];
  const parameters = [...receiver, ...method.parameters.map((parameter) => {
    const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
    return `${capability}${parameter.name}: ${displaySubstitutedType(parameter.type.name, substitutions, typeDisplayNames)}`;
  })];
  const result = displaySubstitutedType(method.returnType.name, substitutions, typeDisplayNames);
  const throws = method.errorType
    ? ` throws ${displaySubstitutedType(method.errorType.name, substitutions, typeDisplayNames)}`
    : "";
  const executor = method.executorAffinity ? " on thread.main" : "";
  const override = method.override ? " override" : "";
  const selector = method.override && method.nativeSelector ? ` as ${JSON.stringify(method.nativeSelector)}` : "";
  return `${visibility}${override}${staticPrefix}${asyncPrefix} function ${method.name}${generic}(${parameters.join(", ")}): ${result}${throws}${executor}${selector}`;
}

function executorBoundClassTransportHover(
  typeName: string,
  context: AnalyzedSource,
): string {
  const internalName = [...context.typeDisplayNames]
    .find(([, displayName]) => displayName === typeName)?.[0] ?? typeName;
  const declaration = context.program.structs.find((candidate) => (
    candidate.name === internalName || candidate.name === typeName
  ));
  const affinity = context.semanticInfo.aggregateExecutorAffinities.get(internalName)
    ?? context.semanticInfo.aggregateExecutorAffinities.get(typeName);
  if (declaration?.kind !== "class" || !affinity) return "";
  return `\n// transportable ARC handle; isolated ${displayType(
    internalName,
    context.typeDisplayNames,
  )} members still require thread.main`;
}

function executorAffinityHover(info: ExecutorAffinityInfo | undefined): string {
  if (!info) return "";
  if (info.reason === "mixedClassSafety") {
    return "\n// executor-isolated to thread.main because this mixed-affinity member is mutable or not thread-shareable";
  }
  if (info.declared) return "\n// executor-isolated to thread.main";
  const path = info.fieldPath.length ? ` through ${info.fieldPath.join(".")}` : "";
  return `\n// executor-isolated to thread.main (inherited from ${info.originType}${path})`;
}

function mixedClassLifecycleHover(info: ExecutorAffinityInfo): string {
  const path = info.fieldPath.length ? ` through ${info.fieldPath.join(".")}` : "";
  return `\n// construction and destruction on thread.main${path}; members keep their individual executor contracts`;
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
  const readonly = parseReadonlyType(type);
  if (readonly) return `readonly ${displayType(readonly.target, typeDisplayNames)}`;
  const known = typeDisplayNames.get(type);
  // A linked aggregate display name can itself contain encoded nested types.
  // Reconstruct containers below so those implementation identities never
  // leak into hover or completion text.
  if (known && !known.includes("__z_")) return known;
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
  const option = parseOptionType(type);
  if (option) return `Option<${displayType(option.target, typeDisplayNames)}>`;
  const map = parseMapType(type);
  if (map) {
    const prefix = map.readonly ? "readonly " : "";
    return `${prefix}Map<${displayType(map.keyType, typeDisplayNames)}, ${displayType(map.valueType, typeDisplayNames)}>`;
  }
  const set = parseSetType(type);
  if (set) {
    const prefix = set.readonly ? "readonly " : "";
    return `${prefix}Set<${displayType(set.elementType, typeDisplayNames)}>`;
  }
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

function ownershipOperandBinding(
  source: string,
  operatorEnd: number,
  bindings: readonly Binding[],
  fileName: string,
): Binding | null {
  const operand = source.slice(operatorEnd).match(/^\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (!operand?.[1]) return null;
  const operandOffset = operatorEnd + operand[0].lastIndexOf(operand[1]);
  return bindings
    .filter((candidate) => (
      candidate.name === operand[1]
      && candidate.offset <= operandOffset
      && (!candidate.fileName || resolve(candidate.fileName) === resolve(fileName))
    ))
    .sort((left, right) => left.offset - right.offset)
    .at(-1) ?? null;
}

function primitiveTypeHover(type: string): string {
  if (type === "String") return "String  // owned UTF-8 value with deterministic cleanup";
  if (type === "cstring") return "cstring  // borrowed NUL-terminated C string; valid only for its proven native lifetime";
  if (type === "boolean") return "boolean  // true or false; no truthiness coercion";
  if (type === "void") return "void  // no value is produced";
  if (/^[iu](?:8|16|32|64)$/.test(type)) {
    const signed = type.startsWith("i") ? "signed" : "unsigned";
    return `${type}  // fixed-width ${signed} integer; arithmetic is checked by default`;
  }
  if (type === "usize" || type === "isize") {
    const signed = type === "isize" ? "signed" : "unsigned";
    return `${type}  // target-pointer-width ${signed} integer`;
  }
  if (type === "f32" || type === "f64") return `${type}  // IEEE 754 floating-point value`;
  if (type === "Slice") return "Slice<T>  // borrowed contiguous elements; non-owning and non-escaping";
  if (type === "Array") return "Array<T>  // owned growable contiguous collection";
  if (type === "Option") return "Option<T>  // explicit some(T) or none presence";
  if (type === "Result") return "Result<T, E>  // explicit success(T) or failure(E) outcome";
  if (type === "Task") return "Task<T, E?>  // owned handle to structured asynchronous work";
  if (type === "Weak") return "Weak<T>  // non-owning ARC identity that must be upgraded before use";
  return type;
}

function sourceTypeParameterHover(
  context: AnalyzedSource,
  name: string,
  offset: number,
): string | null {
  const declarations = [
    ...context.sourceProgram.functions,
    ...context.sourceProgram.structs,
    ...context.sourceProgram.structs.flatMap((declaration) => declaration.methods),
    ...context.sourceProgram.traits,
    ...context.sourceProgram.traits.flatMap((declaration) => declaration.methods),
  ].filter((declaration) => (
    declaration.location.offset <= offset
    && declaration.typeParameters?.includes(name)
  )).sort((left, right) => left.location.offset - right.location.offset);
  const declaration = declarations.at(-1);
  if (!declaration) return null;
  const constraints = declaration.typeParameterConstraints
    ?.find((constraint) => constraint.parameter === name)
    ?.traits.map((trait) => displayType(trait.name, context.typeDisplayNames)) ?? [];
  const constrained = constraints.length > 0 ? `: ${constraints.join(" & ")}` : "";
  return `${name}${constrained}  // type parameter`;
}

function sourceCallableAliasParameterHover(
  context: AnalyzedSource,
  source: string,
  name: string,
  offset: number,
): string | null {
  for (const declaration of context.sourceProgram.typeAliases) {
    const start = declaration.location.offset;
    if (offset < start) continue;
    const end = source.indexOf(";", start);
    if (end < 0 || offset > end) continue;
    const callable = parseFunctionType(declaration.target.name);
    const parameter = callable?.parameters.find((candidate) => candidate.name === name);
    if (!parameter) continue;
    const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
    return `${capability}${name}: ${displayType(parameter.type, context.typeDisplayNames)}  // callable parameter`;
  }
  return null;
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

function numericConversionHover(conversion: NumericConversion): string {
  const behavior = conversion.checked
    ? "runtime representability check; traps rather than changing the value"
    : "source range is fully representable; lowers to a direct value-preserving cast";
  const representation = conversion.sourceDisplayType
    ? `\n// native enum representation: ${conversion.sourceType}`
    : "";
  return `${conversion.targetType}(value: ${conversion.sourceDisplayType ?? conversion.sourceType}): ${conversion.targetType}\n// explicit value-preserving numeric conversion${representation}\n// ${behavior}`;
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
        functionType.thread,
        functionType.async,
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

type MemberReceiver = {
  readonly text: string;
  readonly start: number;
};

function receiverSemanticOffsets(text: string, start: number): number[] {
  const offsets = [start];
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\"" || character === "'" || character === "`") {
      const quote = character;
      for (index += 1; index < text.length; index += 1) {
        if (text[index] !== quote) continue;
        let escapes = 0;
        for (let probe = index - 1; probe >= 0 && text[probe] === "\\"; probe -= 1) escapes += 1;
        if (escapes % 2 === 0) break;
      }
      continue;
    }
    const topLevel = parentheses === 0 && brackets === 0 && braces === 0;
    if (topLevel && (character === "(" || character === "[")) offsets.push(start + index);
    if (topLevel && character === ".") {
      let member = index + 1;
      while (member < text.length && /\s/.test(text[member])) member += 1;
      if (/[A-Za-z_]/.test(text[member] ?? "")) offsets.push(start + member);
    }
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
  }
  return offsets;
}

function memberReceiverBeforeMember(source: string, memberStart: number): MemberReceiver | null {
  let dot = memberStart - 1;
  while (dot >= 0 && /\s/.test(source[dot])) dot -= 1;
  return source[dot] === "." ? memberReceiverBeforeDot(source, dot) : null;
}

function memberReceiverBeforeDot(source: string, dot: number): MemberReceiver | null {
  let end = dot;
  while (end > 0 && /\s/.test(source[end - 1])) end -= 1;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let angles = 0;
  let cursor = end - 1;
  for (; cursor >= 0; cursor -= 1) {
    const character = source[cursor];
    const nested = () => parentheses > 0 || brackets > 0 || braces > 0 || angles > 0;
    if (character === "\"" || character === "'" || character === "`") {
      const quote = character;
      cursor -= 1;
      while (cursor >= 0) {
        if (source[cursor] === quote) {
          let escapes = 0;
          for (let probe = cursor - 1; probe >= 0 && source[probe] === "\\"; probe -= 1) escapes += 1;
          if (escapes % 2 === 0) break;
        }
        cursor -= 1;
      }
      continue;
    }
    if (character === ")") { parentheses += 1; continue; }
    if (character === "]") { brackets += 1; continue; }
    if (character === "}") { braces += 1; continue; }
    if (character === "(" && parentheses > 0) { parentheses -= 1; continue; }
    if (character === "[" && brackets > 0) { brackets -= 1; continue; }
    if (character === "{" && braces > 0) { braces -= 1; continue; }
    if (parentheses === 0 && brackets === 0 && braces === 0) {
      if (character === ">") { angles += 1; continue; }
      if (character === "<" && angles > 0) { angles -= 1; continue; }
    }
    if (nested()) continue;
    if (/\s/.test(character) || /[;=,+\-*/%!?:&|^~{}()[\]]/.test(character)) break;
  }
  const start = cursor + 1;
  const text = source.slice(start, end);
  return text && /[A-Za-z0-9_\])}>]$/.test(text) ? { text, start } : null;
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
