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
import { parseTaskType, taskTypeName } from "./async-types.ts";
import {
  displayArrayType,
  dynamicArrayTypeName,
  fixedArrayTypeName,
  parseDynamicArrayType,
  parseFixedArrayType,
  parseSliceType,
} from "./array-types.ts";
import {
  displayFunctionType,
  functionTypeName,
  functionTypesCompatible,
  parseFunctionType,
  type FunctionType,
} from "./function-types.ts";
import {
  pointerTypeName,
  type ForeignCallbackType,
  type ForeignBlockType,
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
import {
  isStandardModuleSpecifier,
  standardFunctionSignature,
  type StandardFunctionName,
} from "./standard-library.ts";
import {
  parseWeakType,
  weakResultTypeName,
  weakTypeName,
} from "./weak-types.ts";

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
  readonly location: SourceLocation;
};

export type ClosureInfo = {
  readonly type: string;
  readonly declaration: FunctionDeclaration;
  readonly captures: readonly ClosureCaptureInfo[];
  readonly parameterCount: number;
  readonly owned: boolean;
  readonly storable: boolean;
};

type ValueType = string | "unknown" | "never";

export type IntegerOperation = {
  readonly kind:
    | "checkedAdd"
    | "checkedSubtract"
    | "checkedMultiply"
    | "checkedDivide"
    | "checkedRemainder"
    | "checkedNegate"
    | "checkedShiftLeft"
    | "checkedShiftRight"
    | "wrappingAdd"
    | "wrappingSubtract"
    | "wrappingMultiply"
    | "saturatingAdd"
    | "saturatingSubtract"
    | "saturatingMultiply";
  readonly type: string;
};

export type ForeignCallArgumentPlan =
  | { readonly kind: "argument"; readonly source: number }
  | { readonly kind: "callback"; readonly source: number; readonly callback: ForeignCallbackType; readonly functionType: string }
  | { readonly kind: "context"; readonly source: number; readonly callback: ForeignCallbackType; readonly functionType: string }
  | { readonly kind: "release"; readonly source: number; readonly callback: ForeignCallbackType; readonly functionType: string };

export type SemanticInfo = {
  readonly movedExpressions: ReadonlySet<number>;
  readonly managedCopies: ReadonlySet<number>;
  readonly sliceConversions: ReadonlyMap<number, { readonly sourceType: string; readonly targetType: string }>;
  readonly foreignTypes: ReadonlyMap<string, ForeignPointerType>;
  readonly foreignCallTypes: ReadonlyMap<number, string>;
  readonly foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly foreignExpressionTypes: ReadonlyMap<number, string>;
  readonly numericLiteralTypes: ReadonlyMap<number, string>;
  readonly integerOperations: ReadonlyMap<number, IntegerOperation>;
  readonly foreignArgumentAccesses: ReadonlyMap<number, "in" | "out" | "inout">;
  readonly foreignCallbackTargets: ReadonlyMap<number, string>;
  readonly foreignCallArgumentPlans: ReadonlyMap<number, readonly ForeignCallArgumentPlan[]>;
  readonly foreignFunctionNames: ReadonlyMap<number, string>;
  readonly foreignConstantNames: ReadonlyMap<number, string>;
  readonly nativeArgumentAccesses: ReadonlyMap<number, "in" | "inout" | "out">;
  readonly foreignObjectTypes: ReadonlyMap<string, ForeignObjectType>;
  readonly foreignInterfaces: ReadonlyMap<string, ForeignObjCInterface>;
  readonly objcClassNames: ReadonlyMap<number, string>;
  readonly objcProperties: ReadonlyMap<number, ObjCPropertyInfo>;
  readonly objcCalls: ReadonlyMap<number, ObjCCallInfo>;
  readonly objcBlockArguments: ReadonlyMap<number, ForeignBlockType>;
  readonly objcStringLiterals: ReadonlySet<number>;
  readonly objcStringsToNative: ReadonlySet<number>;
  readonly objcStringsToZ: ReadonlySet<number>;
  readonly cstringConversions: ReadonlySet<number>;
  readonly expressionTypes: ReadonlyMap<number, string>;
  readonly bindingTypes: ReadonlyMap<number, string>;
  readonly borrowedMatches: ReadonlySet<number>;
  readonly constructorFieldInitializations: ReadonlySet<number>;
  readonly closures: ReadonlyMap<number, ClosureInfo>;
  readonly consoleCalls: ReadonlySet<number>;
  readonly consoleBindings: ReadonlySet<string>;
  readonly standardFunctionReferences: ReadonlyMap<number, StandardFunctionName>;
  readonly standardFunctionBindings: ReadonlyMap<string, StandardFunctionName>;
  readonly typeDisplayNames: ReadonlyMap<string, string>;
  readonly objectiveC: boolean;
  readonly cPlusPlus: boolean;
  readonly frameworks: readonly string[];
};

type AnalysisState = {
  readonly movedExpressions: Set<number>;
  readonly managedCopies: Set<number>;
  readonly sliceConversions: Map<number, { readonly sourceType: string; readonly targetType: string }>;
  readonly foreignTypes: ReadonlyMap<string, ForeignPointerType>;
  readonly foreignCallTypes: Map<number, string>;
  readonly foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly foreignExpressionTypes: Map<number, string>;
  readonly numericLiteralTypes: Map<number, string>;
  readonly integerOperations: Map<number, IntegerOperation>;
  readonly foreignArgumentAccesses: Map<number, "in" | "out" | "inout">;
  readonly foreignCallbackTargets: Map<number, string>;
  readonly foreignCallArgumentPlans: Map<number, readonly ForeignCallArgumentPlan[]>;
  readonly foreignFunctionNames: Map<number, string>;
  readonly foreignConstantNames: Map<number, string>;
  readonly nativeArgumentAccesses: Map<number, "in" | "inout" | "out">;
  readonly foreignObjectTypes: ReadonlyMap<string, ForeignObjectType>;
  readonly foreignInterfaces: ReadonlyMap<string, ForeignObjCInterface>;
  readonly objcClassNames: Map<number, string>;
  readonly objcProperties: Map<number, ObjCPropertyInfo>;
  readonly objcCalls: Map<number, ObjCCallInfo>;
  readonly objcBlockArguments: Map<number, ForeignBlockType>;
  readonly objcStringLiterals: Set<number>;
  readonly objcStringsToNative: Set<number>;
  readonly objcStringsToZ: Set<number>;
  readonly cstringConversions: Set<number>;
  readonly expressionTypes: Map<number, string>;
  readonly bindingTypes: Map<number, string>;
  readonly borrowedMatches: Set<number>;
  readonly constructorFieldInitializations: Set<number>;
  readonly closures: Map<number, ClosureInfo>;
  readonly consoleCalls: Set<number>;
  readonly consoleBindings: Set<string>;
  readonly standardFunctionReferences: Map<number, StandardFunctionName>;
  readonly standardFunctionBindings: Map<string, StandardFunctionName>;
  readonly typeDisplayNames: ReadonlyMap<string, string>;
  readonly objectiveC: boolean;
  readonly cPlusPlus: boolean;
  readonly frameworks: readonly string[];
  readonly loopStack: LoopAnalysisFrame[];
  readonly moveOrigins: Map<string, SourceLocation>;
  readonly borrowOrigins: Map<string, { readonly location: SourceLocation; readonly kind: "closure" | "iteration" | "match" }>;
  readonly iterationBorrowOrigins: Map<string, SourceLocation>;
  readonly asyncCallContexts: { readonly mode: "await" | "spawn"; calls: number }[];
  activeFunction: FunctionDeclaration | null;
  activeReceiver: string | null;
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
  | { readonly kind: "console" }
  | { readonly kind: "standardFunction"; readonly name: StandardFunctionName; readonly declaration: FunctionDeclaration }
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
const callTargetPrefix = "__z_calltarget:";

export function analyze(
  program: Program,
  fileName: string,
  foreignModules: ReadonlyMap<string, ForeignModule>,
  typeDisplayNames: ReadonlyMap<string, string> = new Map(),
  requireMain = true,
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
    for (const type of module.interfaces.values()) {
      foreignInterfaces.set(type.typeName, type);
      foreignNamedTypes.set(type.typeName, {
        kind: "object",
        exportName: type.exportName,
        typeName: type.typeName,
        cName: `${type.className} *`,
        className: type.className,
      });
    }
    if (module.framework) frameworks.add(module.framework);
    if (module.objectiveC) objectiveC = true;
    if (module.cPlusPlus) cPlusPlus = true;
  }
  const state: AnalysisState = {
    movedExpressions: new Set(),
    managedCopies: new Set(),
    sliceConversions: new Map(),
    foreignTypes,
    foreignCallTypes: new Map(),
    foreignNamedTypes,
    foreignExpressionTypes: new Map(),
    numericLiteralTypes: new Map(),
    integerOperations: new Map(),
    foreignArgumentAccesses: new Map(),
    foreignCallbackTargets: new Map(),
    foreignCallArgumentPlans: new Map(),
    foreignFunctionNames: new Map(),
    foreignConstantNames: new Map(),
    nativeArgumentAccesses: new Map(),
    foreignObjectTypes,
    foreignInterfaces,
    objcClassNames: new Map(),
    objcProperties: new Map(),
    objcCalls: new Map(),
    objcBlockArguments: new Map(),
    objcStringLiterals: new Set(),
    objcStringsToNative: new Set(),
    objcStringsToZ: new Set(),
    cstringConversions: new Set(),
    expressionTypes: new Map(),
    bindingTypes: new Map(),
    borrowedMatches: new Set(),
    constructorFieldInitializations: new Set(),
    closures: new Map(),
    consoleCalls: new Set(),
    consoleBindings: new Set(),
    standardFunctionReferences: new Map(),
    standardFunctionBindings: new Map(),
    typeDisplayNames,
    objectiveC,
    cPlusPlus,
    frameworks: [...frameworks],
    loopStack: [],
    moveOrigins: new Map(),
    borrowOrigins: new Map(),
    iterationBorrowOrigins: new Map(),
    asyncCallContexts: [],
    activeFunction: null,
    activeReceiver: null,
  };
  const globals = new Map<string, SymbolValue>();
  const structs = new Map<string, StructDeclaration>();
  const traits = new Map<string, TraitDeclaration>();
  const enums = new Map<string, EnumDeclaration>();

  for (const declaration of program.imports) {
    if (isStandardModuleSpecifier(declaration.header)) {
      if (declaration.header === "std/console") {
        if (declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, "std/console is a default module import", {
            code: "Z0501",
            helps: ["use `import console from \"std/console\";`"],
          });
        }
        validateUserName(declaration.moduleName, declaration.location, fileName);
        declareGlobal(globals, declaration.moduleName, { kind: "console" }, declaration.location, fileName);
        state.consoleBindings.add(declaration.moduleName);
        continue;
      }
      if (declaration.header === "std") {
        if (!declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, "the std facade requires a selective import", {
            code: "Z0501",
            helps: ["use `import { console } from \"std\";`"],
          });
        }
        for (const binding of declaration.bindings) {
          if (binding.importedName !== "console") {
            throw new DiagnosticError(fileName, binding.location, `std has no export ${JSON.stringify(binding.importedName)}`, {
              code: "Z0501",
              helps: ["the bootstrap std facade currently exports `console`"],
            });
          }
          validateUserName(binding.localName, binding.location, fileName);
          declareGlobal(globals, binding.localName, { kind: "console" }, binding.location, fileName);
          state.consoleBindings.add(binding.localName);
        }
        continue;
      }
      if (declaration.header === "std/time") {
        if (!declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, "std/time requires a selective import", {
            code: "Z0501",
            helps: ["use `import { sleep, delay } from \"std/time\";`"],
          });
        }
        for (const binding of declaration.bindings) {
          if (binding.importedName !== "sleep" && binding.importedName !== "delay") {
            throw new DiagnosticError(fileName, binding.location, `std/time has no export ${JSON.stringify(binding.importedName)}`, {
              code: "Z0501",
              helps: ["the bootstrap std/time module currently exports `sleep` and `delay`"],
            });
          }
          validateUserName(binding.localName, binding.location, fileName);
          const name: StandardFunctionName = binding.importedName;
          declareGlobal(
            globals,
            binding.localName,
            { kind: "standardFunction", name, declaration: standardFunctionDeclaration(binding.localName, name, binding.location) },
            binding.location,
            fileName,
          );
          state.standardFunctionBindings.set(binding.localName, name);
        }
        continue;
      }
      throw new DiagnosticError(fileName, declaration.location, `unknown standard module ${JSON.stringify(declaration.header)}`, {
        code: "Z0501",
        helps: ["the bootstrap standard library currently provides `std`, `std/console`, and `std/time`"],
      });
    }
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
  if ((!main || main.kind !== "function") && requireMain) {
    throw new DiagnosticError(fileName, { offset: 0, line: 1, column: 1 }, "program must declare `function main(): i32`");
  }
  if (main?.kind === "function" && (main.declaration.parameters.length !== 0 || main.declaration.returnType.name !== "i32")) {
    throw new DiagnosticError(fileName, main.declaration.location, "`main` must have signature `function main(): i32`");
  }
  if (main?.kind === "function" && main.declaration.errorType && !main.declaration.async) {
    throw new DiagnosticError(fileName, main.declaration.location, "`main` cannot throw in the bootstrap runtime");
  }

  for (const declaration of program.structs) {
    if (declaration.constructor) {
      analyzeConstructorInitialization(declaration, fileName, state);
      analyzeFunction(
        {
          ...constructorFunction(declaration),
          returnType: { name: "void", location: declaration.constructor.location },
        },
        globals,
        structs,
        enums,
        fileName,
        declaration,
        state,
      );
    }
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
  if (declaration.constructor && declaration.kind !== "class") {
    throw new DiagnosticError(fileName, declaration.constructor.location, "constructors are currently class-only; structs use Type({ ... }) value construction");
  }
  if (declaration.kind === "class" && declaration.fields.some((field) => field.visibility === "private") && !declaration.constructor) {
    const field = declaration.fields.find((candidate) => candidate.visibility === "private")!;
    throw new DiagnosticError(fileName, field.location, `class ${JSON.stringify(declaration.name)} needs a constructor to initialize private field ${JSON.stringify(field.name)}`);
  }
  if (declaration.kind === "class" && declaration.methods.some((method) => !method.static && method.receiverMode === "move")) {
    const method = declaration.methods.find((candidate) => !candidate.static && candidate.receiverMode === "move")!;
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
    if (method.static && method.receiverMode) {
      throw new DiagnosticError(fileName, method.location, "static methods cannot declare a `this` receiver");
    }
    if (method.async && !method.static && declaration.kind === "struct" && method.receiverMode !== "move") {
      throw new DiagnosticError(fileName, method.location, "an async struct method must take ownership with `move this` in the first async tier", {
        code: "Z0704",
        notes: ["a borrowed struct receiver cannot remain live in a suspended task frame"],
        helps: ["use `move this`, make the operation synchronous, or move shared identity into a class"],
      });
    }
    validateFunctionSignature(method, structs, enums, foreignNamedTypes, fileName);
  }
  if (declaration.constructor) {
    validateFunctionSignature(constructorFunction(declaration), structs, enums, foreignNamedTypes, fileName);
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
      const method = declaration.methods.find((candidate) => !candidate.static && candidate.name === requirement.name);
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
  return Boolean(actual.async) === Boolean(required.async)
    && actual.receiverMode === required.receiverMode
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
  if (declaration.errorType && hasCleanupType(declaration.errorType.name, structs, enums)) {
    throw new DiagnosticError(fileName, declaration.errorType.location, "throwing cleanup-bearing error values is not implemented in this bootstrap stage");
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
    if (declaration.async && (parameter.mode !== "value" || slice)) {
      throw new DiagnosticError(fileName, parameter.location, `async parameter ${JSON.stringify(parameter.name)} cannot borrow storage in the first async tier`, {
        code: "Z0704",
        notes: ["in, inout, out, and Slice parameters could otherwise remain live across a suspension point"],
        helps: ["pass an owned value or ARC class reference into the async function"],
      });
    }
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
  const previousReceiver = state.activeReceiver;
  const previousFunction = state.activeFunction;
  state.activeReceiver = receiver?.name ?? null;
  state.activeFunction = declaration;
  state.moveOrigins.clear();
  state.borrowOrigins.clear();
  state.iterationBorrowOrigins.clear();
  const locals = new Map<string, ValueType>();
  if (receiver && !declaration.static) {
    const ownedAsyncClassReceiver = Boolean(declaration.async && receiver.kind === "class");
    const borrowed = declaration.receiverMode === "move" || ownedAsyncClassReceiver ? "" : borrowedPrefix;
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
  state.activeReceiver = previousReceiver;
  state.activeFunction = previousFunction;
}

function constructorFunction(declaration: StructDeclaration): FunctionDeclaration {
  const constructor = declaration.constructor!;
  return {
    kind: "function",
    name: "constructor",
    receiverMode: "inout",
    parameters: constructor.parameters,
    returnType: { name: declaration.name, location: constructor.location },
    errorType: constructor.errorType,
    body: constructor.body,
    location: constructor.location,
  };
}

function analyzeConstructorInitialization(
  declaration: StructDeclaration,
  fileName: string,
  state: AnalysisState,
): void {
  const fields = new Map(declaration.fields.map((field) => [field.name, field]));
  const allFields = new Set(fields.keys());
  const complete = (initialized: ReadonlySet<string>): boolean => initialized.size === allFields.size;
  const missing = (initialized: ReadonlySet<string>): string | null => (
    declaration.fields.find((field) => !initialized.has(field.name))?.name ?? null
  );

  const checkExpression = (expression: Expression, initialized: ReadonlySet<string>): void => {
    if (expression.kind === "identifier") {
      if (expression.name === "this" && !complete(initialized)) {
        throw new DiagnosticError(fileName, expression.location, `this cannot escape before field ${JSON.stringify(missing(initialized))} is initialized`);
      }
      return;
    }
    if (expression.kind === "member") {
      if (expression.object.kind === "identifier" && expression.object.name === "this") {
        const field = fields.get(expression.property);
        if (field && !initialized.has(field.name)) {
          throw new DiagnosticError(fileName, expression.location, `field ${JSON.stringify(field.name)} is read before it is initialized`);
        }
        if (!field && !complete(initialized)) {
          throw new DiagnosticError(fileName, expression.location, `this cannot call methods before field ${JSON.stringify(missing(initialized))} is initialized`);
        }
        return;
      }
      checkExpression(expression.object, initialized);
      return;
    }
    switch (expression.kind) {
      case "number":
      case "string":
      case "boolean":
      case "null":
      case "dynamicArrayExpression":
      case "argumentReference":
        return;
      case "template":
        for (const part of expression.parts) if (part.kind === "value") checkExpression(part.expression, initialized);
        return;
      case "unary":
        checkExpression(expression.operand, initialized);
        return;
      case "binary":
        checkExpression(expression.left, initialized);
        checkExpression(expression.right, initialized);
        return;
      case "conditional":
        checkExpression(expression.condition, initialized);
        checkExpression(expression.thenExpression, initialized);
        checkExpression(expression.elseExpression, initialized);
        return;
      case "new":
        for (const argument of expression.arguments) checkExpression(argument, initialized);
        return;
      case "weak":
        checkExpression(expression.expression, initialized);
        return;
      case "closure":
        if (expression.body.kind === "block") {
          analyzeConstructorStatements(expression.body.statements, new Set(initialized));
        } else {
          checkExpression(expression.body, initialized);
        }
        return;
      case "call":
        checkExpression(expression.callee, initialized);
        for (const argument of expression.arguments) checkExpression(argument, initialized);
        return;
      case "index":
        checkExpression(expression.object, initialized);
        checkExpression(expression.index, initialized);
        return;
      case "arrayExpression":
        for (const element of expression.elements) checkExpression(element, initialized);
        return;
      case "structExpression":
      case "objectExpression":
        for (const field of expression.fields) checkExpression(field.expression, initialized);
        return;
      case "variantExpression":
        checkExpression(expression.payload, initialized);
        return;
      case "attempt":
      case "try":
      case "await":
      case "spawn":
        checkExpression(expression.expression, initialized);
        return;
      case "matchExpression":
        checkExpression(expression.expression, initialized);
        for (const arm of expression.arms) analyzeConstructorStatements([arm.body], new Set(initialized));
        return;
      case "ifExpression":
        checkExpression(expression.condition, initialized);
        analyzeConstructorStatements(expression.thenBranch.statements, new Set(initialized));
        if (expression.elseBranch.kind === "ifExpression") checkExpression(expression.elseBranch, initialized);
        else analyzeConstructorStatements(expression.elseBranch.statements, new Set(initialized));
        return;
    }
  };

  const intersect = (sets: readonly Set<string>[]): Set<string> => {
    if (sets.length === 0) return new Set(allFields);
    return new Set([...sets[0]].filter((name) => sets.every((candidate) => candidate.has(name))));
  };

  const analyzeConstructorStatements = (
    statements: readonly Statement[],
    initial: Set<string>,
  ): { readonly initialized: Set<string>; readonly stops: boolean } => {
    let initialized = initial;
    for (const statement of statements) {
      if (statement.kind === "return") {
        throw new DiagnosticError(fileName, statement.location, "constructors return the initialized instance implicitly; omit return");
      }
      if (statement.kind === "assignment"
        && statement.target.kind === "member"
        && statement.target.object.kind === "identifier"
        && statement.target.object.name === "this"
        && fields.has(statement.target.property)) {
        checkExpression(statement.expression, initialized);
        if (!initialized.has(statement.target.property)) {
          state.constructorFieldInitializations.add(statement.location.offset);
          initialized = new Set(initialized).add(statement.target.property);
        }
        continue;
      }
      if (statement.kind === "variable") {
        if (statement.initializer) checkExpression(statement.initializer, initialized);
      } else if (statement.kind === "assignment") {
        checkExpression(statement.target, initialized);
        checkExpression(statement.expression, initialized);
      } else if (statement.kind === "throw" || statement.kind === "select" || statement.kind === "expressionStatement") {
        checkExpression(statement.expression, initialized);
      } else if (statement.kind === "block") {
        const result = analyzeConstructorStatements(statement.statements, initialized);
        initialized = result.initialized;
        if (result.stops) return result;
      } else if (statement.kind === "if") {
        checkExpression(statement.condition, initialized);
        const branches = [analyzeConstructorStatements(statement.thenBranch.statements, new Set(initialized))];
        if (statement.elseBranch?.kind === "block") {
          branches.push(analyzeConstructorStatements(statement.elseBranch.statements, new Set(initialized)));
        } else if (statement.elseBranch?.kind === "if") {
          branches.push(analyzeConstructorStatements([statement.elseBranch], new Set(initialized)));
        } else {
          branches.push({ initialized: new Set(initialized), stops: false });
        }
        const continuing = branches.filter((branch) => !branch.stops);
        if (continuing.length === 0) return { initialized, stops: true };
        initialized = intersect(continuing.map((branch) => branch.initialized));
      } else if (statement.kind === "match") {
        checkExpression(statement.expression, initialized);
        const branches = statement.arms.map((arm) => analyzeConstructorStatements([arm.body], new Set(initialized)));
        const continuing = branches.filter((branch) => !branch.stops);
        if (continuing.length === 0) return { initialized, stops: true };
        initialized = intersect(continuing.map((branch) => branch.initialized));
      } else if (statement.kind === "while" || statement.kind === "for") {
        if (!complete(initialized)) {
          throw new DiagnosticError(fileName, statement.location, `initialize field ${JSON.stringify(missing(initialized))} before entering a loop`);
        }
      } else if (statement.kind === "asyncScope") {
        throw new DiagnosticError(fileName, statement.location, "async scope requires an async function");
      }
      if (statementStopsFlow(statement)) return { initialized, stops: true };
    }
    return { initialized, stops: false };
  };

  const result = analyzeConstructorStatements(declaration.constructor!.body, new Set());
  const missingField = missing(result.initialized);
  if (!result.stops && missingField) {
    throw new DiagnosticError(
      fileName,
      declaration.constructor!.location,
      `constructor for ${JSON.stringify(declaration.name)} does not initialize field ${JSON.stringify(missingField)} on every successful path`,
    );
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
  if (statement.kind === "asyncScope") return statementReturns(statement.body);
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
  if (statement.kind === "asyncScope") return statementStopsFlow(statement.body);
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
        if (statement.type && !parseFunctionType(statement.type.name)) {
          throw new DiagnosticError(fileName, statement.type.location, "a closure annotation must be a function type");
        }
      }
      const contextualFunction = statement.initializer.kind === "closure" && statement.type
        ? parseFunctionType(statement.type.name)
        : null;
      let initializerType = statement.initializer.kind === "closure"
        ? inferClosureExpression(statement.initializer, locals, globals, structs, enums, fileName, state, contextualFunction)
        : inferDirectValue(statement.initializer, owner, locals, globals, structs, enums, fileName, state);
      let variableType = initializerType;
      if (statement.type) {
        validateType(statement.type, structs, enums, state.foreignNamedTypes, fileName, false);
        variableType = statement.type.name;
        if (statement.initializer.kind === "closure") {
          const expectedFunction = parseFunctionType(variableType)!;
          finalizeClosureFunctionValue(
            statement.initializer,
            expectedFunction,
            variableType,
            locals,
            structs,
            enums,
            fileName,
            state,
          );
          initializerType = variableType;
        } else {
          initializerType = contextualCStringLiteral(variableType, statement.initializer, state)
            ?? contextualObjCStringToZ(variableType, initializerType, statement.initializer, state)
            ?? initializerType;
          requireAssignable(variableType, initializerType, statement.initializer, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
        }
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
      if (statement.initializer.kind === "closure") {
        const closure = state.closures.get(statement.initializer.location.offset)!;
        const cleanupCapture = closure.captures.find((capture) => hasCleanupType(capture.type, structs, enums, state.foreignTypes));
        if (cleanupCapture && !closure.owned && statement.initializer.captureMode === "move") {
          throw new DiagnosticError(
            fileName,
            cleanupCapture.location,
            `move-capturing cleanup-bearing ${cleanupCapture.type} requires an explicitly typed owned closure`,
            {
              code: "Z0211",
              length: cleanupCapture.name.length,
              labels: [{ location: statement.initializer.location, message: "this closure needs an owned environment", length: 4 }],
              notes: ["owned closure environments are created when a `move` closure initializes an explicit function type"],
              helps: ["add a function type annotation to this closure binding"],
            },
          );
        }
      }
      consumeOwnedValue(statement.initializer, variableType, locals, structs, enums, fileName, state);
      if (containsSliceType(String(variableType))) {
        throw new DiagnosticError(fileName, statement.location, "Slice values cannot be stored in local bindings yet");
      }
      let storedVariableType = statement.mutable ? `${mutablePrefix}${variableType}` : variableType;
      if (statement.initializer.kind === "closure") {
        const closure = state.closures.get(statement.initializer.location.offset)!;
        if (closure.captures.length === 0 && parseFunctionType(String(variableType))) {
          storedVariableType = callTargetBinding(storedVariableType, closure.declaration.name);
        }
      } else if (statement.initializer.kind === "identifier" && globals.get(statement.initializer.name)?.kind === "function") {
        storedVariableType = callTargetBinding(storedVariableType, statement.initializer.name);
      }
      locals.set(statement.name, storedVariableType);
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
      actual = contextualObjCStringToZ(expected, actual, statement.expression, state) ?? actual;
      requireAssignable(expected, actual, statement.expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      if (hasCleanupType(expected, structs, enums, state.foreignTypes)) {
        consumeOwnedValue(statement.expression, expected, locals, structs, enums, fileName, state);
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
      actual = contextualObjCStringToZ(expected, actual, statement.expression, state) ?? actual;
      requireAssignable(expected, actual, statement.expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      consumeOwnedValue(statement.expression, expected, locals, structs, enums, fileName, state);
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
    case "asyncScope": {
      if (!owner.async) {
        throw new DiagnosticError(fileName, statement.location, "async scope requires an enclosing async function", {
          code: "Z0703",
          helps: [`add \`async\` before \`function ${owner.name}\``],
        });
      }
      const scopeLocals = new Map(locals);
      analyzeStatements(statement.body.statements, owner, scopeLocals, globals, structs, enums, fileName, state);
      propagateOuterOwnership(locals, scopeLocals);
      return;
    }
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
        if (hasCleanupType(type, structs, enums, state.foreignTypes)) {
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
      const candidateRoot = storageRoot(statement.expression);
      const candidateRootType = candidateRoot ? locals.get(candidateRoot.name) : null;
      const borrowed = statement.mode === "in" || Boolean(candidateRootType && isBorrowedBinding(candidateRootType));
      if (borrowed) state.borrowedMatches.add(statement.location.offset);
      const borrowedRoot = borrowed ? candidateRoot : null;
      const borrowedRootType = borrowedRoot ? locals.get(borrowedRoot.name) : null;
      if (statement.mode === "in" && (!borrowedRoot || !borrowedRootType)) {
        throw new DiagnosticError(fileName, statement.expression.location, "match (in ...) requires stored enum storage", {
          code: "Z0230",
        helps: ["bind the enum value before borrowing it, or remove `in` to consume the value"],
        });
      }
      if (!borrowed && hasCleanupType(subjectType, structs, enums, state.foreignTypes)) {
        consumeOwnedValue(statement.expression, subjectType, locals, structs, enums, fileName, state);
      }
      const covered = new Set<string>();
      const continuing: Map<string, ValueType>[] = [];
      for (const arm of statement.arms) {
        const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName);
        if (!variant) throw new DiagnosticError(fileName, arm.location, `unknown variant ${JSON.stringify(arm.variantName)}`);
        if (covered.has(variant.name)) throw new DiagnosticError(fileName, arm.location, `duplicate match arm ${JSON.stringify(variant.name)}`);
        covered.add(variant.name);
        const hasPattern = Boolean(arm.binding || arm.objectBindings);
        if (Boolean(variant.payload) !== hasPattern) {
          throw new DiagnosticError(fileName, arm.location, variant.payload ? "payload variant requires a binding" : "payloadless variant cannot bind a value");
        }
        if (arm.binding && arm.bindingLocation) validateUserName(arm.binding, arm.bindingLocation, fileName);
        if (arm.objectBindings) {
          const payloadDeclaration = variant.payload ? structs.get(variant.payload.name) : null;
          if (!payloadDeclaration) {
            throw new DiagnosticError(fileName, arm.location, "an object pattern requires a struct or class payload");
          }
          const seen = new Set<string>();
          for (const fieldBinding of arm.objectBindings) {
            if (seen.has(fieldBinding.fieldName)) throw new DiagnosticError(fileName, fieldBinding.fieldLocation, `duplicate object pattern field ${JSON.stringify(fieldBinding.fieldName)}`);
            seen.add(fieldBinding.fieldName);
            const field = payloadDeclaration.fields.find((candidate) => candidate.name === fieldBinding.fieldName);
            if (!field) {
              throw new DiagnosticError(fileName, fieldBinding.fieldLocation, `${payloadDeclaration.kind} ${JSON.stringify(payloadDeclaration.name)} has no field ${JSON.stringify(fieldBinding.fieldName)}`);
            }
            if (field.visibility === "private" && state.activeReceiver !== payloadDeclaration.name) {
              throw new DiagnosticError(fileName, fieldBinding.fieldLocation, `field ${JSON.stringify(field.name)} is private to class ${JSON.stringify(payloadDeclaration.name)}`);
            }
            validateUserName(fieldBinding.bindingName, fieldBinding.bindingLocation, fileName);
          }
        }
        const armLocals = new Map(locals);
        if (borrowedRoot && borrowedRootType) {
          armLocals.set(borrowedRoot.name, `${borrowedPrefix}${underlyingType(borrowedRootType)}`);
        }
        if (variant.payload && arm.binding && arm.bindingLocation) {
          const payloadBorrowed = borrowed && hasCleanupType(variant.payload.name, structs, enums, state.foreignTypes);
          armLocals.set(arm.binding, payloadBorrowed ? `${borrowedPrefix}${variant.payload.name}` : variant.payload.name);
          state.bindingTypes.set(arm.bindingLocation.offset, variant.payload.name);
        }
        const payloadDeclaration = variant.payload ? structs.get(variant.payload.name) : null;
        for (const fieldBinding of arm.objectBindings ?? []) {
          const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
          const fieldBorrowed = hasCleanupType(field.type.name, structs, enums, state.foreignTypes);
          armLocals.set(fieldBinding.bindingName, fieldBorrowed ? `${borrowedPrefix}${field.type.name}` : field.type.name);
          state.bindingTypes.set(fieldBinding.bindingLocation.offset, field.type.name);
        }
        const patternNames = [arm.binding, ...(arm.objectBindings ?? []).map((field) => field.bindingName)].filter((name): name is string => Boolean(name));
        const previousBorrows = new Map(patternNames.map((name) => [name, state.borrowOrigins.get(name)]));
        if (borrowed && arm.binding && variant.payload && hasCleanupType(variant.payload.name, structs, enums, state.foreignTypes)) {
          state.borrowOrigins.set(arm.binding, { location: statement.location, kind: "match" });
        }
        for (const fieldBinding of arm.objectBindings ?? []) {
          const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
          if (hasCleanupType(field.type.name, structs, enums, state.foreignTypes)) {
            state.borrowOrigins.set(fieldBinding.bindingName, { location: statement.location, kind: "match" });
          }
        }
        try {
          analyzeStatement(arm.body, owner, armLocals, globals, structs, enums, fileName, state);
        } finally {
          for (const name of patternNames) {
            const previousBorrow = previousBorrows.get(name);
            if (previousBorrow) state.borrowOrigins.set(name, previousBorrow);
            else state.borrowOrigins.delete(name);
          }
        }
        if (!statementStopsFlow(arm.body)) {
          if (borrowedRoot && borrowedRootType) armLocals.set(borrowedRoot.name, borrowedRootType);
          continuing.push(armLocals);
        }
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
    return inferClosureExpression(expression, locals, globals, structs, enums, fileName, state);
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

function closureFunctionType(closure: ClosureInfo): FunctionType {
  return {
    parameters: closure.declaration.parameters.slice(closure.captures.length).map((parameter) => ({
      name: parameter.name,
      mode: parameter.mode,
      type: parameter.type.name,
    })),
    returnType: closure.declaration.returnType.name,
  };
}

function functionTypeDeclaration(name: string, type: FunctionType, location: SourceLocation): FunctionDeclaration {
  return {
    kind: "function",
    name,
    receiverMode: null,
    parameters: type.parameters.map((parameter) => ({
      name: parameter.name,
      mode: parameter.mode,
      type: { name: parameter.type, location },
      location,
    })),
    returnType: { name: type.returnType, location },
    errorType: null,
    body: [],
    location,
  };
}

function standardFunctionDeclaration(
  localName: string,
  name: StandardFunctionName,
  location: SourceLocation,
): FunctionDeclaration {
  const signature = standardFunctionSignature(name);
  return { ...functionTypeDeclaration(localName, {
    parameters: signature.parameters,
    returnType: signature.returnType,
  }, location), async: signature.async };
}

function inferClosureExpression(
  expression: Extract<Expression, { kind: "closure" }>,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  expectedFunction: FunctionType | null = null,
  transientBorrow = false,
): ValueType {
  if (expectedFunction && expression.parameters.length !== expectedFunction.parameters.length) {
    throw new DiagnosticError(
      fileName,
      expression.location,
      `expected ${expectedFunction.parameters.length} closure parameter(s), found ${expression.parameters.length}`,
    );
  }

  const resolvedParameters: Parameter[] = expression.parameters.map((parameter, index) => {
    const contextual = expectedFunction?.parameters[index];
    if (!parameter.type && !contextual) {
      throw new DiagnosticError(fileName, parameter.location, `cannot infer the type of closure parameter ${JSON.stringify(parameter.name)}`, {
        code: "Z0215",
        length: parameter.name.length,
        notes: ["closure parameter types come from either the closure or its destination function type"],
        helps: [`write \`${parameter.name}: Type\` or assign the closure to an explicitly typed function value`],
      });
    }
    if (contextual && parameter.mode !== contextual.mode) {
      const capability = contextual.mode === "value" ? "no capability" : `the \`${contextual.mode}\` capability`;
      const spelling = contextual.mode === "value" ? parameter.name : `${contextual.mode} ${parameter.name}`;
      throw new DiagnosticError(
        fileName,
        parameter.location,
        `closure parameter ${JSON.stringify(parameter.name)} requires ${capability} from its destination function type`,
        {
          length: parameter.name.length,
          helps: [`write \`${spelling}\``],
        },
      );
    }
    if (contextual && parameter.type && parameter.type.name !== contextual.type) {
      throw new DiagnosticError(
        fileName,
        parameter.type.location,
        `closure parameter ${JSON.stringify(parameter.name)} expects ${contextual.type}, found ${parameter.type.name}`,
      );
    }
    return {
      ...parameter,
      type: parameter.type ?? { name: contextual!.type, location: parameter.location },
    };
  });

  const parameterNames = new Set<string>();
  for (const parameter of resolvedParameters) {
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

  const discovered = collectClosureCaptures(expression, locals, structs, parameterNames);
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
    const cleanupBearing = hasCleanupType(type, structs, enums, state.foreignTypes);
    const mode: ClosureCaptureInfo["mode"] = capture.mutated
      ? "inout"
      : (expression.captureMode === "move" && !cleanupBearing) || type === "cstring" ? "value" : "in";
    captures.push({
      name: capture.name,
      type,
      mode,
      moved: expression.captureMode === "move",
      location: capture.location,
    });
    const captureBorrow = expression.captureMode === "borrow" || cleanupBearing ? borrowedPrefix : "";
    closureLocals.set(capture.name, `${captureBorrow}${capture.mutated ? mutablePrefix : ""}${type}`);
    if (expression.captureMode === "borrow" && cleanupBearing && !transientBorrow) {
      locals.set(capture.name, `${borrowedPrefix}${isMutableBinding(stored) ? mutablePrefix : ""}${type}`);
      state.borrowOrigins.set(capture.name, { location: capture.location, kind: "closure" });
    }
  }
  for (const parameter of resolvedParameters) {
    const borrowed = parameter.mode === "value" && !parseSliceType(parameter.type.name) ? "" : borrowedPrefix;
    const mutable = parameter.mode === "inout" ? mutablePrefix : "";
    closureLocals.set(parameter.name, `${borrowed}${mutable}${parameter.type.name}`);
    state.bindingTypes.set(parameter.location.offset, parameter.type.name);
  }

  const contextualReturn = expression.returnType
    ?? (expectedFunction ? { name: expectedFunction.returnType, location: expression.location } : null);
  if (expression.body.kind === "block" && !contextualReturn) {
    throw new DiagnosticError(fileName, expression.location, "a block-bodied closure requires an explicit or contextual return type");
  }
  const provisionalReturn = contextualReturn ?? { name: "void", location: expression.location };
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
      ...resolvedParameters,
    ],
    returnType: provisionalReturn,
    errorType: null,
    body: [],
    location: expression.location,
  };

  let returnType: ValueType;
  let body: Statement[];
  const previousFunction = state.activeFunction;
  state.activeFunction = syntheticBase;
  try {
    if (expression.body.kind === "block") {
      body = expression.body.statements;
      const returns = analyzeStatements(body, syntheticBase, closureLocals, globals, structs, enums, fileName, state);
      if (syntheticBase.returnType.name !== "void" && !returns) {
        throw new DiagnosticError(fileName, expression.location, "closure must end with a return value");
      }
      returnType = syntheticBase.returnType.name;
    } else {
      returnType = inferDirectValue(expression.body, syntheticBase, closureLocals, globals, structs, enums, fileName, state);
      if (contextualReturn) {
        returnType = contextualCStringLiteral(contextualReturn.name, expression.body, state) ?? returnType;
        requireAssignable(contextualReturn.name, returnType, expression.body, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
        returnType = contextualReturn.name;
      }
      consumeOwnedValue(expression.body, returnType, closureLocals, structs, enums, fileName, state);
      body = [{ kind: "return", expression: expression.body, location: expression.body.location }];
    }
  } finally {
    state.activeFunction = previousFunction;
  }

  const declaration = { ...syntheticBase, returnType: { name: String(returnType), location: provisionalReturn.location }, body };
  const type = closureTypeName(expression);
  state.closures.set(expression.location.offset, {
    type,
    declaration,
    captures,
    parameterCount: resolvedParameters.length,
    owned: false,
    storable: false,
  });
  return type;
}

function finalizeClosureFunctionValue(
  expression: Extract<Expression, { kind: "closure" }>,
  expectedFunction: FunctionType,
  expectedType: string,
  locals: Map<string, ValueType>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  allowBorrowedCaptures = false,
): ClosureInfo {
  let closure = state.closures.get(expression.location.offset)!;
  if (closure.captures.length > 0 && expression.captureMode !== "move" && !allowBorrowedCaptures) {
    throw new DiagnosticError(
      fileName,
      expression.location,
      "a borrowed capturing closure cannot become a function value",
      {
        code: "Z0212",
        length: 1,
        notes: ["a function value can outlive the local bindings it captures"],
        helps: ["add `move` before the closure to place captured values in an owned environment"],
      },
    );
  }
  const actualFunction = closureFunctionType(closure);
  if (!functionTypesCompatible(expectedFunction, actualFunction)) {
    throw new DiagnosticError(
      fileName,
      expression.location,
      `expected ${displayFunctionType(expectedType)}, found ${displayFunctionType(functionTypeName(actualFunction.parameters, actualFunction.returnType))}`,
    );
  }
  closure = {
    ...closure,
    owned: closure.captures.length > 0 && expression.captureMode === "move",
    storable: true,
  };
  state.closures.set(expression.location.offset, closure);
  state.expressionTypes.set(expression.location.offset, expectedType);
  for (const capture of closure.owned ? closure.captures : []) {
    if (!hasCleanupType(capture.type, structs, enums, state.foreignTypes)) continue;
    consumeOwnedValue(
      { kind: "identifier", name: capture.name, location: capture.location },
      capture.type,
      locals,
      structs,
      enums,
      fileName,
      state,
    );
  }
  return closure;
}

function collectClosureCaptures(
  closure: Extract<Expression, { kind: "closure" }>,
  outerLocals: ReadonlyMap<string, ValueType>,
  structs: ReadonlyMap<string, StructDeclaration>,
  parameterNames: ReadonlySet<string>,
): Map<string, { readonly name: string; readonly location: SourceLocation; mutated: boolean }> {
  const outerNames = new Set(outerLocals.keys());
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
      case "new":
        for (const argument of expression.arguments) walkExpression(argument, localNames);
        return;
      case "weak":
        walkExpression(expression.expression, localNames);
        return;
      case "closure":
        return;
      case "call":
        if (expression.callee.kind === "member" && expression.callee.object.kind === "identifier") {
          const receiverType = outerLocals.get(expression.callee.object.name);
          const receiver = receiverType ? structs.get(String(underlyingType(receiverType))) : null;
          const method = receiver?.methods.find((candidate) => candidate.name === expression.callee.property);
          walkExpression(expression.callee, localNames, method?.receiverMode === "inout");
        } else {
          walkExpression(expression.callee, localNames);
        }
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
      case "objectExpression":
        for (const field of expression.fields) walkExpression(field.expression, localNames);
        return;
      case "variantExpression":
        walkExpression(expression.payload, localNames);
        return;
      case "attempt":
      case "try":
      case "await":
      case "spawn":
        walkExpression(expression.expression, localNames);
        return;
      case "matchExpression":
        walkExpression(expression.expression, localNames);
        for (const arm of expression.arms) {
          const armNames = new Set(localNames);
          if (arm.binding) armNames.add(arm.binding);
          for (const field of arm.objectBindings ?? []) armNames.add(field.bindingName);
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
          for (const field of arm.objectBindings ?? []) armNames.add(field.bindingName);
          walkStatement(arm.body, armNames);
        }
        return;
      case "asyncScope":
        walkStatement(statement.body, new Set(localNames));
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
  const candidateRoot = storageRoot(expression.expression);
  const candidateRootType = candidateRoot ? locals.get(candidateRoot.name) : null;
  const borrowed = expression.mode === "in" || Boolean(candidateRootType && isBorrowedBinding(candidateRootType));
  if (borrowed) state.borrowedMatches.add(expression.location.offset);
  const borrowedRoot = borrowed ? candidateRoot : null;
  const borrowedRootType = borrowedRoot ? locals.get(borrowedRoot.name) : null;
  if (expression.mode === "in" && (!borrowedRoot || !borrowedRootType)) {
    throw new DiagnosticError(fileName, expression.expression.location, "match (in ...) requires stored enum storage", {
      code: "Z0230",
      helps: ["bind the enum value before borrowing it, or remove `in` to consume the value"],
    });
  }
  if (!borrowed && hasCleanupType(subjectType, structs, enums, state.foreignTypes)) {
    consumeOwnedValue(expression.expression, subjectType, locals, structs, enums, fileName, state);
  }

  const covered = new Set<string>();
  const continuing: Map<string, ValueType>[] = [];
  let resultType: ValueType = "never";
  for (const arm of expression.arms) {
    const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName);
    if (!variant) throw new DiagnosticError(fileName, arm.location, `unknown variant ${JSON.stringify(arm.variantName)}`);
    if (covered.has(variant.name)) throw new DiagnosticError(fileName, arm.location, `duplicate match arm ${JSON.stringify(variant.name)}`);
    covered.add(variant.name);
    const hasPattern = Boolean(arm.binding || arm.objectBindings);
    if (Boolean(variant.payload) !== hasPattern) {
      throw new DiagnosticError(fileName, arm.location, variant.payload ? "payload variant requires a binding" : "payloadless variant cannot bind a value");
    }
    if (arm.binding && arm.bindingLocation) validateUserName(arm.binding, arm.bindingLocation, fileName);
    if (arm.objectBindings) {
      const payloadDeclaration = variant.payload ? structs.get(variant.payload.name) : null;
      if (!payloadDeclaration) throw new DiagnosticError(fileName, arm.location, "an object pattern requires a struct or class payload");
      const seen = new Set<string>();
      for (const fieldBinding of arm.objectBindings) {
        if (seen.has(fieldBinding.fieldName)) throw new DiagnosticError(fileName, fieldBinding.fieldLocation, `duplicate object pattern field ${JSON.stringify(fieldBinding.fieldName)}`);
        seen.add(fieldBinding.fieldName);
        const field = payloadDeclaration.fields.find((candidate) => candidate.name === fieldBinding.fieldName);
        if (!field) {
          throw new DiagnosticError(fileName, fieldBinding.fieldLocation, `${payloadDeclaration.kind} ${JSON.stringify(payloadDeclaration.name)} has no field ${JSON.stringify(fieldBinding.fieldName)}`);
        }
        if (field.visibility === "private" && state.activeReceiver !== payloadDeclaration.name) {
          throw new DiagnosticError(fileName, fieldBinding.fieldLocation, `field ${JSON.stringify(field.name)} is private to class ${JSON.stringify(payloadDeclaration.name)}`);
        }
        validateUserName(fieldBinding.bindingName, fieldBinding.bindingLocation, fileName);
      }
    }
    const armLocals = new Map(locals);
    if (borrowedRoot && borrowedRootType) {
      armLocals.set(borrowedRoot.name, `${borrowedPrefix}${underlyingType(borrowedRootType)}`);
    }
    if (variant.payload && arm.binding && arm.bindingLocation) {
      const payloadBorrowed = borrowed && hasCleanupType(variant.payload.name, structs, enums, state.foreignTypes);
      armLocals.set(arm.binding, payloadBorrowed ? `${borrowedPrefix}${variant.payload.name}` : variant.payload.name);
      state.bindingTypes.set(arm.bindingLocation.offset, variant.payload.name);
    }
    const payloadDeclaration = variant.payload ? structs.get(variant.payload.name) : null;
    for (const fieldBinding of arm.objectBindings ?? []) {
      const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
      const fieldBorrowed = hasCleanupType(field.type.name, structs, enums, state.foreignTypes);
      armLocals.set(fieldBinding.bindingName, fieldBorrowed ? `${borrowedPrefix}${field.type.name}` : field.type.name);
      state.bindingTypes.set(fieldBinding.bindingLocation.offset, field.type.name);
    }
    const patternNames = [arm.binding, ...(arm.objectBindings ?? []).map((field) => field.bindingName)].filter((name): name is string => Boolean(name));
    const previousBorrows = new Map(patternNames.map((name) => [name, state.borrowOrigins.get(name)]));
    if (borrowed && arm.binding && variant.payload && hasCleanupType(variant.payload.name, structs, enums, state.foreignTypes)) {
      state.borrowOrigins.set(arm.binding, { location: expression.location, kind: "match" });
    }
    for (const fieldBinding of arm.objectBindings ?? []) {
      const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
      if (hasCleanupType(field.type.name, structs, enums, state.foreignTypes)) {
        state.borrowOrigins.set(fieldBinding.bindingName, { location: expression.location, kind: "match" });
      }
    }
    let armType: ValueType = "never";
    try {
      armType = inferValueArm(arm.body, owner, armLocals, globals, structs, enums, fileName, state);
    } finally {
      for (const name of patternNames) {
        const previousBorrow = previousBorrows.get(name);
        if (previousBorrow) state.borrowOrigins.set(name, previousBorrow);
        else state.borrowOrigins.delete(name);
      }
    }
    if (armType !== "never") {
      if (borrowedRoot && borrowedRootType) armLocals.set(borrowedRoot.name, borrowedRootType);
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
    consumeOwnedValue(statement.expression, type, locals, structs, enums, fileName, state);
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
  const success = result.variants.find((variant) => variant.name === "success")!;
  const failure = result.variants.find((variant) => variant.name === "failure")!.payload!;
  if (failure.name !== owner.errorType.name) {
    throw new DiagnosticError(fileName, expression.location, `cannot propagate ${failure.name} from a function throwing ${owner.errorType.name}`);
  }
  return success.payload?.name ?? "void";
}

function isConsoleMember(
  expression: Extract<Expression, { kind: "member" }>,
  locals: ReadonlyMap<string, ValueType>,
  globals: ReadonlyMap<string, SymbolValue>,
): boolean {
  return expression.object.kind === "identifier"
    && !locals.has(expression.object.name)
    && globals.get(expression.object.name)?.kind === "console";
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
  if (hasCleanupType(actual, structs, enums, state.foreignTypes)
    && !isNamedStorageExpression(expression)
    && expression.kind !== "string") {
    throw new DiagnosticError(fileName, expression.location, "console formatting of a cleanup-bearing temporary requires stored ownership", {
      code: "Z0402",
      helps: ["bind the value to a const or let before logging it"],
    });
  }
  if (actual === "null" || (primitiveTypes.has(actual) && actual !== "void")) return;
  if (actual.startsWith("__z_objc:") || actual.startsWith(objcClassPrefix)
    || state.foreignObjectTypes.has(actual) || state.foreignTypes.has(actual)) return;
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

function registerAsyncCall(
  declaration: FunctionDeclaration,
  location: SourceLocation,
  fileName: string,
  state: AnalysisState,
): void {
  if (!declaration.async) return;
  const context = state.asyncCallContexts.at(-1);
  if (!context) {
    throw new DiagnosticError(fileName, location, `async call to ${JSON.stringify(declaration.name)} requires \`await\` or \`spawn\``, {
      code: "Z0702",
      notes: ["Z never starts asynchronous work from a naked function call"],
      helps: ["use `await` for sequential work or `spawn` for concurrent work in an async function"],
    });
  }
  context.calls += 1;
}

function firstLiveBorrow(locals: ReadonlyMap<string, ValueType>): string | null {
  for (const [name, type] of locals) {
    if (isBorrowedBinding(type)
      && initializationState(type) === "initialized"
      && ownershipState(type) === "available") return name;
  }
  return null;
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
        if (expression.operator === "-" && isIntegerType(canonicalOperand)) {
          state.integerOperations.set(expression.location.offset, { kind: "checkedNegate", type: canonicalOperand });
          validateConstantIntegerOperation(expression, canonicalOperand, fileName);
        }
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
        if (global.declaration.async) {
          throw new DiagnosticError(fileName, expression.location, "async function values are deferred; call the function beneath `await` or `spawn`");
        }
        if (global.declaration.typeParameters?.length) {
          throw new DiagnosticError(fileName, expression.location, "generic function values require explicit specialization, which is not implemented yet");
        }
        if (global.declaration.errorType) {
          throw new DiagnosticError(fileName, expression.location, "throwing function values are not implemented in the first function-type tier");
        }
        return functionTypeName(
          global.declaration.parameters.map((parameter) => ({
            name: parameter.name,
            mode: parameter.mode,
            type: parameter.type.name,
          })),
          global.declaration.returnType.name,
        );
      }
      if (global?.kind === "standardFunction") {
        const signature = standardFunctionSignature(global.name);
        if (signature.async) {
          throw new DiagnosticError(fileName, expression.location, "async function values are deferred; call the function beneath `await` or `spawn`");
        }
        state.standardFunctionReferences.set(expression.location.offset, global.name);
        return functionTypeName(signature.parameters, signature.returnType);
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
      if (global?.kind === "console") {
        throw new DiagnosticError(fileName, expression.location, "the console module must be followed by a method name");
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
      if (["+", "-", "*", "/", "%"].includes(expression.operator)) {
        if (canonicalLeft !== canonicalRight || !isNumericType(canonicalLeft)) {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires matching numeric operands`);
        }
        state.foreignExpressionTypes.set(expression.location.offset, canonicalLeft);
        if (isIntegerType(canonicalLeft)) {
          const kinds = {
            "+": "checkedAdd",
            "-": "checkedSubtract",
            "*": "checkedMultiply",
            "/": "checkedDivide",
            "%": "checkedRemainder",
          } as const;
          state.integerOperations.set(expression.location.offset, {
            kind: kinds[expression.operator as keyof typeof kinds],
            type: canonicalLeft,
          });
          validateConstantIntegerOperation(expression, canonicalLeft, fileName);
        }
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
        if (expression.operator === "<<" || expression.operator === ">>") {
          state.integerOperations.set(expression.location.offset, {
            kind: expression.operator === "<<" ? "checkedShiftLeft" : "checkedShiftRight",
            type: canonicalLeft,
          });
          validateConstantIntegerOperation(expression, canonicalLeft, fileName);
        }
        return result;
      }
      if (["<", "<=", ">", ">="].includes(expression.operator)) {
        if (canonicalLeft !== canonicalRight || !isNumericType(canonicalLeft)) {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires matching numeric operands`);
        }
        return "bool";
      }
      if (["==", "!="].includes(expression.operator)) {
        const leftNullableReference = nullableForeignReference(left, state);
        const rightNullableReference = nullableForeignReference(right, state);
        if (
          (canonicalLeft === "null" && rightNullableReference)
          || (canonicalRight === "null" && leftNullableReference)
        ) {
          return "bool";
        }
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
      consumeOwnedValue(expression.thenExpression, thenType, thenLocals, structs, enums, fileName, state);
      const elseLocals = narrowedConditionLocals(original, expression.condition, false, state);
      const elseType = inferExpression(expression.elseExpression, elseLocals, globals, structs, enums, fileName, state);
      consumeOwnedValue(expression.elseExpression, elseType, elseLocals, structs, enums, fileName, state);
      mergeOwnershipStates(locals, [thenLocals, elseLocals], state);
      return commonBranchType("conditional", thenType, elseType, expression.elseExpression.location, fileName);
    }
    case "new": {
      const declaration = structs.get(expression.typeName);
      if (!declaration) {
        throw new DiagnosticError(fileName, expression.location, `unknown class ${JSON.stringify(expression.typeName)}`);
      }
      if (declaration.kind !== "class") {
        throw new DiagnosticError(fileName, expression.location, `new requires a class type; construct ${expression.typeName} as ${expression.typeName}({ ... })`);
      }
      rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
      if (declaration.constructor) {
        const target = constructorFunction(declaration);
        checkArguments(target, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
        if (target.errorType) {
          if (!allowThrowingCall) {
            throw new DiagnosticError(fileName, expression.location, "throwing constructor requires `attempt` or `try`");
          }
          return resultTypeName(declaration.name, target.errorType.name);
        }
        return expression.typeName;
      }
      if (expression.arguments.length !== 1 || expression.arguments[0].kind !== "objectExpression") {
        throw new DiagnosticError(fileName, expression.location, "synthesized class initialization requires one object literal");
      }
      inferContextualObjectExpression(expression.arguments[0], expression.typeName, locals, globals, structs, enums, fileName, state);
      return expression.typeName;
    }
    case "weak": {
      if (!isNamedStorageExpression(expression.expression)) {
        throw new DiagnosticError(fileName, expression.expression.location, "weak requires an existing stored class reference", {
          code: "Z0220",
          helps: ["bind the class instance to const or let before creating a weak reference"],
        });
      }
      const target = inferExpression(expression.expression, locals, globals, structs, enums, fileName, state);
      const declaration = structs.get(String(underlyingType(target)));
      if (declaration?.kind !== "class") {
        throw new DiagnosticError(fileName, expression.expression.location, `weak requires a class reference, found ${describeValueType(target, state)}`, {
          code: "Z0220",
        });
      }
      return weakTypeName(declaration.name);
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
        consumeOwnedValue(initializer.expression, fieldType, locals, structs, enums, fileName, state);
      }
      const expectedFields = declaration?.fields ?? (foreignDeclaration?.kind === "record" ? foreignDeclaration.fields : []);
      const missing = expectedFields.find((field) => !provided.has(field.name));
      if (missing) {
        throw new DiagnosticError(fileName, expression.location, `missing field ${JSON.stringify(missing.name)} when constructing ${JSON.stringify(expression.typeName)}`);
      }
      if (foreignDeclaration?.kind === "record") state.foreignExpressionTypes.set(expression.location.offset, expression.typeName);
      return expression.typeName;
    }
    case "objectExpression":
      throw new DiagnosticError(fileName, expression.location, "cannot infer an object literal type here", {
        helps: ["use a named struct literal, or pass the object literal where a concrete payload type is expected"],
      });
    case "arrayExpression": {
      if (expression.elements.length === 0) {
        throw new DiagnosticError(fileName, expression.location, "cannot infer an empty fixed array; provide at least one element");
      }
      const elementType = inferExpression(expression.elements[0], locals, globals, structs, enums, fileName, state);
      if (elementType === "unknown" || elementType === "never" || elementType === "null") {
        throw new DiagnosticError(fileName, expression.elements[0].location, "cannot infer a fixed array element type from this expression");
      }
      consumeOwnedValue(expression.elements[0], elementType, locals, structs, enums, fileName, state);
      for (const element of expression.elements.slice(1)) {
        const actual = inferExpression(element, locals, globals, structs, enums, fileName, state);
        requireAssignable(elementType, actual, element, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
        consumeOwnedValue(element, elementType, locals, structs, enums, fileName, state);
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
      if (hasCleanupType(ownerType, structs, enums, state.foreignTypes) && !isNamedStorageExpression(expression.object)) {
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
      let actual = expression.payload.kind === "objectExpression"
        ? inferContextualObjectExpression(expression.payload, variant.payload.name, locals, globals, structs, enums, fileName, state)
        : inferExpression(expression.payload, locals, globals, structs, enums, fileName, state);
      actual = contextualCStringLiteral(variant.payload.name, expression.payload, state) ?? actual;
      requireAssignable(variant.payload.name, actual, expression.payload, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      consumeOwnedValue(expression.payload, variant.payload.name, locals, structs, enums, fileName, state);
      return declaration.name;
    }
    case "await": {
      if (!state.activeFunction?.async) {
        throw new DiagnosticError(fileName, expression.location, "await requires an enclosing async function", {
          code: "Z0701",
          helps: ["add `async` before the enclosing function declaration"],
        });
      }
      if (expression.expression.kind === "spawn") {
        throw new DiagnosticError(fileName, expression.location, "`await spawn` is redundant", {
          code: "Z0701",
          notes: ["an immediately joined child creates no interval of concurrent parent work"],
          helps: ["use `await operation()` for sequential work, or bind `spawn operation()` and await the Task later"],
        });
      }
      const borrowed = firstLiveBorrow(locals);
      if (borrowed) {
        throw new DiagnosticError(fileName, expression.location, `cannot await while borrowed storage ${JSON.stringify(borrowed)} is live`, {
          code: "Z0704",
          notes: ["the first async tier does not keep borrowed storage across suspension points"],
          helps: ["finish the borrow before awaiting, or move an owned value or ARC class reference into the async operation"],
        });
      }
      const context = { mode: "await" as const, calls: 0 };
      state.asyncCallContexts.push(context);
      let awaited: ValueType;
      try {
        awaited = inferExpression(expression.expression, locals, globals, structs, enums, fileName, state, allowThrowingCall);
      } finally {
        state.asyncCallContexts.pop();
      }
      const task = parseTaskType(String(awaited));
      if (task) {
        if (task.errorType) {
          if (!allowThrowingCall) {
            throw new DiagnosticError(fileName, expression.location, "awaiting a throwing task requires `attempt` or `try`");
          }
          return resultTypeName(task.successType, task.errorType);
        }
        return task.successType;
      }
      if (context.calls === 0) {
        throw new DiagnosticError(fileName, expression.location, "await requires an async call or Task value", {
          code: "Z0701",
          helps: ["remove `await` from synchronous work"],
        });
      }
      return awaited;
    }
    case "spawn": {
      if (!state.activeFunction?.async) {
        throw new DiagnosticError(fileName, expression.location, "spawn requires an enclosing async function", {
          code: "Z0703",
          helps: ["add `async` before the enclosing function declaration"],
        });
      }
      if (expression.expression.kind !== "call") {
        throw new DiagnosticError(fileName, expression.location, "spawn requires a direct async function or method call");
      }
      const context = { mode: "spawn" as const, calls: 0 };
      state.asyncCallContexts.push(context);
      let spawned: ValueType;
      try {
        spawned = inferExpression(expression.expression, locals, globals, structs, enums, fileName, state, true);
      } finally {
        state.asyncCallContexts.pop();
      }
      if (context.calls !== 1) {
        throw new DiagnosticError(fileName, expression.location, "spawn requires exactly one direct async call");
      }
      const result = enums.get(String(spawned));
      if (result?.name.startsWith("__z_Result_")) {
        const successVariant = result.variants.find((variant) => variant.name === "success")!;
        const success = successVariant.payload?.name ?? "void";
        const failure = result.variants.find((variant) => variant.name === "failure")!.payload!.name;
        return taskTypeName(success, failure);
      }
      return taskTypeName(String(spawned), null);
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
        const aggregate = !locals.has(expression.object.name) ? structs.get(expression.object.name) : null;
        if (aggregate) {
          const method = aggregate.methods.find((candidate) => candidate.name === expression.property);
          if (method?.static) {
            if (method.visibility === "private" && state.activeReceiver !== aggregate.name) {
              throw new DiagnosticError(fileName, expression.location, `static method ${JSON.stringify(method.name)} is private to ${aggregate.kind} ${JSON.stringify(aggregate.name)}`);
            }
            throw new DiagnosticError(fileName, expression.location, "static method values are not implemented; call the method instead");
          }
          if (method) {
            throw new DiagnosticError(fileName, expression.location, `instance method ${JSON.stringify(method.name)} must be called through a ${aggregate.name} value`);
          }
        }
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
        if (hasCleanupType(receiverType, structs, enums, state.foreignTypes) && !isNamedStorageExpression(expression.object)) {
          throw new DiagnosticError(fileName, expression.object.location, "a cleanup-bearing array temporary must be bound before reading its length");
        }
        if (expression.property !== "length" && !(dynamic && expression.property === "capacity")) {
          throw new DiagnosticError(fileName, expression.location, `${dynamic ? "Array" : "fixed array"} has no member ${JSON.stringify(expression.property)}`);
        }
        return "usize";
      }
      const objcReceiverType = objcReceiver(receiverType, state);
      rejectNullableObjCReceiver(receiverType, expression.object.location, fileName, state);
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
      if (hasCleanupType(receiverType, structs, enums, state.foreignTypes) && !isNamedStorageExpression(expression.object)) {
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
      if (field) {
        if (field.visibility === "private" && state.activeReceiver !== declaration.name) {
          throw new DiagnosticError(fileName, expression.location, `field ${JSON.stringify(field.name)} is private to class ${JSON.stringify(declaration.name)}`);
        }
        return field.type.name;
      }
      const method = declaration.methods.find((candidate) => candidate.name === expression.property);
      if (method) {
        throw new DiagnosticError(fileName, expression.location, "method values are not implemented; call the method instead");
      }
      throw new DiagnosticError(fileName, expression.location, `struct ${JSON.stringify(declaration.name)} has no member ${JSON.stringify(expression.property)}`);
    }
    case "call": {
      if (expression.callee.kind === "identifier") {
        const aggregate = structs.get(expression.callee.name);
        if (aggregate) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (aggregate.kind === "class") {
            throw new DiagnosticError(fileName, expression.callee.location, `class construction requires new ${aggregate.name}({ ... })`);
          }
          if (expression.arguments.length !== 1 || expression.arguments[0].kind !== "objectExpression") {
            throw new DiagnosticError(fileName, expression.location, `${aggregate.name} construction requires one object literal`);
          }
          inferContextualObjectExpression(expression.arguments[0], aggregate.name, locals, globals, structs, enums, fileName, state);
          return aggregate.name;
        }
        const imported = globals.get(expression.callee.name);
        if (imported?.kind === "foreignType" && imported.declaration.kind === "record") {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.arguments.length !== 1 || expression.arguments[0].kind !== "objectExpression") {
            throw new DiagnosticError(fileName, expression.location, `${expression.callee.name} construction requires one object literal`);
          }
          inferContextualObjectExpression(expression.arguments[0], imported.declaration.typeName, locals, globals, structs, enums, fileName, state);
          return imported.declaration.typeName;
        }
      }
      if (expression.callee.kind === "member" && expression.callee.object.kind === "identifier") {
        const imported = globals.get(expression.callee.object.name);
        const record = imported?.kind === "foreignModule"
          ? imported.module.namedTypes.get(expression.callee.property)
          : null;
        if (record?.kind === "record") {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.arguments.length !== 1 || expression.arguments[0].kind !== "objectExpression") {
            throw new DiagnosticError(fileName, expression.location, `${expression.callee.property} construction requires one object literal`);
          }
          inferContextualObjectExpression(expression.arguments[0], record.typeName, locals, globals, structs, enums, fileName, state);
          return record.typeName;
        }
      }
      if (expression.callee.kind === "member") {
        if (
          expression.callee.object.kind === "identifier"
          && expression.callee.object.name === "console"
          && !locals.has("console")
          && !globals.has("console")
        ) {
          throw new DiagnosticError(fileName, expression.callee.object.location, "console is not in scope", {
            code: "Z0403",
            helps: ["add `import console from \"std/console\";`"],
          });
        }
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
          const aggregate = !locals.has(expression.callee.object.name)
            ? structs.get(expression.callee.object.name)
            : null;
          if (aggregate) {
            const method = aggregate.methods.find((candidate) => candidate.name === expression.callee.property);
            if (!method) {
              throw new DiagnosticError(fileName, expression.callee.location, `${aggregate.kind} ${JSON.stringify(aggregate.name)} has no static method ${JSON.stringify(expression.callee.property)}`);
            }
            if (!method.static) {
              throw new DiagnosticError(fileName, expression.callee.location, `instance method ${JSON.stringify(method.name)} must be called through a ${aggregate.name} value`);
            }
            if (method.visibility === "private" && state.activeReceiver !== aggregate.name) {
              throw new DiagnosticError(fileName, expression.callee.location, `static method ${JSON.stringify(method.name)} is private to ${aggregate.kind} ${JSON.stringify(aggregate.name)}`);
            }
            rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
            checkArguments(method, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
            registerAsyncCall(method, expression.location, fileName, state);
            if (method.errorType) {
              if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
              return resultTypeName(method.returnType.name, method.errorType.name);
            }
            return method.returnType.name;
          }
          const enumDeclaration = enums.get(expression.callee.object.name);
          if (enumDeclaration) {
            rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
            const variant = enumDeclaration.variants.find((candidate) => candidate.name === expression.callee.property);
            if (!variant) throw new DiagnosticError(fileName, expression.callee.location, `enum ${JSON.stringify(enumDeclaration.name)} has no variant ${JSON.stringify(expression.callee.property)}`);
            const expectedCount = variant.payload ? 1 : 0;
            if (expression.arguments.length !== expectedCount) throw new DiagnosticError(fileName, expression.location, `variant ${JSON.stringify(variant.name)} expects ${expectedCount} argument(s)`);
            if (variant.payload) {
              const argument = expression.arguments[0];
              const actual = argument.kind === "objectExpression"
                ? inferContextualObjectExpression(argument, variant.payload.name, locals, globals, structs, enums, fileName, state)
                : inferExpression(argument, locals, globals, structs, enums, fileName, state);
              requireAssignable(variant.payload.name, actual, expression.arguments[0], fileName, state.foreignNamedTypes, state.numericLiteralTypes);
              consumeOwnedValue(expression.arguments[0], variant.payload.name, locals, structs, enums, fileName, state);
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
        const integerReceiverType = canonicalType(receiverType, state.foreignNamedTypes);
        const integerMethod = isIntegerType(integerReceiverType)
          ? integerMethodKind(expression.callee.property)
          : null;
        if (integerMethod) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.arguments.length !== 1) {
            throw new DiagnosticError(
              fileName,
              expression.location,
              `${JSON.stringify(expression.callee.property)} expects 1 argument, received ${expression.arguments.length}`,
            );
          }
          const argument = expression.arguments[0];
          const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
          if (argument.kind === "number") {
            requireNumericLiteralFits(argument, integerReceiverType, fileName, state.numericLiteralTypes);
          } else if (canonicalType(actual, state.foreignNamedTypes) !== integerReceiverType) {
            throw new DiagnosticError(
              fileName,
              argument.location,
              `${expression.callee.property} requires ${integerReceiverType}, found ${displayArrayType(String(actual))}`,
            );
          }
          state.integerOperations.set(expression.location.offset, { kind: integerMethod, type: integerReceiverType });
          return integerReceiverType;
        }
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
          consumeOwnedValue(expression.arguments[0], dynamic.elementType, locals, structs, enums, fileName, state);
          return "void";
        }
        const weak = parseWeakType(String(receiverType));
        if (weak) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.callee.property !== "upgrade") {
            throw new DiagnosticError(fileName, expression.callee.location, `Weak has no method ${JSON.stringify(expression.callee.property)}`);
          }
          if (expression.arguments.length !== 0) {
            throw new DiagnosticError(fileName, expression.location, `"upgrade" expects 0 arguments, received ${expression.arguments.length}`);
          }
          if (!allowThrowingCall) {
            throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
          }
          return weakResultTypeName(weak.target);
        }
        const objcReceiverType = objcReceiver(receiverType, state);
        rejectNullableObjCReceiver(receiverType, expression.callee.object.location, fileName, state);
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
            result = nullable
              ? `__z_objc:nullable:${objcReceiverType.declaration.typeName}`
              : objcReceiverType.declaration.typeName;
          }
          if (result === "unknown") throw new DiagnosticError(fileName, expression.location, `Objective-C selector ${JSON.stringify(method.selector)} uses an unsupported return type`);
          state.foreignCallTypes.set(expression.location.offset, String(result));
          return result;
        }
        const declaration = structs.get(receiverType);
        const field = declaration?.fields.find((candidate) => candidate.name === expression.callee.property);
        const fieldFunctionType = field ? parseFunctionType(field.type.name) : null;
        if (declaration && field && fieldFunctionType) {
          if (field.visibility === "private" && state.activeReceiver !== declaration.name) {
            throw new DiagnosticError(fileName, expression.callee.location, `field ${JSON.stringify(field.name)} is private to class ${JSON.stringify(declaration.name)}`);
          }
          if (hasCleanupType(receiverType, structs, enums, state.foreignTypes) && !isNamedStorageExpression(expression.callee.object)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "a cleanup-bearing temporary must be bound before calling one of its function fields");
          }
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          state.expressionTypes.set(expression.callee.location.offset, field.type.name);
          checkArguments(
            functionTypeDeclaration(expression.callee.property, fieldFunctionType, expression.callee.location),
            expression.arguments,
            locals,
            globals,
            structs,
            enums,
            fileName,
            expression.location,
            state,
          );
          return fieldFunctionType.returnType;
        }
        const method = declaration?.methods.find((candidate) => candidate.name === expression.callee.property);
        if (!declaration || !method) {
          throw new DiagnosticError(fileName, expression.callee.location, `type ${JSON.stringify(receiverType)} has no method ${JSON.stringify(expression.callee.property)}`);
        }
        if (method.static) {
          throw new DiagnosticError(fileName, expression.callee.location, `static method ${JSON.stringify(method.name)} must be called as ${declaration.name}.${method.name}()`);
        }
        if (method.visibility === "private" && state.activeReceiver !== declaration.name) {
          throw new DiagnosticError(fileName, expression.callee.location, `method ${JSON.stringify(method.name)} is private to ${declaration.kind} ${JSON.stringify(declaration.name)}`);
        }
        rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
        if (
          method.receiverMode !== "move"
          && hasCleanupType(receiverType, structs, enums, state.foreignTypes)
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
        registerAsyncCall(method, expression.location, fileName, state);
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
          consumeOwnedValue(expression.callee.object, receiverType, locals, structs, enums, fileName, state);
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
        const functionType = parseFunctionType(String(underlyingType(localCallee)));
        if (!closure && !functionType) {
          throw new DiagnosticError(fileName, expression.callee.location, `${JSON.stringify(expression.callee.name)} is not callable`);
        }
        rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
        if (functionType) {
          state.expressionTypes.set(expression.callee.location.offset, String(underlyingType(localCallee)));
          checkArguments(
            functionTypeDeclaration(expression.callee.name, functionType, expression.callee.location),
            expression.arguments,
            locals,
            globals,
            structs,
            enums,
            fileName,
            expression.location,
            state,
          );
          return functionType.returnType;
        }
        state.expressionTypes.set(expression.callee.location.offset, closure!.type);
        checkArguments(
          { ...closure!.declaration, parameters: closure!.declaration.parameters.slice(closure!.captures.length) },
          expression.arguments,
          locals,
          globals,
          structs,
          enums,
          fileName,
          expression.location,
          state,
        );
        return closure!.declaration.returnType.name;
      }
      const target = globals.get(expression.callee.name);
      if (target?.kind === "standardFunction") {
        rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
        state.standardFunctionReferences.set(expression.callee.location.offset, target.name);
        state.expressionTypes.set(
          expression.callee.location.offset,
          functionTypeName(
            target.declaration.parameters.map((parameter) => ({
              name: parameter.name,
              mode: parameter.mode,
              type: parameter.type.name,
            })),
            target.declaration.returnType.name,
          ),
        );
        checkArguments(target.declaration, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
        registerAsyncCall(target.declaration, expression.location, fileName, state);
        return target.declaration.returnType.name;
      }
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
      registerAsyncCall(target.declaration, expression.location, fileName, state);
      if (target.declaration.errorType) {
        if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
        return resultTypeName(target.declaration.returnType.name, target.declaration.errorType.name);
      }
      return target.declaration.returnType.name;
    }
  }
}

function inferContextualObjectExpression(
  expression: Extract<Expression, { kind: "objectExpression" }>,
  expectedType: string,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType {
  const declaration = structs.get(expectedType);
  if (declaration?.kind === "class" && declaration.constructor) {
    throw new DiagnosticError(
      fileName,
      expression.location,
      `class ${JSON.stringify(declaration.name)} has a constructor and cannot be initialized from an object value`,
    );
  }
  const actual = inferExpression(
    { kind: "structExpression", typeName: expectedType, fields: expression.fields, location: expression.location },
    locals,
    globals,
    structs,
    enums,
    fileName,
    state,
  );
  state.expressionTypes.set(expression.location.offset, expectedType);
  return actual;
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
    if (argument.kind === "closure") {
      const expectedFunction = parseFunctionType(parameter.type.name);
      if (!expectedFunction) {
        throw new DiagnosticError(fileName, argument.location, `expected ${parameter.type.name}, found a closure`);
      }
      inferClosureExpression(argument, locals, globals, structs, enums, fileName, state, expectedFunction, true);
      finalizeClosureFunctionValue(
        argument,
        expectedFunction,
        parameter.type.name,
        locals,
        structs,
        enums,
        fileName,
        state,
        parameter.mode === "in",
      );
      if (parameter.mode === "in") state.nativeArgumentAccesses.set(argument.location.offset, "in");
      continue;
    }
    if (parameter.mode === "in") {
      const aggregateTemporary = argument.kind === "call"
        && argument.callee.kind === "identifier"
        && structs.has(argument.callee.name)
        && argument.arguments.length === 1
        && argument.arguments[0].kind === "objectExpression";
      if (!isNamedStorageExpression(argument) && argument.kind !== "structExpression" && !aggregateTemporary && argument.kind !== "template") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `borrowed argument to ${JSON.stringify(target.name)} must be stored or a struct literal`,
        );
      }
      const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
      if (
        hasCleanupType(actual, structs, enums, state.foreignTypes)
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
    consumeOwnedValue(argument, parameter.type.name, locals, structs, enums, fileName, state);
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
  if (expression.kind === "structExpression" || expression.kind === "objectExpression") {
    for (const field of expression.fields) validateDeinitExpression(field.expression, fileName);
  }
  if (expression.kind === "variantExpression") validateDeinitExpression(expression.payload, fileName);
  if (expression.kind === "attempt" || expression.kind === "try" || expression.kind === "weak") {
    validateDeinitExpression(expression.expression, fileName);
  }
  if (expression.kind === "new") {
    for (const argument of expression.arguments) validateDeinitExpression(argument, fileName);
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
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  if (!hasCleanupType(type, structs, enums, state.foreignTypes)) return;
  if (state.objcStringsToZ.has(expression.location.offset)) return;
  const actual = String(underlyingType(type));
  if (parseWeakType(actual)) {
    if (expression.kind === "identifier" || expression.kind === "member" || expression.kind === "index") {
      state.managedCopies.add(expression.location.offset);
    }
    return;
  }
  const declaration = structs.get(actual);
  if (declaration?.kind === "class" || parseFunctionType(actual)) {
    if (expression.kind === "identifier" || expression.kind === "member" || expression.kind === "index") {
      state.managedCopies.add(expression.location.offset);
    }
    return;
  }
  if (
    expression.kind === "member"
    && expression.object.kind === "identifier"
    && enums.get(expression.object.name)?.variants.some((variant) => variant.name === expression.property && !variant.payload)
  ) {
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
    if (borrow?.kind === "match") {
      throw new DiagnosticError(fileName, expression.location, `cannot move borrowed match binding ${JSON.stringify(expression.name)}`, {
        code: "Z0231",
        length: expression.name.length,
        labels: [{ location: borrow.location, message: "borrowed match begins here", length: 5 }],
        notes: ["this match inspects payload storage without taking it out of the enum"],
        helps: ["match an owned enum value when its payload should be consumed"],
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
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  if (!hasCleanupType(type, structs, enums, state.foreignTypes)) return;
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
  if (type.startsWith(callTargetPrefix)) return ownershipState(stripCallTarget(type));
  if (type.startsWith(movedPrefix)) return "moved";
  if (type.startsWith(maybeMovedPrefix)) return "maybeMoved";
  if (type.startsWith(uninitializedPrefix)) return ownershipState(type.slice(uninitializedPrefix.length));
  if (type.startsWith(maybeUninitializedPrefix)) return ownershipState(type.slice(maybeUninitializedPrefix.length));
  if (type.startsWith(mutablePrefix)) return ownershipState(type.slice(mutablePrefix.length));
  if (type.startsWith(borrowedPrefix)) return ownershipState(type.slice(borrowedPrefix.length));
  return "available";
}

function initializationState(type: ValueType): "initialized" | "uninitialized" | "maybeUninitialized" {
  if (type.startsWith(callTargetPrefix)) return initializationState(stripCallTarget(type));
  if (type.startsWith(uninitializedPrefix)) return "uninitialized";
  if (type.startsWith(maybeUninitializedPrefix)) return "maybeUninitialized";
  if (type.startsWith(movedPrefix)) return initializationState(type.slice(movedPrefix.length));
  if (type.startsWith(maybeMovedPrefix)) return initializationState(type.slice(maybeMovedPrefix.length));
  if (type.startsWith(mutablePrefix)) return initializationState(type.slice(mutablePrefix.length));
  if (type.startsWith(borrowedPrefix)) return initializationState(type.slice(borrowedPrefix.length));
  return "initialized";
}

function underlyingType(type: ValueType): ValueType {
  if (type.startsWith(callTargetPrefix)) return underlyingType(stripCallTarget(type));
  if (type.startsWith(movedPrefix)) return underlyingType(type.slice(movedPrefix.length));
  if (type.startsWith(maybeMovedPrefix)) return underlyingType(type.slice(maybeMovedPrefix.length));
  if (type.startsWith(uninitializedPrefix)) return underlyingType(type.slice(uninitializedPrefix.length));
  if (type.startsWith(maybeUninitializedPrefix)) return underlyingType(type.slice(maybeUninitializedPrefix.length));
  if (type.startsWith(mutablePrefix)) return underlyingType(type.slice(mutablePrefix.length));
  if (type.startsWith(borrowedPrefix)) return underlyingType(type.slice(borrowedPrefix.length));
  return type;
}

function isMutableBinding(type: ValueType): boolean {
  if (type.startsWith(callTargetPrefix)) return isMutableBinding(stripCallTarget(type));
  if (type.startsWith(movedPrefix)) return isMutableBinding(type.slice(movedPrefix.length));
  if (type.startsWith(maybeMovedPrefix)) return isMutableBinding(type.slice(maybeMovedPrefix.length));
  if (type.startsWith(uninitializedPrefix)) return isMutableBinding(type.slice(uninitializedPrefix.length));
  if (type.startsWith(maybeUninitializedPrefix)) return isMutableBinding(type.slice(maybeUninitializedPrefix.length));
  if (type.startsWith(borrowedPrefix)) return isMutableBinding(type.slice(borrowedPrefix.length));
  return type.startsWith(mutablePrefix);
}

function isBorrowedBinding(type: ValueType): boolean {
  if (type.startsWith(callTargetPrefix)) return isBorrowedBinding(stripCallTarget(type));
  if (type.startsWith(movedPrefix)) return isBorrowedBinding(type.slice(movedPrefix.length));
  if (type.startsWith(maybeMovedPrefix)) return isBorrowedBinding(type.slice(maybeMovedPrefix.length));
  if (type.startsWith(uninitializedPrefix)) return isBorrowedBinding(type.slice(uninitializedPrefix.length));
  if (type.startsWith(maybeUninitializedPrefix)) return isBorrowedBinding(type.slice(maybeUninitializedPrefix.length));
  if (type.startsWith(mutablePrefix)) return isBorrowedBinding(type.slice(mutablePrefix.length));
  return type.startsWith(borrowedPrefix);
}

function callTargetBinding(type: ValueType, target: string): ValueType {
  return `${callTargetPrefix}${target}:${type}`;
}

function callTarget(type: ValueType | undefined): string | null {
  if (!type?.startsWith(callTargetPrefix)) return null;
  const separator = type.indexOf(":", callTargetPrefix.length);
  return separator === -1 ? null : type.slice(callTargetPrefix.length, separator);
}

function stripCallTarget(type: ValueType): ValueType {
  const separator = type.indexOf(":", callTargetPrefix.length);
  return separator === -1 ? type : type.slice(separator + 1);
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
    const objectTypes = values.map((value) => foreignObject(value, state));
    const firstObject = objectTypes[0];
    if (firstObject?.className && objectTypes.every((object) => object?.className === firstObject.className)) {
      const nullable = objectTypes.some((object) => object!.nullable);
      const publicType = firstObject.typeName.replace(/^__z_objc:(?:nullable|nonnull):/, "");
      type = nullable ? `__z_objc:nullable:${publicType}` : publicType;
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
  } else if (condition.kind === "binary" && ["==", "!="].includes(condition.operator)) {
    const identifier = condition.left.kind === "identifier" && condition.right.kind === "null"
      ? condition.left
      : condition.right.kind === "identifier" && condition.left.kind === "null"
        ? condition.right
        : null;
    if (identifier) {
      name = identifier.name;
      nonnull = condition.operator === "!=" ? truthy : !truthy;
    }
  }
  if (!name || !nonnull) return narrowed;
  const current = narrowed.get(name);
  const pointer = current ? foreignPointer(current, state) : null;
  if (pointer?.nullable) {
    narrowed.set(name, replaceUnderlyingType(current!, pointerTypeName(pointer.identity, pointer.ownership, false)));
    return narrowed;
  }
  const object = current ? foreignObject(current, state) : null;
  if (object?.nullable && object.className) {
    const publicType = object.typeName.replace(/^__z_objc:(?:nullable|nonnull):/, "");
    narrowed.set(name, replaceUnderlyingType(current!, publicType));
  }
  return narrowed;
}

function foreignPointer(type: ValueType, state: AnalysisState): ForeignPointerType | null {
  const actual = underlyingType(type);
  if (actual === "unknown" || actual === "never") return null;
  return state.foreignTypes.get(actual) ?? null;
}

function foreignObject(type: ValueType, state: AnalysisState): ForeignObjectType | null {
  const actual = underlyingType(type);
  if (actual === "unknown" || actual === "never") return null;
  return state.foreignObjectTypes.get(String(actual)) ?? null;
}

function nullableForeignReference(type: ValueType, state: AnalysisState): boolean {
  return foreignPointer(type, state)?.nullable === true || foreignObject(type, state)?.nullable === true;
}

function replaceUnderlyingType(type: ValueType, replacement: ValueType): ValueType {
  const stored = `${isBorrowedBinding(type) ? borrowedPrefix : ""}${isMutableBinding(type) ? mutablePrefix : ""}${replacement}`;
  const owned = ownershipState(type) === "moved"
    ? `${movedPrefix}${stored}`
    : ownershipState(type) === "maybeMoved"
      ? `${maybeMovedPrefix}${stored}`
      : stored;
  return initializationState(type) === "uninitialized"
    ? `${uninitializedPrefix}${owned}`
    : initializationState(type) === "maybeUninitialized"
      ? `${maybeUninitializedPrefix}${owned}`
      : owned;
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
    const elementBinding = hasCleanupType(collection.elementType, structs, enums, state.foreignTypes)
      ? `${borrowedPrefix}${collection.elementType}`
      : collection.elementType;
    bodyLocals.set(statement.binding, elementBinding);

    const frame: LoopAnalysisFrame = { breaks: [], continues: [] };
    const previousIterationBorrow = state.iterationBorrowOrigins.get(root.name);
    const previousElementBorrow = state.borrowOrigins.get(statement.binding);
    state.iterationBorrowOrigins.set(root.name, statement.location);
    if (hasCleanupType(collection.elementType, structs, enums, state.foreignTypes)) {
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
  enums: Map<string, EnumDeclaration>,
  foreignTypes: ReadonlyMap<string, ForeignPointerType> = new Map(),
  visiting = new Set<string>(),
): boolean {
  const actual = underlyingType(type);
  if (actual === "unknown" || actual === "never" || visiting.has(actual)) return false;
  if (actual === "String") return true;
  if (parseWeakType(actual)) return true;
  if (parseFunctionType(String(actual))) return true;
  if (foreignTypes.get(actual)?.ownership === "owned") return true;
  const declaration = structs.get(actual);
  const enumDeclaration = enums.get(actual);
  if (parseDynamicArrayType(actual)) return true;
  const array = parseFixedArrayType(actual);
  if (array) return hasCleanupType(array.elementType, structs, enums, foreignTypes, visiting);
  if (!declaration && !enumDeclaration) return false;
  if (declaration?.kind === "class") return true;
  if (declaration?.deinitializer) return true;
  visiting.add(actual);
  const result = declaration
    ? declaration.fields.some((field) => hasCleanupType(field.type.name, structs, enums, foreignTypes, visiting))
    : enumDeclaration!.variants.some((variant) => (
      variant.payload && hasCleanupType(variant.payload.name, structs, enums, foreignTypes, visiting)
    ));
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

function rejectNullableObjCReceiver(
  type: ValueType,
  location: SourceLocation,
  fileName: string,
  state: AnalysisState,
): void {
  const object = foreignObject(type, state);
  if (!object?.nullable || !object.className) return;
  const publicType = object.typeName.replace(/^__z_objc:(?:nullable|nonnull):/, "");
  throw new DiagnosticError(fileName, location, `nullable Objective-C ${publicType} must be checked before member access`, {
    helps: ["compare the reference with `null`; the non-null branch narrows it automatically"],
  });
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
  if (type.kind === "callback" || type.kind === "block") {
    const parameters = type.parameters.map((parameter, index) => ({
      name: `argument${index + 1}`,
      mode: "value" as const,
      type: String(foreignValueType(parameter)),
    }));
    const returnType = foreignValueType(type.returnType);
    if (parameters.some((parameter) => parameter.type === "unknown") || returnType === "unknown") return "unknown";
    return functionTypeName(parameters, String(returnType));
  }
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
    let actual: ValueType;
    if (parameter.type.kind === "block" && argument.kind === "closure") {
      const expectedType = foreignValueType(parameter.type);
      const expectedFunction = parseFunctionType(String(expectedType))!;
      inferClosureExpression(argument, locals, globals, structs, enums, fileName, state, expectedFunction, !parameter.type.escaping);
      finalizeClosureFunctionValue(
        argument,
        expectedFunction,
        String(expectedType),
        locals,
        structs,
        enums,
        fileName,
        state,
        !parameter.type.escaping,
      );
      state.foreignArgumentAccesses.set(argument.location.offset, "in");
      state.objcBlockArguments.set(argument.location.offset, parameter.type);
      actual = expectedType;
    } else {
      actual = contextual ?? inferExpression(argument, locals, globals, structs, enums, fileName, state);
    }
    if (parameter.type.kind === "block" && argument.kind !== "closure") {
      throw new DiagnosticError(
        fileName,
        argument.location,
        "the first Objective-C block interop slice requires an inline closure",
        { helps: ["pass `move (value) => ...` directly at the Objective-C call site"] },
      );
    }
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

function contextualObjCStringToZ(
  expected: ValueType,
  actual: ValueType,
  expression: Expression,
  state: AnalysisState,
): ValueType | null {
  if (underlyingType(expected) !== "String") return null;
  const actualObject = state.foreignObjectTypes.get(String(underlyingType(actual)));
  const stringType = [...state.foreignObjectTypes.values()].find((candidate) => (
    candidate.className === "NSString" && !candidate.nullable
  ));
  if (!actualObject || actualObject.nullable || !stringType || !isObjCSubclass(actualObject, stringType, state)) return null;
  state.objcStringsToZ.add(expression.location.offset);
  return "String";
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
  if (actual === "String") {
    const stringType = [...state.foreignObjectTypes.values()].find((candidate) => (
      candidate.className === "NSString" && !candidate.nullable
    ));
    if (stringType && (!expected.className || isObjCSubclass(stringType, expected, state))) {
      state.objcStringsToNative.add(expression.location.offset);
      return;
    }
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
  const visibleParameters = target.parameters
    .map((parameter, nativeIndex) => ({ parameter, nativeIndex }))
    .filter(({ parameter }) => parameter.type.kind !== "callbackContext" && parameter.type.kind !== "callbackRelease");
  if (
    target.variadic
    && target.parameters.some((parameter) => parameter.type.kind === "callback" && parameter.type.lifetime === "escape")
  ) {
    throw new DiagnosticError(fileName, location, `escaping C callback ${JSON.stringify(target.name)} cannot be variadic`);
  }
  const expected = visibleParameters.length;
  if ((!target.variadic && args.length !== expected) || (target.variadic && args.length < expected)) {
    const expectation = target.variadic ? `at least ${expected}` : String(expected);
    throw new DiagnosticError(fileName, location, `C function ${JSON.stringify(target.name)} expects ${expectation} argument(s), found ${args.length}`);
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const parameter = visibleParameters[index]?.parameter;
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
    let actual: ValueType;
    if (parameter?.type.kind === "callback" && argument.kind === "closure") {
      const expectedCallback = foreignValueType(parameter.type);
      const expectedFunction = parseFunctionType(String(expectedCallback))!;
      inferClosureExpression(argument, locals, globals, structs, enums, fileName, state, expectedFunction, true);
      finalizeClosureFunctionValue(
        argument,
        expectedFunction,
        String(expectedCallback),
        locals,
        structs,
        enums,
        fileName,
        state,
        parameter.type.lifetime === "call" && parameter.type.context !== null,
      );
      state.foreignArgumentAccesses.set(argument.location.offset, "in");
      actual = expectedCallback;
    } else {
      actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
    }
    if (parameter?.type.kind === "callback") {
      const expectedCallback = foreignValueType(parameter.type);
      requireAssignable(
        expectedCallback,
        actual,
        argument,
        fileName,
        state.foreignNamedTypes,
        state.numericLiteralTypes,
      );
      if (!parameter.type.context) {
        const global = argument.kind === "identifier" ? globals.get(argument.name) : null;
        const inlineClosure = argument.kind === "closure"
          ? state.closures.get(argument.location.offset)
          : null;
        const callbackTarget = argument.kind === "identifier"
          ? callTarget(locals.get(argument.name)) ?? (global?.kind === "function" ? argument.name : null)
          : inlineClosure?.captures.length === 0 ? inlineClosure.declaration.name : null;
        if (!callbackTarget) {
          throw new DiagnosticError(
            fileName,
            argument.location,
            "this function value carries or may carry an environment; this C callback has no context parameter",
            {
              code: "Z0213",
              helps: ["pass a named function or a directly bound non-capturing closure, or use a C API with a context-pointer callback"],
            },
          );
        }
        if (inlineClosure) {
          state.closures.set(argument.location.offset, { ...inlineClosure, storable: false });
        }
        state.foreignCallbackTargets.set(argument.location.offset, callbackTarget);
      }
      continue;
    }
    if (parameter?.type.kind === "z") {
      if (parameter.type.name === "cstring" && actual === "String") {
        state.cstringConversions.add(argument.location.offset);
        actual = "cstring";
      } else {
        rejectForeignOwnedMove(argument, actual, structs, enums, fileName, state);
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
        consumeOwnedValue(argument, actual, locals, structs, enums, fileName, state);
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
  const contextualCallbacks = visibleParameters
    .map(({ parameter, nativeIndex }, source) => ({ parameter, nativeIndex, source }))
    .filter((entry): entry is typeof entry & { readonly parameter: { readonly type: ForeignCallbackType } } => (
      entry.parameter.type.kind === "callback" && entry.parameter.type.context !== null
    ));
  if (contextualCallbacks.length > 0) {
    const callbacksByNativeIndex = new Map(contextualCallbacks.map((entry) => [entry.nativeIndex, entry]));
    const visibleByNativeIndex = new Map(visibleParameters.map((entry, source) => [entry.nativeIndex, source]));
    const plan: ForeignCallArgumentPlan[] = target.parameters.map((parameter, nativeIndex) => {
      if (parameter.type.kind === "callbackContext") {
        const callback = callbacksByNativeIndex.get(parameter.type.callbackParameter)!;
        return {
          kind: "context",
          source: callback.source,
          callback: callback.parameter.type,
          functionType: String(foreignValueType(callback.parameter.type)),
        };
      }
      if (parameter.type.kind === "callbackRelease") {
        const callback = callbacksByNativeIndex.get(parameter.type.callbackParameter)!;
        return {
          kind: "release",
          source: callback.source,
          callback: callback.parameter.type,
          functionType: String(foreignValueType(callback.parameter.type)),
        };
      }
      const source = visibleByNativeIndex.get(nativeIndex)!;
      if (parameter.type.kind === "callback" && parameter.type.context) {
        return {
          kind: "callback",
          source,
          callback: parameter.type,
          functionType: String(foreignValueType(parameter.type)),
        };
      }
      return { kind: "argument", source };
    });
    for (let source = expected; source < args.length; source += 1) plan.push({ kind: "argument", source });
    state.foreignCallArgumentPlans.set(location.offset, plan);
  }
  const result = target.returnType.kind === "z"
    ? target.returnType.name
    : target.returnType.kind === "named"
      ? target.returnType.type.typeName
    : target.returnType.kind === "pointer"
      ? target.returnType.typeName
    : target.returnType.kind === "callback" || target.returnType.kind === "block"
      ? foreignValueType(target.returnType)
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
  if (pointer) return describePointer(pointer);
  const name = String(underlyingType(type));
  return displayFunctionType(name, displayArrayType) ?? displayArrayType(name);
}

function validateType(
  type: TypeReference,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
  allowVoid: boolean,
): void {
  const functionType = parseFunctionType(type.name);
  if (functionType) {
    for (const parameter of functionType.parameters) {
      if (parseFunctionType(parameter.type)) {
        throw new DiagnosticError(fileName, type.location, "nested function types are deferred beyond the first function-value tier");
      }
      validateType({ name: parameter.type, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    }
    if (parseFunctionType(functionType.returnType)) {
      throw new DiagnosticError(fileName, type.location, "returning another function type is deferred beyond the first function-value tier");
    }
    validateType({ name: functionType.returnType, location: type.location }, structs, enums, foreignNamedTypes, fileName, true);
    return;
  }
  const weak = parseWeakType(type.name);
  if (weak) {
    const target = structs.get(weak.target);
    if (target?.kind !== "class") {
      throw new DiagnosticError(fileName, type.location, `Weak requires a class type, found ${JSON.stringify(weak.target)}`);
    }
    return;
  }
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
  const expectedFunction = expectedType === "unknown" || expectedType === "never"
    ? null
    : parseFunctionType(String(expectedType));
  const actualFunction = actual === "unknown" || actual === "never"
    ? null
    : parseFunctionType(String(underlyingType(actual)));
  if (expectedFunction || actualFunction) {
    if (expectedFunction && actualFunction && functionTypesCompatible(expectedFunction, actualFunction)) return;
    throw new DiagnosticError(
      fileName,
      expression.location,
      `expected ${displayFunctionType(String(expectedType)) ?? displayArrayType(String(expectedType))}, found ${displayFunctionType(String(underlyingType(actual))) ?? displayArrayType(String(actual))}`,
    );
  }
  if (isNumericType(expectedType) && requireContextualSignedLiteral(expression, expectedType, fileName, numericLiteralTypes)) {
    return;
  }
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

function requireContextualSignedLiteral(
  expression: Expression,
  type: string,
  fileName: string,
  numericLiteralTypes: Map<number, string>,
): boolean {
  if (
    expression.kind !== "unary"
    || !["+", "-"].includes(expression.operator)
    || expression.operand.kind !== "number"
  ) return false;
  const spelling = `${expression.operator}${expression.operand.value}`;
  if (isIntegerType(type)) {
    if (!isIntegerLiteral(expression.operand.value)) {
      throw new DiagnosticError(fileName, expression.location, `floating-point literal ${spelling} cannot initialize ${type}`);
    }
    if (!integerLiteralFits(spelling, type)) {
      throw new DiagnosticError(fileName, expression.location, `integer literal ${spelling} does not fit ${type}`);
    }
  } else if (isFloatType(type)) {
    const value = Number(spelling);
    const maximum = type === "f32" ? 3.4028234663852886e38 : Number.MAX_VALUE;
    if (!Number.isFinite(value) || Math.abs(value) > maximum) {
      throw new DiagnosticError(fileName, expression.location, `floating-point literal ${spelling} does not fit ${type}`);
    }
  } else {
    return false;
  }
  numericLiteralTypes.set(expression.location.offset, type);
  numericLiteralTypes.set(expression.operand.location.offset, type);
  return true;
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

function integerMethodKind(name: string): IntegerOperation["kind"] | null {
  const methods: Readonly<Record<string, IntegerOperation["kind"]>> = {
    wrappingAdd: "wrappingAdd",
    wrappingSubtract: "wrappingSubtract",
    wrappingMultiply: "wrappingMultiply",
    saturatingAdd: "saturatingAdd",
    saturatingSubtract: "saturatingSubtract",
    saturatingMultiply: "saturatingMultiply",
  };
  return methods[name] ?? null;
}

function integerBounds(type: string): { readonly minimum: bigint; readonly maximum: bigint; readonly width: number } | null {
  const widths: Readonly<Record<string, number>> = {
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
  const width = widths[type];
  if (!width) return null;
  const unsigned = type.startsWith("u");
  return {
    minimum: unsigned ? 0n : -(1n << BigInt(width - 1)),
    maximum: unsigned ? (1n << BigInt(width)) - 1n : (1n << BigInt(width - 1)) - 1n,
    width,
  };
}

function constantIntegerValue(expression: Expression): bigint | null {
  if (expression.kind === "number") return isIntegerLiteral(expression.value) ? BigInt(expression.value) : null;
  if (expression.kind === "unary") {
    const operand = constantIntegerValue(expression.operand);
    if (operand === null) return null;
    if (expression.operator === "+") return operand;
    if (expression.operator === "-") return -operand;
    if (expression.operator === "~") return ~operand;
    return null;
  }
  if (expression.kind !== "binary") return null;
  const left = constantIntegerValue(expression.left);
  const right = constantIntegerValue(expression.right);
  if (left === null || right === null) return null;
  if (expression.operator === "+") return left + right;
  if (expression.operator === "-") return left - right;
  if (expression.operator === "*") return left * right;
  if (expression.operator === "/") return right === 0n ? null : left / right;
  if (expression.operator === "%") return right === 0n ? null : left % right;
  if (expression.operator === "&") return left & right;
  if (expression.operator === "|") return left | right;
  if (expression.operator === "^") return left ^ right;
  if ((expression.operator === "<<" || expression.operator === ">>") && right >= 0n && right < 1024n) {
    return expression.operator === "<<" ? left << right : left >> right;
  }
  return null;
}

function validateConstantIntegerOperation(expression: Expression, type: string, fileName: string): void {
  const bounds = integerBounds(type);
  if (!bounds) return;
  if (expression.kind === "unary") {
    const value = constantIntegerValue(expression);
    if (value !== null && (value < bounds.minimum || value > bounds.maximum)) {
      throw integerOverflowError(fileName, expression, type);
    }
    return;
  }
  if (expression.kind !== "binary") return;
  const left = constantIntegerValue(expression.left);
  const right = constantIntegerValue(expression.right);
  if (left === null || right === null) return;
  if ((expression.operator === "/" || expression.operator === "%") && right === 0n) {
    const operation = expression.operator === "/" ? "division" : "remainder";
    throw new DiagnosticError(fileName, expression.location, `integer ${operation} by zero`, {
      code: "Z0102",
      length: expression.operator.length,
      notes: [`integer ${operation} by zero traps at runtime when the divisor is not known during compilation`],
      helps: ["ensure the divisor is nonzero before dividing"],
    });
  }
  if (expression.operator === "%" && left === bounds.minimum && right === -1n) {
    throw integerOverflowError(fileName, expression, type);
  }
  if (expression.operator === "<<" || expression.operator === ">>") {
    if (right < 0n || right >= BigInt(bounds.width)) {
      throw new DiagnosticError(fileName, expression.location, `shift count ${right} is outside the range for ${type}`, {
        code: "Z0103",
        length: expression.operator.length,
        notes: [`${type} shift counts must be between 0 and ${bounds.width - 1}`],
        helps: ["use a shift count within the integer width"],
      });
    }
  }
  const value = constantIntegerValue(expression);
  if (value !== null && (value < bounds.minimum || value > bounds.maximum)) {
    throw integerOverflowError(fileName, expression, type);
  }
}

function integerOverflowError(fileName: string, expression: Expression, type: string): DiagnosticError {
  return new DiagnosticError(fileName, expression.location, `constant integer expression overflows ${type}`, {
    code: "Z0101",
    length: expression.kind === "binary" || expression.kind === "unary" ? expression.operator.length : 1,
    notes: ["ordinary integer arithmetic is checked in every build mode"],
    helps: ["use wrappingAdd, wrappingSubtract, wrappingMultiply, or a saturating counterpart when overflow is intentional"],
  });
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
  const bounds = integerBounds(type);
  if (!bounds) return false;
  const literal = BigInt(value);
  return literal >= bounds.minimum && literal <= bounds.maximum;
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
