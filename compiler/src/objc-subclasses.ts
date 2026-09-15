import type { Expression, FunctionDeclaration, SourceLocation, Statement, StructDeclaration } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { ForeignNamedType, ForeignObjectType, ForeignObjCInterface, ForeignObjCMethod, ForeignType } from "./foreign-ir.ts";

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
    notes: ["native subclasses use main-isolated inline storage and synchronous guarded overrides"],
  });
}

export function isSuperCall(expression: Expression): boolean {
  return expression.kind === "call" && expression.callee.kind === "member"
    && expression.callee.object.kind === "identifier" && expression.callee.object.name === "super";
}

// A full-expression boundary has no surrounding partially evaluated call or
// assignment that could still hold a receiver-field address. Nested super
// expressions keep the ordinary entry guard in this first delegation tier.
export function isObjCSubclassHandoffBoundary(method: FunctionDeclaration, offset: number): boolean {
  const visit = (node: Statement): boolean => {
    const expression = node.kind === "variable" ? node.initializer
      : node.kind === "return" || node.kind === "expressionStatement" ? node.expression : null;
    if (expression?.location.offset === offset && isSuperCall(expression)) return true;
    switch (node.kind) {
      case "block": return node.statements.some(visit);
      case "if": return visit(node.thenBranch) || (node.elseBranch !== null && visit(node.elseBranch));
      case "while": case "for": case "unsafe": case "asyncScope": return visit(node.body);
      case "match": return node.arms.some((arm) => visit(arm.body));
      default: return false;
    }
  };
  return method.body.some(visit);
}

export function isObjCSubclassHandoffValue(type: ForeignType): boolean {
  if (type.kind === "z") return /^(void|boolean|[iu](8|16|32|64)|[iu]size|f(32|64))$/.test(type.name);
  return type.kind === "named" && (type.type.kind === "scalar" || type.type.kind === "enum"
    || (type.type.kind === "record" && type.type.layout === "struct" && !type.type.viewOnly && !type.type.resource));
}

/** Validate the syntax-only boundary before ordinary class analysis can accept it. */
export function validateObjCSubclassShape(declaration: StructDeclaration, fileName: string): Extract<Expression, { kind: "call" }> {
  const reject = (location: SourceLocation, message: string): never => objcSubclassError(fileName, location, message);
  if (declaration.kind !== "class" || declaration.nativeLayout) reject(declaration.location, "`extends` requires a native Objective-C class declaration");
  if (declaration.typeParameters?.length) reject(declaration.location, "generic native subclasses are not supported in the first tier");
  if (!declaration.executorAffinity) reject(declaration.location, "a native subclass must declare `on thread.main`");
  for (const field of declaration.fields) {
    if (field.visibility !== "private") reject(field.location, "native subclass stored fields must be private; expose state through guarded overrides");
    if (field.optional || field.defaultValue) reject(field.location, "native stored fields require explicit constructor initialization, without defaults or optional fields");
  }
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
  rejectImplicitReceiverShadow(declaration.deinitializer);
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
  if (declaration.deinitializer) inspect(declaration.deinitializer.body);
  for (const method of declaration.methods) {
    if (!method.nativeSelector) {
      if (method.override) reject(method.location,
        "a native subclass override requires an explicit `as \"selector:\"`; Z-only methods cannot override native entries");
      if (method.static || method.async || method.errorType || method.rawBody || method.receiverMode === "move" || method.typeParameters?.length) {
        reject(method.location, "a Z-only native-subclass method must be a synchronous, non-throwing, non-consuming instance method");
      }
      const rejectSuper = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const node = value as Expression;
        if (node.kind === "identifier" && node.name === "super") reject(node.location,
          "superclass dispatch belongs in an explicit native entry, not a Z-only method");
        for (const child of Object.values(value)) rejectSuper(child);
      };
      rejectSuper(method.body);
      inspect(method.body);
      continue;
    }
    if (method.nativeSelector.startsWith("_z_")) reject(method.location, "compiler-owned native selectors beginning with `_z_` cannot be declared");
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
  // Until native field loans have their own escaping representation, receiver
  // identity cannot be captured and dying identity cannot be published at all.
  const checkReceiver = (value: unknown, dying = false, closure = false): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) checkReceiver(child, dying, closure); return; }
    const node = value as Expression;
    if (node.kind === "member" && node.object.kind === "identifier" && node.object.name === "this"
      && declaration.fields.some((field) => field.name === node.property) && !closure) return;
    if (node.kind === "identifier" && (node.name === "this" || node.name === "super") && (dying || closure)) {
      reject(node.location, dying ? "native subclass deinit cannot publish or call through the dying receiver; use its stored fields"
        : "native subclass receiver captures require escaping field-loan support");
    }
    for (const child of Object.values(value)) checkReceiver(child, dying, closure || node.kind === "closure");
  };
  checkReceiver(constructor.body);
  checkReceiver(declaration.methods);
  if (declaration.deinitializer) checkReceiver(declaration.deinitializer.body, true);
  // A fail-closed first storage tier: initialize the fields in a straight-line
  // prefix, before receiver use/control flow. Ordinary sema then checks moves,
  // field types, mutability, and all subsequent uses.
  const pending = new Set(declaration.fields.map((field) => field.name));
  for (const statement of constructor.body.slice(1)) {
    if (!pending.size) break;
    if (statement.kind !== "assignment" || statement.target.kind !== "member"
      || statement.target.object.kind !== "identifier" || statement.target.object.name !== "this"
      || !pending.has(statement.target.property)) {
      reject(statement.location, "initialize every native stored field directly after super.init before other receiver use or control flow");
    }
    const use = usesThis(statement.expression);
    if (use) reject(use, "native stored field initialization cannot use the partially initialized receiver");
    pending.delete(statement.target.property);
  }
  if (pending.size) reject(constructor.location, `native stored fields are not initialized: ${[...pending].join(", ")}`);
  return initializer;
}

export function nativeSubclassClassName(name: string): string {
  return `ZNative_${[...name].map((character) => /[A-Za-z0-9_]/.test(character) ? character : `_${character.codePointAt(0)!.toString(16)}_`).join("")}`;
}

/** A new entry has a source-declared ABI, not an invented inherited method. */
export function newObjCSubclassEntry(
  method: FunctionDeclaration,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  objects: ReadonlyMap<string, ForeignObjectType>,
  subclasses: ReadonlyMap<string, ObjCSubclassPlan>,
  fileName: string,
): ForeignObjCMethod {
  const selector = method.nativeSelector!;
  const labels = selector.split(":");
  if (method.parameters.length === 0 ? !/^[A-Za-z_][A-Za-z0-9_]*$/.test(selector)
    : labels.length !== method.parameters.length + 1 || labels.at(-1) !== ""
      || labels.slice(0, -1).some((label) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(label))) {
    objcSubclassError(fileName, method.location, "new native selector labels must match the declared parameter count");
  }
  const scalars: Record<string, string> = {
    boolean: "bool", i8: "int8_t", u8: "uint8_t", i16: "int16_t", u16: "uint16_t",
    i32: "int32_t", u32: "uint32_t", i64: "int64_t", u64: "uint64_t",
    isize: "intptr_t", usize: "uintptr_t", f32: "float", f64: "double", void: "void",
  };
  const typeFor = (name: string, location: SourceLocation, result: boolean): ForeignType => {
    if (scalars[name] && (name !== "void" || result)) return { kind: "z", name: name as Extract<ForeignType, { kind: "z" }>["name"], cName: scalars[name] };
    const named = namedTypes.get(name);
    if (named?.kind === "enum" || named?.kind === "scalar") return { kind: "named", type: named, cName: named.cName };
    const object = objects.get(name);
    if (!result && object && !object.nullable && object.className && !subclasses.has(name)) return object;
    return objcSubclassError(fileName, location, "new native entries support scalar/native-enum values, borrowed concrete imported object parameters, and void returns");
  };
  return {
    selector, baseName: method.name, instance: true, returnsInstanceType: false,
    returnType: typeFor(method.returnType.name, method.returnType.location, true),
    parameters: method.parameters.map((parameter) => ({ name: parameter.name,
      type: typeFor(parameter.type.name, parameter.location, false), protocols: [],
    })),
    metadata: { source: null, availability: [], executorAffinity: "main" },
    asyncCallbackParameter: null, asyncResultParameter: null, asyncErrorParameter: null,
  };
}
