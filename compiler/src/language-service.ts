import type {
  Expression,
  ObjectExpression,
  Program,
  SourceLocation,
  Statement,
  StructDeclaration,
  StructExpression,
  TypeParameterConstraint,
} from "./ast.ts";
import { analyzeSource, type AnalyzedSource } from "./compiler.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type {
  ForeignDeclarationMetadata,
  ForeignFunction,
  ForeignModule,
  ForeignObjCInterface,
  ForeignObjCMethod,
  ForeignObjCProperty,
  ForeignType,
  ForeignNamedType,
} from "./foreign.ts";
import { lex } from "./lexer.ts";
import { parseDynamicArrayType, parseFixedArrayType, parseSliceType } from "./array-types.ts";
import { parseGenericType } from "./generic-types.ts";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isLocalSourceModuleSpecifier, type SourceModuleInfo } from "./modules.ts";
import { displayFunctionType, functionTypeName, parseFunctionType } from "./function-types.ts";
import { displayTaskType, parseTaskType } from "./async-types.ts";
import { parseWeakType } from "./weak-types.ts";
import { parseViewType } from "./view-types.ts";
import {
  parseForeignDeclarationContracts,
  type ForeignDeclarationContracts,
} from "./foreign-declarations.ts";

export type Position = { readonly line: number; readonly character: number };
export type Range = { readonly start: Position; readonly end: Position };
export type ServiceDiagnostic = {
  readonly range: Range;
  readonly severity: 1;
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
  interface: 8,
  keyword: 14,
} as const;

const sourceKeywordTokens = [
  "as", "async", "attempt", "await", "break", "class", "const", "constructor",
  "continue", "declare", "deinit", "else", "enum", "export", "for", "from",
  "function", "if", "implements", "import", "in", "inout", "let", "match", "module",
  "move", "mut", "new", "of", "out", "private", "public", "return", "scope", "select",
  "spawn", "static", "struct", "throw", "throws", "trait", "try", "unsafe", "view",
  "weak", "while", "yield",
] as const;

const primitiveTypeTokens = [
  "void", "bool", "String", "cstring", "Slice", "Array", "i8", "i16", "i32", "i64",
  "u8", "u16", "u32", "u64", "f32", "f64", "usize", "isize",
] as const;

const declarationKeywordTokens = [
  "declare", "module", "export", "function", "type", "copy", "in", "inout", "out", "move", "deinit",
  "callback", "context", "thread", "caller",
] as const;

export function diagnostics(source: string, fileName: string): ServiceDiagnostic[] {
  try {
    if (fileName.endsWith(".zd")) parseForeignDeclarationContracts(source, fileName);
    else analyzeSource(source, fileName, { requireMain: false });
    return [];
  } catch (error) {
    const diagnostic = error instanceof DiagnosticError ? error : null;
    const crossFile = diagnostic ? resolve(diagnostic.fileName) !== resolve(fileName) : false;
    const location = diagnostic && !crossFile
      ? diagnostic.location
      : { offset: 0, line: 1, column: 1 };
    const start = { line: location.line - 1, character: location.column - 1 };
    const length = diagnostic?.length ?? 1;
    const relatedInformation = diagnostic?.labels.map((label) => {
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
    }) ?? [];
    if (diagnostic && crossFile) {
      const origin = { line: diagnostic.location.line - 1, character: diagnostic.location.column - 1 };
      relatedInformation.unshift({
        location: {
          uri: diagnosticUri(diagnostic.fileName),
          range: {
            start: origin,
            end: { line: origin.line, character: origin.character + diagnostic.length },
          },
        },
        message: "error originates in an imported Z module or declaration contract",
      });
    }
    return [{
      range: { start, end: { line: start.line, character: start.character + length } },
      severity: 1,
      source: "z",
      code: diagnostic?.code ?? undefined,
      message: diagnostic
        ? [crossFile ? `${diagnostic.fileName}: ${diagnostic.summary}` : diagnostic.summary, ...diagnostic.notes.map((note) => `note: ${note}`), ...diagnostic.helps.map((help) => `help: ${help}`)].join("\n")
        : error instanceof Error ? error.message : String(error),
      relatedInformation: relatedInformation?.length ? relatedInformation : undefined,
      data: diagnostic?.helps.length ? { helps: diagnostic.helps } : undefined,
    }];
  }
}

export function completions(source: string, fileName: string, offset: number): CompletionItem[] {
  if (fileName.endsWith(".zd")) return foreignDeclarationCompletions(source, fileName, offset);
  const before = source.slice(0, offset);
  const member = before.match(/([A-Za-z_][A-Za-z0-9_]*(?:<[^<>]+>)?(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (member) return memberCompletions(source, fileName, offset, member[1], member[2] ?? "");
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
  const methodDeclarations = new Set(
    context.sourceProgram.structs.flatMap((declaration) => declaration.methods.map((method) => method.location.offset)),
  );
  const fieldInitializers = new Set(collectStructLiteralFields(context.sourceProgram).map((item) => item.location.offset));
  const traitNames = new Set(context.program.traits.map((item) => item.name));
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

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const keywordMember = previous?.kind === "dot" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.text);
    if (token.kind !== "identifier" && !keywordMember) continue;
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
        modifiers: 1,
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
    if (context.semanticInfo.standardFunctionBindings.has(token.text)) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("function"), modifiers: 4 });
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
      if (module?.namespaces.has(memberPath.join("."))) {
        classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("namespace"), modifiers: 4 });
      } else if (namespacePath.length === 0 && module?.interfaces.has(memberName)) {
        classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("class"), modifiers: 4 });
      } else if (named) {
        classifications.set(token.location.offset, {
          type: semanticTokenTypes.indexOf(named.kind === "enum" ? "enum" : "type"),
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
  const directWordType = context.semanticInfo.bindingTypes.get(word.start)
    ?? context.semanticInfo.numericLiteralTypes.get(word.start)
    ?? context.semanticInfo.expressionTypes.get(word.start);

  const declaredField = context.sourceProgram.structs
    .flatMap((declaration) => declaration.fields)
    .find((field) => field.location.offset === word.start && field.name === word.text);
  if (declaredField) {
    return markdownHover(`${declaredField.visibility} ${declaredField.name}: ${displayType(declaredField.type.name, context.typeDisplayNames)}`, source, word.start, word.end);
  }
  const declaredMethod = context.sourceProgram.structs
    .flatMap((declaration) => declaration.methods)
    .find((method) => (
      method.name === word.text
      && method.location.offset <= word.start
      && new RegExp(`^function\\s+${word.text}$`).test(source.slice(method.location.offset, word.end))
    ));
  if (declaredMethod) {
    return markdownHover(methodDetail(declaredMethod, context.typeDisplayNames), source, word.start, word.end);
  }

  const literalField = structLiteralFieldHover(context, word.start);
  if (literalField) return markdownHover(literalField, source, word.start, word.end);

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
    return markdownHover(
      `${capability}${matchBinding.binding}: ${displayType(matchBinding.payloadType, context.typeDisplayNames)}`,
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
  const standardFunction = context.semanticInfo.standardFunctionBindings.get(word.text);
  if (standardFunction) {
    return markdownHover(standardFunctionDetail(word.text, standardFunction), source, word.start, word.end);
  }

  const chainedSelector = objectiveCSelectorAt(context, word.start);
  if (chainedSelector) {
    const details = new Set<string>();
    for (const declaration of context.semanticInfo.foreignInterfaces.values()) {
      for (const method of declaration.methods) {
        if (method.selector === chainedSelector && method.baseName === word.text) details.add(objCMethodDetail(method));
      }
    }
    if (details.size > 0) return markdownHover([...details].join("\n"), source, word.start, word.end);
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
    if (memberPrefix[1] === "String" && word.text === "from") {
      return markdownHover("from(value: cstring): String  // copies borrowed C bytes", source, word.start, word.end);
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
      const item = describeModuleMember(resolved.module, resolved.namespacePath, word.text);
      if (item) return markdownHover(item, source, word.start, word.end);
    }
    if (resolved?.kind === "objc") {
      const property = collectObjCProperties(resolved.declaration, resolved.instance, context).find((item) => item.name === word.text);
      if (property) return markdownHover(`${property.name}: ${foreignTypeName(property.type)}${foreignAvailabilityDetail(property.metadata)}`, source, word.start, word.end);
      const methods = collectObjCMethods(resolved.declaration, resolved.instance, context).filter((item) => item.baseName === word.text);
      if (methods.length) return markdownHover(methods.map(objCMethodDetail).join("\n"), source, word.start, word.end);
    }
    if (resolved?.kind === "struct") {
      const field = resolved.declaration.fields.find((item) => item.name === word.text);
      if (field) return markdownHover(`${field.visibility} ${field.name}: ${displayType(field.type.name, context.typeDisplayNames)}`, source, word.start, word.end);
      const method = resolved.declaration.methods.find((item) => item.name === word.text);
      if (method) return markdownHover(methodDetail(method, context.typeDisplayNames), source, word.start, word.end);
    }
    if (resolved?.kind === "weak" && word.text === "upgrade") {
      return markdownHover(`upgrade(): ${displayType(resolved.target, context.typeDisplayNames)} throws WeakExpired`, source, word.start, word.end);
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
  }

  const type = directWordType;
  if (type) {
    const binding = collectBindings(context)
      .filter((candidate) => candidate.name === word.text && candidate.offset <= word.start)
      .at(-1);
    const owner = context.semanticInfo.viewBindingOwners.get(binding?.offset ?? word.start);
    const provenance = owner ? `  // view of ${owner}` : "";
    return markdownHover(`${word.text}: ${displayServiceType(type, context)}${provenance}`, source, word.start, word.end);
  }
  return declarationHover(source, context.sourceProgram, word.text, word.start, word.end, context.typeDisplayNames);
}

export function definition(source: string, uri: string, offset: number): Location | null {
  const word = wordAt(source, offset);
  if (!word) return null;
  const fileName = uriToFileName(uri);
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
    const declarationKeyword = previous && ["function", "struct", "class", "trait", "enum", "const", "let"].includes(previous.kind);
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
  const chainedSelector = objectiveCSelectorAt(context, word.start);
  if (chainedSelector) {
    for (const declaration of context.semanticInfo.foreignInterfaces.values()) {
      const method = declaration.methods.find((candidate) => (
        candidate.selector === chainedSelector && candidate.baseName === word.text
      ));
      const target = method ? foreignMetadataLocation(method.metadata) : null;
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
        ?? resolved.module.interfaces.get(word.text);
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
      ?? module?.interfaces.get(binding.importedName) : null;
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

function symbolCompletions(source: string, fileName: string, offset: number): CompletionItem[] {
  const prefix = source.slice(0, offset).match(/([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
  if (!prefix) return [];
  const builtIns: CompletionItem[] = [{
    label: "Option",
    kind: completionKinds.enum,
    detail: "compiler-provided enum Option<T>",
  }];
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
      detail: `${binding.parameter ? "parameter" : binding.readonly ? "const" : "let"} ${binding.name}: ${displayServiceType(binding.type, context)}`,
      sortText: `0-${binding.name}`,
    });
  }
  for (const declaration of context.program.functions) {
    if (declaration.name.startsWith("__z_mono_") || declaration.name.startsWith("__z_module_")) continue;
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
      ),
    });
  }
  for (const declaration of context.program.structs) {
    if (declaration.name.startsWith("__z_mono_") || declaration.name.startsWith("__z_module_")) continue;
    items.push({
      label: declaration.name,
      kind: declaration.kind === "class" ? completionKinds.class : completionKinds.struct,
      detail: `${declaration.kind} ${declaration.name}`,
    });
  }
  for (const match of source.matchAll(/\b(function|struct|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*<([^>]+)>/g)) {
    const kind = match[1] === "function" ? completionKinds.function : match[1] === "class" ? completionKinds.class : completionKinds.struct;
    items.push({ label: match[2], kind, detail: `${match[1]} ${match[2]}<${match[3].trim()}>` });
  }
  for (const declaration of context.program.traits) {
    if (declaration.name.startsWith("__z_module_")) continue;
    items.push({ label: declaration.name, kind: completionKinds.interface, detail: `trait ${declaration.name}` });
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
  for (const [name, standardFunction] of context.semanticInfo.standardFunctionBindings) {
    items.push({
      label: name,
      kind: completionKinds.function,
      detail: standardFunctionDetail(name, standardFunction),
      sortText: `0-${name}`,
    });
  }
  const semanticLabels = new Set(items.map((item) => item.label));
  items.push(...tokenItems.filter((item) => !semanticLabels.has(item.label)));
  return filterCompletions(uniqueCompletions(items), prefix, 500);
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
    );
  }
  return items;
}

function foreignDeclarationCompletions(source: string, fileName: string, offset: number): CompletionItem[] {
  const before = source.slice(0, offset);
  const prefix = before.match(/([A-Za-z_][A-Za-z0-9_.]*)$/)?.[1] ?? "";
  if (!prefix) return [];
  const module = foreignDeclarationNativeModule(source, fileName);
  const contextual: CompletionItem[] = [];
  const ownerName = [...before.matchAll(/\bexport\s+function\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].at(-1)?.[1];
  const owner = ownerName ? module?.functions.get(ownerName) : null;

  const typePrefix = /\bexport\s+type\s+([A-Za-z_][A-Za-z0-9_.]*)?$/.exec(before)?.[1];
  if (module && typePrefix !== undefined) {
    const declared = new Set([...source.matchAll(/\bexport\s+type\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\{/g)].map((match) => match[1]));
    for (const declaration of module.namedTypes.values()) {
      if (declaration.kind !== "value"
        || declared.has(declaration.qualifiedName)
        || !declaration.qualifiedName.toLowerCase().startsWith(typePrefix.toLowerCase())) continue;
      contextual.push({
        label: declaration.qualifiedName,
        kind: completionKinds.struct,
        detail: foreignNamedTypeDetail(declaration),
        sortText: `0-${declaration.qualifiedName}`,
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
  }

  const deinitPrefix = /\bdeinit\s+([A-Za-z_][A-Za-z0-9_.]*)?$/.exec(before)?.[1];
  if (module && deinitPrefix !== undefined) {
    const returnTypes = new Set(owner?.overloads.map((overload) => foreignTypeName(overload.returnType).replace(/ \| null$/, "")) ?? []);
    const candidates = [...module.functions].filter(([, declaration]) => declaration.overloads.some((overload) => (
      overload.parameters.length === 1
      && (returnTypes.size === 0 || returnTypes.has(foreignTypeName(overload.parameters[0].type).replace(/ \| null$/, "")))
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

  const callbackDeinitPrefix = /\bcallback\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[^}]*\bdeinit\s+([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before)?.[1];
  if (owner && callbackDeinitPrefix !== undefined) {
    const candidates = new Map<string, string>();
    for (const overload of owner.overloads) {
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
  if (owner && callbackContractPrefix !== undefined) {
    const candidates = new Map<string, string>();
    for (const overload of owner.overloads) {
      for (const parameter of overload.parameters) {
        if (parameter.name && parameter.type.kind === "callback") {
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

  const contextContractPrefix = /\bcallback\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*context\s+([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);
  if (owner && contextContractPrefix?.[2] !== undefined) {
    const candidates = new Map<string, string>();
    for (const overload of owner.overloads) {
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
    const declaration = module.functions.get(parameterContext[1]);
    const parameterIndex = topLevelCommaCount(parameterContext[2]);
    const names = new Map<string, string>();
    for (const overload of declaration?.overloads ?? []) {
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
    ? `${fileName.slice(0, -suffix.length)}__zd_editor.z`
    : resolve(dirname(fileName), "__zd_editor.z");
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
    if (!declaration || declaration.kind !== "value") continue;
    if (containsDeclarationName(contract.nameLocation.offset, contract.name, word.start)) {
      return markdownHover(`type ${foreignNamedTypeDetail(declaration)}`, source, word.start, word.end);
    }
    for (const [capability, location] of [
      ["copy", contract.copyLocation],
      ["move", contract.moveLocation],
      ["deinit", contract.deinitLocation],
    ] as const) {
      if (location?.offset === word.start) {
        return markdownHover(`${capability}: native lifecycle capability of ${declaration.cName}`, source, word.start, word.end);
      }
    }
  }

  for (const contract of contracts.functions) {
    const declaration = module.functions.get(contract.name);
    if (containsDeclarationName(contract.nameLocation.offset, contract.name, word.start) && declaration) {
      return markdownHover(foreignFunctionDetail(declaration), source, word.start, word.end);
    }
    const parameterIndex = contract.parameters.findIndex((parameter) => parameter.location.offset === word.start);
    if (parameterIndex >= 0) {
      const parameter = contract.parameters[parameterIndex];
      const types = new Set(declaration?.overloads.map((overload) => overload.parameters[parameterIndex]).filter(Boolean).map((native) => foreignTypeName(native.type)) ?? []);
      const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
      return markdownHover(`${capability}${parameter.name}: ${[...types].join(" | ") || "_"}  // inferred from native parameter`, source, word.start, word.end);
    }
    const parameterTypeIndex = contract.parameters.findIndex((parameter) => parameter.typeLocation.offset === word.start);
    if (parameterTypeIndex >= 0) {
      const types = new Set(declaration?.overloads.map((overload) => overload.parameters[parameterTypeIndex]).filter(Boolean).map((native) => foreignTypeName(native.type)) ?? []);
      return markdownHover(`_: ${[...types].join(" | ") || "unknown"}  // inferred native parameter type`, source, word.start, word.end);
    }
    if (contract.returnLocation.offset === word.start) {
      const types = new Set(declaration?.overloads.map((overload) => foreignTypeName(overload.returnType)) ?? []);
      const lifecycle = contract.release ? `; deinit ${contract.release}` : "";
      return markdownHover(`_: ${[...types].join(" | ") || "unknown"}${lifecycle}  // inferred native return type`, source, word.start, word.end);
    }
    if (contract.release && contract.releaseLocation
      && containsDeclarationName(contract.releaseLocation.offset, contract.release, word.start)) {
      const release = module.functions.get(contract.release);
      if (release) {
        return markdownHover(`${foreignFunctionDetail(release)}\n// deinitializer for ${contract.name} result`, source, word.start, word.end);
      }
    }
    for (const callback of contract.callbacks) {
      const callbackIndex = contract.parameters.findIndex((parameter) => parameter.name === callback.parameter);
      const contextIndex = contract.parameters.findIndex((parameter) => parameter.name === callback.context);
      const releaseIndex = callback.release
        ? contract.parameters.findIndex((parameter) => parameter.name === callback.release)
        : -1;
      if (callback.parameterLocation.offset === word.start) {
        const types = new Set(
          declaration?.overloads
            .map((overload) => overload.parameters[callbackIndex])
            .filter(Boolean)
            .map((native) => foreignTypeName(native.type)) ?? [],
        );
        const mode = contract.parameters[callbackIndex]?.mode ?? "in";
        const lifetime = mode === "move" ? "escaping retained callback" : "call-scoped callback";
        return markdownHover(
          `${mode} ${callback.parameter}: ${[...types].join(" | ") || "_"}  // ${lifetime} using native context ${callback.context}`,
          source,
          word.start,
          word.end,
        );
      }
      if (callback.contextLocation.offset === word.start) {
        const types = new Set(
          declaration?.overloads
            .map((overload) => overload.parameters[contextIndex])
            .filter(Boolean)
            .map((native) => foreignTypeName(native.type)) ?? [],
        );
        return markdownHover(
          `${callback.context}: ${[...types].join(" | ") || "_"}  // native context for callback ${callback.parameter}`,
          source,
          word.start,
          word.end,
        );
      }
      if (callback.release && callback.releaseLocation?.offset === word.start) {
        const types = new Set(
          declaration?.overloads
            .map((overload) => overload.parameters[releaseIndex])
            .filter(Boolean)
            .map((native) => foreignTypeName(native.type)) ?? [],
        );
        return markdownHover(
          `${callback.release}: ${[...types].join(" | ") || "_"}  // exactly-once native release for callback ${callback.parameter}`,
          source,
          word.start,
          word.end,
        );
      }
      if (callback.threadLocation?.offset === word.start) {
        return markdownHover(
          "caller  // native code invokes and releases this callback only on the registering thread",
          source,
          word.start,
          word.end,
        );
      }
    }
  }
  return null;
}

function containsDeclarationName(start: number, name: string, offset: number): boolean {
  return offset >= start && offset < start + name.length;
}

function standardFunctionDetail(localName: string, name: "sleep" | "delay"): string {
  const signature = name === "delay"
    ? `async ${localName}(milliseconds: u64): void  // suspends the current task`
    : `${localName}(milliseconds: u64): void  // blocks the current thread`;
  return localName === name ? signature : `${signature} — alias of ${name} from "std/time"`;
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

function collectBindings(context: AnalyzedSource): Binding[] {
  const bindings: Binding[] = [];
  const seenClosures = new Set<number>();
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
  const visitStatements = (statements: readonly Statement[]): void => {
    for (const statement of statements) {
      if (statement.kind === "variable") {
        bindings.push({
          name: statement.name,
          type: context.semanticInfo.bindingTypes.get(statement.nameLocation.offset) ?? statement.type?.name ?? "unknown",
          offset: statement.nameLocation.offset,
          readonly: !statement.mutable,
          parameter: false,
          fileName: statement.nameLocation.fileName,
        });
        if (statement.initializer?.kind === "closure") visitClosure(statement.initializer);
      }
      if (statement.kind === "block") visitStatements(statement.statements);
      if (statement.kind === "if") {
        visitStatements(statement.thenBranch.statements);
        if (statement.elseBranch?.kind === "block") visitStatements(statement.elseBranch.statements);
        if (statement.elseBranch?.kind === "if") visitStatements([statement.elseBranch]);
      }
      if (statement.kind === "while") visitStatements(statement.body.statements);
      if (statement.kind === "asyncScope") visitStatements(statement.body.statements);
      if (statement.kind === "for") {
        bindings.push({
          name: statement.binding,
          type: context.semanticInfo.bindingTypes.get(statement.bindingLocation.offset) ?? "unknown",
          offset: statement.bindingLocation.offset,
          readonly: true,
          parameter: false,
          fileName: statement.bindingLocation.fileName,
        });
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

  const [moduleName, className, extra] = receiverText.split(".");
  if (!extra && moduleName && className) {
    const declaration = importContext.foreignModules.get(moduleName)?.interfaces.get(className);
    if (declaration) return filterCompletions(objcCompletions(declaration, false, importContext), prefix, 1000);
  }

  const receiverOffset = offset - receiverText.length - prefix.length - 1;
  const dotOffset = receiverOffset + receiverText.length;
  const tailOffset = completionTailOffset(source, offset);
  const sanitized = source.slice(0, dotOffset) + source.slice(tailOffset);
  const lengthSanitized = source.slice(0, dotOffset) + ".length" + source.slice(tailOffset);
  const upgradeSanitized = source.slice(0, dotOffset) + ".upgrade()" + source.slice(tailOffset);
  const statementTailOffset = source[tailOffset] === ";" ? tailOffset + 1 : tailOffset;
  const statementStart = Math.max(
    source.lastIndexOf(";", receiverOffset - 1),
    source.lastIndexOf("{", receiverOffset - 1),
    source.lastIndexOf("}", receiverOffset - 1),
  ) + 1;
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
  let context = safeAnalysis(sanitized, fileName)
    ?? safeAnalysis(statementSanitized, fileName)
    ?? safeAnalysis(lengthSanitized, fileName)
    ?? safeAnalysis(upgradeSanitized, fileName)
    ?? safeAnalysis(lengthStatementSanitized, fileName);
  let resolvedOffset = receiverOffset;
  if (!context) {
    const probePrefix = `${source.slice(0, statementStart)}const completionProbe = `;
    const probeSource = `${probePrefix}${receiverText};${source.slice(statementTailOffset)}`;
    context = safeAnalysis(probeSource, fileName);
    resolvedOffset = probePrefix.length;
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
  if (!context) return [];
  const resolved = resolveReceiver(context, receiverText, resolvedOffset);
  if (resolved?.kind === "objc") return filterCompletions(objcCompletions(resolved.declaration, resolved.instance, context), prefix, 1000);
  if (resolved?.kind === "struct") {
    const includePrivate = insideAggregateBody(source, fileName, offset, resolved.declaration.name);
    return filterCompletions(structCompletions(resolved.declaration, context.typeDisplayNames, includePrivate), prefix, 1000);
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
  | null {
  return module.program.functions.find((item) => item.name === name)
    ?? module.program.structs.find((item) => item.name === name)
    ?? module.program.traits.find((item) => item.name === name)
    ?? module.program.enums.find((item) => item.name === name)
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
    );
  }
  if (declaration.kind === "struct" || declaration.kind === "class") {
    return `${declaration.kind} ${displayName}${formatTypeParameters(
      declaration.typeParameters ?? [],
      declaration.typeParameterConstraints ?? [],
      typeDisplayNames,
    )}`;
  }
  return `${declaration.kind} ${displayName}`;
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
  | { readonly kind: "struct"; readonly declaration: StructDeclaration }
  | { readonly kind: "integer"; readonly type: string }
  | { readonly kind: "array"; readonly type: string }
  | { readonly kind: "weak"; readonly target: string };

function resolveReceiver(context: AnalyzedSource, text: string, offset: number): ResolvedReceiver | null {
  const nativeNamespace = resolveForeignModuleNamespace(context, text);
  if (nativeNamespace) return { kind: "module", ...nativeNamespace };
  const [moduleName, className, extra] = text.split(".");
  if (!extra && moduleName && className) {
    const declaration = context.foreignModules.get(moduleName)?.interfaces.get(className);
    if (declaration) return { kind: "objc", declaration, instance: false };
  }
  const type = context.semanticInfo.expressionTypes.get(offset);
  if (!type) return null;
  const view = parseViewType(type);
  const receiverType = view?.target ?? type;
  if (parseFixedArrayType(receiverType) || parseSliceType(receiverType) || parseDynamicArrayType(receiverType)) return { kind: "array", type: receiverType };
  const weak = parseWeakType(receiverType);
  if (weak) return { kind: "weak", target: weak.target };
  if (isIntegerSourceType(receiverType)) return { kind: "integer", type: receiverType };
  const interfaceName = receiverType.replace(/^__z_objc:(?:nullable|nonnull):/, "");
  const objc = context.semanticInfo.foreignInterfaces.get(interfaceName);
  if (objc) return { kind: "objc", declaration: objc, instance: true };
  const declaration = context.program.structs.find((item) => item.name === receiverType);
  return declaration ? { kind: "struct", declaration } : null;
}

function isIntegerSourceType(type: string): boolean {
  return /^(?:i8|u8|i16|u16|i32|u32|i64|u64|isize|usize)$/.test(type);
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
): CompletionItem[] {
  const items: CompletionItem[] = [];
  if (namespacePath.length === 0) {
    for (const declaration of module.interfaces.values()) {
      items.push({ label: declaration.exportName, kind: completionKinds.class, detail: `Objective-C class ${declaration.className}` });
    }
    for (const declaration of module.constants.values()) {
      items.push({ label: declaration.name, kind: completionKinds.constant, detail: declaration.typeName });
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
    items.push({ label: declaration.name, kind: completionKinds.function, detail: foreignFunctionDetail(declaration) });
  }
  if (namespacePath.length === 0) {
    for (const [alias, qualifiedName] of module.functionAliases) {
      const declaration = module.functions.get(qualifiedName);
      if (declaration?.namespacePath.length) {
        items.push({ label: alias, kind: completionKinds.function, detail: foreignFunctionDetail(declaration) });
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
  if (module.cPlusPlus) return unique.slice(0, 2500);
  return unique.filter((item) => (
    item.kind === completionKinds.class
    || ((item.kind === completionKinds.struct || item.kind === completionKinds.enum) && /^(?:NS|CG)/.test(item.label))
    || (item.kind === completionKinds.function && /^(?:NS|CG)/.test(item.label))
  )).slice(0, 2500);
}

function objcCompletions(declaration: ForeignObjCInterface, instance: boolean, context: AnalyzedSource): CompletionItem[] {
  const properties = collectObjCProperties(declaration, instance, context);
  const accessors = new Set(properties.flatMap((property) => [property.getter, property.setter].filter(Boolean)));
  const items: CompletionItem[] = properties.map((property) => ({
    label: property.name,
    kind: completionKinds.property,
    detail: `${property.readonly ? "readonly " : ""}${foreignTypeName(property.type)}`,
  }));
  for (const method of collectObjCMethods(declaration, instance, context)) {
    if (accessors.has(method.selector)) continue;
    items.push({
      label: method.baseName,
      kind: completionKinds.method,
      detail: objCMethodDetail(method),
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
): CompletionItem[] {
  return [
    ...declaration.fields
      .filter((field) => field.visibility === "public" || includePrivate)
      .map((field) => ({
        label: field.name,
        kind: completionKinds.field,
        detail: `${field.visibility} ${displayType(field.type.name, typeDisplayNames)}`,
      })),
    ...declaration.methods
      .filter((method) => !method.static && ((method.visibility ?? "public") === "public" || includePrivate))
      .map((method) => ({
      label: method.name,
      kind: completionKinds.method,
      detail: methodDetail(method, typeDisplayNames),
      insertText: `${method.name}()`,
    })),
  ];
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

function objCMethodSnippet(method: ForeignObjCMethod): string {
  if (method.parameters.length === 0) return `${method.baseName}()`;
  const parts = selectorParts(method.selector);
  const args = method.parameters.map((parameter, index) => {
    const placeholder = `\${${index + 1}:${parameter.name ?? "value"}}`;
    return index === 0 ? placeholder : `${parts[index]}: ${placeholder}`;
  });
  return `${method.baseName}(${args.join(", ")})`;
}

function objCMethodDetail(method: ForeignObjCMethod): string {
  const parameters = method.parameters.map((parameter, index) => {
    const label = selectorParts(method.selector)[index];
    const sourceName = index === 0 ? parameter.name ?? "value" : label;
    return `${sourceName}: ${foreignTypeName(parameter.type)}`;
  });
  return `${method.baseName}(${parameters.join(", ")}): ${foreignTypeName(method.returnType)}  // ${method.selector}${foreignAvailabilityDetail(method.metadata)}`;
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
  if (fn) return foreignFunctionDetail(fn);
  const named = resolveModuleNamedType(module, namespacePath, name);
  if (named) return `${foreignNamedTypeDetail(named)}${foreignAvailabilityDetail(named.metadata)}`;
  const namespaceName = [...namespacePath, name].join(".");
  if (module.namespaces.has(namespaceName)) return `native namespace ${namespaceName}`;
  if (namespacePath.length > 0) return null;
  const constant = module.constants.get(name);
  if (constant) return `${constant.name}: ${constant.typeName}${foreignAvailabilityDetail(constant.metadata)}`;
  const objc = module.interfaces.get(name);
  return objc ? `Objective-C class ${objc.className}${foreignAvailabilityDetail(objc.metadata)}` : null;
}

function foreignNamedTypeDetail(named: ForeignNamedType): string {
  if (named.kind !== "value") return `${named.exportName}: ${named.cName}`;
  const available = (["copy", "move", "deinit"] as const).filter((capability) => named.lifecycle[capability]);
  const unavailable = (["copy", "move", "deinit"] as const).filter((capability) => !named.lifecycle[capability]);
  const missing = unavailable.length ? `; unavailable: ${unavailable.join(", ")}` : "";
  return `${named.exportName}: ${named.cName}  // native value: ${available.join(", ")}${missing}`;
}

function foreignFunctionDetail(declaration: ForeignFunction): string {
  return declaration.overloads.map((overload) => {
    const parameters = overload.parameters
      .filter((parameter) => parameter.type.kind !== "callbackContext" && parameter.type.kind !== "callbackRelease")
      .map((parameter, index) => (
        `${parameter.name ?? `argument${index + 1}`}: ${foreignTypeName(parameter.type)}`
      ));
    if (overload.variadic) parameters.push("...arguments");
    return `${declaration.name}(${parameters.join(", ")}): ${foreignTypeName(overload.returnType)}  // C: ${overload.cSignature}${foreignAvailabilityDetail(overload.metadata)}`;
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
      return markdownHover(`${struct.kind} ${struct.name}${parameters}`, source, start, end);
    }
    const trait = program.traits.find((item) => item.name === name);
    if (trait) return markdownHover(`trait ${trait.name}`, source, start, end);
    const enumeration = program.enums.find((item) => item.name === name);
    if (enumeration) return markdownHover(`enum ${enumeration.name}`, source, start, end);
  }
  const generic = new RegExp(`\\b(function|struct|class)\\s+${name}\\s*<([^>]+)>`).exec(source);
  if (generic) return markdownHover(`${generic[1]} ${name}<${generic[2].trim()}>`, source, start, end);
  return null;
}

function objectiveCSelectorAt(context: AnalyzedSource, memberOffset: number): string | null {
  let selector: string | null = null;
  const visit = (value: unknown): void => {
    if (selector || value === null || typeof value !== "object") return;
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
      selector = context.semanticInfo.objcCalls.get(node.location.offset)?.selector ?? null;
      if (selector) return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(context.program);
  return selector;
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
): string {
  const generic = formatTypeParameters(typeParameters, typeParameterConstraints, typeDisplayNames);
  const asyncPrefix = isAsync ? "async " : "";
  const throws = errorType ? ` throws ${displayType(errorType, typeDisplayNames)}` : "";
  return `${asyncPrefix}function ${name}${generic}(${parameters.map((item) => `${item.name}: ${displayType(item.type.name, typeDisplayNames)}`).join(", ")}): ${displayType(returnType, typeDisplayNames)}${throws}`;
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
  return `${visibility}${staticPrefix}${asyncPrefix} function ${method.name}${generic}(${parameters.join(", ")}): ${result}${throws}`;
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

function foreignTypeName(type: ForeignType): string {
  if (type.kind === "z") return type.name;
  if (type.kind === "named") return type.type.typeName;
  if (type.kind === "object") return `${type.className ?? "id"}${type.nullable ? " | null" : ""}`;
  if (type.kind === "pointer") return `${type.cName}${type.nullable ? " | null" : ""}`;
  if (type.kind === "callback" || type.kind === "block") {
    const parameters = type.parameters.map((parameter, index) => `argument${index + 1}: ${foreignTypeName(parameter)}`);
    return `(${parameters.join(", ")}) => ${foreignTypeName(type.returnType)}`;
  }
  return type.cName;
}

function displayType(type: string, typeDisplayNames: ReadonlyMap<string, string> = new Map()): string {
  const known = typeDisplayNames.get(type);
  if (known) return known;
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
  if (pointer) return `${pointer.cName}${pointer.nullable ? " | null" : ""}`;
  const closure = [...context.semanticInfo.closures.values()].find((item) => item.type === type);
  if (!closure) return displayType(type, context.typeDisplayNames);
  const parameters = closure.declaration.parameters.slice(closure.captures.length).map((parameter) => {
    const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
    return `${capability}${parameter.name}: ${displayType(parameter.type.name, context.typeDisplayNames)}`;
  });
  return `(${parameters.join(", ")}) => ${displayType(closure.declaration.returnType.name, context.typeDisplayNames)}`;
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
