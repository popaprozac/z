import type { Expression, SourceLocation, StructDeclaration } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { ForeignObjCInterface, ForeignObjCMethod } from "./foreign-ir.ts";

export type ObjCSubclassPlan = {
  readonly declaration: StructDeclaration;
  readonly base: ForeignObjCInterface;
  readonly className: string;
  readonly initializer: Extract<Expression, { kind: "call" }>;
  readonly methods: ReadonlyMap<number, ForeignObjCMethod>;
};

export function objcSubclassError(fileName: string, location: SourceLocation, message: string): never {
  throw new DiagnosticError(fileName, location, message, {
    code: "Z0814",
    notes: ["the first native subclass tier supports field-free, main-isolated Objective-C subclasses with synchronous overrides"],
  });
}

export function isSuperCall(expression: Expression): boolean {
  return expression.kind === "call" && expression.callee.kind === "member"
    && expression.callee.object.kind === "identifier" && expression.callee.object.name === "super";
}

/** Validate the syntax-only boundary before ordinary class analysis can accept it. */
export function validateObjCSubclassShape(declaration: StructDeclaration, fileName: string): Extract<Expression, { kind: "call" }> {
  const reject = (location: SourceLocation, message: string): never => objcSubclassError(fileName, location, message);
  if (declaration.kind !== "class" || declaration.nativeLayout) reject(declaration.location, "`extends` requires a native Objective-C class declaration");
  if (declaration.typeParameters?.length) reject(declaration.location, "generic native subclasses are not supported in the first tier");
  if (!declaration.executorAffinity) reject(declaration.location, "a native subclass must declare `on thread.main`");
  if (declaration.fields.length) reject(declaration.fields[0].location, "native subclass fields require the later initialization and state-lifetime tier");
  if (declaration.deinitializer) reject(declaration.deinitializer.location, "native subclass deinit requires the later state-lifetime tier");
  if (declaration.implements.length) reject(declaration.implements[0].location, "native subclass protocol and trait conformance is not supported in the first tier");
  const constructor = declaration.constructor;
  if (!constructor) reject(declaration.location, "a native subclass requires an explicit constructor and superclass initializer");
  if (constructor.errorType) reject(constructor.location, "fallible native subclass construction is not supported in the first tier");
  const rejectImplicitReceiverShadow = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as { kind?: string; name?: string; binding?: string; bindingName?: string; mode?: string; type?: unknown; location?: SourceLocation; bindingLocation?: SourceLocation };
    const binding = node.kind === "variable" || (node.mode && node.type) ? node.name : node.bindingName ?? node.binding;
    if (binding === "self" || binding === "_cmd") {
      reject(node.location ?? node.bindingLocation ?? declaration.location, "native implicit receiver names `self` and `_cmd` cannot be shadowed in a native subclass");
    }
    for (const child of Object.values(value)) rejectImplicitReceiverShadow(child);
  };
  rejectImplicitReceiverShadow(constructor);
  rejectImplicitReceiverShadow(declaration.methods);
  const first = constructor.body[0];
  if (first?.kind !== "expressionStatement" || !isSuperCall(first.expression)) {
    objcSubclassError(fileName, first?.location ?? constructor.location, "a native subclass constructor must begin with exactly one `super.init...(...)` call");
  }
  const initializer = first.expression as Extract<Expression, { kind: "call" }>;
  const rejectEarlyReturn = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as { kind?: string; location: SourceLocation };
    if (node.kind === "closure") return;
    if (node.kind === "return") reject(node.location, "native subclass constructors must fall through after initialization in the first tier");
    for (const child of Object.values(value)) rejectEarlyReturn(child);
  };
  rejectEarlyReturn(constructor.body);
  // `super` is not a first-class value or an aliasable native receiver. No
  // use before initialization is permitted, including in initializer arguments.
  const inspect = (value: unknown, insideClosure = false): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) inspect(item, insideClosure); return; }
    const node = value as Expression;
    if (node.kind === "identifier" && node.name === "super") reject(node.location, "`super` may only be the direct receiver of a native superclass call");
    if (node.kind === "call" && isSuperCall(node)) {
      if (insideClosure) reject(node.location, "`super` cannot be captured by a closure");
      for (const argument of node.arguments) inspect(argument, insideClosure);
      return;
    }
    for (const child of Object.values(value)) inspect(child, insideClosure || node.kind === "closure");
  };
  inspect(constructor.body);
  for (const method of declaration.methods) {
    if (!method.override || !method.nativeSelector) reject(method.location, "a native subclass method requires `override function` and an explicit `as \"selector:\"`");
    if (method.static || method.async || method.errorType || method.rawBody || method.receiverMode === "move" || method.typeParameters?.length) {
      reject(method.location, "a native override must be a synchronous, non-throwing, non-consuming instance method");
    }
    if (/^(?:init(?:$|[^a-z])|dealloc$|retain$|release$|autorelease$|retainCount$|class$|isKindOfClass:|forward|methodSignatureForSelector:|respondsToSelector:)/.test(method.nativeSelector)) {
      reject(method.location, `native lifecycle or runtime selector ${JSON.stringify(method.nativeSelector)} cannot be overridden in the first tier`);
    }
    inspect(method.body);
  }
  const usesThis = (value: unknown): SourceLocation | null => {
    if (!value || typeof value !== "object") return null;
    const node = value as Expression;
    if (node.kind === "identifier" && (node.name === "this" || node.name === "super")) return node.location;
    for (const child of Object.values(value)) { const found = usesThis(child); if (found) return found; }
    return null;
  };
  for (const argument of initializer.arguments) {
    const location = usesThis(argument);
    if (location) reject(location, "the native receiver cannot be used before superclass initialization succeeds");
  }
  return initializer;
}

export function nativeSubclassClassName(name: string): string {
  return `ZNative_${[...name].map((character) => /[A-Za-z0-9_]/.test(character) ? character : `_${character.codePointAt(0)!.toString(16)}_`).join("")}`;
}
