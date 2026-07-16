import type { Program, SourceLocation, StructDeclaration } from "./ast.ts";
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

export type Position = { readonly line: number; readonly character: number };
export type Range = { readonly start: Position; readonly end: Position };
export type ServiceDiagnostic = { readonly range: Range; readonly severity: 1; readonly source: "z"; readonly message: string };
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
  enum: 13,
  constant: 21,
  struct: 22,
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
    return [{
      range: { start, end: { line: start.line, character: start.character + 1 } },
      severity: 1,
      source: "z",
      message: error instanceof DiagnosticError
        ? diagnosticMessage(error)
        : error instanceof Error ? error.message : String(error),
    }];
  }
}

export function completions(source: string, fileName: string, offset: number): CompletionItem[] {
  const before = source.slice(0, offset);
  const member = before.match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.$/);
  if (member) return memberCompletions(source, fileName, offset, member[1]);
  return labelCompletions(source, fileName, offset);
}

export function hover(source: string, fileName: string, offset: number): Hover | null {
  const word = wordAt(source, offset);
  if (!word) return null;
  const context = safeAnalysis(source, fileName);
  if (!context) return declarationHover(source, null, word.text, word.start, word.end);

  const memberPrefix = source.slice(0, word.start).match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.$/);
  if (memberPrefix) {
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
      if (field) return markdownHover(`${field.name}: ${field.type.name}`, source, word.start, word.end);
      const method = resolved.declaration.methods.find((item) => item.name === word.text);
      if (method) return markdownHover(zFunctionDetail(method.name, method.parameters, method.returnType.name), source, word.start, word.end);
    }
  }

  const type = context.semanticInfo.expressionTypes.get(word.start);
  if (type) return markdownHover(`${word.text}: ${displayType(type)}`, source, word.start, word.end);
  return declarationHover(source, context.program, word.text, word.start, word.end);
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
    const declarationKeyword = previous && ["function", "struct", "enum", "const", "let"].includes(previous.kind);
    const namedSlot = next?.kind === "colon";
    const importSlot = previous?.kind === "leftBrace" || previous?.kind === "comma" || previous?.kind === "as";
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

function memberCompletions(source: string, fileName: string, offset: number, receiverText: string): CompletionItem[] {
  const importContext = importAnalysis(source, fileName);
  if (!importContext) return [];
  const directModule = importContext.foreignModules.get(receiverText);
  if (directModule) return moduleCompletions(directModule);

  const [moduleName, className, extra] = receiverText.split(".");
  if (!extra && moduleName && className) {
    const declaration = importContext.foreignModules.get(moduleName)?.interfaces.get(className);
    if (declaration) return objcCompletions(declaration, false, importContext);
  }

  const dotOffset = offset - 1;
  const sanitized = source.slice(0, dotOffset) + source.slice(dotOffset + 1);
  const context = safeAnalysis(sanitized, fileName);
  if (!context) return [];
  const receiverOffset = offset - 1 - receiverText.length;
  const resolved = resolveReceiver(context, receiverText, receiverOffset);
  if (resolved?.kind === "objc") return objcCompletions(resolved.declaration, resolved.instance, context);
  if (resolved?.kind === "struct") return structCompletions(resolved.declaration);
  return [];
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
  | { readonly kind: "struct"; readonly declaration: StructDeclaration };

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
  const interfaceName = type.replace(/^__z_objc:(?:nullable|nonnull):/, "");
  const objc = context.semanticInfo.foreignInterfaces.get(interfaceName);
  if (objc) return { kind: "objc", declaration: objc, instance: true };
  const declaration = context.program.structs.find((item) => item.name === type);
  return declaration ? { kind: "struct", declaration } : null;
}

function moduleCompletions(module: ForeignModule): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const declaration of module.functions.values()) {
    items.push({ label: declaration.name, kind: completionKinds.function, detail: declaration.cSignature });
  }
  for (const declaration of module.constants.values()) {
    items.push({ label: declaration.name, kind: completionKinds.constant, detail: declaration.typeName });
  }
  for (const declaration of module.namedTypes.values()) {
    items.push({
      label: declaration.exportName,
      kind: declaration.kind === "enum" ? completionKinds.enum : completionKinds.struct,
      detail: declaration.cName,
    });
  }
  for (const declaration of module.interfaces.values()) {
    items.push({ label: declaration.exportName, kind: completionKinds.class, detail: `Objective-C class ${declaration.className}` });
  }
  return uniqueCompletions(items);
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

function structCompletions(declaration: StructDeclaration): CompletionItem[] {
  return [
    ...declaration.fields.map((field) => ({ label: field.name, kind: completionKinds.field, detail: field.type.name })),
    ...declaration.methods.map((method) => ({
      label: method.name,
      kind: completionKinds.method,
      detail: zFunctionDetail(method.name, method.parameters, method.returnType.name),
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
    return `${index === 0 ? "" : `${label}: `}${parameter.name ?? "value"}: ${foreignTypeName(parameter.type)}`;
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

function declarationHover(source: string, program: Program | null, name: string, start: number, end: number): Hover | null {
  if (program) {
    const fn = program.functions.find((item) => item.name === name);
    if (fn) return markdownHover(zFunctionDetail(fn.name, fn.parameters, fn.returnType.name), source, start, end);
    const struct = program.structs.find((item) => item.name === name);
    if (struct) return markdownHover(`struct ${struct.name}`, source, start, end);
    const enumeration = program.enums.find((item) => item.name === name);
    if (enumeration) return markdownHover(`enum ${enumeration.name}`, source, start, end);
  }
  return null;
}

function zFunctionDetail(name: string, parameters: readonly { readonly name: string; readonly type: { readonly name: string } }[], returnType: string): string {
  return `function ${name}(${parameters.map((item) => `${item.name}: ${item.type.name}`).join(", ")}): ${returnType}`;
}

function foreignTypeName(type: ForeignType): string {
  if (type.kind === "z") return type.name;
  if (type.kind === "named") return type.type.typeName;
  if (type.kind === "object") return `${type.className ?? "id"}${type.nullable ? "?" : ""}`;
  if (type.kind === "pointer") return `${type.cName}${type.nullable ? "?" : ""}`;
  return type.cName;
}

function displayType(type: string): string {
  return type.replace(/^__z_objc:(?:nullable|nonnull):/, "");
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

function diagnosticMessage(error: DiagnosticError): string {
  const marker = ": error: ";
  const index = error.message.indexOf(marker);
  return index >= 0 ? error.message.slice(index + marker.length) : error.message;
}

function uriToFileName(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  return decodeURIComponent(new URL(uri).pathname);
}
