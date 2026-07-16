import type {
  Expression,
  EnumDeclaration,
  FunctionDeclaration,
  Program,
  SourceLocation,
  Statement,
  StructDeclaration,
  TraitDeclaration,
  TypeReference,
} from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { resultTypeName } from "./results.ts";
import {
  displayArrayType,
  dynamicArrayTypeName,
  fixedArrayTypeName,
  parseDynamicArrayType,
  parseFixedArrayType,
  parseSliceType,
} from "./array-types.ts";
import {
  pointerTypeName,
  type ForeignConstant,
  type ForeignFunction,
  type ForeignModule,
  type ForeignNamedType,
  type ForeignObjCInterface,
  type ForeignObjCMethod,
  type ForeignObjCProperty,
  type ForeignObjectType,
  type ForeignPointerType,
  type ForeignType,
} from "./foreign.ts";

export type ObjCCallInfo = {
  readonly selector: string;
};

export type ObjCPropertyInfo = {
  readonly getter: string;
  readonly setter: string | null;
  readonly type: ForeignType;
};

export type ClosureCaptureInfo = {
  readonly name: string;
  readonly type: string;
  readonly mode: "value" | "in" | "inout";
  readonly moved: boolean;
};

export type ClosureInfo = {
  readonly type: string;
  readonly declaration: FunctionDeclaration;
  readonly captures: readonly ClosureCaptureInfo[];
  readonly parameterCount: number;
};

type ValueType = string | "unknown" | "never";

export type SemanticInfo = {
  readonly movedExpressions: ReadonlySet<number>;
  readonly classCopies: ReadonlySet<number>;
  readonly sliceConversions: ReadonlyMap<number, { readonly sourceType: string; readonly targetType: string }>;
  readonly foreignTypes: ReadonlyMap<string, ForeignPointerType>;
  readonly foreignCallTypes: ReadonlyMap<number, string>;
  readonly foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly foreignExpressionTypes: ReadonlyMap<number, string>;
  readonly numericLiteralTypes: ReadonlyMap<number, string>;
  readonly foreignArgumentAccesses: ReadonlyMap<number, "in" | "out" | "inout">;
  readonly foreignFunctionNames: ReadonlyMap<number, string>;
  readonly foreignConstantNames: ReadonlyMap<number, string>;
  readonly nativeArgumentAccesses: ReadonlyMap<number, "in" | "inout" | "out">;
  readonly foreignObjectTypes: ReadonlyMap<string, ForeignObjectType>;
  readonly foreignInterfaces: ReadonlyMap<string, ForeignObjCInterface>;
  readonly objcClassNames: ReadonlyMap<number, string>;
  readonly objcProperties: ReadonlyMap<number, ObjCPropertyInfo>;
  readonly objcCalls: ReadonlyMap<number, ObjCCallInfo>;
  readonly objcStringLiterals: ReadonlySet<number>;
  readonly cstringConversions: ReadonlySet<number>;
  readonly expressionTypes: ReadonlyMap<number, string>;
  readonly bindingTypes: ReadonlyMap<number, string>;
  readonly closures: ReadonlyMap<number, ClosureInfo>;
  readonly consoleCalls: ReadonlySet<number>;
  readonly objectiveC: boolean;
  readonly cPlusPlus: boolean;
  readonly frameworks: readonly string[];
};

type AnalysisState = {
  readonly movedExpressions: Set<number>;
  readonly classCopies: Set<number>;
  readonly sliceConversions: Map<number, { readonly sourceType: string; readonly targetType: string }>;
  readonly foreignTypes: ReadonlyMap<string, ForeignPointerType>;
  readonly foreignCallTypes: Map<number, string>;
  readonly foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly foreignExpressionTypes: Map<number, string>;
  readonly numericLiteralTypes: Map<number, string>;
  readonly foreignArgumentAccesses: Map<number, "in" | "out" | "inout">;
  readonly foreignFunctionNames: Map<number, string>;
  readonly foreignConstantNames: Map<number, string>;
  readonly nativeArgumentAccesses: Map<number, "in" | "inout" | "out">;
  readonly foreignObjectTypes: ReadonlyMap<string, ForeignObjectType>;
  readonly foreignInterfaces: ReadonlyMap<string, ForeignObjCInterface>;
  readonly objcClassNames: Map<number, string>;
  readonly objcProperties: Map<number, ObjCPropertyInfo>;
  readonly objcCalls: Map<number, ObjCCallInfo>;
  readonly objcStringLiterals: Set<number>;
  readonly cstringConversions: Set<number>;
  readonly expressionTypes: Map<number, string>;
  readonly bindingTypes: Map<number, string>;
  readonly closures: Map<number, ClosureInfo>;
  readonly consoleCalls: Set<number>;
  readonly objectiveC: boolean;
  readonly cPlusPlus: boolean;
  readonly frameworks: readonly string[];
  readonly loopStack: LoopAnalysisFrame[];
  readonly moveOrigins: Map<string, SourceLocation>;
  readonly borrowOrigins: Map<string, { readonly location: SourceLocation; readonly kind: "closure" | "iteration" }>;
  readonly iterationBorrowOrigins: Map<string, SourceLocation>;
};

type LoopAnalysisFrame = {
  readonly breaks: Map<string, ValueType>[];
  readonly continues: Map<string, ValueType>[];
};

type SymbolValue =
  | { readonly kind: "function"; readonly declaration: FunctionDeclaration }
  | { readonly kind: "foreignFunction"; readonly declaration: ForeignFunction }
  | { readonly kind: "foreignConstant"; readonly declaration: ForeignConstant }
  | { readonly kind: "foreignType"; readonly declaration: ForeignNamedType }
  | { readonly kind: "foreignModule"; readonly module: ForeignModule }
  | { readonly kind: "struct"; readonly declaration: StructDeclaration }
  | { readonly kind: "trait"; readonly declaration: TraitDeclaration }
  | { readonly kind: "enum"; readonly declaration: EnumDeclaration };

const integerTypes = new Set(["i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "isize", "usize"]);
const floatTypes = new Set(["f32", "f64"]);
const primitiveTypes = new Set([...integerTypes, ...floatTypes, "void", "bool", "cstring", "String"]);
const movedPrefix = "__z_moved:";
const maybeMovedPrefix = "__z_maybe_moved:";
const uninitializedPrefix = "__z_uninitialized:";
const maybeUninitializedPrefix = "__z_maybe_uninitialized:";
const mutablePrefix = "__z_mutable:";
const borrowedPrefix = "__z_borrowed:";

export function analyze(
  program: Program,
  fileName: string,
  foreignModules: ReadonlyMap<string, ForeignModule>,
): SemanticInfo {
  const foreignTypes = new Map<string, ForeignPointerType>();
  const foreignNamedTypes = new Map<string, ForeignNamedType>();
  const foreignObjectTypes = new Map<string, ForeignObjectType>();
  const foreignInterfaces = new Map<string, ForeignObjCInterface>();
  const frameworks = new Set<string>();
  let objectiveC = false;
  let cPlusPlus = false;
  for (const module of foreignModules.values()) {
    for (const [name, type] of module.types) foreignTypes.set(name, type);
    for (const type of module.namedTypes.values()) foreignNamedTypes.set(type.typeName, type);
    for (const [name, type] of module.objectTypes) foreignObjectTypes.set(name, type);
    for (const type of module.interfaces.values()) foreignInterfaces.set(type.typeName, type);
    if (module.framework) frameworks.add(module.framework);
    if (module.objectiveC) objectiveC = true;
    if (module.cPlusPlus) cPlusPlus = true;
  }
  const state: AnalysisState = {
    movedExpressions: new Set(),
    classCopies: new Set(),
    sliceConversions: new Map(),
    foreignTypes,
    foreignCallTypes: new Map(),
    foreignNamedTypes,
    foreignExpressionTypes: new Map(),
    numericLiteralTypes: new Map(),
    foreignArgumentAccesses: new Map(),
    foreignFunctionNames: new Map(),
    foreignConstantNames: new Map(),
    nativeArgumentAccesses: new Map(),
    foreignObjectTypes,
    foreignInterfaces,
    objcClassNames: new Map(),
    objcProperties: new Map(),
    objcCalls: new Map(),
    objcStringLiterals: new Set(),
    cstringConversions: new Set(),
    expressionTypes: new Map(),
    bindingTypes: new Map(),
    closures: new Map(),
    consoleCalls: new Set(),
    objectiveC,
    cPlusPlus,
    frameworks: [...frameworks],
    loopStack: [],
    moveOrigins: new Map(),
    borrowOrigins: new Map(),
    iterationBorrowOrigins: new Map(),
  };
  const globals = new Map<string, SymbolValue>();
  const structs = new Map<string, StructDeclaration>();
  const traits = new Map<string, TraitDeclaration>();
  const enums = new Map<string, EnumDeclaration>();

  for (const declaration of program.imports) {
    const module = foreignModules.get(declaration.moduleName);
    if (!module) throw new DiagnosticError(fileName, declaration.location, `header ${JSON.stringify(declaration.header)} was not resolved`);
    if (!declaration.bindings) {
      declareGlobal(globals, declaration.moduleName, { kind: "foreignModule", module }, declaration.location, fileName);
      continue;
    }
    for (const binding of declaration.bindings) {
      validateUserName(binding.localName, binding.location, fileName);
      const foreignFunction = module.functions.get(binding.importedName);
      if (foreignFunction) {
        declareGlobal(
          globals,
          binding.localName,
          { kind: "foreignFunction", declaration: foreignFunction },
          binding.location,
          fileName,
        );
        continue;
      }
      const foreignType = module.namedTypes.get(binding.importedName);
      if (foreignType) {
        foreignNamedTypes.set(binding.localName, foreignType);
        declareGlobal(globals, binding.localName, { kind: "foreignType", declaration: foreignType }, binding.location, fileName);
        continue;
      }
      const foreignConstant = module.constants.get(binding.importedName);
      if (foreignConstant) {
        declareGlobal(globals, binding.localName, { kind: "foreignConstant", declaration: foreignConstant }, binding.location, fileName);
        continue;
      }
      throw new DiagnosticError(
        fileName,
        binding.location,
        `header ${JSON.stringify(declaration.header)} has no declaration ${JSON.stringify(binding.importedName)}`,
      );
    }
  }

  for (const declaration of program.structs) {
    declareGlobal(globals, declaration.name, { kind: "struct", declaration }, declaration.location, fileName);
    structs.set(declaration.name, declaration);
  }
  for (const declaration of program.traits) {
    declareGlobal(globals, declaration.name, { kind: "trait", declaration }, declaration.location, fileName);
    traits.set(declaration.name, declaration);
  }
  for (const declaration of program.enums) {
    declareGlobal(globals, declaration.name, { kind: "enum", declaration }, declaration.location, fileName);
    enums.set(declaration.name, declaration);
  }

  for (const declaration of program.functions) {
    declareGlobal(globals, declaration.name, { kind: "function", declaration }, declaration.location, fileName);
  }

  for (const declaration of program.structs) {
    analyzeStructDeclaration(declaration, structs, enums, foreignNamedTypes, fileName);
  }
  for (const declaration of program.traits) {
    analyzeTraitDeclaration(declaration, structs, enums, foreignNamedTypes, fileName);
  }
  for (const declaration of program.structs) {
    validateTraitConformance(declaration, traits, fileName);
  }
  for (const declaration of program.enums) {
    analyzeEnumDeclaration(declaration, structs, enums, foreignNamedTypes, fileName);
  }

  for (const declaration of program.functions) {
    if (declaration.receiverMode) {
      throw new DiagnosticError(
        fileName,
        declaration.location,
        `\`${declaration.receiverMode} this\` is only valid on a struct method (or class method)`,
      );
    }
    validateFunctionSignature(declaration, structs, enums, foreignNamedTypes, fileName);
  }

  validateValueLayouts(program.structs, program.enums, structs, enums, fileName);

  const main = globals.get("main");
  if (!main || main.kind !== "function") {
    throw new DiagnosticError(fileName, { offset: 0, line: 1, column: 1 }, "program must declare `function main(): i32`");
  }
  if (main.declaration.parameters.length !== 0 || main.declaration.returnType.name !== "i32") {
    throw new DiagnosticError(fileName, main.declaration.location, "`main` must have signature `function main(): i32`");
  }
  if (main.declaration.errorType) {
    throw new DiagnosticError(fileName, main.declaration.location, "`main` cannot throw in the bootstrap runtime");
  }

  for (const declaration of program.structs) {
    for (const method of declaration.methods) {
      analyzeFunction(method, globals, structs, enums, fileName, declaration, state);
    }
    if (declaration.deinitializer) {
      validateDeinitControlFlow(declaration.deinitializer.body, fileName);
      analyzeFunction(
        {
          kind: "function",
          name: "deinit",
          receiverMode: null,
          parameters: [],
          returnType: { name: "void", location: declaration.deinitializer.location },
          errorType: null,
          body: declaration.deinitializer.body,
          location: declaration.deinitializer.location,
        },
        globals,
        structs,
        enums,
        fileName,
        declaration,
        state,
      );
    }
  }
  for (const declaration of program.functions) {
    analyzeFunction(declaration, globals, structs, enums, fileName, null, state);
  }
  return state;
}

function analyzeStructDeclaration(
  declaration: StructDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
): void {
  if (declaration.kind === "class" && declaration.methods.some((method) => method.receiverMode === "move")) {
    const method = declaration.methods.find((candidate) => candidate.receiverMode === "move")!;
    throw new DiagnosticError(fileName, method.location, "class methods cannot declare `move this`; ARC references may have aliases");
  }
  const members = new Set<string>();
  for (const field of declaration.fields) {
    validateUserName(field.name, field.location, fileName);
    if (members.has(field.name)) {
      throw new DiagnosticError(fileName, field.location, `duplicate member ${JSON.stringify(field.name)} in ${declaration.kind} ${JSON.stringify(declaration.name)}`);
    }
    members.add(field.name);
    validateType(field.type, structs, enums, foreignNamedTypes, fileName, false);
    if (containsSliceType(field.type.name)) {
      throw new DiagnosticError(fileName, field.location, "Slice values cannot be stored in struct or class fields");
    }
  }
  for (const method of declaration.methods) {
    validateUserName(method.name, method.location, fileName);
    if (members.has(method.name)) {
      throw new DiagnosticError(fileName, method.location, `duplicate member ${JSON.stringify(method.name)} in ${declaration.kind} ${JSON.stringify(declaration.name)}`);
    }
    members.add(method.name);
    validateFunctionSignature(method, structs, enums, foreignNamedTypes, fileName);
  }
}

function analyzeTraitDeclaration(
  declaration: TraitDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
): void {
  const methods = new Set<string>();
  for (const method of declaration.methods) {
    validateUserName(method.name, method.location, fileName);
    if (methods.has(method.name)) {
      throw new DiagnosticError(fileName, method.location, `duplicate method ${JSON.stringify(method.name)} in trait ${JSON.stringify(declaration.name)}`);
    }
    methods.add(method.name);
    validateFunctionSignature(method, structs, enums, foreignNamedTypes, fileName);
  }
}

function validateTraitConformance(
  declaration: StructDeclaration,
  traits: Map<string, TraitDeclaration>,
  fileName: string,
): void {
  const implemented = new Set<string>();
  for (const reference of declaration.implements) {
    if (implemented.has(reference.name)) {
      throw new DiagnosticError(fileName, reference.location, `${declaration.kind} ${JSON.stringify(declaration.name)} repeats trait ${JSON.stringify(reference.name)}`);
    }
    implemented.add(reference.name);
    const trait = traits.get(reference.name);
    if (!trait) throw new DiagnosticError(fileName, reference.location, `unknown trait ${JSON.stringify(reference.name)}`);
    for (const requirement of trait.methods) {
      const method = declaration.methods.find((candidate) => candidate.name === requirement.name);
      if (!method) {
        throw new DiagnosticError(
          fileName,
          reference.location,
          `${declaration.kind} ${JSON.stringify(declaration.name)} does not implement ${reference.name}.${requirement.name}`,
        );
      }
      if (!sameMethodSignature(method, requirement)) {
        throw new DiagnosticError(
          fileName,
          method.location,
          `method ${declaration.name}.${method.name} does not match trait requirement ${reference.name}.${requirement.name}`,
        );
      }
    }
  }
}

function sameMethodSignature(actual: FunctionDeclaration, required: FunctionDeclaration): boolean {
  return actual.receiverMode === required.receiverMode
    && actual.returnType.name === required.returnType.name
    && actual.errorType?.name === required.errorType?.name
    && actual.parameters.length === required.parameters.length
    && actual.parameters.every((parameter, index) => (
      parameter.mode === required.parameters[index].mode
      && parameter.type.name === required.parameters[index].type.name
    ));
}

function analyzeEnumDeclaration(
  declaration: EnumDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
): void {
  const names = new Set<string>();
  for (const variant of declaration.variants) {
    validateUserName(variant.name, variant.location, fileName);
    if (names.has(variant.name)) {
      throw new DiagnosticError(fileName, variant.location, `duplicate variant ${JSON.stringify(variant.name)}`);
    }
    names.add(variant.name);
    if (variant.payload) {
      validateType(variant.payload, structs, enums, foreignNamedTypes, fileName, false);
      if (containsSliceType(variant.payload.name)) {
        throw new DiagnosticError(fileName, variant.location, "Slice values cannot be stored in enum payloads");
      }
      if (variant.payload.name === declaration.name) {
        throw new DiagnosticError(fileName, variant.location, "an enum cannot contain itself directly by value");
      }
      if (hasCleanupType(variant.payload.name, structs)) {
        throw new DiagnosticError(fileName, variant.location, "enum payloads with deterministic cleanup are not implemented in this bootstrap stage");
      }
    }
  }
  if (declaration.variants.length === 0) {
    throw new DiagnosticError(fileName, declaration.location, "an enum must declare at least one variant");
  }
}

function validateFunctionSignature(
  declaration: FunctionDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
): void {
  validateType(declaration.returnType, structs, enums, foreignNamedTypes, fileName, true);
  if (containsSliceType(declaration.returnType.name)) {
    throw new DiagnosticError(fileName, declaration.returnType.location, "returning Slice values requires an explicit lifetime contract and is not implemented yet");
  }
  if (declaration.errorType) validateType(declaration.errorType, structs, enums, foreignNamedTypes, fileName, false);
  if (declaration.errorType && hasCleanupType(declaration.errorType.name, structs)) {
    throw new DiagnosticError(fileName, declaration.errorType.location, "throwing cleanup-bearing error values is not implemented in this bootstrap stage");
  }
  if (declaration.errorType && declaration.returnType.name === "void") {
    throw new DiagnosticError(fileName, declaration.returnType.location, "void success results are not implemented in this bootstrap stage");
  }
  if (declaration.errorType && declaration.parameters.some((parameter) => parameter.mode === "out")) {
    throw new DiagnosticError(fileName, declaration.location, "throwing functions with out parameters are not implemented yet");
  }
  for (const parameter of declaration.parameters) {
    if (parameter.name === "this") {
      throw new DiagnosticError(fileName, parameter.location, "`this` is reserved for a method receiver");
    }
    validateUserName(parameter.name, parameter.location, fileName);
    validateType(parameter.type, structs, enums, foreignNamedTypes, fileName, false);
    const slice = parseSliceType(parameter.type.name);
    if (slice && parameter.mode === "in") {
      throw new DiagnosticError(fileName, parameter.location, "Slice parameters are already borrowed; omit `in`");
    }
    if (slice && parameter.mode === "out") {
      throw new DiagnosticError(fileName, parameter.location, "out Slice parameters are not supported");
    }
    if (parameter.mode !== "value" && parameter.type.name === "cstring") {
      throw new DiagnosticError(fileName, parameter.location, "cstring already represents a borrowed C string; it cannot use in, inout, or out");
    }
  }
}

function validateValueLayouts(
  structDeclarations: StructDeclaration[],
  enumDeclarations: EnumDeclaration[],
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visitType = (name: string, location: SourceLocation): void => {
    const array = parseFixedArrayType(name);
    if (array) {
      visitType(array.elementType, location);
      return;
    }
    const struct = structs.get(name);
    if (struct?.kind === "struct") {
      visit(`struct:${name}`, name, location, struct.fields.map((field) => ({ type: field.type.name, location: field.location })));
      return;
    }
    const enumDeclaration = enums.get(name);
    if (enumDeclaration) {
      visit(
        `enum:${name}`,
        name,
        location,
        enumDeclaration.variants.flatMap((variant) => variant.payload ? [{ type: variant.payload.name, location: variant.location }] : []),
      );
    }
  };

  const visit = (
    key: string,
    name: string,
    location: SourceLocation,
    children: readonly { readonly type: string; readonly location: SourceLocation }[],
  ): void => {
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      throw new DiagnosticError(fileName, location, `type ${JSON.stringify(name)} has a recursive value layout`);
    }
    visiting.add(key);
    for (const child of children) visitType(child.type, child.location);
    visiting.delete(key);
    visited.add(key);
  };

  for (const declaration of structDeclarations) {
    if (declaration.kind === "struct") {
      visit(
        `struct:${declaration.name}`,
        declaration.name,
        declaration.location,
        declaration.fields.map((field) => ({ type: field.type.name, location: field.location })),
      );
    }
  }
  for (const declaration of enumDeclarations) {
    visit(
      `enum:${declaration.name}`,
      declaration.name,
      declaration.location,
      declaration.variants.flatMap((variant) => variant.payload ? [{ type: variant.payload.name, location: variant.location }] : []),
    );
  }
}

function analyzeFunction(
  declaration: FunctionDeclaration,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  receiver: StructDeclaration | null,
  state: AnalysisState,
): void {
  state.moveOrigins.clear();
  state.borrowOrigins.clear();
  state.iterationBorrowOrigins.clear();
  const locals = new Map<string, ValueType>();
  if (receiver) {
    const borrowed = declaration.receiverMode === "move" ? "" : borrowedPrefix;
    const mutable = declaration.receiverMode === "inout" || declaration.receiverMode === "move" ? mutablePrefix : "";
    locals.set("this", `${borrowed}${mutable}${receiver.name}`);
  }

  for (const parameter of declaration.parameters) {
    if (locals.has(parameter.name)) {
      throw new DiagnosticError(fileName, parameter.location, `duplicate parameter ${JSON.stringify(parameter.name)}`);
    }
    const borrowed = parameter.mode === "value" && !parseSliceType(parameter.type.name) ? "" : borrowedPrefix;
    const mutable = parameter.mode === "inout" || parameter.mode === "out" ? mutablePrefix : "";
    const uninitialized = parameter.mode === "out" ? uninitializedPrefix : "";
    locals.set(parameter.name, `${uninitialized}${borrowed}${mutable}${parameter.type.name}`);
    state.bindingTypes.set(parameter.location.offset, parameter.type.name);
  }

  const returns = analyzeStatements(declaration.body, declaration, locals, globals, structs, enums, fileName, state);
  if (!returns) requireOutParametersInitialized(declaration, locals, declaration.location, fileName);
  if (declaration.returnType.name !== "void" && !returns) {
    throw new DiagnosticError(fileName, declaration.location, `function ${JSON.stringify(declaration.name)} must end with a return value`);
  }
}

function analyzeStatements(
  statements: Statement[],
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): boolean {
  let returns = false;
  let stops = false;
  for (const statement of statements) {
    if (stops) {
      throw new DiagnosticError(
        fileName,
        statement.location,
        returns
          ? "unreachable statement after guaranteed function exit"
          : "unreachable statement after guaranteed loop control transfer",
      );
    }
    analyzeStatement(statement, owner, locals, globals, structs, enums, fileName, state);
    returns = statementReturns(statement);
    stops = statementStopsFlow(statement);
  }
  return returns;
}

function statementReturns(statement: Statement | undefined): boolean {
  if (!statement) return false;
  if (statement.kind === "return" || statement.kind === "throw") return true;
  if (statement.kind === "block") return statementReturns(statement.statements.at(-1));
  if (statement.kind === "if") {
    return Boolean(statement.elseBranch)
      && statementReturns(statement.thenBranch)
      && statementReturns(statement.elseBranch!);
  }
  return statement.kind === "match" && statement.arms.length > 0
    && statement.arms.every((arm) => statementReturns(arm.body));
}

function statementStopsFlow(statement: Statement | undefined): boolean {
  if (!statement) return false;
  if (
    statement.kind === "return"
    || statement.kind === "throw"
    || statement.kind === "break"
    || statement.kind === "continue"
  ) {
    return true;
  }
  if (statement.kind === "block") return statementStopsFlow(statement.statements.at(-1));
  if (statement.kind === "if") {
    return Boolean(statement.elseBranch)
      && statementStopsFlow(statement.thenBranch)
      && statementStopsFlow(statement.elseBranch!);
  }
  return statement.kind === "match" && statement.arms.length > 0
    && statement.arms.every((arm) => statementStopsFlow(arm.body));
}

function analyzeStatement(
  statement: Statement,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  switch (statement.kind) {
    case "variable": {
      validateUserName(statement.name, statement.location, fileName);
      if (locals.has(statement.name)) {
        throw new DiagnosticError(fileName, statement.location, `duplicate local ${JSON.stringify(statement.name)}`);
      }
      if (!statement.initializer) {
        const declaredType = statement.type!;
        validateType(declaredType, structs, enums, state.foreignNamedTypes, fileName, false);
        if (containsSliceType(declaredType.name)) {
          throw new DiagnosticError(fileName, declaredType.location, "Slice values cannot be stored in local bindings yet");
        }
        locals.set(statement.name, `${uninitializedPrefix}${mutablePrefix}${declaredType.name}`);
        state.bindingTypes.set(statement.nameLocation.offset, declaredType.name);
        return;
      }
      if (statement.initializer.kind === "closure") {
        if (statement.mutable) {
          throw new DiagnosticError(fileName, statement.location, "closure bindings are immutable in the initial non-escaping tier");
        }
        if (statement.type) {
          throw new DiagnosticError(fileName, statement.type.location, "explicit closure function types are not implemented yet");
        }
      }
      let initializerType = inferDirectValue(statement.initializer, owner, locals, globals, structs, enums, fileName, state);
      let variableType = initializerType;
      if (statement.type) {
        validateType(statement.type, structs, enums, state.foreignNamedTypes, fileName, false);
        variableType = statement.type.name;
        initializerType = contextualCStringLiteral(variableType, statement.initializer, state) ?? initializerType;
        requireAssignable(variableType, initializerType, statement.initializer, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      } else if (initializerType === "unknown") {
        throw new DiagnosticError(
          fileName,
          statement.initializer.location,
          "cannot infer the result of an imported function until its header is typed; add a type annotation",
        );
      } else if (initializerType === "never") {
        throw new DiagnosticError(fileName, statement.initializer.location, "cannot bind a value from an expression that never produces one");
      } else if (initializerType === "null") {
        throw new DiagnosticError(fileName, statement.initializer.location, "cannot infer a type from null; provide an explicitly nullable type");
      } else if (String(initializerType).startsWith(objcClassPrefix)) {
        throw new DiagnosticError(fileName, statement.initializer.location, "Objective-C class values can only be used as class-member receivers in the bootstrap");
      } else if (!statement.type && statement.initializer.kind === "number" && isIntegerLiteral(statement.initializer.value) && !integerLiteralFits(statement.initializer.value, "i32")) {
        throw new DiagnosticError(
          fileName,
          statement.initializer.location,
          `integer literal ${statement.initializer.value} does not fit default i32; add an explicit integer type`,
        );
      }
      consumeOwnedValue(statement.initializer, variableType, locals, structs, fileName, state);
      if (containsSliceType(String(variableType))) {
        throw new DiagnosticError(fileName, statement.location, "Slice values cannot be stored in local bindings yet");
      }
      locals.set(statement.name, statement.mutable ? `${mutablePrefix}${variableType}` : variableType);
      state.bindingTypes.set(statement.nameLocation.offset, String(variableType));
      return;
    }
    case "assignment": {
      if (statement.target.kind === "member") {
        inferExpression(statement.target, locals, globals, structs, enums, fileName, state);
        const property = state.objcProperties.get(statement.target.location.offset);
        if (property) {
          if (!property.setter) {
            throw new DiagnosticError(fileName, statement.target.location, `Objective-C property ${JSON.stringify(statement.target.property)} is readonly`);
          }
          const contextual = contextualObjCStringType(property.type, statement.expression, state);
          let actual = contextual ?? inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state);
          if (property.type.kind === "z" && property.type.name === "cstring" && actual === "String") {
            state.cstringConversions.add(statement.expression.location.offset);
            actual = "cstring";
          }
          requireObjCAssignable(property.type, actual, statement.expression, fileName, state);
          return;
        }
      }
      const root = storageRoot(statement.target);
      if (!root) {
        throw new DiagnosticError(fileName, statement.target.location, "assignment target must be a mutable binding or one of its fields");
      }
      const stored = locals.get(root.name);
      if (!stored) {
        inferExpression(statement.target, locals, globals, structs, enums, fileName, state);
        throw new DiagnosticError(fileName, statement.target.location, "assignment target must be local mutable storage");
      }
      const rootDeclaration = structs.get(underlyingType(stored));
      const mutatesThroughClassReference = statement.target.kind !== "identifier"
        && rootDeclaration?.kind === "class"
        && (!isBorrowedBinding(stored) || isMutableBinding(stored));
      if (!isMutableBinding(stored) && !mutatesThroughClassReference) {
        const action = statement.target.kind === "identifier"
          ? "assign to"
          : statement.target.kind === "member" ? "mutate a field through" : "mutate an indexed element through";
        throw new DiagnosticError(fileName, statement.target.location, `cannot ${action} immutable binding ${JSON.stringify(root.name)}`);
      }
      const expected = statement.target.kind === "identifier"
        ? underlyingType(stored)
        : inferExpression(statement.target, locals, globals, structs, enums, fileName, state);
      let actual = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state);
      actual = contextualCStringLiteral(expected, statement.expression, state) ?? actual;
      requireAssignable(expected, actual, statement.expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      if (hasCleanupType(expected, structs, state.foreignTypes)) {
        consumeOwnedValue(statement.expression, expected, locals, structs, fileName, state);
        if (statement.target.kind === "identifier") {
          // A whole binding may move into the replacement expression and become
          // initialized again when that expression succeeds.
          locals.set(root.name, initializedAvailableBinding(stored));
          state.moveOrigins.delete(root.name);
        } else {
          const rootAfterReplacement = locals.get(root.name);
          if (rootAfterReplacement && ownershipState(rootAfterReplacement) !== "available") {
            throw new DiagnosticError(
              fileName,
              statement.expression.location,
              `cannot replace a field after its owner ${JSON.stringify(root.name)} moves while evaluating the new value`,
            );
          }
        }
      } else if (statement.target.kind === "identifier") {
        locals.set(root.name, initializedAvailableBinding(stored));
        state.moveOrigins.delete(root.name);
      }
      return;
    }
    case "return": {
      const expected = owner.returnType.name;
      if (!statement.expression) {
        if (expected !== "void") {
          throw new DiagnosticError(fileName, statement.location, `expected a ${expected} return value`);
        }
        requireOutParametersInitialized(owner, locals, statement.location, fileName);
        return;
      }
      if (expected === "void") {
        throw new DiagnosticError(fileName, statement.location, "a void function cannot return a value");
      }
      let actual = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state);
      actual = contextualCStringLiteral(expected, statement.expression, state) ?? actual;
      requireAssignable(expected, actual, statement.expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      consumeOwnedValue(statement.expression, expected, locals, structs, fileName, state);
      requireOutParametersInitialized(owner, locals, statement.location, fileName);
      return;
    }
    case "throw": {
      if (!owner.errorType) {
        throw new DiagnosticError(fileName, statement.location, `function ${JSON.stringify(owner.name)} does not declare an error type`);
      }
      let actual = inferExpression(statement.expression, locals, globals, structs, enums, fileName, state);
      actual = contextualCStringLiteral(owner.errorType.name, statement.expression, state) ?? actual;
      requireAssignable(owner.errorType.name, actual, statement.expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      return;
    }
    case "break": {
      const loop = state.loopStack.at(-1);
      if (!loop) throw new DiagnosticError(fileName, statement.location, "break requires an enclosing loop");
      loop.breaks.push(new Map(locals));
      return;
    }
    case "continue": {
      const loop = state.loopStack.at(-1);
      if (!loop) throw new DiagnosticError(fileName, statement.location, "continue requires an enclosing loop");
      loop.continues.push(new Map(locals));
      return;
    }
    case "select":
      throw new DiagnosticError(fileName, statement.location, "select requires an enclosing value-producing block");
    case "block": {
      const blockLocals = new Map(locals);
      analyzeStatements(statement.statements, owner, blockLocals, globals, structs, enums, fileName, state);
      propagateOuterOwnership(locals, blockLocals);
      return;
    }
    case "if": {
      const conditionType = inferExpression(statement.condition, locals, globals, structs, enums, fileName, state);
      if (conditionType !== "bool" && !foreignPointer(conditionType, state)?.nullable) {
        requireAssignable("bool", conditionType, statement.condition, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      }
      analyzeIfBranches(statement, owner, locals, globals, structs, enums, fileName, state);
      return;
    }
    case "while": {
      analyzeWhileLoop(statement, owner, locals, globals, structs, enums, fileName, state);
      return;
    }
    case "for": {
      analyzeForLoop(statement, owner, locals, globals, structs, enums, fileName, state);
      return;
    }
    case "expressionStatement":
      {
        if (statement.expression.kind === "number" && isIntegerLiteral(statement.expression.value) && !integerLiteralFits(statement.expression.value, "i32")) {
          throw new DiagnosticError(fileName, statement.expression.location, `integer literal ${statement.expression.value} does not fit default i32`);
        }
        const type = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state);
        if (hasCleanupType(type, structs, state.foreignTypes)) {
          throw new DiagnosticError(fileName, statement.expression.location, "a cleanup-bearing value must be bound or transferred; it cannot be discarded");
        }
      }
      return;
    case "match": {
      const subjectType = inferExpression(statement.expression, locals, globals, structs, enums, fileName, state);
      const declaration = enums.get(subjectType);
      if (!declaration) {
        throw new DiagnosticError(fileName, statement.expression.location, `match requires an enum value, found ${subjectType}`);
      }
      const covered = new Set<string>();
      const continuing: Map<string, ValueType>[] = [];
      for (const arm of statement.arms) {
        const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName);
        if (!variant) throw new DiagnosticError(fileName, arm.location, `unknown variant ${JSON.stringify(arm.variantName)}`);
        if (covered.has(variant.name)) throw new DiagnosticError(fileName, arm.location, `duplicate match arm ${JSON.stringify(variant.name)}`);
        covered.add(variant.name);
        if (Boolean(variant.payload) !== Boolean(arm.binding)) {
          throw new DiagnosticError(fileName, arm.location, variant.payload ? "payload variant requires a binding" : "payloadless variant cannot bind a value");
        }
        if (arm.binding && arm.bindingLocation) validateUserName(arm.binding, arm.bindingLocation, fileName);
        const armLocals = new Map(locals);
        if (variant.payload && arm.binding && arm.bindingLocation) {
          armLocals.set(arm.binding, variant.payload.name);
          state.bindingTypes.set(arm.bindingLocation.offset, variant.payload.name);
        }
        analyzeStatement(arm.body, owner, armLocals, globals, structs, enums, fileName, state);
        if (!statementStopsFlow(arm.body)) continuing.push(armLocals);
      }
      const missing = declaration.variants.find((variant) => !covered.has(variant.name));
      if (missing) throw new DiagnosticError(fileName, statement.location, `non-exhaustive match; missing ${declaration.name}.${missing.name}`);
      mergeOwnershipStates(locals, continuing, state);
      return;
    }
  }
}

function inferDirectValue(
  expression: Expression,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType {
  if (expression.kind === "try") {
    return inferTrySuccess(expression, owner, locals, globals, structs, enums, fileName, state);
  }
  if (expression.kind === "matchExpression") {
    return inferMatchExpression(expression, owner, locals, globals, structs, enums, fileName, state);
  }
  if (expression.kind === "ifExpression") {
    return inferIfExpression(expression, owner, locals, globals, structs, enums, fileName, state);
  }
  if (expression.kind === "closure") {
    return inferClosureExpression(expression, owner, locals, globals, structs, enums, fileName, state);
  }
  return inferExpression(expression, locals, globals, structs, enums, fileName, state);
}

function closureTypeName(expression: Extract<Expression, { kind: "closure" }>): string {
  return `__z_closure_${expression.location.offset}`;
}

function closureInfoForType(type: ValueType, state: AnalysisState): ClosureInfo | null {
  const actual = String(underlyingType(type));
  if (!actual.startsWith("__z_closure_")) return null;
  return [...state.closures.values()].find((closure) => closure.type === actual) ?? null;
}

function inferClosureExpression(
  expression: Extract<Expression, { kind: "closure" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType {
  const parameterNames = new Set<string>();
  for (const parameter of expression.parameters) {
    if (parameterNames.has(parameter.name)) {
      throw new DiagnosticError(fileName, parameter.location, `duplicate closure parameter ${JSON.stringify(parameter.name)}`);
    }
    parameterNames.add(parameter.name);
    validateUserName(parameter.name, parameter.location, fileName);
    validateType(parameter.type, structs, enums, state.foreignNamedTypes, fileName, false);
    if (parameter.mode === "out") {
      throw new DiagnosticError(fileName, parameter.location, "out closure parameters are deferred until escaping function types are implemented");
    }
    const slice = parseSliceType(parameter.type.name);
    if (slice && parameter.mode === "in") {
      throw new DiagnosticError(fileName, parameter.location, "Slice parameters are already borrowed; omit `in`");
    }
    if (parameter.mode !== "value" && parameter.type.name === "cstring") {
      throw new DiagnosticError(fileName, parameter.location, "cstring already represents a borrowed C string; it cannot use in or inout");
    }
  }

  const discovered = collectClosureCaptures(expression, new Set(locals.keys()), parameterNames);
  const captures: ClosureCaptureInfo[] = [];
  const closureLocals = new Map<string, ValueType>();
  for (const capture of discovered.values()) {
    if (capture.name === "this") {
      throw new DiagnosticError(fileName, capture.location, "capturing `this` is not implemented in the initial closure tier");
    }
    const stored = locals.get(capture.name)!;
    if (initializationState(stored) !== "initialized") {
      throw new DiagnosticError(fileName, capture.location, `cannot capture uninitialized value ${JSON.stringify(capture.name)}`);
    }
    if (ownershipState(stored) !== "available") {
      throw movedValueError(fileName, { name: capture.name, location: capture.location }, state, false, "capture");
    }
    if (capture.mutated && !isMutableBinding(stored)) {
      throw new DiagnosticError(fileName, capture.location, `closure cannot mutate immutable capture ${JSON.stringify(capture.name)}`, {
        code: "Z0210",
        length: capture.name.length,
        notes: ["capturing a const binding does not make that binding mutable"],
        helps: [`declare ${JSON.stringify(capture.name)} with \`let\` if mutation is intended`],
      });
    }
    const type = String(underlyingType(stored));
    if (type.startsWith("__z_closure_")) {
      throw new DiagnosticError(fileName, capture.location, "capturing another closure requires escaping closure environments");
    }
    if (parseSliceType(type)) {
      throw new DiagnosticError(fileName, capture.location, "capturing Slice values requires an explicit lifetime contract");
    }
    if (expression.captureMode === "move" && hasCleanupType(type, structs, state.foreignTypes)) {
      throw new DiagnosticError(
        fileName,
        capture.location,
        `move-capturing cleanup-bearing ${type} requires an owned closure environment, which is not implemented yet`,
        {
          code: "Z0211",
          length: capture.name.length,
          labels: [{
            location: expression.location,
            message: "this `move` closure would need to own and later destroy its environment",
            length: 4,
          }],
          notes: ["the bootstrap currently supports borrowed closures and copyable move snapshots"],
          helps: ["remove `move` and keep the closure non-escaping, or keep ownership outside the closure for now"],
        },
      );
    }
    const mode: ClosureCaptureInfo["mode"] = capture.mutated
      ? "inout"
      : expression.captureMode === "move" || type === "cstring" ? "value" : "in";
    captures.push({ name: capture.name, type, mode, moved: expression.captureMode === "move" });
    closureLocals.set(capture.name, `${borrowedPrefix}${capture.mutated ? mutablePrefix : ""}${type}`);
    if (expression.captureMode === "borrow" && hasCleanupType(type, structs, state.foreignTypes)) {
      locals.set(capture.name, `${borrowedPrefix}${isMutableBinding(stored) ? mutablePrefix : ""}${type}`);
      state.borrowOrigins.set(capture.name, { location: capture.location, kind: "closure" });
    }
  }
  for (const parameter of expression.parameters) {
    const borrowed = parameter.mode === "value" && !parseSliceType(parameter.type.name) ? "" : borrowedPrefix;
    const mutable = parameter.mode === "inout" ? mutablePrefix : "";
    closureLocals.set(parameter.name, `${borrowed}${mutable}${parameter.type.name}`);
    state.bindingTypes.set(parameter.location.offset, parameter.type.name);
  }

  if (expression.body.kind === "block" && !expression.returnType) {
    throw new DiagnosticError(fileName, expression.location, "a block-bodied closure requires an explicit return type");
  }
  const provisionalReturn = expression.returnType ?? { name: "void", location: expression.location };
  if (expression.returnType) validateType(expression.returnType, structs, enums, state.foreignNamedTypes, fileName, true);
  const syntheticBase: FunctionDeclaration = {
    kind: "function",
    name: `__z_closure_call_${expression.location.offset}`,
    receiverMode: null,
    parameters: [
      ...captures.map((capture) => ({
        name: capture.name,
        mode: capture.mode,
        type: { name: capture.type, location: expression.location },
        location: expression.location,
      })),
      ...expression.parameters,
    ],
    returnType: provisionalReturn,
    errorType: null,
    body: [],
    location: expression.location,
  };

  let returnType: ValueType;
  let body: Statement[];
  if (expression.body.kind === "block") {
    body = expression.body.statements;
    const returns = analyzeStatements(body, syntheticBase, closureLocals, globals, structs, enums, fileName, state);
    if (syntheticBase.returnType.name !== "void" && !returns) {
      throw new DiagnosticError(fileName, expression.location, "closure must end with a return value");
    }
    returnType = syntheticBase.returnType.name;
  } else {
    returnType = inferDirectValue(expression.body, syntheticBase, closureLocals, globals, structs, enums, fileName, state);
    if (expression.returnType) {
      requireAssignable(expression.returnType.name, returnType, expression.body, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      returnType = expression.returnType.name;
    }
    consumeOwnedValue(expression.body, returnType, closureLocals, structs, fileName, state);
    body = [{ kind: "return", expression: expression.body, location: expression.body.location }];
  }

  const declaration = { ...syntheticBase, returnType: { name: String(returnType), location: provisionalReturn.location }, body };
  const type = closureTypeName(expression);
  state.closures.set(expression.location.offset, { type, declaration, captures, parameterCount: expression.parameters.length });
  return type;
}

function collectClosureCaptures(
  closure: Extract<Expression, { kind: "closure" }>,
  outerNames: ReadonlySet<string>,
  parameterNames: ReadonlySet<string>,
): Map<string, { readonly name: string; readonly location: SourceLocation; mutated: boolean }> {
  const captures = new Map<string, { readonly name: string; readonly location: SourceLocation; mutated: boolean }>();
  const record = (name: string, location: SourceLocation, mutated = false, localNames: ReadonlySet<string>): void => {
    if (!outerNames.has(name) || localNames.has(name)) return;
    const previous = captures.get(name);
    if (previous) previous.mutated ||= mutated;
    else captures.set(name, { name, location, mutated });
  };

  const walkExpression = (expression: Expression, localNames: ReadonlySet<string>, mutated = false): void => {
    switch (expression.kind) {
      case "number":
      case "string":
      case "boolean":
      case "null":
      case "dynamicArrayExpression":
        return;
      case "template":
        for (const part of expression.parts) {
          if (part.kind === "value") walkExpression(part.expression, localNames);
        }
        return;
      case "identifier":
        record(expression.name, expression.location, mutated, localNames);
        return;
      case "argumentReference":
        record(expression.name, expression.location, true, localNames);
        return;
      case "unary":
        walkExpression(expression.operand, localNames);
        return;
      case "binary":
        walkExpression(expression.left, localNames);
        walkExpression(expression.right, localNames);
        return;
      case "conditional":
        walkExpression(expression.condition, localNames);
        walkExpression(expression.thenExpression, localNames);
        walkExpression(expression.elseExpression, localNames);
        return;
      case "closure":
        return;
      case "call":
        walkExpression(expression.callee, localNames);
        for (const argument of expression.arguments) walkExpression(argument, localNames);
        return;
      case "member":
        walkExpression(expression.object, localNames, mutated);
        return;
      case "index":
        walkExpression(expression.object, localNames, mutated);
        walkExpression(expression.index, localNames);
        return;
      case "arrayExpression":
        for (const element of expression.elements) walkExpression(element, localNames);
        return;
      case "structExpression":
        for (const field of expression.fields) walkExpression(field.expression, localNames);
        return;
      case "variantExpression":
        walkExpression(expression.payload, localNames);
        return;
      case "attempt":
      case "try":
        walkExpression(expression.expression, localNames);
        return;
      case "matchExpression":
        walkExpression(expression.expression, localNames);
        for (const arm of expression.arms) {
          const armNames = new Set(localNames);
          if (arm.binding) armNames.add(arm.binding);
          walkStatement(arm.body, armNames);
        }
        return;
      case "ifExpression":
        walkExpression(expression.condition, localNames);
        walkStatement(expression.thenBranch, new Set(localNames));
        if (expression.elseBranch.kind === "ifExpression") walkExpression(expression.elseBranch, new Set(localNames));
        else walkStatement(expression.elseBranch, new Set(localNames));
        return;
    }
  };

  const walkStatements = (statements: readonly Statement[], localNames: Set<string>): void => {
    for (const statement of statements) {
      if (statement.kind === "variable") {
        if (statement.initializer) walkExpression(statement.initializer, localNames);
        localNames.add(statement.name);
      } else walkStatement(statement, localNames);
    }
  };

  const walkStatement = (statement: Statement, localNames: Set<string>): void => {
    switch (statement.kind) {
      case "variable":
        if (statement.initializer) walkExpression(statement.initializer, localNames);
        localNames.add(statement.name);
        return;
      case "assignment":
        walkExpression(statement.target, localNames, true);
        walkExpression(statement.expression, localNames);
        return;
      case "return":
        if (statement.expression) walkExpression(statement.expression, localNames);
        return;
      case "throw":
      case "select":
      case "expressionStatement":
        walkExpression(statement.expression, localNames);
        return;
      case "block":
        walkStatements(statement.statements, new Set(localNames));
        return;
      case "if":
        walkExpression(statement.condition, localNames);
        walkStatement(statement.thenBranch, new Set(localNames));
        if (statement.elseBranch) walkStatement(statement.elseBranch, new Set(localNames));
        return;
      case "while":
        walkExpression(statement.condition, localNames);
        walkStatement(statement.body, new Set(localNames));
        return;
      case "for": {
        walkExpression(statement.iterable, localNames);
        const bodyNames = new Set(localNames);
        bodyNames.add(statement.binding);
        walkStatement(statement.body, bodyNames);
        return;
      }
      case "match":
        walkExpression(statement.expression, localNames);
        for (const arm of statement.arms) {
          const armNames = new Set(localNames);
          if (arm.binding) armNames.add(arm.binding);
          walkStatement(arm.body, armNames);
        }
        return;
      case "break":
      case "continue":
        return;
    }
  };

  const names = new Set(parameterNames);
  if (closure.body.kind === "block") walkStatements(closure.body.statements, names);
  else walkExpression(closure.body, names);
  return captures;
}

function inferIfExpression(
  expression: Extract<Expression, { kind: "ifExpression" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType {
  const conditionType = inferExpression(expression.condition, locals, globals, structs, enums, fileName, state);
  if (conditionType !== "bool" && !foreignPointer(conditionType, state)?.nullable) {
    requireAssignable("bool", conditionType, expression.condition, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
  }

  const original = new Map(locals);
  const continuing: Map<string, ValueType>[] = [];
  const thenLocals = narrowedConditionLocals(original, expression.condition, true, state);
  const thenType = inferValueArm(expression.thenBranch, owner, thenLocals, globals, structs, enums, fileName, state);
  if (thenType !== "never") continuing.push(thenLocals);

  const elseLocals = narrowedConditionLocals(original, expression.condition, false, state);
  const elseType = expression.elseBranch.kind === "ifExpression"
    ? inferIfExpression(expression.elseBranch, owner, elseLocals, globals, structs, enums, fileName, state)
    : inferValueArm(expression.elseBranch, owner, elseLocals, globals, structs, enums, fileName, state);
  if (elseType !== "never") continuing.push(elseLocals);

  const resultType = commonBranchType("if", thenType, elseType, expression.elseBranch.location, fileName);
  mergeOwnershipStates(locals, continuing, state);
  return resultType;
}

function commonBranchType(
  construct: string,
  first: ValueType,
  second: ValueType,
  location: Expression["location"],
  fileName: string,
): ValueType {
  if (first === "never" || first === "unknown") return second;
  if (second === "never" || second === "unknown") return first;
  if (first !== second) {
    throw new DiagnosticError(fileName, location, `${construct} branch produces ${second}, but the other branch produces ${first}`);
  }
  return first;
}

function inferMatchExpression(
  expression: Extract<Expression, { kind: "matchExpression" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType {
  const subjectType = inferExpression(expression.expression, locals, globals, structs, enums, fileName, state);
  const declaration = enums.get(subjectType);
  if (!declaration) {
    throw new DiagnosticError(fileName, expression.expression.location, `match requires an enum value, found ${subjectType}`);
  }

  const covered = new Set<string>();
  const continuing: Map<string, ValueType>[] = [];
  let resultType: ValueType = "never";
  for (const arm of expression.arms) {
    const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName);
    if (!variant) throw new DiagnosticError(fileName, arm.location, `unknown variant ${JSON.stringify(arm.variantName)}`);
    if (covered.has(variant.name)) throw new DiagnosticError(fileName, arm.location, `duplicate match arm ${JSON.stringify(variant.name)}`);
    covered.add(variant.name);
    if (Boolean(variant.payload) !== Boolean(arm.binding)) {
      throw new DiagnosticError(fileName, arm.location, variant.payload ? "payload variant requires a binding" : "payloadless variant cannot bind a value");
    }
    if (arm.binding && arm.bindingLocation) validateUserName(arm.binding, arm.bindingLocation, fileName);
    const armLocals = new Map(locals);
    if (variant.payload && arm.binding && arm.bindingLocation) {
      armLocals.set(arm.binding, variant.payload.name);
      state.bindingTypes.set(arm.bindingLocation.offset, variant.payload.name);
    }
    const armType = inferValueArm(arm.body, owner, armLocals, globals, structs, enums, fileName, state);
    if (armType !== "never") {
      continuing.push(armLocals);
      if (resultType === "never" || resultType === "unknown") resultType = armType;
      else if (armType !== "unknown" && armType !== resultType) {
        throw new DiagnosticError(fileName, arm.location, `match arm produces ${armType}, but previous arms produce ${resultType}`);
      }
    }
  }
  const missing = declaration.variants.find((variant) => !covered.has(variant.name));
  if (missing) throw new DiagnosticError(fileName, expression.location, `non-exhaustive match; missing ${declaration.name}.${missing.name}`);
  mergeOwnershipStates(locals, continuing, state);
  return resultType;
}

function inferValueArm(
  statement: Statement,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType {
  if (statement.kind === "expressionStatement" || statement.kind === "select") {
    const type = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state);
    consumeOwnedValue(statement.expression, type, locals, structs, fileName, state);
    return type;
  }
  if (statement.kind === "return" || statement.kind === "throw") {
    analyzeStatement(statement, owner, locals, globals, structs, enums, fileName, state);
    return "never";
  }
  if (statement.kind === "block") {
    if (statement.statements.length === 0) {
      throw new DiagnosticError(fileName, statement.location, "a value-producing block cannot be empty");
    }
    const blockLocals = new Map(locals);
    const prefixReturns = analyzeStatements(
      statement.statements.slice(0, -1),
      owner,
      blockLocals,
      globals,
      structs,
      enums,
      fileName,
      state,
    );
    if (prefixReturns) {
      throw new DiagnosticError(fileName, statement.statements.at(-1)!.location, "unreachable statement after guaranteed function exit");
    }
    const type = inferValueArm(statement.statements.at(-1)!, owner, blockLocals, globals, structs, enums, fileName, state);
    propagateOuterOwnership(locals, blockLocals);
    return type;
  }
  if (statement.kind === "match") {
    return inferMatchExpression(
      { ...statement, kind: "matchExpression" },
      owner,
      locals,
      globals,
      structs,
      enums,
      fileName,
      state,
    );
  }
  throw new DiagnosticError(fileName, statement.location, "a value-producing block must produce a value with an expression or `select`");
}

function inferTrySuccess(
  expression: Extract<Expression, { kind: "try" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType {
  if (!owner.errorType) {
    throw new DiagnosticError(fileName, expression.location, "try requires an enclosing throwing function");
  }
  const resultType = inferExpression(expression.expression, locals, globals, structs, enums, fileName, state, true);
  const result = enums.get(resultType);
  if (!result || !result.name.startsWith("__z_Result_")) {
    throw new DiagnosticError(fileName, expression.location, "try requires a throwing function call");
  }
  const success = result.variants.find((variant) => variant.name === "success")!.payload!;
  const failure = result.variants.find((variant) => variant.name === "failure")!.payload!;
  if (failure.name !== owner.errorType.name) {
    throw new DiagnosticError(fileName, expression.location, `cannot propagate ${failure.name} from a function throwing ${owner.errorType.name}`);
  }
  return success.name;
}

function isConsoleMember(
  expression: Extract<Expression, { kind: "member" }>,
  locals: ReadonlyMap<string, ValueType>,
  globals: ReadonlyMap<string, SymbolValue>,
): boolean {
  return expression.object.kind === "identifier"
    && expression.object.name === "console"
    && !locals.has("console")
    && !globals.has("console");
}

function requireConsoleFormattable(
  type: ValueType,
  expression: Expression,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  visiting = new Set<string>(),
): void {
  const actual = String(underlyingType(type));
  if (hasCleanupType(actual, structs, state.foreignTypes)
    && !isNamedStorageExpression(expression)
    && expression.kind !== "string") {
    throw new DiagnosticError(fileName, expression.location, "console formatting of a cleanup-bearing temporary requires stored ownership", {
      code: "Z0402",
      helps: ["bind the value to a const or let before logging it"],
    });
  }
  if (actual === "null" || (primitiveTypes.has(actual) && actual !== "void")) return;
  if (actual.startsWith("__z_objc:") || actual.startsWith(objcClassPrefix) || state.foreignTypes.has(actual)) return;
  if (visiting.has(actual)) return;
  visiting.add(actual);
  const array = parseFixedArrayType(actual) ?? parseDynamicArrayType(actual) ?? parseSliceType(actual);
  if (array) {
    requireConsoleFormattable(
      array.elementType,
      { kind: "identifier", name: "element", location: expression.location },
      structs,
      enums,
      fileName,
      state,
      visiting,
    );
    visiting.delete(actual);
    return;
  }
  const declaration = structs.get(actual);
  if (declaration?.kind === "class") {
    visiting.delete(actual);
    return;
  }
  if (declaration) {
    for (const field of declaration.fields) {
      requireConsoleFormattable(
        field.type.name,
        { kind: "identifier", name: field.name, location: expression.location },
        structs,
        enums,
        fileName,
        state,
        visiting,
      );
    }
    visiting.delete(actual);
    return;
  }
  const enumDeclaration = enums.get(actual);
  if (enumDeclaration) {
    for (const variant of enumDeclaration.variants) {
      if (!variant.payload) continue;
      requireConsoleFormattable(
        variant.payload.name,
        { kind: "identifier", name: variant.name, location: expression.location },
        structs,
        enums,
        fileName,
        state,
        visiting,
      );
    }
    visiting.delete(actual);
    return;
  }
  const foreign = state.foreignNamedTypes.get(actual);
  if (foreign?.kind === "record") {
    for (const field of foreign.fields) {
      requireConsoleFormattable(
        field.typeName,
        { kind: "identifier", name: field.name, location: expression.location },
        structs,
        enums,
        fileName,
        state,
        visiting,
      );
    }
    visiting.delete(actual);
    return;
  }
  if (foreign?.kind === "enum" || foreign?.kind === "scalar") {
    visiting.delete(actual);
    return;
  }
  throw new DiagnosticError(fileName, expression.location, `console cannot format value of type ${actual}`, {
    code: "Z0401",
    helps: ["log one of the value's formattable fields, or add formatting support for this type"],
  });
}

function inferExpression(
  expression: Expression,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  allowThrowingCall = false,
): ValueType {
  const type = inferExpressionInner(
    expression,
    locals,
    globals,
    structs,
    enums,
    fileName,
    state,
    allowThrowingCall,
  );
  state.expressionTypes.set(expression.location.offset, String(type));
  return type;
}

function inferExpressionInner(
  expression: Expression,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  allowThrowingCall = false,
): ValueType {
  switch (expression.kind) {
    case "number":
      return isIntegerLiteral(expression.value) ? "i32" : "f64";
    case "string":
      return "String";
    case "template":
      for (const part of expression.parts) {
        if (part.kind !== "value") continue;
        const type = inferExpression(part.expression, locals, globals, structs, enums, fileName, state);
        requireConsoleFormattable(type, part.expression, structs, enums, fileName, state);
      }
      return "String";
    case "boolean":
      return "bool";
    case "null":
      return "null";
    case "argumentReference":
      throw new DiagnosticError(
        fileName,
        expression.location,
        `${expression.access} is only valid for a classified imported C record-pointer parameter`,
      );
    case "unary": {
      const operand = inferExpression(expression.operand, locals, globals, structs, enums, fileName, state);
      const canonicalOperand = canonicalType(operand, state.foreignNamedTypes);
      if (expression.operator === "!" && canonicalOperand === "bool") return "bool";
      if (expression.operator === "!" && foreignPointer(operand, state)?.nullable) return "bool";
      if (["+", "-"].includes(expression.operator) && isNumericType(canonicalOperand)) {
        state.foreignExpressionTypes.set(expression.location.offset, canonicalOperand);
        return canonicalOperand;
      }
      if (expression.operator === "~" && isIntegerType(canonicalOperand)) {
        state.foreignExpressionTypes.set(expression.location.offset, canonicalOperand);
        return canonicalOperand;
      }
      const requirement = expression.operator === "!" ? "a bool operand" : expression.operator === "~" ? "an integer operand" : "a numeric operand";
      throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires ${requirement}`);
    }
    case "identifier": {
      const local = locals.get(expression.name);
      if (local) {
        const initialization = initializationState(local);
        if (initialization === "uninitialized") {
          throw new DiagnosticError(fileName, expression.location, `use of uninitialized value ${JSON.stringify(expression.name)}`, {
            code: "Z0303",
            length: expression.name.length,
            notes: ["an out-style binding becomes readable only after every path initializes it"],
            helps: ["assign a value before this read, or pass the binding to an `out` parameter first"],
          });
        }
        if (initialization === "maybeUninitialized") {
          throw new DiagnosticError(fileName, expression.location, `value ${JSON.stringify(expression.name)} may be uninitialized on another control-flow path`, {
            code: "Z0304",
            length: expression.name.length,
            notes: ["Z requires a value to be initialized on every path reaching a read"],
            helps: ["initialize the binding in every branch before using it here"],
          });
        }
        const ownership = ownershipState(local);
        if (ownership === "moved") {
          throw movedValueError(fileName, expression, state, false);
        }
        if (ownership === "maybeMoved") {
          throw movedValueError(fileName, expression, state, true);
        }
        return underlyingType(local);
      }
      const global = globals.get(expression.name);
      if (global?.kind === "function") {
        throw new DiagnosticError(fileName, expression.location, "function values are not implemented; call the function instead");
      }
      if (global?.kind === "foreignFunction") {
        throw new DiagnosticError(fileName, expression.location, "foreign function values are not implemented; call the function instead");
      }
      if (global?.kind === "foreignConstant") {
        state.foreignExpressionTypes.set(expression.location.offset, global.declaration.typeName);
        state.foreignConstantNames.set(expression.location.offset, global.declaration.cName);
        return global.declaration.typeName;
      }
      if (global?.kind === "foreignType") {
        throw new DiagnosticError(fileName, expression.location, "an imported type must be followed by a field initializer or used in a type position");
      }
      if (global?.kind === "foreignModule") {
        throw new DiagnosticError(fileName, expression.location, "an imported module must be followed by a member name");
      }
      if (global?.kind === "struct") {
        throw new DiagnosticError(fileName, expression.location, "a struct type must be followed by a field initializer");
      }
      if (global?.kind === "enum") {
        throw new DiagnosticError(fileName, expression.location, "an enum type must be followed by a variant name");
      }
      throw new DiagnosticError(fileName, expression.location, `unknown name ${JSON.stringify(expression.name)}`);
    }
    case "binary": {
      const left = inferExpression(expression.left, locals, globals, structs, enums, fileName, state);
      const right = inferExpression(expression.right, locals, globals, structs, enums, fileName, state);
      let canonicalLeft = canonicalType(left, state.foreignNamedTypes);
      let canonicalRight = canonicalType(right, state.foreignNamedTypes);
      if (expression.right.kind === "number" && isNumericType(canonicalLeft)) {
        requireNumericLiteralFits(expression.right, canonicalLeft, fileName, state.numericLiteralTypes);
        canonicalRight = canonicalLeft;
      } else if (expression.left.kind === "number" && isNumericType(canonicalRight)) {
        requireNumericLiteralFits(expression.left, canonicalRight, fileName, state.numericLiteralTypes);
        canonicalLeft = canonicalRight;
      }
      if (["+", "-", "*", "/"].includes(expression.operator)) {
        if (canonicalLeft !== canonicalRight || !isNumericType(canonicalLeft)) {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires matching numeric operands`);
        }
        state.foreignExpressionTypes.set(expression.location.offset, canonicalLeft);
        return canonicalLeft;
      }
      if (["&", "|", "^", "<<", ">>"].includes(expression.operator)) {
        if (canonicalLeft !== canonicalRight || !isIntegerType(canonicalLeft)) {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires matching integer operands`);
        }
        const leftNamed = state.foreignNamedTypes.get(String(left));
        const rightNamed = state.foreignNamedTypes.get(String(right));
        const result = leftNamed?.kind === "enum"
          && leftNamed.flags
          && rightNamed?.kind === "enum"
          && rightNamed.cName === leftNamed.cName
          ? left
          : canonicalLeft;
        state.foreignExpressionTypes.set(expression.location.offset, String(result));
        return result;
      }
      if (["<", "<=", ">", ">="].includes(expression.operator)) {
        if (canonicalLeft !== canonicalRight || !isNumericType(canonicalLeft)) {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires matching numeric operands`);
        }
        return "bool";
      }
      if (["==", "!="].includes(expression.operator)) {
        const comparableNamed = left === right && state.foreignNamedTypes.get(String(left))?.kind === "enum";
        if (canonicalLeft !== canonicalRight || (!isNumericType(canonicalLeft) && canonicalLeft !== "bool" && !comparableNamed)) {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires matching numeric, bool, or enum operands`);
        }
        return "bool";
      }
      if (["&&", "||"].includes(expression.operator)) {
        if (canonicalType(left, state.foreignNamedTypes) !== "bool" || canonicalType(right, state.foreignNamedTypes) !== "bool") {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires bool operands`);
        }
        return "bool";
      }
      throw new DiagnosticError(fileName, expression.location, `unsupported binary operator ${JSON.stringify(expression.operator)}`);
    }
    case "conditional": {
      const conditionType = inferExpression(expression.condition, locals, globals, structs, enums, fileName, state);
      if (conditionType !== "bool" && !foreignPointer(conditionType, state)?.nullable) {
        requireAssignable("bool", conditionType, expression.condition, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      }
      const original = new Map(locals);
      const thenLocals = narrowedConditionLocals(original, expression.condition, true, state);
      const thenType = inferExpression(expression.thenExpression, thenLocals, globals, structs, enums, fileName, state);
      consumeOwnedValue(expression.thenExpression, thenType, thenLocals, structs, fileName, state);
      const elseLocals = narrowedConditionLocals(original, expression.condition, false, state);
      const elseType = inferExpression(expression.elseExpression, elseLocals, globals, structs, enums, fileName, state);
      consumeOwnedValue(expression.elseExpression, elseType, elseLocals, structs, fileName, state);
      mergeOwnershipStates(locals, [thenLocals, elseLocals], state);
      return commonBranchType("conditional", thenType, elseType, expression.elseExpression.location, fileName);
    }
    case "closure":
      throw new DiagnosticError(fileName, expression.location, "a closure must directly initialize a const binding in the initial non-escaping tier");
    case "structExpression": {
      const declaration = structs.get(expression.typeName);
      const foreignDeclaration = state.foreignNamedTypes.get(expression.typeName);
      if (!declaration && foreignDeclaration?.kind !== "record") {
        throw new DiagnosticError(fileName, expression.location, `unknown struct ${JSON.stringify(expression.typeName)}`);
      }
      const provided = new Set<string>();
      for (const initializer of expression.fields) {
        if (provided.has(initializer.name)) {
          throw new DiagnosticError(fileName, initializer.location, `duplicate field initializer ${JSON.stringify(initializer.name)}`);
        }
        provided.add(initializer.name);
        const field = declaration?.fields.find((candidate) => candidate.name === initializer.name)
          ?? (foreignDeclaration?.kind === "record" ? foreignDeclaration.fields.find((candidate) => candidate.name === initializer.name) : null);
        if (!field) {
          throw new DiagnosticError(fileName, initializer.location, `struct ${JSON.stringify(expression.typeName)} has no field ${JSON.stringify(initializer.name)}`);
        }
        const fieldType = "type" in field ? field.type.name : field.typeName;
        let actual = inferExpression(initializer.expression, locals, globals, structs, enums, fileName, state);
        actual = contextualCStringLiteral(fieldType, initializer.expression, state) ?? actual;
        requireAssignable(fieldType, actual, initializer.expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
        consumeOwnedValue(initializer.expression, fieldType, locals, structs, fileName, state);
      }
      const expectedFields = declaration?.fields ?? (foreignDeclaration?.kind === "record" ? foreignDeclaration.fields : []);
      const missing = expectedFields.find((field) => !provided.has(field.name));
      if (missing) {
        throw new DiagnosticError(fileName, expression.location, `missing field ${JSON.stringify(missing.name)} when constructing ${JSON.stringify(expression.typeName)}`);
      }
      if (foreignDeclaration?.kind === "record") state.foreignExpressionTypes.set(expression.location.offset, expression.typeName);
      return expression.typeName;
    }
    case "arrayExpression": {
      if (expression.elements.length === 0) {
        throw new DiagnosticError(fileName, expression.location, "cannot infer an empty fixed array; provide at least one element");
      }
      const elementType = inferExpression(expression.elements[0], locals, globals, structs, enums, fileName, state);
      if (elementType === "unknown" || elementType === "never" || elementType === "null") {
        throw new DiagnosticError(fileName, expression.elements[0].location, "cannot infer a fixed array element type from this expression");
      }
      consumeOwnedValue(expression.elements[0], elementType, locals, structs, fileName, state);
      for (const element of expression.elements.slice(1)) {
        const actual = inferExpression(element, locals, globals, structs, enums, fileName, state);
        requireAssignable(elementType, actual, element, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
        consumeOwnedValue(element, elementType, locals, structs, fileName, state);
      }
      return fixedArrayTypeName(String(elementType), expression.elements.length);
    }
    case "dynamicArrayExpression":
      return dynamicArrayTypeName(expression.elementType);
    case "index": {
      const ownerType = inferExpression(expression.object, locals, globals, structs, enums, fileName, state);
      const array = parseFixedArrayType(String(ownerType));
      const slice = parseSliceType(String(ownerType));
      const dynamic = parseDynamicArrayType(String(ownerType));
      if (!array && !slice && !dynamic) {
        throw new DiagnosticError(fileName, expression.object.location, `indexing requires an array or Slice, found ${ownerType}`);
      }
      if (hasCleanupType(ownerType, structs, state.foreignTypes) && !isNamedStorageExpression(expression.object)) {
        throw new DiagnosticError(fileName, expression.object.location, "a cleanup-bearing array temporary must be bound before indexing");
      }
      const indexType = inferExpression(expression.index, locals, globals, structs, enums, fileName, state);
      if (!isIntegerType(canonicalType(indexType, state.foreignNamedTypes))) {
        throw new DiagnosticError(fileName, expression.index.location, `array index must be an integer, found ${indexType}`);
      }
      if (array && expression.index.kind === "number" && /^[0-9]+$/.test(expression.index.value)) {
        const index = BigInt(expression.index.value);
        if (index >= BigInt(array.length)) {
          throw new DiagnosticError(
            fileName,
            expression.index.location,
            `array index ${expression.index.value} is out of bounds for length ${array.length}`,
          );
        }
      }
      return (array ?? slice ?? dynamic)!.elementType;
    }
    case "variantExpression": {
      const declaration = enums.get(expression.enumName);
      const variant = declaration?.variants.find((candidate) => candidate.name === expression.variantName);
      if (!declaration || !variant) {
        throw new DiagnosticError(fileName, expression.location, `unknown enum variant ${expression.enumName}.${expression.variantName}`);
      }
      if (!variant.payload) {
        throw new DiagnosticError(fileName, expression.location, "payloadless variant does not accept a value");
      }
      let actual = inferExpression(expression.payload, locals, globals, structs, enums, fileName, state);
      actual = contextualCStringLiteral(variant.payload.name, expression.payload, state) ?? actual;
      requireAssignable(variant.payload.name, actual, expression.payload, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      return declaration.name;
    }
    case "attempt": {
      const result = inferExpression(expression.expression, locals, globals, structs, enums, fileName, state, true);
      if (!result.startsWith("__z_Result_")) {
        throw new DiagnosticError(fileName, expression.location, "attempt requires a throwing function call");
      }
      return result;
    }
    case "try":
      throw new DiagnosticError(fileName, expression.location, "try must be the direct value of a binding, return, or expression statement");
    case "matchExpression":
      throw new DiagnosticError(fileName, expression.location, "match must be the direct value of a binding, return, or expression statement");
    case "ifExpression":
      throw new DiagnosticError(fileName, expression.location, "if must be the direct value of a binding, return, or expression statement");
    case "member": {
      const foreignConstant = getForeignConstant(expression, globals);
      if (foreignConstant) {
        state.foreignConstantNames.set(expression.location.offset, foreignConstant.cName);
        state.foreignExpressionTypes.set(expression.location.offset, foreignConstant.typeName);
        return foreignConstant.typeName;
      }
      const objcClass = getObjCClass(expression, globals);
      if (objcClass) {
        state.objcClassNames.set(expression.location.offset, objcClass.className);
        return `${objcClassPrefix}${objcClass.typeName}`;
      }
      const foreignFunction = getForeignFunction(expression, globals);
      if (foreignFunction) {
        throw new DiagnosticError(fileName, expression.location, "foreign function values are not implemented; call the function instead");
      }
      if (expression.object.kind === "identifier") {
        const enumDeclaration = enums.get(expression.object.name);
        if (enumDeclaration) {
          const variant = enumDeclaration.variants.find((candidate) => candidate.name === expression.property);
          if (!variant) throw new DiagnosticError(fileName, expression.location, `enum ${JSON.stringify(enumDeclaration.name)} has no variant ${JSON.stringify(expression.property)}`);
          if (variant.payload) throw new DiagnosticError(fileName, expression.location, "payload variant must be called with a value");
          return enumDeclaration.name;
        }
      }
      const receiverType = inferExpression(expression.object, locals, globals, structs, enums, fileName, state);
      const array = parseFixedArrayType(String(receiverType));
      const slice = parseSliceType(String(receiverType));
      const dynamic = parseDynamicArrayType(String(receiverType));
      if (array || slice || dynamic) {
        if (hasCleanupType(receiverType, structs, state.foreignTypes) && !isNamedStorageExpression(expression.object)) {
          throw new DiagnosticError(fileName, expression.object.location, "a cleanup-bearing array temporary must be bound before reading its length");
        }
        if (expression.property !== "length" && !(dynamic && expression.property === "capacity")) {
          throw new DiagnosticError(fileName, expression.location, `${dynamic ? "Array" : "fixed array"} has no member ${JSON.stringify(expression.property)}`);
        }
        return "usize";
      }
      const objcReceiverType = objcReceiver(receiverType, state);
      if (objcReceiverType) {
        const property = findObjCProperty(objcReceiverType, expression.property, state);
        if (!property) {
          throw new DiagnosticError(fileName, expression.location, `Objective-C ${JSON.stringify(objcReceiverType.declaration.className)} has no ${objcReceiverType.instance ? "instance" : "class"} property ${JSON.stringify(expression.property)}`);
        }
        const propertyType = foreignValueType(property.type);
        if (propertyType === "unknown") throw new DiagnosticError(fileName, expression.location, `Objective-C property ${JSON.stringify(property.name)} uses an unsupported type`);
        state.objcProperties.set(expression.location.offset, {
          getter: property.getter,
          setter: property.setter,
          type: property.type,
        });
        state.foreignExpressionTypes.set(expression.location.offset, String(propertyType));
        return propertyType;
      }
      if (hasCleanupType(receiverType, structs, state.foreignTypes) && !isNamedStorageExpression(expression.object)) {
        throw new DiagnosticError(fileName, expression.object.location, "a cleanup-bearing temporary must be bound before borrowing one of its members");
      }
      const declaration = structs.get(receiverType);
      const foreignRecord = state.foreignNamedTypes.get(String(receiverType));
      if (foreignRecord?.kind === "record") {
        const field = foreignRecord.fields.find((candidate) => candidate.name === expression.property);
        if (field) {
          state.foreignExpressionTypes.set(expression.location.offset, field.typeName);
          return field.typeName;
        }
        throw new DiagnosticError(fileName, expression.location, `record ${JSON.stringify(foreignRecord.typeName)} has no field ${JSON.stringify(expression.property)}`);
      }
      if (!declaration) {
        throw new DiagnosticError(fileName, expression.location, `type ${JSON.stringify(receiverType)} has no members`);
      }
      const field = declaration.fields.find((candidate) => candidate.name === expression.property);
      if (field) return field.type.name;
      const method = declaration.methods.find((candidate) => candidate.name === expression.property);
      if (method) {
        throw new DiagnosticError(fileName, expression.location, "method values are not implemented; call the method instead");
      }
      throw new DiagnosticError(fileName, expression.location, `struct ${JSON.stringify(declaration.name)} has no member ${JSON.stringify(expression.property)}`);
    }
    case "call": {
      if (expression.callee.kind === "member") {
        if (isConsoleMember(expression.callee, locals, globals)) {
          const supported = new Set(["log", "write", "error", "debug"]);
          if (!supported.has(expression.callee.property)) {
            throw new DiagnosticError(fileName, expression.callee.location, `console has no method ${JSON.stringify(expression.callee.property)} in the bootstrap`, {
              code: "Z0401",
              helps: ["use console.log, console.write, console.error, or console.debug"],
            });
          }
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          for (const argument of expression.arguments) {
            if (argument.kind === "template") {
              for (const part of argument.parts) {
                if (part.kind !== "value") continue;
                const type = inferExpression(part.expression, locals, globals, structs, enums, fileName, state);
                requireConsoleFormattable(type, part.expression, structs, enums, fileName, state);
              }
              continue;
            }
            const type = inferExpression(argument, locals, globals, structs, enums, fileName, state);
            requireConsoleFormattable(type, argument, structs, enums, fileName, state);
          }
          state.consoleCalls.add(expression.location.offset);
          return "void";
        }
        if (
          expression.callee.object.kind === "identifier"
          && expression.callee.object.name === "String"
          && expression.callee.property === "from"
        ) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.arguments.length !== 1) {
            throw new DiagnosticError(fileName, expression.location, `String.from expects 1 argument, received ${expression.arguments.length}`);
          }
          const actual = inferExpression(expression.arguments[0], locals, globals, structs, enums, fileName, state);
          requireAssignable("cstring", actual, expression.arguments[0], fileName, state.foreignNamedTypes, state.numericLiteralTypes);
          return "String";
        }
        if (expression.callee.object.kind === "identifier") {
          const enumDeclaration = enums.get(expression.callee.object.name);
          if (enumDeclaration) {
            rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
            const variant = enumDeclaration.variants.find((candidate) => candidate.name === expression.callee.property);
            if (!variant) throw new DiagnosticError(fileName, expression.callee.location, `enum ${JSON.stringify(enumDeclaration.name)} has no variant ${JSON.stringify(expression.callee.property)}`);
            const expectedCount = variant.payload ? 1 : 0;
            if (expression.arguments.length !== expectedCount) throw new DiagnosticError(fileName, expression.location, `variant ${JSON.stringify(variant.name)} expects ${expectedCount} argument(s)`);
            if (variant.payload) {
              const actual = inferExpression(expression.arguments[0], locals, globals, structs, enums, fileName, state);
              requireAssignable(variant.payload.name, actual, expression.arguments[0], fileName, state.foreignNamedTypes, state.numericLiteralTypes);
            }
            return enumDeclaration.name;
          }
        }
        if (isForeignMember(expression.callee, globals)) {
          const foreignFunction = getForeignFunction(expression.callee, globals);
          if (foreignFunction) {
            rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
            state.foreignFunctionNames.set(expression.callee.location.offset, foreignFunction.cName);
            return checkForeignCall(foreignFunction, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
          }
          const symbol = expression.callee.object.kind === "identifier" ? globals.get(expression.callee.object.name) : null;
          if (symbol?.kind === "foreignModule") {
            throw new DiagnosticError(fileName, expression.callee.location, `header ${JSON.stringify(symbol.module.declaration.header)} has no function ${JSON.stringify(expression.callee.property)}`);
          }
        }
        const receiverType = inferExpression(expression.callee.object, locals, globals, structs, enums, fileName, state);
        const dynamic = parseDynamicArrayType(String(receiverType));
        if (dynamic) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.callee.property !== "push") {
            throw new DiagnosticError(fileName, expression.callee.location, `Array has no method ${JSON.stringify(expression.callee.property)}`);
          }
          if (expression.arguments.length !== 1) {
            throw new DiagnosticError(fileName, expression.location, `"push" expects 1 argument, received ${expression.arguments.length}`);
          }
          const root = storageRoot(expression.callee.object);
          const stored = root ? locals.get(root.name) : null;
          if (!root || !stored || !isMutableBinding(stored)) {
            const iteration = root ? state.iterationBorrowOrigins.get(root.name) : null;
            if (root && iteration) {
              throw new DiagnosticError(
                fileName,
                expression.callee.location,
                `cannot structurally mutate Array ${JSON.stringify(root.name)} while for...of is borrowing it`,
                {
                  code: "Z0311",
                  length: expression.callee.property.length,
                  labels: [{ location: iteration, message: "iteration borrow begins here", length: 3 }],
                  notes: ["Array.push may reallocate storage and invalidate the element currently being visited"],
                  helps: ["finish the loop before pushing, or iterate a separate snapshot"],
                },
              );
            }
            throw new DiagnosticError(fileName, expression.callee.object.location, "Array.push requires addressable let storage");
          }
          const actual = inferExpression(expression.arguments[0], locals, globals, structs, enums, fileName, state);
          requireAssignable(dynamic.elementType, actual, expression.arguments[0], fileName, state.foreignNamedTypes, state.numericLiteralTypes);
          consumeOwnedValue(expression.arguments[0], dynamic.elementType, locals, structs, fileName, state);
          return "void";
        }
        const objcReceiverType = objcReceiver(receiverType, state);
        if (objcReceiverType) {
          const method = findObjCMethod(
            objcReceiverType,
            expression.callee.property,
            expression.arguments.length,
            expression.argumentLabels,
            state,
            fileName,
            expression.callee.location,
          );
          checkObjCArguments(method, expression.arguments, locals, globals, structs, enums, fileName, state);
          state.objcCalls.set(expression.location.offset, { selector: method.selector });
          let result = foreignValueType(method.returnType);
          if (method.returnsInstanceType) {
            const nullable = method.returnType.kind === "object" && method.returnType.nullable;
            result = `__z_objc:${nullable ? "nullable" : "nonnull"}:${objcReceiverType.declaration.typeName}`;
          }
          if (result === "unknown") throw new DiagnosticError(fileName, expression.location, `Objective-C selector ${JSON.stringify(method.selector)} uses an unsupported return type`);
          state.foreignCallTypes.set(expression.location.offset, String(result));
          return result;
        }
        const declaration = structs.get(receiverType);
        const method = declaration?.methods.find((candidate) => candidate.name === expression.callee.property);
        if (!declaration || !method) {
          throw new DiagnosticError(fileName, expression.callee.location, `type ${JSON.stringify(receiverType)} has no method ${JSON.stringify(expression.callee.property)}`);
        }
        rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
        if (
          method.receiverMode !== "move"
          && hasCleanupType(receiverType, structs, state.foreignTypes)
          && !isNamedStorageExpression(expression.callee.object)
        ) {
          throw new DiagnosticError(fileName, expression.callee.object.location, "a cleanup-bearing temporary must be bound before borrowing it for a method call");
        }
        const mutableReceiverRoot = method.receiverMode === "inout"
          ? storageRoot(expression.callee.object)
          : null;
        const consumingReceiverRoot = method.receiverMode === "move"
          ? storageRoot(expression.callee.object)
          : null;
        if (method.receiverMode === "inout") {
          if (!mutableReceiverRoot) {
            throw new DiagnosticError(
              fileName,
              expression.callee.object.location,
              declaration.kind === "class"
                ? `mutable method ${JSON.stringify(method.name)} requires an addressable class reference`
                : `mutable method ${JSON.stringify(method.name)} requires addressable let storage`,
            );
          }
          const storedReceiver = locals.get(mutableReceiverRoot.name);
          const unavailableClassBorrow = declaration.kind === "class"
            && storedReceiver
            && isBorrowedBinding(storedReceiver)
            && !isMutableBinding(storedReceiver);
          if (
            !storedReceiver
            || declaration.kind !== "class" && !isMutableBinding(storedReceiver)
            || unavailableClassBorrow
          ) {
            throw new DiagnosticError(
              fileName,
              expression.callee.object.location,
              `mutable method ${JSON.stringify(method.name)} cannot be called through immutable binding ${JSON.stringify(mutableReceiverRoot.name)}`,
            );
          }
        }
        checkArguments(
          method,
          expression.arguments,
          locals,
          globals,
          structs,
          enums,
          fileName,
          expression.location,
          state,
          mutableReceiverRoot
            ? { name: mutableReceiverRoot.name, mode: "inout" }
            : consumingReceiverRoot
              ? { name: consumingReceiverRoot.name, mode: "move" }
              : null,
        );
        if (mutableReceiverRoot) {
          const receiverAfterArguments = locals.get(mutableReceiverRoot.name);
          if (receiverAfterArguments && ownershipState(receiverAfterArguments) !== "available") {
            throw new DiagnosticError(
              fileName,
              expression.location,
              `mutable receiver ${JSON.stringify(mutableReceiverRoot.name)} cannot move while borrowed for this call`,
            );
          }
        }
        if (method.receiverMode === "move") {
          consumeOwnedValue(expression.callee.object, receiverType, locals, structs, fileName, state);
        }
        if (method.errorType) {
          if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
          return resultTypeName(method.returnType.name, method.errorType.name);
        }
        return method.returnType.name;
      }
      if (expression.callee.kind !== "identifier") {
        throw new DiagnosticError(fileName, expression.callee.location, "this expression is not callable");
      }
      const localCallee = locals.get(expression.callee.name);
      if (localCallee) {
        const closure = closureInfoForType(localCallee, state);
        if (!closure) {
          throw new DiagnosticError(fileName, expression.callee.location, `${JSON.stringify(expression.callee.name)} is not callable`);
        }
        state.expressionTypes.set(expression.callee.location.offset, closure.type);
        rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
        checkArguments(
          { ...closure.declaration, parameters: closure.declaration.parameters.slice(closure.captures.length) },
          expression.arguments,
          locals,
          globals,
          structs,
          enums,
          fileName,
          expression.location,
          state,
        );
        return closure.declaration.returnType.name;
      }
      const target = globals.get(expression.callee.name);
      if (target?.kind === "foreignFunction") {
        rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
        state.foreignFunctionNames.set(expression.callee.location.offset, target.declaration.cName);
        return checkForeignCall(target.declaration, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
      }
      if (target?.kind !== "function") {
        throw new DiagnosticError(fileName, expression.callee.location, `unknown function ${JSON.stringify(expression.callee.name)}`);
      }
      rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
      checkArguments(target.declaration, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
      if (target.declaration.errorType) {
        if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
        return resultTypeName(target.declaration.returnType.name, target.declaration.errorType.name);
      }
      return target.declaration.returnType.name;
    }
  }
}

function checkArguments(
  target: FunctionDeclaration,
  args: Expression[],
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  location: SourceLocation,
  state: AnalysisState,
  receiverUse: { readonly name: string; readonly mode: "inout" | "move" } | null = null,
): void {
  if (target.parameters.length !== args.length) {
    throw new DiagnosticError(
      fileName,
      location,
      `${JSON.stringify(target.name)} expects ${target.parameters.length} argument(s), received ${args.length}`,
    );
  }
  const activeUses = new Map<string, "value" | "in" | "inout" | "out" | "move">();
  if (receiverUse) activeUses.set(receiverUse.name, receiverUse.mode);
  for (let index = 0; index < target.parameters.length; index += 1) {
    const parameter = target.parameters[index];
    const useMode = parseSliceType(parameter.type.name) && parameter.mode === "value" ? "in" : parameter.mode;
    const argument = args[index];
    const root = argument.kind === "argumentReference"
      ? argument.name
      : storageRoot(argument)?.name ?? null;
    if (!root) continue;
    const previous = activeUses.get(root);
    if (previous && !((previous === "in" && useMode === "in") || (previous === "value" && useMode === "value"))) {
      throw new DiagnosticError(
        fileName,
        argument.location,
        `overlapping ${previous} and ${useMode} uses of ${JSON.stringify(root)} in one call are not allowed`,
      );
    }
    activeUses.set(root, useMode);
  }
  for (let index = 0; index < target.parameters.length; index += 1) {
    const parameter = target.parameters[index];
    const argument = args[index];
    if (parameter.mode === "out") {
      if (argument.kind !== "argumentReference" || argument.access !== "out") {
        const binding = argument.kind === "identifier" ? argument.name : "value";
        throw new DiagnosticError(
          fileName,
          argument.location,
          `${JSON.stringify(target.name)} requires out <mutable binding> for parameter ${index + 1}`,
          {
            code: "Z0302",
            length: argument.kind === "identifier" ? argument.name.length : 1,
            notes: ["`out` grants the callee permission to initialize storage without reading its previous value"],
            helps: [`pass mutable storage explicitly as \`out ${binding}\``],
          },
        );
      }
      const stored = locals.get(argument.name);
      if (!stored) throw new DiagnosticError(fileName, argument.location, `unknown name ${JSON.stringify(argument.name)}`);
      if (!isMutableBinding(stored)) {
        throw new DiagnosticError(fileName, argument.location, `out argument ${JSON.stringify(argument.name)} requires a mutable let binding`, {
          code: "Z0302",
          length: argument.name.length,
          helps: [`declare ${JSON.stringify(argument.name)} with \`let\` before passing it as \`out\``],
        });
      }
      requireAssignable(
        parameter.type.name,
        underlyingType(stored),
        argument,
        fileName,
        state.foreignNamedTypes,
        state.numericLiteralTypes,
      );
      locals.set(argument.name, initializedAvailableBinding(stored));
      state.moveOrigins.delete(argument.name);
      state.nativeArgumentAccesses.set(argument.location.offset, "out");
      continue;
    }
    if (parameter.mode === "inout") {
      if (argument.kind !== "argumentReference" || argument.access !== "inout") {
        const binding = argument.kind === "identifier" ? argument.name : "value";
        throw new DiagnosticError(
          fileName,
          argument.location,
          `${JSON.stringify(target.name)} requires inout <mutable binding> for parameter ${index + 1}`,
          {
            code: "Z0301",
            length: argument.kind === "identifier" ? argument.name.length : 1,
            notes: ["`inout` makes mutation visible at both the function declaration and the call site"],
            helps: [`pass mutable storage explicitly as \`inout ${binding}\``],
          },
        );
      }
      const stored = locals.get(argument.name);
      if (!stored) throw new DiagnosticError(fileName, argument.location, `unknown name ${JSON.stringify(argument.name)}`);
      if (initializationState(stored) === "uninitialized") {
        throw new DiagnosticError(fileName, argument.location, `inout argument ${JSON.stringify(argument.name)} must be initialized before the call`);
      }
      if (initializationState(stored) === "maybeUninitialized") {
        throw new DiagnosticError(fileName, argument.location, `inout argument ${JSON.stringify(argument.name)} may be uninitialized on another control-flow path`);
      }
      if (ownershipState(stored) === "moved") {
        throw movedValueError(fileName, { ...argument, kind: "identifier" }, state, false);
      }
      if (ownershipState(stored) === "maybeMoved") {
        throw movedValueError(fileName, { ...argument, kind: "identifier" }, state, true);
      }
      if (!isMutableBinding(stored)) {
        throw new DiagnosticError(fileName, argument.location, `inout argument ${JSON.stringify(argument.name)} requires a mutable let binding`, {
          code: "Z0301",
          length: argument.name.length,
          helps: [`declare ${JSON.stringify(argument.name)} with \`let\` before passing it as \`inout\``],
        });
      }
      const expectedSlice = parseSliceType(parameter.type.name);
      const storedType = underlyingType(stored);
      const storedArray = parseFixedArrayType(storedType);
      const storedDynamic = parseDynamicArrayType(storedType);
      if (expectedSlice && (storedArray ?? storedDynamic)?.elementType === expectedSlice.elementType) {
        state.sliceConversions.set(argument.location.offset, { sourceType: storedType, targetType: parameter.type.name });
      } else {
        requireAssignable(
          parameter.type.name,
          storedType,
          argument,
          fileName,
          state.foreignNamedTypes,
          state.numericLiteralTypes,
        );
      }
      state.nativeArgumentAccesses.set(argument.location.offset, "inout");
      continue;
    }
    if (argument.kind === "argumentReference") {
      throw new DiagnosticError(
        fileName,
        argument.location,
        `${argument.access} is not valid for ${parameter.mode === "in" ? "an immutable borrow" : "an owned value parameter"}`,
      );
    }
    if (parameter.mode === "in") {
      if (!isNamedStorageExpression(argument) && argument.kind !== "structExpression" && argument.kind !== "template") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `borrowed argument to ${JSON.stringify(target.name)} must be stored or a struct literal`,
        );
      }
      const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
      if (
        hasCleanupType(actual, structs, state.foreignTypes)
        && !isNamedStorageExpression(argument)
        && argument.kind !== "template"
      ) {
        throw new DiagnosticError(fileName, argument.location, "a cleanup-bearing borrowed temporary must be bound before the call");
      }
      requireAssignable(parameter.type.name, actual, argument, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      state.nativeArgumentAccesses.set(argument.location.offset, "in");
      continue;
    }
    let actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
    actual = contextualCStringLiteral(parameter.type.name, argument, state) ?? actual;
    const expectedSlice = parseSliceType(parameter.type.name);
    const actualArray = parseFixedArrayType(String(actual));
    const actualDynamic = parseDynamicArrayType(String(actual));
    if (expectedSlice) {
      if ((actualArray ?? actualDynamic)?.elementType === expectedSlice.elementType) {
        if (!isNamedStorageExpression(argument)) {
          throw new DiagnosticError(fileName, argument.location, "an array-to-Slice borrow requires stored array storage");
        }
        state.sliceConversions.set(argument.location.offset, { sourceType: String(actual), targetType: parameter.type.name });
      } else {
        requireAssignable(parameter.type.name, actual, argument, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      }
      continue;
    }
    requireAssignable(parameter.type.name, actual, argument, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
    consumeOwnedValue(argument, parameter.type.name, locals, structs, fileName, state);
  }
}

function validateDeinitControlFlow(statements: Statement[], fileName: string): void {
  for (const statement of statements) {
    if (statement.kind === "return" || statement.kind === "throw" || statement.kind === "select") {
      throw new DiagnosticError(fileName, statement.location, `deinit cannot contain ${JSON.stringify(statement.kind)}`);
    }
    if (statement.kind === "block") validateDeinitControlFlow(statement.statements, fileName);
    if (statement.kind === "variable" && statement.initializer) validateDeinitExpression(statement.initializer, fileName);
    if (statement.kind === "assignment") {
      validateDeinitExpression(statement.target, fileName);
      validateDeinitExpression(statement.expression, fileName);
    }
    if (statement.kind === "expressionStatement") validateDeinitExpression(statement.expression, fileName);
    if (statement.kind === "if") {
      validateDeinitExpression(statement.condition, fileName);
      validateDeinitControlFlow(statement.thenBranch.statements, fileName);
      if (statement.elseBranch?.kind === "block") validateDeinitControlFlow(statement.elseBranch.statements, fileName);
      if (statement.elseBranch?.kind === "if") validateDeinitControlFlow([statement.elseBranch], fileName);
    }
    if (statement.kind === "for") {
      validateDeinitExpression(statement.iterable, fileName);
      validateDeinitControlFlow(statement.body.statements, fileName);
    }
    if (statement.kind === "while") {
      validateDeinitExpression(statement.condition, fileName);
      validateDeinitControlFlow(statement.body.statements, fileName);
    }
    if (statement.kind === "match") {
      validateDeinitExpression(statement.expression, fileName);
      for (const arm of statement.arms) validateDeinitControlFlow([arm.body], fileName);
    }
  }
}

function validateDeinitExpression(expression: Expression, fileName: string): void {
  if (expression.kind === "unary") validateDeinitExpression(expression.operand, fileName);
  if (expression.kind === "binary") {
    validateDeinitExpression(expression.left, fileName);
    validateDeinitExpression(expression.right, fileName);
  }
  if (expression.kind === "conditional") {
    validateDeinitExpression(expression.condition, fileName);
    validateDeinitExpression(expression.thenExpression, fileName);
    validateDeinitExpression(expression.elseExpression, fileName);
  }
  if (expression.kind === "call") {
    validateDeinitExpression(expression.callee, fileName);
    for (const argument of expression.arguments) validateDeinitExpression(argument, fileName);
  }
  if (expression.kind === "member") validateDeinitExpression(expression.object, fileName);
  if (expression.kind === "index") {
    validateDeinitExpression(expression.object, fileName);
    validateDeinitExpression(expression.index, fileName);
  }
  if (expression.kind === "arrayExpression") {
    for (const element of expression.elements) validateDeinitExpression(element, fileName);
  }
  if (expression.kind === "structExpression") {
    for (const field of expression.fields) validateDeinitExpression(field.expression, fileName);
  }
  if (expression.kind === "variantExpression") validateDeinitExpression(expression.payload, fileName);
  if (expression.kind === "attempt" || expression.kind === "try") {
    validateDeinitExpression(expression.expression, fileName);
  }
  if (expression.kind === "matchExpression") {
    validateDeinitExpression(expression.expression, fileName);
    for (const arm of expression.arms) validateDeinitControlFlow([arm.body], fileName);
  }
  if (expression.kind === "template") {
    for (const part of expression.parts) {
      if (part.kind === "value") validateDeinitExpression(part.expression, fileName);
    }
  }
  if (expression.kind === "ifExpression") {
    validateDeinitExpression(expression.condition, fileName);
    validateDeinitControlFlow(expression.thenBranch.statements, fileName);
    if (expression.elseBranch.kind === "ifExpression") validateDeinitExpression(expression.elseBranch, fileName);
    else validateDeinitControlFlow(expression.elseBranch.statements, fileName);
  }
  if (expression.kind === "closure") {
    throw new DiagnosticError(fileName, expression.location, "deinit cannot create a closure");
  }
}

function consumeOwnedValue(
  expression: Expression,
  type: ValueType,
  locals: Map<string, ValueType>,
  structs: Map<string, StructDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  if (!hasCleanupType(type, structs, state.foreignTypes)) return;
  const declaration = structs.get(underlyingType(type));
  if (declaration?.kind === "class") {
    if (expression.kind === "identifier" || expression.kind === "member" || expression.kind === "index") {
      state.classCopies.add(expression.location.offset);
    }
    return;
  }
  if (expression.kind === "member" || expression.kind === "index") {
    throw new DiagnosticError(fileName, expression.location, "moving a cleanup-bearing element out of its owner is not implemented yet");
  }
  if (expression.kind !== "identifier") return;
  const stored = locals.get(expression.name);
  if (!stored) return;
  if (isBorrowedBinding(stored)) {
    if (expression.name === "this") {
      throw new DiagnosticError(fileName, expression.location, "cannot move the borrowed method receiver `this`; declare `move this`", {
        code: "Z0203",
        length: 4,
        notes: ["methods borrow their receiver unless their signature explicitly consumes it"],
        helps: ["change the receiver declaration to `move this` if this method must consume the value"],
      });
    }
    const borrow = state.borrowOrigins.get(expression.name);
    if (borrow?.kind === "closure") {
      throw new DiagnosticError(fileName, expression.location, `cannot transfer ownership of ${JSON.stringify(expression.name)} while it is borrowed by a closure`, {
        code: "Z0203",
        length: expression.name.length,
        labels: [{ location: borrow.location, message: "closure borrow begins here", length: expression.name.length }],
        notes: ["the borrowed closure may still read this value later in the enclosing scope"],
        helps: ["keep the owner available until the closure is no longer used; owned escaping closure environments are not implemented yet"],
      });
    }
    if (borrow?.kind === "iteration") {
      throw new DiagnosticError(fileName, expression.location, `cannot move borrowed iteration binding ${JSON.stringify(expression.name)}`, {
        code: "Z0203",
        length: expression.name.length,
        labels: [{ location: borrow.location, message: "for...of borrows cleanup-bearing elements here", length: 3 }],
        notes: ["moving an element would leave a hole in collection storage that still owns its elements"],
        helps: ["borrow the element with an `in` parameter inside the loop; explicit element removal is a future collection operation"],
      });
    }
    throw new DiagnosticError(fileName, expression.location, `cannot move borrowed parameter ${JSON.stringify(expression.name)}`, {
      code: "Z0203",
      length: expression.name.length,
      notes: ["an `in` parameter is borrowed from its caller and is not owned by this function"],
      helps: ["remove `in` from the parameter if the function is intended to take ownership"],
    });
  }
  locals.set(
    expression.name,
    `${movedPrefix}${isMutableBinding(stored) ? mutablePrefix : ""}${underlyingType(stored)}`,
  );
  state.movedExpressions.add(expression.location.offset);
  state.moveOrigins.set(expression.name, expression.location);
}

function movedValueError(
  fileName: string,
  expression: { readonly name: string; readonly location: SourceLocation },
  state: AnalysisState,
  maybe: boolean,
  action = "use",
): DiagnosticError {
  const origin = state.moveOrigins.get(expression.name);
  return new DiagnosticError(
    fileName,
    expression.location,
    maybe
      ? `value ${JSON.stringify(expression.name)} may have been moved on another control-flow path`
      : `${action} of moved value ${JSON.stringify(expression.name)}`,
    {
      code: maybe ? "Z0202" : "Z0201",
      length: expression.name.length,
      labels: origin ? [{
        location: origin,
        message: maybe ? "ownership is transferred on at least one path here" : "ownership was transferred here",
        length: expression.name.length,
      }] : [],
      notes: ["cleanup-bearing values have a single owner and cannot be used after ownership transfers"],
      helps: [
        maybe
          ? "make ownership transfer consistent across every branch, or keep the value borrowed"
          : "borrow the value with an `in` parameter when ownership transfer is unnecessary, or stop using it after the transfer",
      ],
    },
  );
}

function rejectForeignOwnedMove(
  expression: Expression,
  type: ValueType,
  structs: Map<string, StructDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  if (!hasCleanupType(type, structs, state.foreignTypes)) return;
  throw new DiagnosticError(
    fileName,
    expression.location,
    "passing an owned Z value to an untyped foreign function requires imported ownership metadata",
  );
}

function isNamedStorageExpression(expression: Expression): boolean {
  if (expression.kind === "identifier") return true;
  return (expression.kind === "member" || expression.kind === "index") && isNamedStorageExpression(expression.object);
}

function storageRoot(expression: Expression): Extract<Expression, { kind: "identifier" }> | null {
  let current: Expression = expression;
  while (current.kind === "member" || current.kind === "index") current = current.object;
  return current.kind === "identifier" ? current : null;
}

function ownershipState(type: ValueType): "available" | "moved" | "maybeMoved" {
  if (type.startsWith(movedPrefix)) return "moved";
  if (type.startsWith(maybeMovedPrefix)) return "maybeMoved";
  if (type.startsWith(uninitializedPrefix)) return ownershipState(type.slice(uninitializedPrefix.length));
  if (type.startsWith(maybeUninitializedPrefix)) return ownershipState(type.slice(maybeUninitializedPrefix.length));
  if (type.startsWith(mutablePrefix)) return ownershipState(type.slice(mutablePrefix.length));
  if (type.startsWith(borrowedPrefix)) return ownershipState(type.slice(borrowedPrefix.length));
  return "available";
}

function initializationState(type: ValueType): "initialized" | "uninitialized" | "maybeUninitialized" {
  if (type.startsWith(uninitializedPrefix)) return "uninitialized";
  if (type.startsWith(maybeUninitializedPrefix)) return "maybeUninitialized";
  if (type.startsWith(movedPrefix)) return initializationState(type.slice(movedPrefix.length));
  if (type.startsWith(maybeMovedPrefix)) return initializationState(type.slice(maybeMovedPrefix.length));
  if (type.startsWith(mutablePrefix)) return initializationState(type.slice(mutablePrefix.length));
  if (type.startsWith(borrowedPrefix)) return initializationState(type.slice(borrowedPrefix.length));
  return "initialized";
}

function underlyingType(type: ValueType): ValueType {
  if (type.startsWith(movedPrefix)) return underlyingType(type.slice(movedPrefix.length));
  if (type.startsWith(maybeMovedPrefix)) return underlyingType(type.slice(maybeMovedPrefix.length));
  if (type.startsWith(uninitializedPrefix)) return underlyingType(type.slice(uninitializedPrefix.length));
  if (type.startsWith(maybeUninitializedPrefix)) return underlyingType(type.slice(maybeUninitializedPrefix.length));
  if (type.startsWith(mutablePrefix)) return underlyingType(type.slice(mutablePrefix.length));
  if (type.startsWith(borrowedPrefix)) return underlyingType(type.slice(borrowedPrefix.length));
  return type;
}

function isMutableBinding(type: ValueType): boolean {
  if (type.startsWith(movedPrefix)) return isMutableBinding(type.slice(movedPrefix.length));
  if (type.startsWith(maybeMovedPrefix)) return isMutableBinding(type.slice(maybeMovedPrefix.length));
  if (type.startsWith(uninitializedPrefix)) return isMutableBinding(type.slice(uninitializedPrefix.length));
  if (type.startsWith(maybeUninitializedPrefix)) return isMutableBinding(type.slice(maybeUninitializedPrefix.length));
  if (type.startsWith(borrowedPrefix)) return isMutableBinding(type.slice(borrowedPrefix.length));
  return type.startsWith(mutablePrefix);
}

function isBorrowedBinding(type: ValueType): boolean {
  if (type.startsWith(movedPrefix)) return isBorrowedBinding(type.slice(movedPrefix.length));
  if (type.startsWith(maybeMovedPrefix)) return isBorrowedBinding(type.slice(maybeMovedPrefix.length));
  if (type.startsWith(uninitializedPrefix)) return isBorrowedBinding(type.slice(uninitializedPrefix.length));
  if (type.startsWith(maybeUninitializedPrefix)) return isBorrowedBinding(type.slice(maybeUninitializedPrefix.length));
  if (type.startsWith(mutablePrefix)) return isBorrowedBinding(type.slice(mutablePrefix.length));
  return type.startsWith(borrowedPrefix);
}

function initializedAvailableBinding(type: ValueType): ValueType {
  return `${isBorrowedBinding(type) ? borrowedPrefix : ""}${isMutableBinding(type) ? mutablePrefix : ""}${underlyingType(type)}`;
}

function requireOutParametersInitialized(
  declaration: FunctionDeclaration,
  locals: Map<string, ValueType>,
  location: SourceLocation,
  fileName: string,
): void {
  for (const parameter of declaration.parameters) {
    if (parameter.mode !== "out") continue;
    const stored = locals.get(parameter.name)!;
    const initialization = initializationState(stored);
    if (initialization === "uninitialized") {
      throw new DiagnosticError(fileName, location, `out parameter ${JSON.stringify(parameter.name)} is not initialized before successful return`, {
        code: "Z0305",
        labels: [{
          location: parameter.location,
          message: "this out parameter must be initialized on every successful path",
          length: parameter.name.length,
        }],
        helps: [`assign to ${JSON.stringify(parameter.name)} before returning`],
      });
    }
    if (initialization === "maybeUninitialized") {
      throw new DiagnosticError(fileName, location, `out parameter ${JSON.stringify(parameter.name)} may be uninitialized on a successful return path`, {
        code: "Z0305",
        labels: [{
          location: parameter.location,
          message: "this out parameter requires path-complete initialization",
          length: parameter.name.length,
        }],
        notes: ["at least one branch reaches this return without initializing the output"],
        helps: [`initialize ${JSON.stringify(parameter.name)} in every branch that can return successfully`],
      });
    }
  }
}

function propagateOuterOwnership(target: Map<string, ValueType>, source: Map<string, ValueType>): void {
  for (const name of target.keys()) {
    const value = source.get(name);
    if (value) target.set(name, value);
  }
}

function mergeOwnershipStates(
  target: Map<string, ValueType>,
  paths: Map<string, ValueType>[],
  state: AnalysisState,
): void {
  if (paths.length === 0) return;
  for (const name of target.keys()) {
    const values = paths.map((path) => path.get(name)).filter((value): value is ValueType => Boolean(value));
    if (values.length === 0) continue;
    let type = underlyingType(values[0]);
    const mutable = values.every(isMutableBinding);
    const borrowed = values.every(isBorrowedBinding);
    const pointerTypes = values.map((value) => foreignPointer(value, state));
    const firstPointer = pointerTypes[0];
    if (firstPointer && pointerTypes.every((pointer) => pointer?.identity === firstPointer.identity && pointer.ownership === firstPointer.ownership)) {
      const nullable = pointerTypes.some((pointer) => pointer!.nullable);
      type = pointerTypeName(firstPointer.identity, firstPointer.ownership, nullable);
    }
    const states = new Set(values.map(ownershipState));
    const initializationStates = new Set(values.map(initializationState));
    const storedType = `${borrowed ? borrowedPrefix : ""}${mutable ? mutablePrefix : ""}${type}`;
    const ownershipType = states.size === 1 && states.has("available")
      ? storedType
      : states.size === 1 && states.has("moved")
        ? `${movedPrefix}${storedType}`
        : `${maybeMovedPrefix}${storedType}`;
    if (initializationStates.size === 1 && initializationStates.has("initialized")) target.set(name, ownershipType);
    else if (initializationStates.size === 1 && initializationStates.has("uninitialized")) {
      target.set(name, `${uninitializedPrefix}${ownershipType}`);
    } else {
      target.set(name, `${maybeUninitializedPrefix}${ownershipType}`);
    }
  }
}

function narrowedConditionLocals(
  locals: Map<string, ValueType>,
  condition: Expression,
  truthy: boolean,
  state: AnalysisState,
): Map<string, ValueType> {
  const narrowed = new Map(locals);
  let name: string | null = null;
  let nonnull = truthy;
  if (condition.kind === "identifier") {
    name = condition.name;
  } else if (condition.kind === "unary" && condition.operator === "!" && condition.operand.kind === "identifier") {
    name = condition.operand.name;
    nonnull = !truthy;
  }
  if (!name || !nonnull) return narrowed;
  const current = narrowed.get(name);
  const pointer = current ? foreignPointer(current, state) : null;
  if (pointer?.nullable) {
    narrowed.set(name, pointerTypeName(pointer.identity, pointer.ownership, false));
  }
  return narrowed;
}

function foreignPointer(type: ValueType, state: AnalysisState): ForeignPointerType | null {
  const actual = underlyingType(type);
  if (actual === "unknown" || actual === "never") return null;
  return state.foreignTypes.get(actual) ?? null;
}

function analyzeIfBranches(
  statement: Extract<Statement, { kind: "if" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  const original = new Map(locals);
  const continuing: Map<string, ValueType>[] = [];
  const thenLocals = narrowedConditionLocals(original, statement.condition, true, state);
  analyzeStatement(statement.thenBranch, owner, thenLocals, globals, structs, enums, fileName, state);
  if (!statementStopsFlow(statement.thenBranch)) continuing.push(thenLocals);

  if (statement.elseBranch) {
    const elseLocals = narrowedConditionLocals(original, statement.condition, false, state);
    analyzeStatement(statement.elseBranch, owner, elseLocals, globals, structs, enums, fileName, state);
    if (!statementStopsFlow(statement.elseBranch)) continuing.push(elseLocals);
  } else {
    continuing.push(narrowedConditionLocals(original, statement.condition, false, state));
  }
  mergeOwnershipStates(locals, continuing, state);
}

function analyzeWhileLoop(
  statement: Extract<Statement, { kind: "while" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  const entry = new Map(locals);
  let header = new Map(entry);
  let finalCondition = new Map(header);
  let finalFrame: LoopAnalysisFrame = { breaks: [], continues: [] };

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const conditionLocals = new Map(header);
    const conditionType = inferExpression(
      statement.condition,
      conditionLocals,
      globals,
      structs,
      enums,
      fileName,
      state,
    );
    if (conditionType !== "bool" && !foreignPointer(conditionType, state)?.nullable) {
      requireAssignable(
        "bool",
        conditionType,
        statement.condition,
        fileName,
        state.foreignNamedTypes,
        state.numericLiteralTypes,
      );
    }

    const bodyLocals = narrowedConditionLocals(conditionLocals, statement.condition, true, state);
    const frame: LoopAnalysisFrame = { breaks: [], continues: [] };
    state.loopStack.push(frame);
    try {
      analyzeStatement(statement.body, owner, bodyLocals, globals, structs, enums, fileName, state);
    } finally {
      state.loopStack.pop();
    }

    const backEdges = [...frame.continues];
    if (!statementStopsFlow(statement.body)) backEdges.push(bodyLocals);
    const nextHeader = new Map(entry);
    mergeOwnershipStates(nextHeader, [entry, ...backEdges], state);

    finalCondition = conditionLocals;
    finalFrame = frame;
    if (sameLocalStates(header, nextHeader)) break;
    header = nextHeader;
  }

  const exits = [
    narrowedConditionLocals(finalCondition, statement.condition, false, state),
    ...finalFrame.breaks,
  ];
  mergeOwnershipStates(locals, exits, state);
}

function analyzeForLoop(
  statement: Extract<Statement, { kind: "for" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  validateUserName(statement.binding, statement.bindingLocation, fileName);
  if (locals.has(statement.binding)) {
    throw new DiagnosticError(fileName, statement.bindingLocation, `duplicate local ${JSON.stringify(statement.binding)}`);
  }
  const root = storageRoot(statement.iterable);
  if (!root) {
    throw new DiagnosticError(fileName, statement.iterable.location, "for...of requires stored array or Slice storage in the initial iteration tier", {
      code: "Z0310",
      helps: ["bind the collection to a const or let before iterating it"],
    });
  }
  const iterableType = inferExpression(statement.iterable, locals, globals, structs, enums, fileName, state);
  const collection = parseFixedArrayType(String(iterableType))
    ?? parseDynamicArrayType(String(iterableType))
    ?? parseSliceType(String(iterableType));
  if (!collection) {
    throw new DiagnosticError(fileName, statement.iterable.location, `for...of requires an array or Slice, found ${iterableType}`, {
      code: "Z0310",
      helps: ["iterate a fixed array, Array<T>, or Slice<T> value"],
    });
  }
  state.bindingTypes.set(statement.bindingLocation.offset, collection.elementType);

  const entry = new Map(locals);
  let header = new Map(entry);
  let finalFrame: LoopAnalysisFrame = { breaks: [], continues: [] };
  const normalize = (candidate: Map<string, ValueType>): Map<string, ValueType> => {
    const normalized = new Map(candidate);
    normalized.delete(statement.binding);
    const rootType = header.get(root.name);
    if (rootType) normalized.set(root.name, rootType);
    return normalized;
  };

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const bodyLocals = new Map(header);
    const rootType = bodyLocals.get(root.name);
    if (rootType) bodyLocals.set(root.name, `${borrowedPrefix}${underlyingType(rootType)}`);
    const elementBinding = hasCleanupType(collection.elementType, structs, state.foreignTypes)
      ? `${borrowedPrefix}${collection.elementType}`
      : collection.elementType;
    bodyLocals.set(statement.binding, elementBinding);

    const frame: LoopAnalysisFrame = { breaks: [], continues: [] };
    const previousIterationBorrow = state.iterationBorrowOrigins.get(root.name);
    const previousElementBorrow = state.borrowOrigins.get(statement.binding);
    state.iterationBorrowOrigins.set(root.name, statement.location);
    if (hasCleanupType(collection.elementType, structs, state.foreignTypes)) {
      state.borrowOrigins.set(statement.binding, { location: statement.location, kind: "iteration" });
    }
    state.loopStack.push(frame);
    try {
      analyzeStatement(statement.body, owner, bodyLocals, globals, structs, enums, fileName, state);
    } finally {
      state.loopStack.pop();
      if (previousIterationBorrow) state.iterationBorrowOrigins.set(root.name, previousIterationBorrow);
      else state.iterationBorrowOrigins.delete(root.name);
      if (previousElementBorrow) state.borrowOrigins.set(statement.binding, previousElementBorrow);
      else state.borrowOrigins.delete(statement.binding);
    }

    const backEdges = frame.continues.map(normalize);
    if (!statementStopsFlow(statement.body)) backEdges.push(normalize(bodyLocals));
    const nextHeader = new Map(entry);
    mergeOwnershipStates(nextHeader, [entry, ...backEdges], state);
    finalFrame = {
      breaks: frame.breaks.map(normalize),
      continues: frame.continues.map(normalize),
    };
    if (sameLocalStates(header, nextHeader)) {
      header = nextHeader;
      break;
    }
    header = nextHeader;
  }

  mergeOwnershipStates(locals, [header, ...finalFrame.breaks], state);
}

function sameLocalStates(left: Map<string, ValueType>, right: Map<string, ValueType>): boolean {
  if (left.size !== right.size) return false;
  for (const [name, type] of left) {
    if (right.get(name) !== type) return false;
  }
  return true;
}

function hasCleanupType(
  type: ValueType,
  structs: Map<string, StructDeclaration>,
  foreignTypes: ReadonlyMap<string, ForeignPointerType> = new Map(),
  visiting = new Set<string>(),
): boolean {
  const actual = underlyingType(type);
  if (actual === "unknown" || actual === "never" || visiting.has(actual)) return false;
  if (actual === "String") return true;
  if (foreignTypes.get(actual)?.ownership === "owned") return true;
  const declaration = structs.get(actual);
  if (parseDynamicArrayType(actual)) return true;
  const array = parseFixedArrayType(actual);
  if (array) return hasCleanupType(array.elementType, structs, foreignTypes, visiting);
  if (!declaration) return false;
  if (declaration.kind === "class") return true;
  if (declaration.deinitializer) return true;
  visiting.add(actual);
  const result = declaration.fields.some((field) => hasCleanupType(field.type.name, structs, foreignTypes, visiting));
  visiting.delete(actual);
  return result;
}

function isForeignMember(
  expression: Extract<Expression, { kind: "member" }>,
  globals: Map<string, SymbolValue>,
): boolean {
  return expression.object.kind === "identifier"
    && globals.get(expression.object.name)?.kind === "foreignModule";
}

function getForeignFunction(
  expression: Extract<Expression, { kind: "member" }>,
  globals: Map<string, SymbolValue>,
): ForeignFunction | null {
  if (expression.object.kind !== "identifier") return null;
  const symbol = globals.get(expression.object.name);
  if (symbol?.kind !== "foreignModule") return null;
  return symbol.module.functions.get(expression.property) ?? null;
}

function getObjCClass(
  expression: Extract<Expression, { kind: "member" }>,
  globals: Map<string, SymbolValue>,
): ForeignObjCInterface | null {
  if (expression.object.kind !== "identifier") return null;
  const symbol = globals.get(expression.object.name);
  if (symbol?.kind !== "foreignModule") return null;
  return symbol.module.interfaces.get(expression.property) ?? null;
}

function getForeignConstant(
  expression: Extract<Expression, { kind: "member" }>,
  globals: Map<string, SymbolValue>,
): ForeignConstant | null {
  if (expression.object.kind !== "identifier") return null;
  const symbol = globals.get(expression.object.name);
  if (symbol?.kind !== "foreignModule") return null;
  return symbol.module.constants.get(expression.property) ?? null;
}

const objcClassPrefix = "__z_objc_class:";

function objcReceiver(
  type: ValueType,
  state: AnalysisState,
): { readonly declaration: ForeignObjCInterface; readonly instance: boolean } | null {
  if (type === "unknown" || type === "never") return null;
  const actual = String(underlyingType(type));
  if (actual.startsWith(objcClassPrefix)) {
    const declaration = state.foreignInterfaces.get(actual.slice(objcClassPrefix.length));
    return declaration ? { declaration, instance: false } : null;
  }
  const object = state.foreignObjectTypes.get(actual);
  if (!object?.className) return null;
  const interfaceName = actual.replace(/^__z_objc:(?:nullable|nonnull):/, "");
  const declaration = state.foreignInterfaces.get(interfaceName);
  return declaration ? { declaration, instance: true } : null;
}

function findObjCMethod(
  receiver: { readonly declaration: ForeignObjCInterface; readonly instance: boolean },
  baseName: string,
  argumentCount: number,
  argumentLabels: readonly (string | null)[],
  state: AnalysisState,
  fileName: string,
  location: SourceLocation,
): ForeignObjCMethod {
  const usesLabels = argumentLabels.some((label) => label !== null);
  if (argumentLabels[0] !== null && argumentLabels.length > 0) {
    throw new DiagnosticError(fileName, location, "the first Objective-C argument is already named by the method and must not have a label");
  }
  if (usesLabels && argumentLabels.slice(1).some((label) => label === null)) {
    throw new DiagnosticError(fileName, location, "a labeled Objective-C call must label every argument after the first");
  }
  let declaration: ForeignObjCInterface | undefined = receiver.declaration;
  const matches: ForeignObjCMethod[] = [];
  while (declaration) {
    matches.push(...declaration.methods.filter((method) => (
      method.instance === receiver.instance
      && method.baseName === baseName
      && method.parameters.length === argumentCount
      && (!usesLabels || objectiveCLabels(method.selector).every((label, index) => label === argumentLabels[index]))
    )));
    if (matches.length > 0 || !declaration.superName) break;
    const moduleName = declaration.typeName.slice(0, declaration.typeName.lastIndexOf("."));
    declaration = state.foreignInterfaces.get(`${moduleName}.${declaration.superName}`);
  }
  if (matches.length === 0) {
    const kind = receiver.instance ? "instance" : "class";
    const suffix = usesLabels
      ? ` matching labels ${argumentLabels.slice(1).map((label) => `${label}:`).join(" ")}`
      : ` accepting ${argumentCount} argument(s)`;
    throw new DiagnosticError(fileName, location, `Objective-C ${kind} ${JSON.stringify(receiver.declaration.className)} has no method ${JSON.stringify(baseName)}${suffix}`);
  }
  if (matches.length > 1) {
    throw new DiagnosticError(fileName, location, `Objective-C method ${JSON.stringify(baseName)} is ambiguous; labeled arguments are required to select a selector`);
  }
  return matches[0];
}

function objectiveCLabels(selector: string): (string | null)[] {
  if (!selector.includes(":")) return [];
  return [null, ...selector.split(":").slice(1, -1)];
}

function rejectLabeledArguments(
  labels: readonly (string | null)[],
  location: SourceLocation,
  fileName: string,
): void {
  if (labels.some((label) => label !== null)) {
    throw new DiagnosticError(fileName, location, "labeled arguments are currently supported only for Objective-C method calls");
  }
}

function findObjCProperty(
  receiver: { readonly declaration: ForeignObjCInterface; readonly instance: boolean },
  name: string,
  state: AnalysisState,
): ForeignObjCProperty | null {
  let declaration: ForeignObjCInterface | undefined = receiver.declaration;
  while (declaration) {
    const property = declaration.properties.find((candidate) => candidate.classProperty === !receiver.instance && candidate.name === name);
    if (property) return property;
    if (!declaration.superName) break;
    const moduleName = declaration.typeName.slice(0, declaration.typeName.lastIndexOf("."));
    declaration = state.foreignInterfaces.get(`${moduleName}.${declaration.superName}`);
  }
  return null;
}

function foreignValueType(type: ForeignType): ValueType {
  if (type.kind === "z") return type.name;
  if (type.kind === "named") return type.type.typeName;
  if (type.kind === "pointer" || type.kind === "object") return type.typeName;
  return "unknown";
}

function checkObjCArguments(
  target: ForeignObjCMethod,
  args: Expression[],
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const parameter = target.parameters[index];
    if (parameter.type.kind === "unsupported" || parameter.type.kind === "recordPointer") {
      throw new DiagnosticError(fileName, argument.location, `Objective-C selector ${JSON.stringify(target.selector)} uses unsupported parameter type ${JSON.stringify(parameter.type.cName)}`);
    }
    const contextual = contextualObjCStringType(parameter.type, argument, state);
    let actual = contextual ?? inferExpression(argument, locals, globals, structs, enums, fileName, state);
    if (parameter.type.kind === "z" && parameter.type.name === "cstring" && actual === "String") {
      state.cstringConversions.add(argument.location.offset);
      actual = "cstring";
    }
    requireObjCAssignable(parameter.type, actual, argument, fileName, state, target.selector);
  }
}

function contextualObjCStringType(
  expected: ForeignType,
  expression: Expression,
  state: AnalysisState,
): ValueType | null {
  if (expression.kind !== "string" || expected.kind !== "object") return null;
  const stringType = [...state.foreignObjectTypes.values()].find((candidate) => (
    candidate.className === "NSString" && !candidate.nullable
  ));
  if (!stringType) return null;
  if (expected.className && !isObjCSubclass(stringType, expected, state)) return null;
  state.objcStringLiterals.add(expression.location.offset);
  return stringType.typeName;
}

function contextualCStringLiteral(
  expected: ValueType,
  expression: Expression,
  state: AnalysisState,
): ValueType | null {
  if (underlyingType(expected) !== "cstring" || expression.kind !== "string") return null;
  state.cstringConversions.add(expression.location.offset);
  return "cstring";
}

function requireObjCAssignable(
  expected: ForeignType,
  actual: ValueType,
  expression: Expression,
  fileName: string,
  state: AnalysisState,
  selector: string | null = null,
): void {
  if (expected.kind !== "object") {
    requireAssignable(foreignValueType(expected), actual, expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
    return;
  }
  const subject = selector ? `Objective-C selector ${JSON.stringify(selector)}` : "Objective-C property";
  if (actual === "null") {
    if (!expected.nullable) throw new DiagnosticError(fileName, expression.location, `${subject} requires a non-null ${expected.cName}`);
    return;
  }
  const actualObject = state.foreignObjectTypes.get(String(underlyingType(actual)));
  if (!actualObject || (expected.className && !isObjCSubclass(actualObject, expected, state))) {
    throw new DiagnosticError(fileName, expression.location, `${subject} expects ${expected.cName}, found ${describeValueType(actual, state)}`);
  }
}

function isObjCSubclass(actual: ForeignObjectType, expected: ForeignObjectType, state: AnalysisState): boolean {
  if (!expected.className) return true;
  if (!actual.className) return false;
  let name = actual.typeName.replace(/^__z_objc:(?:nullable|nonnull):/, "");
  while (true) {
    const declaration = state.foreignInterfaces.get(name);
    if (!declaration) return false;
    if (declaration.className === expected.className) return true;
    if (!declaration.superName) return false;
    const moduleName = declaration.typeName.slice(0, declaration.typeName.lastIndexOf("."));
    name = `${moduleName}.${declaration.superName}`;
  }
}

function checkForeignCall(
  target: ForeignFunction,
  args: Expression[],
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  location: SourceLocation,
  state: AnalysisState,
): ValueType {
  if (target.alternatives.length > 1) {
    throw new DiagnosticError(
      fileName,
      location,
      `C++ function ${JSON.stringify(target.name)} is overloaded or ambiguous; overload selection is not implemented yet`,
      {
        notes: target.alternatives.map((candidate) => `${candidate.cName}: ${candidate.cSignature}`),
        helps: ["expose a uniquely named wrapper in the C++ header for this bootstrap tier"],
      },
    );
  }
  const unsupported = [target.returnType, ...target.parameters.map((parameter) => parameter.type)]
    .find((type) => type.kind === "unsupported");
  if (unsupported?.kind === "unsupported") {
    throw new DiagnosticError(
      fileName,
      location,
      `C function ${JSON.stringify(target.name)} uses unsupported type ${JSON.stringify(unsupported.cName)} in signature ${JSON.stringify(target.cSignature)}`,
    );
  }
  const expected = target.parameters.length;
  if ((!target.variadic && args.length !== expected) || (target.variadic && args.length < expected)) {
    const expectation = target.variadic ? `at least ${expected}` : String(expected);
    throw new DiagnosticError(fileName, location, `C function ${JSON.stringify(target.name)} expects ${expectation} argument(s), found ${args.length}`);
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const parameter = target.parameters[index];
    if (argument.kind === "argumentReference") {
      if (parameter?.type.kind !== "recordPointer") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `${argument.access} is only valid for a classified imported C record-pointer parameter`,
        );
      }
      if (parameter.type.access !== argument.access) {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C function ${JSON.stringify(target.name)} expects ${parameter.type.access} ${argument.name}, found ${argument.access} ${argument.name}`,
        );
      }
      const stored = locals.get(argument.name);
      if (!stored) {
        throw new DiagnosticError(fileName, argument.location, `unknown name ${JSON.stringify(argument.name)}`);
      }
      if (argument.access !== "out" && initializationState(stored) === "uninitialized") {
        throw new DiagnosticError(fileName, argument.location, `${argument.access} argument ${JSON.stringify(argument.name)} must be initialized before the call`);
      }
      if (argument.access !== "out" && initializationState(stored) === "maybeUninitialized") {
        throw new DiagnosticError(fileName, argument.location, `${argument.access} argument ${JSON.stringify(argument.name)} may be uninitialized on another control-flow path`);
      }
      if (argument.access !== "out" && ownershipState(stored) === "moved") {
        throw movedValueError(fileName, { name: argument.name, location: argument.location }, state, false);
      }
      if (argument.access !== "out" && ownershipState(stored) === "maybeMoved") {
        throw movedValueError(fileName, { name: argument.name, location: argument.location }, state, true);
      }
      if (!isMutableBinding(stored)) {
        throw new DiagnosticError(fileName, argument.location, `${argument.access} argument ${JSON.stringify(argument.name)} requires a mutable let binding`);
      }
      requireAssignable(
        parameter.type.record.typeName,
        underlyingType(stored),
        argument,
        fileName,
        state.foreignNamedTypes,
        state.numericLiteralTypes,
      );
      state.foreignArgumentAccesses.set(argument.location.offset, argument.access);
      if (argument.access === "out") {
        locals.set(argument.name, initializedAvailableBinding(stored));
        state.moveOrigins.delete(argument.name);
      }
      continue;
    }
    if (parameter?.type.kind === "recordPointer") {
      if (parameter.type.access !== "in") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C function ${JSON.stringify(target.name)} requires ${parameter.type.access} <mutable binding> for parameter ${index + 1}`,
        );
      }
      if (!isNamedStorageExpression(argument) && argument.kind !== "structExpression") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `in record argument to C function ${JSON.stringify(target.name)} must be a stored value or struct literal`,
        );
      }
      const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
      requireAssignable(
        parameter.type.record.typeName,
        actual,
        argument,
        fileName,
        state.foreignNamedTypes,
        state.numericLiteralTypes,
      );
      state.foreignArgumentAccesses.set(argument.location.offset, "in");
      continue;
    }
    let actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
    if (parameter?.type.kind === "z") {
      if (parameter.type.name === "cstring" && actual === "String") {
        state.cstringConversions.add(argument.location.offset);
        actual = "cstring";
      } else {
        rejectForeignOwnedMove(argument, actual, structs, fileName, state);
      }
      requireAssignable(parameter.type.name, actual, argument, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
    }
    if (parameter?.type.kind === "named") {
      requireAssignable(parameter.type.type.typeName, actual, argument, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
    }
    if (parameter?.type.kind === "pointer") {
      if (actual === "null") {
        if (!parameter.type.nullable) {
          throw new DiagnosticError(
            fileName,
            argument.location,
            `C function ${JSON.stringify(target.name)} requires a non-null ${parameter.type.cName}`,
          );
        }
        continue;
      }
      const actualPointer = foreignPointer(actual, state);
      if (!actualPointer || actualPointer.identity !== parameter.type.identity) {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C function ${JSON.stringify(target.name)} expects ${describePointer(parameter.type)}, found ${describeValueType(actual, state)}`,
        );
      }
      if (!parameter.type.nullable && actualPointer.nullable) {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `nullable ${actualPointer.cName} must be checked before passing it to ${JSON.stringify(target.name)}`,
        );
      }
      if (parameter.type.ownership === "consuming") {
        if (actualPointer.ownership !== "owned") {
          throw new DiagnosticError(fileName, argument.location, `C function ${JSON.stringify(target.name)} can only consume an owned ${actualPointer.cName}`);
        }
        consumeOwnedValue(argument, actual, locals, structs, fileName, state);
      }
    }
    if (!parameter && actual === "String") {
      state.cstringConversions.add(argument.location.offset);
      actual = "cstring";
    }
    if (!parameter && !isNumericType(canonicalType(actual, state.foreignNamedTypes)) && actual !== "bool" && actual !== "cstring") {
      throw new DiagnosticError(fileName, argument.location, `unsupported variadic argument type ${describeValueType(actual, state)} for C function ${JSON.stringify(target.name)}`);
    }
    if (!parameter && argument.kind === "number" && isIntegerLiteral(argument.value) && !integerLiteralFits(argument.value, "i32")) {
      throw new DiagnosticError(fileName, argument.location, `variadic integer literal ${argument.value} does not fit default i32; bind it to an explicit integer type first`);
    }
  }
  const result = target.returnType.kind === "z"
    ? target.returnType.name
    : target.returnType.kind === "named"
      ? target.returnType.type.typeName
    : target.returnType.kind === "pointer"
      ? target.returnType.typeName
      : "unknown";
  state.foreignCallTypes.set(location.offset, result);
  return result;
}

function describePointer(type: ForeignPointerType): string {
  const ownership = type.ownership === "consuming" ? "owned" : type.ownership;
  return `${ownership} ${type.nullable ? "nullable " : ""}${type.cName}`;
}

function describeValueType(type: ValueType, state: AnalysisState): string {
  const pointer = foreignPointer(type, state);
  return pointer ? describePointer(pointer) : displayArrayType(String(underlyingType(type)));
}

function validateType(
  type: TypeReference,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
  allowVoid: boolean,
): void {
  const slice = parseSliceType(type.name);
  if (slice) {
    validateType({ name: slice.elementType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    return;
  }
  const dynamic = parseDynamicArrayType(type.name);
  if (dynamic) {
    validateType({ name: dynamic.elementType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    return;
  }
  const array = parseFixedArrayType(type.name);
  if (array) {
    validateType({ name: array.elementType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    return;
  }
  if (!primitiveTypes.has(type.name) && !structs.has(type.name) && !enums.has(type.name) && !foreignNamedTypes.has(type.name)) {
    throw new DiagnosticError(fileName, type.location, `unknown type ${JSON.stringify(type.name)}`);
  }
  if (!allowVoid && type.name === "void") {
    throw new DiagnosticError(fileName, type.location, "void is not a value type");
  }
}

function containsSliceType(name: string): boolean {
  if (parseSliceType(name)) return true;
  const dynamic = parseDynamicArrayType(name);
  if (dynamic) return containsSliceType(dynamic.elementType);
  const array = parseFixedArrayType(name);
  return array ? containsSliceType(array.elementType) : false;
}

function requireAssignable(
  expected: ValueType,
  actual: ValueType,
  expression: Expression,
  fileName: string,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  numericLiteralTypes: Map<number, string>,
): void {
  const expectedType = canonicalType(expected, foreignNamedTypes);
  if (expression.kind === "number" && isNumericType(expectedType)) {
    requireNumericLiteralFits(expression, expectedType, fileName, numericLiteralTypes);
    return;
  }
  if (actual === "null" && isNullableForeignTypeName(String(underlyingType(expected)))) {
    return;
  }
  if (
    actual !== "unknown"
    && actual !== "never"
    && expectedType !== canonicalType(actual, foreignNamedTypes)
    && !sameForeignNamedType(expected, actual, foreignNamedTypes)
  ) {
    throw new DiagnosticError(
      fileName,
      expression.location,
      `expected ${displayArrayType(String(expected))}, found ${displayArrayType(String(actual))}`,
    );
  }
}

function sameForeignNamedType(
  expected: ValueType,
  actual: ValueType,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
): boolean {
  if (expected === "unknown" || expected === "never" || actual === "unknown" || actual === "never") return false;
  const expectedNamed = foreignNamedTypes.get(String(underlyingType(expected)));
  const actualNamed = foreignNamedTypes.get(String(underlyingType(actual)));
  return Boolean(
    expectedNamed
    && actualNamed
    && expectedNamed.kind === actualNamed.kind
    && expectedNamed.cName === actualNamed.cName,
  );
}

function isIntegerType(type: ValueType): type is string {
  return type !== "unknown" && type !== "never" && integerTypes.has(type);
}

function isFloatType(type: ValueType): type is string {
  return type !== "unknown" && type !== "never" && floatTypes.has(type);
}

function isNumericType(type: ValueType): type is string {
  return isIntegerType(type) || isFloatType(type);
}

function isIntegerLiteral(value: string): boolean {
  return !/[.eE]/.test(value);
}

function requireNumericLiteralFits(
  expression: Extract<Expression, { kind: "number" }>,
  type: string,
  fileName: string,
  numericLiteralTypes: Map<number, string>,
): void {
  if (isIntegerType(type)) {
    if (!isIntegerLiteral(expression.value)) {
      throw new DiagnosticError(fileName, expression.location, `floating-point literal ${expression.value} cannot initialize ${type}`);
    }
    if (!integerLiteralFits(expression.value, type)) {
      throw new DiagnosticError(fileName, expression.location, `integer literal ${expression.value} does not fit ${type}`);
    }
  } else if (isFloatType(type)) {
    const value = Number(expression.value);
    const maximum = type === "f32" ? 3.4028234663852886e38 : Number.MAX_VALUE;
    if (!Number.isFinite(value) || Math.abs(value) > maximum) {
      throw new DiagnosticError(fileName, expression.location, `floating-point literal ${expression.value} does not fit ${type}`);
    }
  } else {
    return;
  }
  numericLiteralTypes.set(expression.location.offset, type);
}

function isNullableForeignTypeName(type: string): boolean {
  return type.startsWith("__z_ffi:") && type.includes(":nullable:");
}

function integerLiteralFits(value: string, type: string): boolean {
  const bits: Readonly<Record<string, number>> = {
    i8: 8,
    u8: 8,
    i16: 16,
    u16: 16,
    i32: 32,
    u32: 32,
    i64: 64,
    u64: 64,
    isize: process.arch.includes("64") ? 64 : 32,
    usize: process.arch.includes("64") ? 64 : 32,
  };
  const width = bits[type];
  if (!width) return false;
  const literal = BigInt(value);
  const unsigned = type.startsWith("u");
  const maximum = unsigned ? (1n << BigInt(width)) - 1n : (1n << BigInt(width - 1)) - 1n;
  return literal <= maximum;
}

function canonicalType(type: ValueType, foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>): ValueType {
  if (type === "unknown" || type === "never") return type;
  const named = foreignNamedTypes.get(String(underlyingType(type)));
  if (named?.kind === "scalar") return named.underlying;
  if (named?.kind === "enum" && named.flags) return named.underlying;
  return type;
}

function declareGlobal(
  globals: Map<string, SymbolValue>,
  name: string,
  symbol: SymbolValue,
  location: SourceLocation,
  fileName: string,
): void {
  validateUserName(name, location, fileName);
  if (globals.has(name)) {
    throw new DiagnosticError(fileName, location, `duplicate top-level name ${JSON.stringify(name)}`);
  }
  globals.set(name, symbol);
}

function validateUserName(name: string, location: SourceLocation, fileName: string): void {
  if (name.startsWith("_z_")) {
    throw new DiagnosticError(fileName, location, "names beginning with `_z_` are reserved for compiler-generated storage");
  }
}
