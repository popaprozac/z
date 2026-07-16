import type {
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
  ForeignModule,
  ForeignObjCInterface,
  ForeignObjCMethod,
  ForeignObjCProperty,
  ForeignType,
} from "./foreign.ts";
import { lex } from "./lexer.ts";
import { parseDynamicArrayType, parseFixedArrayType, parseSliceType } from "./array-types.ts";
import { parseGenericType } from "./generic-types.ts";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

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
  constant: 21,
  struct: 22,
  interface: 8,
} as const;

export function diagnostics(source: string, fileName: string): ServiceDiagnostic[] {
  try {
    analyzeSource(source, fileName);
    return [];
  } catch (error) {
    const location = error instanceof DiagnosticError
      ? error.location
      : { offset: 0, line: 1, column: 1 };
    const start = { line: location.line - 1, character: location.column - 1 };
    const diagnostic = error instanceof DiagnosticError ? error : null;
    const length = diagnostic?.length ?? 1;
    const relatedInformation = diagnostic?.labels.map((label) => {
      const labelStart = { line: label.location.line - 1, character: label.location.column - 1 };
      return {
        location: {
          uri: diagnosticUri(fileName),
          range: {
            start: labelStart,
            end: { line: labelStart.line, character: labelStart.character + (label.length ?? 1) },
          },
        },
        message: label.message,
      };
    });
    return [{
      range: { start, end: { line: start.line, character: start.character + length } },
      severity: 1,
      source: "z",
      code: diagnostic?.code ?? undefined,
      message: diagnostic
        ? [diagnostic.summary, ...diagnostic.notes.map((note) => `note: ${note}`), ...diagnostic.helps.map((help) => `help: ${help}`)].join("\n")
        : error instanceof Error ? error.message : String(error),
      relatedInformation: relatedInformation?.length ? relatedInformation : undefined,
      data: diagnostic?.helps.length ? { helps: diagnostic.helps } : undefined,
    }];
  }
}

export function completions(source: string, fileName: string, offset: number): CompletionItem[] {
  const before = source.slice(0, offset);
  const member = before.match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)?$/);
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
  const fieldInitializers = new Set(collectStructLiteralFields(context.sourceProgram).map((item) => item.location.offset));
  const traitNames = new Set(context.program.traits.map((item) => item.name));
  const enumNames = new Set(context.program.enums.map((item) => item.name));
  const enumVariantDeclarations = new Set(
    context.sourceProgram.enums.flatMap((declaration) => declaration.variants.map((variant) => variant.location.offset)),
  );
  const matchVariants = new Set(collectMatchArmInfos(context).map((item) => item.variantOffset));
  const modules = new Map([...context.foreignModules.keys()].map((name) => [name, context.foreignModules.get(name)!]));
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
    if (enumVariantDeclarations.has(token.location.offset) || matchVariants.has(token.location.offset)) {
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
    if (fieldInitializers.has(token.location.offset)) {
      classifications.set(token.location.offset, {
        type: semanticTokenTypes.indexOf("property"),
        modifiers: 0,
      });
      continue;
    }
    const namedBindings = bindingsByName.get(token.text) ?? [];
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
    if (
      previous?.kind === "dot"
      && consoleBindings.has(tokens[index - 2]?.text ?? "")
      && ["log", "write", "error", "debug"].includes(token.text)
    ) {
      classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("method"), modifiers: 4 });
      continue;
    }
    if (modules.has(token.text)) {
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
    if (token.text === "Slice" || token.text === "Array") {
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
      const module = namespaceToken ? modules.get(namespaceToken.text) : null;
      if (module?.interfaces.has(token.text)) {
        classifications.set(token.location.offset, { type: semanticTokenTypes.indexOf("class"), modifiers: 4 });
      } else if (module?.namedTypes.has(token.text)) {
        const named = module.namedTypes.get(token.text)!;
        classifications.set(token.location.offset, {
          type: semanticTokenTypes.indexOf(named.kind === "enum" ? "enum" : "type"),
          modifiers: 4,
        });
      } else if (module?.functions.has(token.text)) {
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
  const word = wordAt(source, offset);
  if (!word) return null;
  const context = safeAnalysis(source, fileName);
  if (!context) return declarationHover(source, null, word.text, word.start, word.end);

  const declaredField = context.sourceProgram.structs
    .flatMap((declaration) => declaration.fields)
    .find((field) => field.location.offset === word.start && field.name === word.text);
  if (declaredField) {
    return markdownHover(`${declaredField.name}: ${displayType(declaredField.type.name, context.typeDisplayNames)}`, source, word.start, word.end);
  }

  const literalField = structLiteralFieldHover(context, word.start);
  if (literalField) return markdownHover(literalField, source, word.start, word.end);

  const matchVariant = collectMatchArmInfos(context).find((item) => item.variantOffset === word.start);
  if (matchVariant) {
    const payload = matchVariant.payloadType
      ? ` ${displayType(matchVariant.payloadType, context.typeDisplayNames)}`
      : "";
    return markdownHover(
      `${displayType(matchVariant.enumName, context.typeDisplayNames)}.${matchVariant.variantName}${payload}`,
      source,
      word.start,
      word.end,
    );
  }

  const module = context.foreignModules.get(word.text);
  if (module) {
    return markdownHover(`import ${word.text} from ${JSON.stringify(module.declaration.header)}`, source, word.start, word.end);
  }
  if (context.semanticInfo.consoleBindings.has(word.text)) {
    return markdownHover(`standard console imported as ${word.text}`, source, word.start, word.end);
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

  const memberPrefix = source.slice(0, word.start).match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.$/);
  if (memberPrefix) {
    if (context.semanticInfo.consoleBindings.has(memberPrefix[1])) {
      const detail = consoleMethodDetail(word.text);
      if (detail) return markdownHover(detail, source, word.start, word.end);
    }
    if (memberPrefix[1] === "String" && word.text === "from") {
      return markdownHover("from(value: cstring): String  // copies borrowed C bytes", source, word.start, word.end);
    }
    const resolved = resolveReceiver(context, memberPrefix[1], word.start - memberPrefix[1].length - 1);
    if (resolved?.kind === "module") {
      const item = describeModuleMember(resolved.module, word.text);
      if (item) return markdownHover(item, source, word.start, word.end);
    }
    if (resolved?.kind === "objc") {
      const property = collectObjCProperties(resolved.declaration, resolved.instance, context).find((item) => item.name === word.text);
      if (property) return markdownHover(`${property.name}: ${foreignTypeName(property.type)}`, source, word.start, word.end);
      const methods = collectObjCMethods(resolved.declaration, resolved.instance, context).filter((item) => item.baseName === word.text);
      if (methods.length) return markdownHover(methods.map(objCMethodDetail).join("\n"), source, word.start, word.end);
    }
    if (resolved?.kind === "struct") {
      const field = resolved.declaration.fields.find((item) => item.name === word.text);
      if (field) return markdownHover(`${field.name}: ${displayType(field.type.name, context.typeDisplayNames)}`, source, word.start, word.end);
      const method = resolved.declaration.methods.find((item) => item.name === word.text);
      if (method) return markdownHover(zFunctionDetail(method.name, method.parameters, method.returnType.name, [], context.typeDisplayNames), source, word.start, word.end);
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

  const type = context.semanticInfo.bindingTypes.get(word.start)
    ?? context.semanticInfo.expressionTypes.get(word.start);
  if (type) return markdownHover(`${word.text}: ${displayServiceType(type, context)}`, source, word.start, word.end);
  return declarationHover(source, context.sourceProgram, word.text, word.start, word.end, context.typeDisplayNames);
}

export function definition(source: string, uri: string, offset: number): Location | null {
  const word = wordAt(source, offset);
  if (!word) return null;
  let tokens;
  try {
    tokens = lex(source, uriToFileName(uri));
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
  const start = offset - prefix.length;
  const tailOffset = source[offset] === ";" ? offset + 1 : offset;
  const context = safeAnalysis(source, fileName)
    ?? safeAnalysis(source.slice(0, start) + "0;" + source.slice(tailOffset), fileName);
  if (!context) return [];
  const items: CompletionItem[] = [];
  for (const binding of collectBindings(context)) {
    if (binding.offset >= start) continue;
    items.push({
      label: binding.name,
      kind: completionKinds.variable,
      detail: `${binding.parameter ? "parameter" : binding.readonly ? "const" : "let"} ${binding.name}: ${displayServiceType(binding.type, context)}`,
      sortText: `0-${binding.name}`,
    });
  }
  for (const declaration of context.program.functions) {
    if (declaration.name.startsWith("__z_mono_")) continue;
    items.push({
      label: declaration.name,
      kind: completionKinds.function,
      detail: zFunctionDetail(declaration.name, declaration.parameters, declaration.returnType.name),
    });
  }
  for (const declaration of context.program.structs) {
    if (declaration.name.startsWith("__z_mono_")) continue;
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
    items.push({ label: declaration.name, kind: completionKinds.interface, detail: `trait ${declaration.name}` });
  }
  for (const declaration of context.program.enums) {
    items.push({ label: declaration.name, kind: completionKinds.enum, detail: `enum ${declaration.name}` });
  }
  for (const [name, module] of context.foreignModules) {
    items.push({ label: name, kind: completionKinds.module, detail: `import from ${JSON.stringify(module.declaration.header)}` });
  }
  for (const name of context.semanticInfo.consoleBindings) {
    items.push({ label: name, kind: completionKinds.module, detail: `standard console imported as ${name}` });
  }
  return filterCompletions(uniqueCompletions(items), prefix, 500);
}

type Binding = {
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly readonly: boolean;
  readonly parameter: boolean;
};

function collectBindings(context: AnalyzedSource): Binding[] {
  const bindings: Binding[] = [];
  const visitClosure = (expression: Extract<NonNullable<Extract<Statement, { kind: "variable" }>["initializer"]>, { kind: "closure" }>): void => {
    for (const parameter of expression.parameters) {
      bindings.push({
        name: parameter.name,
        type: parameter.type.name,
        offset: parameter.location.offset,
        readonly: parameter.mode === "value" || parameter.mode === "in",
        parameter: true,
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
      if (statement.kind === "for") {
        bindings.push({
          name: statement.binding,
          type: context.semanticInfo.bindingTypes.get(statement.bindingLocation.offset) ?? "unknown",
          offset: statement.bindingLocation.offset,
          readonly: true,
          parameter: false,
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
      });
    }
    visitStatements(declaration.body);
  };
  for (const declaration of context.program.functions) visitFunction(declaration);
  for (const declaration of context.program.structs) {
    for (const method of declaration.methods) visitFunction(method);
    if (declaration.deinitializer) visitStatements(declaration.deinitializer.body);
  }
  for (const arm of collectMatchArmInfos(context)) {
    if (!arm.binding || arm.bindingOffset === null || !arm.payloadType) continue;
    bindings.push({
      name: arm.binding,
      type: context.semanticInfo.bindingTypes.get(arm.bindingOffset) ?? arm.payloadType,
      offset: arm.bindingOffset,
      readonly: true,
      parameter: false,
    });
  }
  return bindings;
}

type MatchArmInfo = {
  readonly variantName: string;
  readonly variantOffset: number;
  readonly binding: string | null;
  readonly bindingOffset: number | null;
  readonly enumName: string;
  readonly payloadType: string | null;
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
            readonly location: SourceLocation;
          };
          const variant = declaration.variants.find((item) => item.name === arm.variantName);
          if (!variant) continue;
          collected.push({
            variantName: arm.variantName,
            variantOffset: arm.location.offset,
            binding: arm.binding,
            bindingOffset: arm.bindingLocation?.offset ?? null,
            enumName,
            payloadType: variant.payload?.name ?? null,
          });
        }
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(context.sourceProgram);
  return collected;
}

function memberCompletions(
  source: string,
  fileName: string,
  offset: number,
  receiverText: string,
  prefix: string,
): CompletionItem[] {
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
  const directModule = importContext.foreignModules.get(receiverText);
  if (directModule) return moduleCompletions(directModule, prefix);

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
  const statementTailOffset = source[tailOffset] === ";" ? tailOffset + 1 : tailOffset;
  const statementSanitized = source.slice(0, dotOffset) + ";" + source.slice(statementTailOffset);
  const lengthStatementSanitized = source.slice(0, dotOffset) + ".length;" + source.slice(statementTailOffset);
  const context = safeAnalysis(sanitized, fileName)
    ?? safeAnalysis(statementSanitized, fileName)
    ?? safeAnalysis(lengthSanitized, fileName)
    ?? safeAnalysis(lengthStatementSanitized, fileName);
  if (!context) return [];
  const resolved = resolveReceiver(context, receiverText, receiverOffset);
  if (resolved?.kind === "objc") return filterCompletions(objcCompletions(resolved.declaration, resolved.instance, context), prefix, 1000);
  if (resolved?.kind === "struct") return filterCompletions(structCompletions(resolved.declaration, context.typeDisplayNames), prefix, 1000);
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
    return analyzeSource(`${imports}\nfunction main(): i32 { return 0; }`, fileName);
  } catch {
    return null;
  }
}

function safeAnalysis(source: string, fileName: string): AnalyzedSource | null {
  try {
    return analyzeSource(source, fileName);
  } catch {
    return null;
  }
}

type ResolvedReceiver =
  | { readonly kind: "module"; readonly module: ForeignModule }
  | { readonly kind: "objc"; readonly declaration: ForeignObjCInterface; readonly instance: boolean }
  | { readonly kind: "struct"; readonly declaration: StructDeclaration }
  | { readonly kind: "array"; readonly type: string };

function resolveReceiver(context: AnalyzedSource, text: string, offset: number): ResolvedReceiver | null {
  const module = context.foreignModules.get(text);
  if (module) return { kind: "module", module };
  const [moduleName, className, extra] = text.split(".");
  if (!extra && moduleName && className) {
    const declaration = context.foreignModules.get(moduleName)?.interfaces.get(className);
    if (declaration) return { kind: "objc", declaration, instance: false };
  }
  const type = context.semanticInfo.expressionTypes.get(offset);
  if (!type) return null;
  if (parseFixedArrayType(type) || parseSliceType(type) || parseDynamicArrayType(type)) return { kind: "array", type };
  const interfaceName = type.replace(/^__z_objc:(?:nullable|nonnull):/, "");
  const objc = context.semanticInfo.foreignInterfaces.get(interfaceName);
  if (objc) return { kind: "objc", declaration: objc, instance: true };
  const declaration = context.program.structs.find((item) => item.name === type);
  return declaration ? { kind: "struct", declaration } : null;
}

function moduleCompletions(module: ForeignModule, prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const declaration of module.interfaces.values()) {
    items.push({ label: declaration.exportName, kind: completionKinds.class, detail: `Objective-C class ${declaration.className}` });
  }
  for (const declaration of module.namedTypes.values()) {
    items.push({
      label: declaration.exportName,
      kind: declaration.kind === "enum" ? completionKinds.enum : completionKinds.struct,
      detail: declaration.cName,
    });
  }
  for (const declaration of module.functions.values()) {
    items.push({ label: declaration.name, kind: completionKinds.function, detail: declaration.cSignature });
  }
  for (const declaration of module.constants.values()) {
    items.push({ label: declaration.name, kind: completionKinds.constant, detail: declaration.typeName });
  }
  const unique = uniqueCompletions(items);
  if (prefix) return filterCompletions(unique, prefix, 1500);
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

function structCompletions(declaration: StructDeclaration, typeDisplayNames: ReadonlyMap<string, string>): CompletionItem[] {
  return [
    ...declaration.fields.map((field) => ({ label: field.name, kind: completionKinds.field, detail: displayType(field.type.name, typeDisplayNames) })),
    ...declaration.methods.map((method) => ({
      label: method.name,
      kind: completionKinds.method,
      detail: zFunctionDetail(method.name, method.parameters, method.returnType.name, [], typeDisplayNames),
      insertText: `${method.name}()`,
    })),
  ];
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
  return `${method.baseName}(${parameters.join(", ")}): ${foreignTypeName(method.returnType)}  // ${method.selector}`;
}

function describeModuleMember(module: ForeignModule, name: string): string | null {
  const fn = module.functions.get(name);
  if (fn) return fn.cSignature;
  const constant = module.constants.get(name);
  if (constant) return `${constant.name}: ${constant.typeName}`;
  const named = module.namedTypes.get(name);
  if (named) return `${named.exportName}: ${named.cName}`;
  const objc = module.interfaces.get(name);
  return objc ? `Objective-C class ${objc.className}` : null;
}

function structLiteralFieldHover(context: AnalyzedSource, offset: number): string | null {
  const item = collectStructLiteralFields(context.sourceProgram).find((candidate) => candidate.location.offset === offset);
  if (!item) return null;
  const generic = parseGenericType(item.expression.typeName);
  const declaration = context.sourceProgram.structs.find((candidate) => candidate.name === (generic?.base ?? item.expression.typeName));
  if (!declaration) {
    const foreign = context.semanticInfo.foreignNamedTypes.get(item.expression.typeName);
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
  readonly expression: StructExpression;
  readonly name: string;
  readonly location: SourceLocation;
}> {
  const fields: Array<{ expression: StructExpression; name: string; location: SourceLocation }> = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { readonly kind?: string };
    if (node.kind === "structExpression") {
      const expression = value as StructExpression;
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
): string {
  const generic = formatTypeParameters(typeParameters, typeParameterConstraints, typeDisplayNames);
  return `function ${name}${generic}(${parameters.map((item) => `${item.name}: ${displayType(item.type.name, typeDisplayNames)}`).join(", ")}): ${displayType(returnType, typeDisplayNames)}`;
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
  if (type.kind === "object") return `${type.className ?? "id"}${type.nullable ? "?" : ""}`;
  if (type.kind === "pointer") return `${type.cName}${type.nullable ? "?" : ""}`;
  return type.cName;
}

function displayType(type: string, typeDisplayNames: ReadonlyMap<string, string> = new Map()): string {
  const known = typeDisplayNames.get(type);
  if (known) return known;
  const generic = parseGenericType(type);
  if (generic) return `${generic.base}<${generic.arguments.map((argument) => displayType(argument, typeDisplayNames)).join(", ")}>`;
  const array = parseFixedArrayType(type);
  if (array) return `${displayType(array.elementType, typeDisplayNames)}[${array.length}]`;
  const slice = parseSliceType(type);
  if (slice) return `Slice<${displayType(slice.elementType, typeDisplayNames)}>`;
  const dynamic = parseDynamicArrayType(type);
  if (dynamic) return `Array<${displayType(dynamic.elementType, typeDisplayNames)}>`;
  return type.replace(/^__z_objc:(?:nullable|nonnull):/, "");
}

function displayServiceType(type: string, context: AnalyzedSource): string {
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
