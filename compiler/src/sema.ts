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
import { DiagnosticError, type DiagnosticLabel } from "./diagnostics.ts";
import {
  compareTargetVersions,
  displayTargetPlatform,
  normalizeTargetPlatform,
  type DeploymentTarget,
} from "./project.ts";
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
  parsePointerTypeName,
  type ForeignCallbackType,
  type ForeignBlockType,
  type ForeignConstant,
  type ForeignCxxMethodOverload,
  type ForeignDeclarationMetadata,
  type ForeignFunction,
  type ForeignFunctionOverload,
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
  standardModuleFunction,
  standardModuleMemberNames,
  type StandardFunctionName,
  type StandardModuleName,
} from "./standard-library.ts";
import {
  parseWeakType,
  weakResultTypeName,
  weakTypeName,
} from "./weak-types.ts";
import {
  isNullableObjCTypeName,
  nullableObjCTypeName,
  publicObjCTypeName,
} from "./objc-types.ts";
import { parseOptionType } from "./option-types.ts";
import { parseOptionalViewType, parseReceiverViewReturnType, parseViewType, viewTypeName } from "./view-types.ts";

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

export type SemanticFunctionCallResolution = {
  readonly location: SourceLocation;
  readonly declaration: FunctionDeclaration;
};

export type SemanticMethodCallResolution = {
  readonly location: SourceLocation;
  readonly aggregate: StructDeclaration;
  readonly declaration: FunctionDeclaration;
};

export type SemanticConstructorCallResolution = {
  readonly location: SourceLocation;
  readonly aggregate: StructDeclaration;
  readonly declaration: FunctionDeclaration;
};

export type SemanticAggregateConstructionResolution = {
  readonly location: SourceLocation;
  readonly declaration: StructDeclaration;
};

export type SemanticFieldResolution = {
  readonly location: SourceLocation;
  readonly aggregate: StructDeclaration;
  readonly field: StructDeclaration["fields"][number];
};

export type SemanticEnumVariantResolution = {
  readonly location: SourceLocation;
  readonly enumeration: EnumDeclaration;
  readonly variant: EnumDeclaration["variants"][number];
};

export type SemanticTypeResolution = {
  readonly location: SourceLocation;
  readonly declaration: StructDeclaration | EnumDeclaration;
};

export type SemanticObserver = {
  readonly resolveFunctionCall?: (resolution: SemanticFunctionCallResolution) => FunctionDeclaration | null;
  readonly resolveMethodCall?: (resolution: SemanticMethodCallResolution) => FunctionDeclaration | null;
  readonly resolveConstructorCall?: (resolution: SemanticConstructorCallResolution) => FunctionDeclaration | null;
  readonly onFunctionCall?: (resolution: SemanticFunctionCallResolution) => void;
  readonly onMethodCall?: (resolution: SemanticMethodCallResolution) => void;
  readonly onConstructorCall?: (resolution: SemanticConstructorCallResolution) => void;
  readonly onAggregateConstruction?: (resolution: SemanticAggregateConstructionResolution) => void;
  readonly onFieldResolution?: (resolution: SemanticFieldResolution) => void;
  readonly onEnumVariantResolution?: (resolution: SemanticEnumVariantResolution) => void;
  readonly onTypeResolution?: (resolution: SemanticTypeResolution) => void;
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
  readonly warnings: readonly DiagnosticError[];
  readonly deploymentTarget: DeploymentTarget | null;
  readonly viewReturnExpressions: ReadonlySet<number>;
  readonly viewBindingOwners: ReadonlyMap<number, string>;
  readonly movedExpressions: ReadonlySet<number>;
  readonly managedCopies: ReadonlySet<number>;
  readonly sliceConversions: ReadonlyMap<number, { readonly sourceType: string; readonly targetType: string }>;
  readonly foreignTypes: ReadonlyMap<string, ForeignPointerType>;
  readonly foreignCallTypes: ReadonlyMap<number, string>;
  readonly foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly foreignExpressionTypes: ReadonlyMap<number, string>;
  readonly numericLiteralTypes: ReadonlyMap<number, string>;
  readonly integerOperations: ReadonlyMap<number, IntegerOperation>;
  readonly dynamicArrayPushTypes: ReadonlySet<string>;
  readonly arenaCreateCalls: ReadonlyMap<number, string>;
  readonly arenaResetCalls: ReadonlySet<number>;
  readonly threadSpawnCalls: ReadonlyMap<number, number>;
  readonly shareableClasses: ReadonlySet<string>;
  readonly foreignArgumentAccesses: ReadonlyMap<number, "in" | "out" | "inout">;
  readonly foreignCxxArgumentAccesses: ReadonlyMap<number, "in" | "inout" | "move">;
  readonly foreignCallbackTargets: ReadonlyMap<number, string>;
  readonly foreignCallArgumentPlans: ReadonlyMap<number, readonly ForeignCallArgumentPlan[]>;
  readonly foreignFunctionNames: ReadonlyMap<number, string>;
  readonly foreignFunctionDefinitions: ReadonlyMap<number, ForeignDeclarationMetadata>;
  readonly foreignCxxMethodCalls: ReadonlyMap<number, { readonly name: string; readonly receiverAccess: "in" | "inout" | "move" }>;
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
  readonly swiftStringsToZ: ReadonlySet<number>;
  readonly cstringConversions: ReadonlySet<number>;
  readonly optionFromNullable: ReadonlySet<number>;
  readonly expressionTypes: ReadonlyMap<number, string>;
  readonly bindingTypes: ReadonlyMap<number, string>;
  readonly borrowedMatches: ReadonlySet<number>;
  readonly constructorFieldInitializations: ReadonlySet<number>;
  readonly closures: ReadonlyMap<number, ClosureInfo>;
  readonly consoleCalls: ReadonlySet<number>;
  readonly consoleBindings: ReadonlySet<string>;
  readonly standardFunctionReferences: ReadonlyMap<number, StandardFunctionName>;
  readonly standardFunctionBindings: ReadonlyMap<string, StandardFunctionName>;
  readonly standardModuleBindings: ReadonlyMap<string, StandardModuleName>;
  readonly standardTypeBindings: ReadonlyMap<string, "TextBuffer" | "Arena">;
  readonly typeDisplayNames: ReadonlyMap<string, string>;
  readonly objectiveC: boolean;
  readonly cPlusPlus: boolean;
  readonly frameworks: readonly string[];
};

type AnalysisState = {
  readonly warnings: DiagnosticError[];
  readonly warningKeys: Set<string>;
  readonly deploymentTarget: DeploymentTarget | null;
  readonly viewReturnExpressions: Set<number>;
  readonly viewBindingOwners: Map<number, string>;
  readonly viewCallOrigins: Map<number, { readonly owner: string; readonly location: SourceLocation }>;
  readonly viewOrigins: Map<string, { readonly owner: string; readonly location: SourceLocation }>;
  readonly movedExpressions: Set<number>;
  readonly managedCopies: Set<number>;
  readonly sliceConversions: Map<number, { readonly sourceType: string; readonly targetType: string }>;
  readonly foreignTypes: ReadonlyMap<string, ForeignPointerType>;
  readonly foreignCallTypes: Map<number, string>;
  readonly foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly foreignExpressionTypes: Map<number, string>;
  readonly numericLiteralTypes: Map<number, string>;
  readonly integerOperations: Map<number, IntegerOperation>;
  readonly dynamicArrayPushTypes: Set<string>;
  readonly arenaCreateCalls: Map<number, string>;
  readonly arenaResetCalls: Set<number>;
  readonly threadSpawnCalls: Map<number, number>;
  readonly shareableClasses: Set<string>;
  readonly threadSharedClassUses: Map<string, SourceLocation>;
  readonly weakClassUses: Map<string, SourceLocation>;
  readonly foreignArgumentAccesses: Map<number, "in" | "out" | "inout">;
  readonly foreignCxxArgumentAccesses: Map<number, "in" | "inout" | "move">;
  readonly foreignCallbackTargets: Map<number, string>;
  readonly foreignCallArgumentPlans: Map<number, readonly ForeignCallArgumentPlan[]>;
  readonly foreignFunctionNames: Map<number, string>;
  readonly foreignFunctionDefinitions: Map<number, ForeignDeclarationMetadata>;
  readonly foreignCxxMethodCalls: Map<number, { readonly name: string; readonly receiverAccess: "in" | "inout" | "move" }>;
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
  readonly swiftStringsToZ: Set<number>;
  readonly cstringConversions: Set<number>;
  readonly optionFromNullable: Set<number>;
  readonly expressionTypes: Map<number, string>;
  readonly bindingTypes: Map<number, string>;
  readonly borrowedMatches: Set<number>;
  readonly constructorFieldInitializations: Set<number>;
  readonly closures: Map<number, ClosureInfo>;
  readonly consoleCalls: Set<number>;
  readonly consoleBindings: Set<string>;
  readonly standardFunctionReferences: Map<number, StandardFunctionName>;
  readonly standardFunctionBindings: Map<string, StandardFunctionName>;
  readonly standardModuleBindings: Map<string, StandardModuleName>;
  readonly standardTypeBindings: Map<string, "TextBuffer" | "Arena">;
  readonly inferredOutBindingLocations: Map<string, SourceLocation>;
  readonly typeDisplayNames: ReadonlyMap<string, string>;
  readonly objectiveC: boolean;
  readonly cPlusPlus: boolean;
  readonly frameworks: readonly string[];
  readonly loopStack: LoopAnalysisFrame[];
  readonly moveOrigins: Map<string, SourceLocation>;
  readonly borrowOrigins: Map<string, { readonly location: SourceLocation; readonly kind: "closure" | "iteration" | "match" }>;
  readonly iterationBorrowOrigins: Map<string, SourceLocation>;
  readonly activeLoans: AccessLoanSet;
  readonly asyncSpawnBorrowRoots: Map<number, readonly string[]>;
  readonly asyncTaskBorrowSpawns: Map<string, number>;
  readonly asyncCallContexts: {
    readonly mode: "await" | "spawn";
    readonly spawnOffset: number | null;
    calls: number;
    cancellationCalls: number;
  }[];
  readonly placementErrorTypes: (TypeReference | null)[];
  readonly observer: SemanticObserver | null;
  executorContext: "main" | null;
  nativeThreadBodyDepth: number;
  asyncScopeDepth: number;
  asyncLoopDepth: number;
  activeFunction: FunctionDeclaration | null;
  activeReceiver: string | null;
};

type AccessCapability = "value" | "in" | "inout" | "out" | "move";

type AccessLoan = {
  readonly root: string;
  readonly capability: AccessCapability;
  readonly lifetime:
    | { readonly kind: "call" }
    | { readonly kind: "view"; readonly binding: string }
    | { readonly kind: "task"; readonly spawnOffset: number };
  readonly location: SourceLocation;
};

type AccessLoanSet = Map<string, readonly AccessLoan[]>;

type AccessLoanState = {
  readonly activeLoans: AccessLoanSet;
  readonly taskBorrowSpawns: Map<string, number>;
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
  | { readonly kind: "foreignNamespace"; readonly module: ForeignModule; readonly namespacePath: readonly string[] }
  | { readonly kind: "console" }
  | { readonly kind: "standardModule"; readonly module: StandardModuleName }
  | { readonly kind: "standardFunction"; readonly name: StandardFunctionName; readonly declaration: FunctionDeclaration }
  | { readonly kind: "standardType"; readonly type: "TextBuffer" | "Arena" }
  | { readonly kind: "struct"; readonly declaration: StructDeclaration }
  | { readonly kind: "trait"; readonly declaration: TraitDeclaration }
  | { readonly kind: "enum"; readonly declaration: EnumDeclaration };

const integerTypes = new Set(["i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "isize", "usize"]);
const floatTypes = new Set(["f32", "f64"]);
const primitiveTypes = new Set([...integerTypes, ...floatTypes, "void", "boolean", "cstring", "String", "TextBuffer", "Arena"]);
const movedPrefix = "__z_moved:";
const maybeMovedPrefix = "__z_maybe_moved:";
const uninitializedPrefix = "__z_uninitialized:";
const maybeUninitializedPrefix = "__z_maybe_uninitialized:";
const mutablePrefix = "__z_mutable:";
const borrowedPrefix = "__z_borrowed:";
const callTargetPrefix = "__z_calltarget:";
const swiftStringTypeName = "__z_swift:String";

export function analyze(
  program: Program,
  fileName: string,
  foreignModules: ReadonlyMap<string, ForeignModule>,
  typeDisplayNames: ReadonlyMap<string, string> = new Map(),
  requireMain = true,
  deploymentTarget: DeploymentTarget | null = null,
  observer: SemanticObserver | null = null,
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
    for (const [alias, qualifiedName] of module.namedTypeAliases) {
      const type = module.namedTypes.get(qualifiedName);
      if (type) foreignNamedTypes.set(`${module.declaration.moduleName}.${alias}`, type);
    }
    for (const [name, type] of module.objectTypes) foreignObjectTypes.set(name, type);
    for (const type of module.interfaces.values()) {
      foreignInterfaces.set(type.typeName, type);
      const named: ForeignNamedType = {
        kind: "object",
        exportName: type.exportName,
        namespacePath: [],
        qualifiedName: type.exportName,
        typeName: type.typeName,
        cName: `${type.className} *`,
        className: type.className,
        metadata: type.metadata,
      };
      foreignNamedTypes.set(type.typeName, named);
      foreignObjectTypes.set(type.typeName, {
        kind: "object",
        typeName: type.typeName,
        cName: named.cName,
        className: type.className,
        nullable: false,
      });
      const nullableName = nullableObjCTypeName(type.typeName);
      foreignNamedTypes.set(nullableName, { ...named, typeName: nullableName });
      foreignObjectTypes.set(nullableName, {
        kind: "object",
        typeName: nullableName,
        cName: named.cName,
        className: type.className,
        nullable: true,
      });
    }
    if (module.framework) frameworks.add(module.framework);
    if (module.objectiveC) objectiveC = true;
    if (module.cPlusPlus) cPlusPlus = true;
  }
  const state: AnalysisState = {
    warnings: [],
    warningKeys: new Set(),
    deploymentTarget,
    viewReturnExpressions: new Set(),
    viewBindingOwners: new Map(),
    viewCallOrigins: new Map(),
    viewOrigins: new Map(),
    movedExpressions: new Set(),
    managedCopies: new Set(),
    sliceConversions: new Map(),
    foreignTypes,
    foreignCallTypes: new Map(),
    foreignNamedTypes,
    foreignExpressionTypes: new Map(),
    numericLiteralTypes: new Map(),
    integerOperations: new Map(),
    dynamicArrayPushTypes: new Set(),
    arenaCreateCalls: new Map(),
    arenaResetCalls: new Set(),
    threadSpawnCalls: new Map(),
    shareableClasses: new Set(),
    threadSharedClassUses: new Map(),
    weakClassUses: new Map(),
    foreignArgumentAccesses: new Map(),
    foreignCxxArgumentAccesses: new Map(),
    foreignCallbackTargets: new Map(),
    foreignCallArgumentPlans: new Map(),
    foreignFunctionNames: new Map(),
    foreignFunctionDefinitions: new Map(),
    foreignCxxMethodCalls: new Map(),
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
    swiftStringsToZ: new Set(),
    cstringConversions: new Set(),
    optionFromNullable: new Set(),
    expressionTypes: new Map(),
    bindingTypes: new Map(),
    borrowedMatches: new Set(),
    constructorFieldInitializations: new Set(),
    closures: new Map(),
    consoleCalls: new Set(),
    consoleBindings: new Set(),
    standardFunctionReferences: new Map(),
    standardFunctionBindings: new Map(),
    standardModuleBindings: new Map(),
    standardTypeBindings: new Map(),
    inferredOutBindingLocations: new Map(),
    typeDisplayNames,
    objectiveC,
    cPlusPlus,
    frameworks: [...frameworks],
    loopStack: [],
    moveOrigins: new Map(),
    borrowOrigins: new Map(),
    iterationBorrowOrigins: new Map(),
    activeLoans: new Map(),
    asyncSpawnBorrowRoots: new Map(),
    asyncTaskBorrowSpawns: new Map(),
    asyncCallContexts: [],
    placementErrorTypes: [],
    observer,
    executorContext: null,
    nativeThreadBodyDepth: 0,
    asyncScopeDepth: 0,
    asyncLoopDepth: 0,
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
      if (declaration.header === "std/text") {
        if (!declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, "std/text requires a selective import", {
            code: "Z0501",
            helps: ["use `import { TextBuffer } from \"std/text\";`"],
          });
        }
        for (const binding of declaration.bindings) {
          if (binding.importedName !== "TextBuffer") {
            throw new DiagnosticError(fileName, binding.location, `std/text has no export ${JSON.stringify(binding.importedName)}`, {
              code: "Z0501",
              helps: ["the bootstrap std/text module currently exports `TextBuffer`"],
            });
          }
          validateUserName(binding.localName, binding.location, fileName);
          declareGlobal(globals, binding.localName, { kind: "standardType", type: "TextBuffer" }, binding.location, fileName);
          state.standardTypeBindings.set(binding.localName, "TextBuffer");
        }
        continue;
      }
      if (declaration.header === "std/memory") {
        if (!declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, "std/memory requires a selective import", {
            code: "Z0501",
            helps: ["use `import { Arena } from \"std/memory\";`"],
          });
        }
        for (const binding of declaration.bindings) {
          if (binding.importedName !== "Arena") {
            throw new DiagnosticError(fileName, binding.location, `std/memory has no export ${JSON.stringify(binding.importedName)}`, {
              code: "Z0501",
              helps: ["the bootstrap std/memory module currently exports `Arena`"],
            });
          }
          validateUserName(binding.localName, binding.location, fileName);
          declareGlobal(globals, binding.localName, { kind: "standardType", type: "Arena" }, binding.location, fileName);
          state.standardTypeBindings.set(binding.localName, "Arena");
        }
        continue;
      }
      if (declaration.header === "std/thread") {
        if (!declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, "std/thread requires a selective import", {
            code: "Z0501",
            helps: ["use `import { thread } from \"std/thread\";`"],
          });
        }
        for (const binding of declaration.bindings) {
          if (binding.importedName !== "thread") {
            throw new DiagnosticError(fileName, binding.location, `std/thread has no export ${JSON.stringify(binding.importedName)}`, {
              code: "Z0501",
              helps: ["the first std/thread tier exports `thread`; pools remain a later explicit type"],
            });
          }
          validateUserName(binding.localName, binding.location, fileName);
          declareGlobal(globals, binding.localName, { kind: "standardModule", module: "thread" }, binding.location, fileName);
          state.standardModuleBindings.set(binding.localName, "thread");
        }
        continue;
      }
      if (declaration.header === "std/fs" || declaration.header === "std/process") {
        const module: StandardModuleName = declaration.header === "std/fs" ? "fs" : "process";
        if (declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, `${declaration.header} is a default module import`, {
            code: "Z0501",
            helps: [`use \`import ${module} from ${JSON.stringify(declaration.header)};\``],
          });
        }
        validateUserName(declaration.moduleName, declaration.location, fileName);
        declareGlobal(globals, declaration.moduleName, { kind: "standardModule", module }, declaration.location, fileName);
        state.standardModuleBindings.set(declaration.moduleName, module);
        continue;
      }
      throw new DiagnosticError(fileName, declaration.location, `unknown standard module ${JSON.stringify(declaration.header)}`, {
        code: "Z0501",
        helps: ["the bootstrap standard library currently provides `std`, `std/console`, `std/time`, `std/text`, `std/memory`, `std/thread`, `std/fs`, and `std/process`"],
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
      if (module.namespaces.has(binding.importedName)) {
        const namespacePath = binding.importedName.split(".");
        declareGlobal(
          globals,
          binding.localName,
          { kind: "foreignNamespace", module, namespacePath },
          binding.location,
          fileName,
        );
        for (const foreignType of module.namedTypes.values()) {
          if (foreignType.namespacePath.slice(0, namespacePath.length).join(".") !== binding.importedName) continue;
          const suffix = [...foreignType.namespacePath.slice(namespacePath.length), foreignType.exportName];
          foreignNamedTypes.set([binding.localName, ...suffix].join("."), foreignType);
        }
        continue;
      }
      const foreignFunction = resolveForeignFunction(module, [binding.importedName]);
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
      const foreignType = resolveForeignNamedType(module, [binding.importedName]);
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
    analyzeStructDeclaration(declaration, structs, enums, foreignNamedTypes, foreignTypes, fileName);
  }
  for (const declaration of program.traits) {
    analyzeTraitDeclaration(declaration, structs, enums, foreignNamedTypes, foreignTypes, fileName);
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
    validateFunctionSignature(declaration, structs, enums, foreignNamedTypes, foreignTypes, fileName);
    if (parseReceiverViewReturnType(declaration.returnType.name)) {
      throw new DiagnosticError(fileName, declaration.returnType.location, "view returns require a borrowed instance method receiver", {
        code: "Z0206",
        helps: ["declare the projection as a synchronous instance method on the owner type"],
      });
    }
  }

  validateValueLayouts(program.structs, program.enums, structs, enums, fileName);

  for (const declaration of program.structs) {
    if (declaration.kind === "class" && !shareableTypeIssue(declaration.name, structs, enums, state)) {
      state.shareableClasses.add(declaration.name);
    }
  }

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
  for (const [type, location] of state.threadSharedClassUses) {
    const weakUse = state.weakClassUses.get(type);
    if (!weakUse) continue;
    throw new DiagnosticError(fileName, location, `class ${JSON.stringify(type)} cannot cross a native thread boundary while Weak<${type}> is used`, {
      code: "Z0704",
      labels: [{ location: weakUse, message: "weak reference is created here", length: 4 }],
      notes: ["the first atomic ARC tier covers strong references; concurrent weak upgrade needs a shared side-table protocol"],
      helps: ["keep the class thread-local, remove the weak reference, or pass an owned immutable value snapshot"],
    });
  }
  return state;
}

function analyzeStructDeclaration(
  declaration: StructDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  foreignTypes: ReadonlyMap<string, ForeignPointerType>,
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
    if (declaration.kind === "class" && field.type.name === "Arena") {
      throw new DiagnosticError(fileName, field.type.location, "ARC class fields cannot own an Arena in the first region tier", {
        code: "Z0206",
        notes: ["class aliases would make exclusive reset and view invalidation ambiguous"],
        helps: ["store the Arena in a value struct or a local let binding"],
      });
    }
    if (declaration.kind === "class" && hasMoveOnlyForeignType(field.type.name, structs, enums, foreignNamedTypes)) {
      throw new DiagnosticError(fileName, field.type.location, "ARC class fields cannot store move-only native values in the first C++ ownership tier", {
        code: "Z0240",
        notes: ["ARC class storage is currently allocated as zeroed memory, which does not run a C++ value constructor"],
        helps: ["store the native value in a Z struct and move that struct synchronously, or use an owned native pointer contract"],
      });
    }
    if (containsViewType(field.type.name)) {
      throw new DiagnosticError(fileName, field.type.location, "view values cannot be stored in fields", { code: "Z0206" });
    }
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
    validateFunctionSignature(method, structs, enums, foreignNamedTypes, foreignTypes, fileName);
    const view = parseReceiverViewReturnType(method.returnType.name);
    if (view) {
      if (declaration.kind !== "struct") {
        throw new DiagnosticError(fileName, method.returnType.location, "the zero-overhead view tier requires a value-struct owner", {
          code: "Z0206",
          notes: ["ARC class aliases could otherwise mutate or reallocate projected storage through another reference"],
          helps: ["move the projected storage into a value struct, or return an owned snapshot from the class"],
        });
      }
      if (method.static || method.async || method.receiverMode === "inout" || method.receiverMode === "move" || method.errorType) {
        throw new DiagnosticError(fileName, method.returnType.location, "a view return requires a synchronous, non-throwing borrowed instance method", {
          code: "Z0206",
          notes: ["the first view tier ties the result directly to an immutable `this` receiver"],
        });
      }
      if (structs.get(view.target)?.kind !== "struct") {
        throw new DiagnosticError(fileName, method.returnType.location, "the first view tier requires a concrete Z struct target", { code: "Z0206" });
      }
    }
  }
  if (declaration.constructor) {
    validateFunctionSignature(constructorFunction(declaration), structs, enums, foreignNamedTypes, foreignTypes, fileName);
  }
}

function analyzeTraitDeclaration(
  declaration: TraitDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  foreignTypes: ReadonlyMap<string, ForeignPointerType>,
  fileName: string,
): void {
  const methods = new Set<string>();
  for (const method of declaration.methods) {
    validateUserName(method.name, method.location, fileName);
    if (methods.has(method.name)) {
      throw new DiagnosticError(fileName, method.location, `duplicate method ${JSON.stringify(method.name)} in trait ${JSON.stringify(declaration.name)}`);
    }
    methods.add(method.name);
    validateFunctionSignature(method, structs, enums, foreignNamedTypes, foreignTypes, fileName);
    if (containsViewType(method.returnType.name)) {
      throw new DiagnosticError(fileName, method.returnType.location, "trait requirements cannot expose receiver-tied views in the first view tier", { code: "Z0206" });
    }
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
      const optionalViewPayload = Boolean(parseOptionType(declaration.name) && parseViewType(variant.payload.name));
      if (containsViewType(variant.payload.name) && !optionalViewPayload) {
        throw new DiagnosticError(fileName, variant.payload.location, "view values cannot be stored in enum payloads", { code: "Z0206" });
      }
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
  foreignTypes: ReadonlyMap<string, ForeignPointerType>,
  fileName: string,
): void {
  validateType(declaration.returnType, structs, enums, foreignNamedTypes, fileName, true);
  const directNativeReturn = foreignNamedTypes.get(declaration.returnType.name);
  const aggregateNativeReturn = structs.get(declaration.returnType.name)?.kind === "struct"
    || enums.has(declaration.returnType.name);
  if (
    declaration.async
    && hasMoveOnlyForeignType(declaration.returnType.name, structs, enums, foreignNamedTypes)
    && directNativeReturn?.kind !== "value"
    && !aggregateNativeReturn
  ) {
    throw new DiagnosticError(fileName, declaration.returnType.location, "async functions cannot return move-only native values in the first C++ ownership tier", {
      code: "Z0704",
      notes: ["direct move-only native returns work; containing aggregates need recursive async-result construction"],
      helps: ["return the native value directly until aggregate native async-result storage is implemented"],
    });
  }
  if (containsViewType(declaration.returnType.name) && !parseReceiverViewReturnType(declaration.returnType.name)) {
    throw new DiagnosticError(fileName, declaration.returnType.location, "view values cannot be nested inside returned storage", { code: "Z0206" });
  }
  if (containsSliceType(declaration.returnType.name)) {
    throw new DiagnosticError(fileName, declaration.returnType.location, "returning Slice values requires an explicit lifetime contract and is not implemented yet");
  }
  if (declaration.errorType) validateType(declaration.errorType, structs, enums, foreignNamedTypes, fileName, false);
  if (declaration.errorType && declaration.parameters.some((parameter) => parameter.mode === "out")) {
    throw new DiagnosticError(fileName, declaration.location, "throwing functions with out parameters are not implemented yet");
  }
  for (const parameter of declaration.parameters) {
    if (parameter.name === "this") {
      throw new DiagnosticError(fileName, parameter.location, "`this` is reserved for a method receiver");
    }
    validateUserName(parameter.name, parameter.location, fileName);
    validateType(parameter.type, structs, enums, foreignNamedTypes, fileName, false);
    if (containsViewType(parameter.type.name)) {
      throw new DiagnosticError(fileName, parameter.type.location, "view is a receiver-tied return capability, not a parameter type", { code: "Z0206" });
    }
    if (parameter.mode === "out" && hasMoveOnlyForeignType(parameter.type.name, structs, enums, foreignNamedTypes)) {
      throw new DiagnosticError(fileName, parameter.location, `out parameter ${JSON.stringify(parameter.name)} cannot use move-only native storage in the first C++ ownership tier`, {
        code: "Z0240",
        notes: ["out begins as uninitialized storage, but a non-trivial C++ value must be constructed before it can be assigned"],
        helps: ["return the owned native value, or accept initialized `inout` storage"],
      });
    }
    const slice = parseSliceType(parameter.type.name);
    if (
      declaration.async
      && parameter.mode === "out"
      && hasCleanupType(parameter.type.name, structs, enums, foreignTypes)
    ) {
      throw new DiagnosticError(fileName, parameter.location, `async out parameter ${JSON.stringify(parameter.name)} cannot initialize ownership-bearing storage yet`, {
        code: "Z0704",
        notes: ["the first async out tier supports cleanup-free values; owned output needs a completion-time live-storage handoff"],
        helps: ["return the owned value, or use an initialized direct-awaited `inout` parameter"],
      });
    }
    if (declaration.async && parameter.mode === "in" && structs.get(parameter.type.name)?.kind === "class") {
      throw new DiagnosticError(fileName, parameter.location, `async class parameter ${JSON.stringify(parameter.name)} should use the ordinary owned parameter form`, {
        code: "Z0704",
        notes: ["owned ARC parameters retain identity in the task frame while preserving caller access"],
        helps: [`remove \`in\` from ${JSON.stringify(parameter.name)}`],
      });
    }
    if (declaration.async && parameter.mode === "inout" && structs.get(parameter.type.name)?.kind === "class") {
      throw new DiagnosticError(fileName, parameter.location, `async class parameter ${JSON.stringify(parameter.name)} cannot rebind caller storage yet`, {
        code: "Z0704",
        notes: ["an ordinary owned class parameter retains the reference and can still mutate the referenced object's fields"],
        helps: [`remove \`inout\` unless the function must replace ${JSON.stringify(parameter.name)} in its caller`],
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
  const previousExecutorContext = state.executorContext;
  state.activeReceiver = receiver?.name ?? null;
  state.activeFunction = declaration;
  state.executorContext = !receiver && declaration.name === "main" ? "main" : null;
  state.placementErrorTypes.length = 0;
  state.moveOrigins.clear();
  state.borrowOrigins.clear();
  state.iterationBorrowOrigins.clear();
  state.activeLoans.clear();
  state.asyncSpawnBorrowRoots.clear();
  state.asyncTaskBorrowSpawns.clear();
  state.asyncScopeDepth = 0;
  state.asyncLoopDepth = 0;
  state.viewCallOrigins.clear();
  state.viewOrigins.clear();
  state.inferredOutBindingLocations.clear();
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
  const unresolvedOutBinding = state.inferredOutBindingLocations.entries().next().value as [string, SourceLocation] | undefined;
  if (unresolvedOutBinding) {
    throw new DiagnosticError(fileName, unresolvedOutBinding[1], `cannot infer type of uninitialized let ${JSON.stringify(unresolvedOutBinding[0])}`, {
      notes: ["an untyped uninitialized let is reserved for initialization by a typed out argument"],
      helps: ["pass it as `out <name>` to a classified function or add an explicit type annotation"],
    });
  }
  if (!returns) requireOutParametersInitialized(declaration, locals, declaration.location, fileName);
  if (declaration.returnType.name !== "void" && !returns) {
    throw new DiagnosticError(fileName, declaration.location, `function ${JSON.stringify(declaration.name)} must end with a return value`);
  }
  state.activeReceiver = previousReceiver;
  state.activeFunction = previousFunction;
  state.executorContext = previousExecutorContext;
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
      case "executorPlacement":
        checkExpression(expression.executor, initialized);
        analyzeConstructorStatements(expression.body.statements, new Set(initialized));
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
  transientViews: ReadonlySet<string> = new Set(),
): boolean {
  const inheritedViews = new Set([...state.viewOrigins.keys()].filter((name) => !transientViews.has(name)));
  let returns = false;
  let stops = false;
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    for (const name of state.viewOrigins.keys()) {
      if (inheritedViews.has(name)) continue;
      if (!statements.slice(index).some((candidate) => syntaxReferencesName(candidate, name))) {
        unbindViewOrigin(name, state);
      }
    }
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
  for (const name of state.viewOrigins.keys()) {
    if (!inheritedViews.has(name)) unbindViewOrigin(name, state);
  }
  return returns;
}

function syntaxReferencesName(value: unknown, name: string): boolean {
  if (!value || typeof value !== "object") return false;
  if ((value as { kind?: string; name?: string }).kind === "identifier"
    && (value as { name?: string }).name === name) return true;
  if (Array.isArray(value)) return value.some((item) => syntaxReferencesName(item, name));
  return Object.entries(value as Record<string, unknown>)
    .some(([key, item]) => key !== "location" && key !== "nameLocation" && syntaxReferencesName(item, name));
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
        if (!statement.type) {
          locals.set(statement.name, `${uninitializedPrefix}${mutablePrefix}unknown`);
          state.inferredOutBindingLocations.set(statement.name, statement.nameLocation);
          return;
        }
        const declaredType = statement.type;
        validateType(declaredType, structs, enums, state.foreignNamedTypes, fileName, false);
        observeTypeResolution(declaredType, structs, enums, state);
        if (hasMoveOnlyForeignType(declaredType.name, structs, enums, state.foreignNamedTypes)) {
          throw new DiagnosticError(fileName, declaredType.location, "move-only native values must be initialized when their storage is declared", {
            code: "Z0240",
            notes: ["uninitialized Z locals do not run a non-trivial C++ constructor"],
            helps: ["initialize the binding from a native constructor, owned return, or moved value"],
          });
        }
        if (containsViewType(declaredType.name)) {
          throw new DiagnosticError(fileName, declaredType.location, "view values cannot be declared as uninitialized storage", { code: "Z0206" });
        }
        if (containsSliceType(declaredType.name)) {
          throw new DiagnosticError(fileName, declaredType.location, "Slice values cannot be stored in local bindings yet");
        }
        locals.set(statement.name, `${uninitializedPrefix}${mutablePrefix}${declaredType.name}`);
        state.bindingTypes.set(statement.nameLocation.offset, declaredType.name);
        return;
      }
      if (statement.type && parseViewType(statement.type.name)) {
        throw new DiagnosticError(fileName, statement.type.location, "view locals are inferred from a receiver-tied method call", {
          code: "Z0206",
          helps: ["omit the annotation and bind the view with `const`"],
        });
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
        observeTypeResolution(statement.type, structs, enums, state);
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
            ?? contextualSwiftStringToZ(variableType, initializerType, statement.initializer, state)
            ?? initializerType;
          requireAssignable(variableType, initializerType, statement.initializer, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
        }
      } else if (initializerType === "unknown") {
        throw new DiagnosticError(
          fileName,
          statement.initializer.location,
          "cannot infer the result of an imported function until its header is typed; add a type annotation",
        );
      } else if (initializerType === swiftStringTypeName) {
        throw new DiagnosticError(
          fileName,
          statement.initializer.location,
          "a native Swift String return must initialize an explicit Z String",
          {
            notes: ["the conversion makes a fresh owned UTF-8 copy"],
            helps: [`write \`const ${statement.name}: String = ...\``],
          },
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
      const view = parseViewType(String(variableType));
      const optionalView = parseOptionalViewType(String(variableType));
      if (view || optionalView) {
        if (statement.mutable) {
          throw new DiagnosticError(fileName, statement.location, "a view binding must use const", { code: "Z0206" });
        }
        const origin = state.viewCallOrigins.get(statement.initializer.location.offset);
        if (!origin) {
          throw new DiagnosticError(fileName, statement.initializer.location, "a view-bearing value must be bound directly from a receiver-tied method call", { code: "Z0206" });
        }
        locals.set(statement.name, String(variableType));
        state.bindingTypes.set(statement.nameLocation.offset, String(variableType));
        bindViewOrigin(statement.name, origin, fileName, state);
        state.viewBindingOwners.set(statement.nameLocation.offset, origin.owner);
        return;
      }
      const directForeignValue = state.foreignNamedTypes.get(String(underlyingType(variableType)));
      const supportedAsyncNativeContainer = structs.get(String(underlyingType(variableType)))?.kind === "struct"
        || enums.has(String(underlyingType(variableType)))
        || Boolean(parseFixedArrayType(String(underlyingType(variableType))))
        || Boolean(parseDynamicArrayType(String(underlyingType(variableType))));
      if (
        state.activeFunction?.async
        && hasMoveOnlyForeignType(variableType, structs, enums, state.foreignNamedTypes)
        && directForeignValue?.kind !== "value"
        && !supportedAsyncNativeContainer
        && !/^__z_(?:Option|Result)_/.test(String(underlyingType(variableType)))
      ) {
        throw new DiagnosticError(fileName, statement.location, "async locals cannot store move-only native values in the first C++ ownership tier", {
          code: "Z0704",
          notes: ["direct move-only native locals work across suspension; aggregates containing them need recursive frame construction"],
          helps: ["keep the native value in a direct async local until aggregate native frame storage is implemented"],
        });
      }
      if (statement.initializer.kind === "closure") {
        const closure = state.closures.get(statement.initializer.location.offset)!;
        const cleanupCapture = closure.captures.find((capture) => hasOwnershipType(capture.type, structs, enums, state));
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
      if (
        statement.initializer.kind === "spawn"
        && state.asyncSpawnBorrowRoots.has(statement.initializer.location.offset)
      ) {
        state.asyncTaskBorrowSpawns.set(statement.name, statement.initializer.location.offset);
      }
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
      const readonlyField = readonlyFieldOnPath(statement.target, structs, state);
      const initializesReadonlyField = state.activeFunction?.name === "constructor"
        && state.constructorFieldInitializations.has(statement.location.offset);
      if (readonlyField && !initializesReadonlyField) {
        throw new DiagnosticError(fileName, statement.target.location, `cannot assign to readonly field ${JSON.stringify(readonlyField.name)}`, {
          code: "Z0214",
          helps: ["initialize the field during construction, or remove `readonly` if shared mutation is intended"],
        });
      }
      rejectOwnerMutationWhileViewed(root.name, statement.target.location, fileName, state);
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
      actual = contextualSwiftStringToZ(expected, actual, statement.expression, state) ?? actual;
      requireAssignable(expected, actual, statement.expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      if (
        hasCleanupType(expected, structs, enums, state.foreignTypes)
        && hasMoveOnlyForeignType(expected, structs, enums, state.foreignNamedTypes)
        && !enums.has(expected)
      ) {
        throw new DiagnosticError(fileName, statement.target.location, "replacement assignment for a value combining Z cleanup and move-only native storage is not executable yet", {
          code: "Z0240",
          notes: ["the current cleanup-aware replacement path requires default-constructing temporary storage"],
          helps: ["initialize a new binding and move the complete value once instead of replacing it"],
        });
      }
      if (hasOwnershipType(expected, structs, enums, state)) {
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
      const view = parseViewType(expected);
      if (view) {
        const root = storageRoot(statement.expression);
        if (!root || root.name !== "this" || (statement.expression.kind !== "member" && statement.expression.kind !== "index")) {
          throw new DiagnosticError(fileName, statement.expression.location, "a view method must return a field or indexed element derived directly from this", {
            code: "Z0206",
            notes: ["forwarding another view or returning local storage would let it escape the wrong owner"],
          });
        }
        const actual = inferExpression(statement.expression, locals, globals, structs, enums, fileName, state);
        requireAssignable(view.target, actual, statement.expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
        state.viewReturnExpressions.add(statement.expression.location.offset);
        requireOutParametersInitialized(owner, locals, statement.location, fileName);
        return;
      }
      const optionalView = parseOptionalViewType(expected);
      if (optionalView) {
        validateOptionalViewReturn(statement.expression, expected, owner, locals, globals, structs, enums, fileName, state);
        requireOutParametersInitialized(owner, locals, statement.location, fileName);
        return;
      }
      let actual = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state);
      actual = contextualCStringLiteral(expected, statement.expression, state) ?? actual;
      actual = contextualObjCStringToZ(expected, actual, statement.expression, state) ?? actual;
      actual = contextualSwiftStringToZ(expected, actual, statement.expression, state) ?? actual;
      requireAssignable(expected, actual, statement.expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      consumeOwnedValue(statement.expression, expected, locals, structs, enums, fileName, state);
      requireOutParametersInitialized(owner, locals, statement.location, fileName);
      return;
    }
    case "throw": {
      const errorType = state.placementErrorTypes.length > 0
        ? state.placementErrorTypes.at(-1)
        : owner.errorType;
      if (!errorType) {
        const subject = state.placementErrorTypes.length > 0
          ? "executor block"
          : `function ${JSON.stringify(owner.name)}`;
        throw new DiagnosticError(fileName, statement.location, `${subject} does not declare an error type`);
      }
      let actual = inferExpression(statement.expression, locals, globals, structs, enums, fileName, state);
      actual = contextualCStringLiteral(errorType.name, statement.expression, state) ?? actual;
      requireAssignable(errorType.name, actual, statement.expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      consumeOwnedValue(statement.expression, errorType.name, locals, structs, enums, fileName, state);
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
      const outerLoans = new Map(state.activeLoans);
      const outerSpawnBorrowRoots = new Map(state.asyncSpawnBorrowRoots);
      const outerTaskBorrowSpawns = new Map(state.asyncTaskBorrowSpawns);
      state.asyncScopeDepth += 1;
      try {
        analyzeStatements(statement.body.statements, owner, scopeLocals, globals, structs, enums, fileName, state);
      } finally {
        state.asyncScopeDepth -= 1;
        state.activeLoans.clear();
        for (const [name, loans] of outerLoans) state.activeLoans.set(name, loans);
        state.asyncSpawnBorrowRoots.clear();
        for (const [offset, roots] of outerSpawnBorrowRoots) state.asyncSpawnBorrowRoots.set(offset, roots);
        state.asyncTaskBorrowSpawns.clear();
        for (const [name, offset] of outerTaskBorrowSpawns) state.asyncTaskBorrowSpawns.set(name, offset);
      }
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
      if (conditionType !== "boolean") {
        requireAssignable("boolean", conditionType, statement.condition, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      }
      analyzeIfBranches(statement, owner, locals, globals, structs, enums, fileName, state);
      return;
    }
    case "while": {
      state.asyncLoopDepth += 1;
      try {
        analyzeWhileLoop(statement, owner, locals, globals, structs, enums, fileName, state);
      } finally {
        state.asyncLoopDepth -= 1;
      }
      return;
    }
    case "for": {
      state.asyncLoopDepth += 1;
      try {
        analyzeForLoop(statement, owner, locals, globals, structs, enums, fileName, state);
      } finally {
        state.asyncLoopDepth -= 1;
      }
      return;
    }
    case "expressionStatement":
      {
        if (statement.expression.kind === "number" && isIntegerLiteral(statement.expression.value) && !integerLiteralFits(statement.expression.value, "i32")) {
          throw new DiagnosticError(fileName, statement.expression.location, `integer literal ${statement.expression.value} does not fit default i32`);
        }
        const type = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state);
        if (hasOwnershipType(type, structs, enums, state)) {
          throw new DiagnosticError(fileName, statement.expression.location, "an ownership-bearing value must be bound or transferred; it cannot be discarded");
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
      const optionalView = parseOptionalViewType(subjectType);
      const optionalViewOrigin = candidateRoot ? state.viewOrigins.get(candidateRoot.name) : null;
      if (optionalView && (statement.mode !== "in" || !candidateRoot || !optionalViewOrigin)) {
        throw new DiagnosticError(fileName, statement.expression.location, "an optional receiver-tied view must be matched from its const binding with `match (in value)`", {
          code: "Z0206",
          helps: ["bind the lookup result with const, then borrow it with `match (in result)`"],
        });
      }
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
      if (!borrowed && hasOwnershipType(subjectType, structs, enums, state)) {
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
            state.observer?.onFieldResolution?.({ location: fieldBinding.fieldLocation, aggregate: payloadDeclaration, field });
            validateUserName(fieldBinding.bindingName, fieldBinding.bindingLocation, fileName);
          }
        }
        state.observer?.onEnumVariantResolution?.({ location: arm.location, enumeration: declaration, variant });
        const armLocals = new Map(locals);
        if (borrowedRoot && borrowedRootType) {
          armLocals.set(borrowedRoot.name, `${borrowedPrefix}${underlyingType(borrowedRootType)}`);
        }
        if (variant.payload && arm.binding && arm.bindingLocation) {
          const payloadBorrowed = borrowed && hasOwnershipType(variant.payload.name, structs, enums, state);
          armLocals.set(arm.binding, payloadBorrowed ? `${borrowedPrefix}${variant.payload.name}` : variant.payload.name);
          state.bindingTypes.set(arm.bindingLocation.offset, variant.payload.name);
        }
        const payloadDeclaration = variant.payload ? structs.get(variant.payload.name) : null;
        for (const fieldBinding of arm.objectBindings ?? []) {
          const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
          const fieldBorrowed = hasOwnershipType(field.type.name, structs, enums, state);
          armLocals.set(fieldBinding.bindingName, fieldBorrowed ? `${borrowedPrefix}${field.type.name}` : field.type.name);
          state.bindingTypes.set(fieldBinding.bindingLocation.offset, field.type.name);
        }
        const patternNames = [arm.binding, ...(arm.objectBindings ?? []).map((field) => field.bindingName)].filter((name): name is string => Boolean(name));
        const previousBorrows = new Map(patternNames.map((name) => [name, state.borrowOrigins.get(name)]));
        const previousPatternViews = new Map(patternNames.map((name) => [name, state.viewOrigins.get(name)]));
        if (optionalViewOrigin && candidateRoot) unbindViewOrigin(candidateRoot.name, state);
        if (optionalViewOrigin && arm.binding && variant.payload && parseViewType(variant.payload.name)) {
          bindViewOrigin(arm.binding, optionalViewOrigin, fileName, state);
          if (arm.bindingLocation) state.viewBindingOwners.set(arm.bindingLocation.offset, optionalViewOrigin.owner);
        }
        if (borrowed && arm.binding && variant.payload && hasOwnershipType(variant.payload.name, structs, enums, state)) {
          state.borrowOrigins.set(arm.binding, { location: statement.location, kind: "match" });
        }
        for (const fieldBinding of arm.objectBindings ?? []) {
          const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
          if (hasOwnershipType(field.type.name, structs, enums, state)) {
            state.borrowOrigins.set(fieldBinding.bindingName, { location: statement.location, kind: "match" });
          }
        }
        try {
          const transientViews = new Set(
            optionalViewOrigin && arm.binding && variant.payload && parseViewType(variant.payload.name)
              ? [arm.binding]
              : [],
          );
          if (arm.body.kind === "block" && transientViews.size > 0) {
            const blockLocals = new Map(armLocals);
            analyzeStatements(arm.body.statements, owner, blockLocals, globals, structs, enums, fileName, state, transientViews);
            propagateOuterOwnership(armLocals, blockLocals);
          } else {
            analyzeStatement(arm.body, owner, armLocals, globals, structs, enums, fileName, state);
          }
        } finally {
          for (const name of patternNames) {
            const previousBorrow = previousBorrows.get(name);
            if (previousBorrow) state.borrowOrigins.set(name, previousBorrow);
            else state.borrowOrigins.delete(name);
            const previousView = previousPatternViews.get(name);
            if (previousView) bindViewOrigin(name, previousView, fileName, state);
            else unbindViewOrigin(name, state);
          }
          if (optionalViewOrigin && candidateRoot) bindViewOrigin(candidateRoot.name, optionalViewOrigin, fileName, state);
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
  const declaration = { ...functionTypeDeclaration(localName, {
    parameters: signature.parameters,
    returnType: signature.returnType,
  }, location), async: signature.async };
  return {
    ...declaration,
    errorType: signature.errorType ? { name: signature.errorType, location } : null,
  };
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
  oneShotOwnedCaptures = false,
  nativeThreadBody = false,
): ValueType {
  if (expression.errorType && expectedFunction) {
    throw new DiagnosticError(fileName, expression.errorType.location, "throwing closure values are not implemented yet", {
      code: "Z0216",
      notes: ["the first throwing-closure tier is executable through thread.spawn, which owns and joins a one-shot closure"],
      helps: ["pass this closure directly to thread.spawn, or use a named throwing function outside a callback boundary"],
    });
  }
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
  for (const [parameterIndex, parameter] of resolvedParameters.entries()) {
    if (parameterNames.has(parameter.name)) {
      throw new DiagnosticError(fileName, parameter.location, `duplicate closure parameter ${JSON.stringify(parameter.name)}`);
    }
    parameterNames.add(parameter.name);
    validateUserName(parameter.name, parameter.location, fileName);
    validateType(parameter.type, structs, enums, state.foreignNamedTypes, fileName, false);
    if (expression.parameters[parameterIndex]?.type) {
      observeTypeResolution(parameter.type, structs, enums, state);
    }
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
    if (containsViewType(type)) {
      if (!transientBorrow || expression.captureMode !== "borrow") {
        throw new DiagnosticError(fileName, capture.location, `view-bearing value ${JSON.stringify(capture.name)} can only be captured by a proven nonescaping closure`, {
          code: "Z0206",
          notes: ["an escaping or stored closure could outlive the owner storage projected by the view"],
          helps: ["pass an inline closure to a synchronous `in` function parameter, or capture an explicitly owned snapshot"],
        });
      }
      if (!state.viewOrigins.has(capture.name)) {
        throw new DiagnosticError(fileName, capture.location, `view capture ${JSON.stringify(capture.name)} has no proven owner`, {
          code: "Z0206",
          helps: ["bind the view directly from its owner before using it in the inline closure"],
        });
      }
      captures.push({
        name: capture.name,
        type,
        mode: "value",
        moved: false,
        location: capture.location,
      });
      closureLocals.set(capture.name, `${borrowedPrefix}${type}`);
      continue;
    }
    if (type.startsWith("__z_closure_")) {
      throw new DiagnosticError(fileName, capture.location, "capturing another closure requires escaping closure environments");
    }
    if (parseSliceType(type)) {
      throw new DiagnosticError(fileName, capture.location, "capturing Slice values requires an explicit lifetime contract");
    }
    if (expression.captureMode === "move" && !oneShotOwnedCaptures && hasMoveOnlyForeignType(type, structs, enums, state.foreignNamedTypes)) {
      throw new DiagnosticError(fileName, capture.location, `owned closure environments cannot store move-only native ${type} values yet`, {
        code: "Z0240",
        notes: ["owned closure environments currently use storage that does not construct non-trivial C++ values"],
        helps: ["borrow the value in a non-escaping closure, or move it through a synchronous function"],
      });
    }
    const cleanupBearing = hasOwnershipType(type, structs, enums, state);
    const moveCaptureOwnsValue = expression.captureMode === "move" && (oneShotOwnedCaptures || !cleanupBearing);
    const mode: ClosureCaptureInfo["mode"] = oneShotOwnedCaptures && expression.captureMode === "move"
      ? "value"
      : capture.mutated
        ? "inout"
        : moveCaptureOwnsValue || type === "cstring" ? "value" : "in";
    captures.push({
      name: capture.name,
      type,
      mode,
      moved: expression.captureMode === "move",
      location: capture.location,
    });
    const captureBorrow = expression.captureMode === "borrow" || (cleanupBearing && !oneShotOwnedCaptures)
      ? borrowedPrefix
      : "";
    const captureMutable = capture.mutated || (oneShotOwnedCaptures && isMutableBinding(stored));
    closureLocals.set(capture.name, `${captureBorrow}${captureMutable ? mutablePrefix : ""}${type}`);
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
  if (contextualReturn && parseViewType(contextualReturn.name)) {
    throw new DiagnosticError(fileName, contextualReturn.location, "closures cannot return receiver-tied views", { code: "Z0206" });
  }
  const provisionalReturn = contextualReturn ?? { name: "void", location: expression.location };
  if (expression.returnType) {
    validateType(expression.returnType, structs, enums, state.foreignNamedTypes, fileName, true);
    observeTypeResolution(expression.returnType, structs, enums, state);
  }
  if (expression.errorType) {
    validateType(expression.errorType, structs, enums, state.foreignNamedTypes, fileName, false);
    observeTypeResolution(expression.errorType, structs, enums, state);
  }
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
    errorType: expression.errorType,
    body: [],
    location: expression.location,
  };

  let returnType: ValueType;
  let body: Statement[];
  const previousFunction = state.activeFunction;
  state.activeFunction = syntheticBase;
  if (nativeThreadBody) state.nativeThreadBodyDepth += 1;
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
    if (nativeThreadBody) state.nativeThreadBodyDepth -= 1;
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
  if (closure.declaration.errorType) {
    throw new DiagnosticError(fileName, closure.declaration.errorType.location, "throwing closure values are not implemented yet", {
      code: "Z0216",
      notes: ["thread.spawn supports a one-shot throwing closure without storing it as a general function value"],
      helps: ["pass the closure directly to thread.spawn"],
    });
  }
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
    if (!hasOwnershipType(capture.type, structs, enums, state)) continue;
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
      case "executorPlacement":
        walkExpression(expression.executor, localNames);
        walkStatement(expression.body, new Set(localNames));
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
  if (conditionType !== "boolean") {
    requireAssignable("boolean", conditionType, expression.condition, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
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
  const optionalView = parseOptionalViewType(subjectType);
  const optionalViewOrigin = candidateRoot ? state.viewOrigins.get(candidateRoot.name) : null;
  if (optionalView && (expression.mode !== "in" || !candidateRoot || !optionalViewOrigin)) {
    throw new DiagnosticError(fileName, expression.expression.location, "an optional receiver-tied view must be matched from its const binding with `match (in value)`", {
      code: "Z0206",
      helps: ["bind the lookup result with const, then borrow it with `match (in result)`"],
    });
  }
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
  if (!borrowed && hasOwnershipType(subjectType, structs, enums, state)) {
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
        state.observer?.onFieldResolution?.({ location: fieldBinding.fieldLocation, aggregate: payloadDeclaration, field });
        validateUserName(fieldBinding.bindingName, fieldBinding.bindingLocation, fileName);
      }
    }
    state.observer?.onEnumVariantResolution?.({ location: arm.location, enumeration: declaration, variant });
    const armLocals = new Map(locals);
    if (borrowedRoot && borrowedRootType) {
      armLocals.set(borrowedRoot.name, `${borrowedPrefix}${underlyingType(borrowedRootType)}`);
    }
    if (variant.payload && arm.binding && arm.bindingLocation) {
      const payloadBorrowed = borrowed && hasOwnershipType(variant.payload.name, structs, enums, state);
      armLocals.set(arm.binding, payloadBorrowed ? `${borrowedPrefix}${variant.payload.name}` : variant.payload.name);
      state.bindingTypes.set(arm.bindingLocation.offset, variant.payload.name);
    }
    const payloadDeclaration = variant.payload ? structs.get(variant.payload.name) : null;
    for (const fieldBinding of arm.objectBindings ?? []) {
      const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
      const fieldBorrowed = hasOwnershipType(field.type.name, structs, enums, state);
      armLocals.set(fieldBinding.bindingName, fieldBorrowed ? `${borrowedPrefix}${field.type.name}` : field.type.name);
      state.bindingTypes.set(fieldBinding.bindingLocation.offset, field.type.name);
    }
    const patternNames = [arm.binding, ...(arm.objectBindings ?? []).map((field) => field.bindingName)].filter((name): name is string => Boolean(name));
    const previousBorrows = new Map(patternNames.map((name) => [name, state.borrowOrigins.get(name)]));
    const previousPatternViews = new Map(patternNames.map((name) => [name, state.viewOrigins.get(name)]));
    if (optionalViewOrigin && candidateRoot) unbindViewOrigin(candidateRoot.name, state);
    if (optionalViewOrigin && arm.binding && variant.payload && parseViewType(variant.payload.name)) {
      bindViewOrigin(arm.binding, optionalViewOrigin, fileName, state);
      if (arm.bindingLocation) state.viewBindingOwners.set(arm.bindingLocation.offset, optionalViewOrigin.owner);
    }
    if (borrowed && arm.binding && variant.payload && hasOwnershipType(variant.payload.name, structs, enums, state)) {
      state.borrowOrigins.set(arm.binding, { location: expression.location, kind: "match" });
    }
    for (const fieldBinding of arm.objectBindings ?? []) {
      const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
      if (hasOwnershipType(field.type.name, structs, enums, state)) {
        state.borrowOrigins.set(fieldBinding.bindingName, { location: expression.location, kind: "match" });
      }
    }
    let armType: ValueType = "never";
    try {
      const transientViews = new Set(
        optionalViewOrigin && arm.binding && variant.payload && parseViewType(variant.payload.name)
          ? [arm.binding]
          : [],
      );
      armType = inferValueArm(arm.body, owner, armLocals, globals, structs, enums, fileName, state, transientViews);
    } finally {
      for (const name of patternNames) {
        const previousBorrow = previousBorrows.get(name);
        if (previousBorrow) state.borrowOrigins.set(name, previousBorrow);
        else state.borrowOrigins.delete(name);
        const previousView = previousPatternViews.get(name);
        if (previousView) bindViewOrigin(name, previousView, fileName, state);
        else unbindViewOrigin(name, state);
      }
      if (optionalViewOrigin && candidateRoot) bindViewOrigin(candidateRoot.name, optionalViewOrigin, fileName, state);
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
  transientViews: ReadonlySet<string> = new Set(),
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
    const finalStatement = statement.statements.at(-1)!;
    const prefixTransientViews = new Set(
      [...transientViews].filter((name) => !syntaxReferencesName(finalStatement, name)),
    );
    const prefixReturns = analyzeStatements(
      statement.statements.slice(0, -1),
      owner,
      blockLocals,
      globals,
      structs,
      enums,
      fileName,
      state,
      prefixTransientViews,
    );
    if (prefixReturns) {
      throw new DiagnosticError(fileName, statement.statements.at(-1)!.location, "unreachable statement after guaranteed function exit");
    }
    for (const name of transientViews) {
      if (!syntaxReferencesName(finalStatement, name)) unbindViewOrigin(name, state);
    }
    const type = inferValueArm(finalStatement, owner, blockLocals, globals, structs, enums, fileName, state, transientViews);
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

function inferExecutorPlacement(
  expression: Extract<Expression, { kind: "executorPlacement" }>,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  allowThrowingCall: boolean,
): ValueType {
  const executor = inferExpression(expression.executor, locals, globals, structs, enums, fileName, state);
  if (executor !== "__z_executor:main") {
    throw new DiagnosticError(fileName, expression.executor.location, `on requires an executor capability, found ${describeValueType(executor, state)}`, {
      code: "Z0710",
      helps: ["import { thread } from \"std/thread\" and use `on thread.main { ... }`"],
    });
  }
  if (expression.mode === "sync" && state.executorContext !== "main") {
    throw new DiagnosticError(fileName, expression.location, "synchronous `on thread.main` requires proven main-executor context", {
      code: "Z0711",
      notes: ["this form is a static placement proof and never schedules at runtime"],
      helps: [state.activeFunction?.async
        ? "use `await on thread.main { ... }` to hop and wait"
        : "enter through a main-isolated function or make this operation async before hopping"],
    });
  }
  const synchronousNativePlacement = expression.mode === "spawn" && state.nativeThreadBodyDepth > 0;
  if (expression.mode !== "sync" && !state.activeFunction?.async && !synchronousNativePlacement) {
    if (expression.mode === "spawn") {
      throw new DiagnosticError(
        fileName,
        expression.location,
        "spawn on thread.main requires an enclosing async function or the direct thread.spawn closure",
        {
          code: "Z0711",
          notes: ["an ordinary synchronous helper does not inherit its caller's task scope or executor context"],
          helps: [
            "inside thread.spawn, call synchronous helpers first and keep `spawn on thread.main { ... }` directly in that closure",
            "otherwise make this helper async and call it from an async-capable context; async thread.spawn closures are not implemented yet",
          ],
        },
      );
    }
    throw new DiagnosticError(fileName, expression.location, "await on thread.main requires an enclosing async function", {
      code: "Z0711",
      notes: ["a synchronous helper cannot suspend or inherit async capability from one of its callers"],
      helps: ["make this helper async and await it from an async-capable caller"],
    });
  }
  if (expression.returnType) {
    validateType(expression.returnType, structs, enums, state.foreignNamedTypes, fileName, true);
    observeTypeResolution(expression.returnType, structs, enums, state);
  }
  if (expression.errorType) {
    validateType(expression.errorType, structs, enums, state.foreignNamedTypes, fileName, false);
    observeTypeResolution(expression.errorType, structs, enums, state);
  }

  const blockLocals = new Map(locals);
  const previousExecutor = state.executorContext;
  state.executorContext = "main";
  state.placementErrorTypes.push(expression.errorType);
  let successType: ValueType = "void";
  try {
    const final = expression.body.statements.at(-1);
    if (final?.kind === "select") {
      const returns = analyzeStatements(
        expression.body.statements.slice(0, -1),
        state.activeFunction!,
        blockLocals,
        globals,
        structs,
        enums,
        fileName,
        state,
      );
      if (returns) {
        throw new DiagnosticError(fileName, final.location, "unreachable select after guaranteed function exit");
      }
      successType = inferDirectValue(final.expression, state.activeFunction!, blockLocals, globals, structs, enums, fileName, state);
      consumeOwnedValue(final.expression, successType, blockLocals, structs, enums, fileName, state);
    } else {
      analyzeStatements(expression.body.statements, state.activeFunction!, blockLocals, globals, structs, enums, fileName, state);
    }
  } finally {
    state.placementErrorTypes.pop();
    state.executorContext = previousExecutor;
  }

  if (expression.returnType) {
    requireAssignable(
      expression.returnType.name,
      successType,
      expression,
      fileName,
      state.foreignNamedTypes,
      state.numericLiteralTypes,
    );
    successType = expression.returnType.name;
  }
  if (expression.mode !== "spawn") propagateOuterOwnership(locals, blockLocals);
  if (expression.mode === "spawn") {
    return taskTypeName(String(successType), expression.errorType?.name ?? null);
  }
  if (!expression.errorType) return successType;
  if (!allowThrowingCall) {
    throw new DiagnosticError(fileName, expression.location, "throwing executor block requires `attempt` or `try`", {
      code: "Z0712",
      helps: ["write `try await on ...` to propagate the error, or `attempt await on ...` to inspect Result<T, E>"],
    });
  }
  return resultTypeName(String(successType), expression.errorType.name);
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
  if (actual === "TextBuffer") {
    throw new DiagnosticError(fileName, expression.location, "TextBuffer is mutable construction storage, not printable text", {
      code: "Z0402",
      helps: ["call finish() and log the resulting String"],
    });
  }
  if (hasOwnershipType(actual, structs, enums, state)
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

function readonlyFieldOnPath(
  expression: Expression,
  structs: ReadonlyMap<string, StructDeclaration>,
  state: AnalysisState,
): StructDeclaration["fields"][number] | null {
  if (expression.kind === "index") return readonlyFieldOnPath(expression.object, structs, state);
  if (expression.kind !== "member") return null;
  const ownerType = state.expressionTypes.get(expression.object.location.offset);
  const declaration = ownerType ? structs.get(String(underlyingType(ownerType))) : null;
  const field = declaration?.fields.find((candidate) => candidate.name === expression.property);
  return field?.readonly ? field : readonlyFieldOnPath(expression.object, structs, state);
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

function isTaskCancellationCall(expression: Expression): expression is Extract<Expression, { kind: "call" }> {
  return expression.kind === "call"
    && expression.callee.kind === "member"
    && expression.callee.property === "cancel";
}

function firstLiveBorrow(
  locals: ReadonlyMap<string, ValueType>,
  activeFunction: FunctionDeclaration | null,
  borrowOrigins: ReadonlyMap<string, { readonly location: SourceLocation; readonly kind: "closure" | "iteration" | "match" }>,
): string | null {
  const asyncParameters = new Set(
    activeFunction?.async
      ? activeFunction.parameters
        .filter((parameter) => (
          parameter.mode === "in"
          || parameter.mode === "inout"
          || parameter.mode === "out"
          || Boolean(parseSliceType(parameter.type.name))
        ))
        .map((parameter) => parameter.name)
      : [],
  );
  for (const [name, type] of locals) {
    if (isBorrowedBinding(type)
      && initializationState(type) === "initialized"
      && ownershipState(type) === "available"
      && (!asyncParameters.has(name) || borrowOrigins.has(name))) return name;
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
      return "boolean";
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
      if (expression.operator === "!" && canonicalOperand === "boolean") return "boolean";
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
      const requirement = expression.operator === "!" ? "a boolean operand" : expression.operator === "~" ? "an integer operand" : "a numeric operand";
      throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires ${requirement}`);
    }
    case "identifier": {
      const local = locals.get(expression.name);
      if (local) {
        const asyncBorrow = state.activeLoans.get(expression.name)
          ?.find((loan) => loan.lifetime.kind === "task" && loan.capability === "inout");
        if (asyncBorrow) {
          throw new DiagnosticError(fileName, expression.location, `cannot read ${JSON.stringify(expression.name)} while a spawned task mutably borrows it`, {
            code: "Z0704",
            length: expression.name.length,
            labels: [{ location: asyncBorrow.location, message: "spawned mutable borrow begins here", length: expression.name.length }],
            notes: ["the child has exclusive access until the enclosing async scope joins its tasks"],
            helps: ["finish the async scope before reading the mutably borrowed value"],
          });
        }
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
      if (global?.kind === "foreignModule" || global?.kind === "foreignNamespace") {
        throw new DiagnosticError(fileName, expression.location, "an imported module or native namespace must be followed by a member name");
      }
      if (global?.kind === "console") {
        throw new DiagnosticError(fileName, expression.location, "the console module must be followed by a method name");
      }
      if (global?.kind === "standardModule") {
        throw new DiagnosticError(fileName, expression.location, `the ${global.module} module must be followed by a method name`);
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
        return "boolean";
      }
      if (["==", "!="].includes(expression.operator)) {
        const leftNullableReference = nullableForeignReference(left, state);
        const rightNullableReference = nullableForeignReference(right, state);
        if (
          (canonicalLeft === "null" && rightNullableReference)
          || (canonicalRight === "null" && leftNullableReference)
        ) {
          return "boolean";
        }
        const comparableNamed = left === right && state.foreignNamedTypes.get(String(left))?.kind === "enum";
        const zEnum = left === right ? enums.get(String(left)) : null;
        const comparableZEnum = zEnum !== null && zEnum !== undefined
          && zEnum.variants.every((variant) => variant.payload === null);
        const comparableString = canonicalLeft === "String" && canonicalRight === "String";
        if (canonicalLeft !== canonicalRight || (!isNumericType(canonicalLeft) && canonicalLeft !== "boolean" && !comparableNamed && !comparableZEnum && !comparableString)) {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires matching numeric, boolean, String, payload-free enum, or native enum operands`);
        }
        return "boolean";
      }
      if (["&&", "||"].includes(expression.operator)) {
        if (canonicalType(left, state.foreignNamedTypes) !== "boolean" || canonicalType(right, state.foreignNamedTypes) !== "boolean") {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires boolean operands`);
        }
        return "boolean";
      }
      throw new DiagnosticError(fileName, expression.location, `unsupported binary operator ${JSON.stringify(expression.operator)}`);
    }
    case "conditional": {
      const conditionType = inferExpression(expression.condition, locals, globals, structs, enums, fileName, state);
      if (conditionType !== "boolean") {
        requireAssignable("boolean", conditionType, expression.condition, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
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
        const resolution = { location: expression.location, aggregate: declaration, declaration: target };
        const callable = state.observer?.resolveConstructorCall?.(resolution) ?? target;
        checkArguments(callable, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
        state.observer?.onConstructorCall?.(resolution);
        if (callable.errorType) {
          if (!allowThrowingCall) {
            throw new DiagnosticError(fileName, expression.location, "throwing constructor requires `attempt` or `try`");
          }
          return resultTypeName(declaration.name, callable.errorType.name);
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
      state.weakClassUses.set(declaration.name, expression.location);
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
        if (declaration && "type" in field) {
          state.observer?.onFieldResolution?.({ location: initializer.location, aggregate: declaration, field });
        }
      }
      const expectedFields = declaration?.fields ?? (foreignDeclaration?.kind === "record" ? foreignDeclaration.fields : []);
      const missing = expectedFields.find((field) => !provided.has(field.name));
      if (missing) {
        throw new DiagnosticError(fileName, expression.location, `missing field ${JSON.stringify(missing.name)} when constructing ${JSON.stringify(expression.typeName)}`);
      }
      if (declaration) {
        state.observer?.onAggregateConstruction?.({ location: expression.location, declaration });
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
      const ownerValueType = parseViewType(String(ownerType))?.target ?? String(ownerType);
      const array = parseFixedArrayType(ownerValueType);
      const slice = parseSliceType(ownerValueType);
      const dynamic = parseDynamicArrayType(ownerValueType);
      if (!array && !slice && !dynamic) {
        throw new DiagnosticError(fileName, expression.object.location, `indexing requires an array or Slice, found ${ownerType}`);
      }
      if (hasOwnershipType(ownerType, structs, enums, state) && !isNamedStorageExpression(expression.object)) {
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
      const payloadView = parseViewType(variant.payload.name);
      if (payloadView) {
        validateReceiverViewProjection(expression.payload, declaration.name, payloadView.target, locals, globals, structs, enums, fileName, state);
        state.observer?.onEnumVariantResolution?.({ location: expression.location, enumeration: declaration, variant });
        return declaration.name;
      }
      let actual = expression.payload.kind === "objectExpression"
        ? inferContextualObjectExpression(expression.payload, variant.payload.name, locals, globals, structs, enums, fileName, state)
        : inferExpression(expression.payload, locals, globals, structs, enums, fileName, state);
      actual = contextualCStringLiteral(variant.payload.name, expression.payload, state) ?? actual;
      requireAssignable(variant.payload.name, actual, expression.payload, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      consumeOwnedValue(expression.payload, variant.payload.name, locals, structs, enums, fileName, state);
      state.observer?.onEnumVariantResolution?.({ location: expression.location, enumeration: declaration, variant });
      return declaration.name;
    }
    case "executorPlacement":
      return inferExecutorPlacement(
        expression,
        locals,
        globals,
        structs,
        enums,
        fileName,
        state,
        allowThrowingCall,
      );
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
      const borrowed = firstLiveBorrow(locals, state.activeFunction, state.borrowOrigins);
      if (borrowed) {
        throw new DiagnosticError(fileName, expression.location, `cannot await while borrowed storage ${JSON.stringify(borrowed)} is live`, {
          code: "Z0704",
          notes: ["async `in`, direct-awaited `inout`/`out`, and Slice parameters can carry proven borrows across suspension"],
          helps: ["finish this lexical borrow before awaiting, or pass storage through an appropriate async parameter capability"],
        });
      }
      const context = { mode: "await" as const, spawnOffset: null, calls: 0, cancellationCalls: 0 };
      state.asyncCallContexts.push(context);
      let awaited: ValueType;
      try {
        awaited = inferExpression(expression.expression, locals, globals, structs, enums, fileName, state, allowThrowingCall);
      } finally {
        state.asyncCallContexts.pop();
      }
      if (context.cancellationCalls > 0 && !isTaskCancellationCall(expression.expression)) {
        throw new DiagnosticError(fileName, expression.expression.location, "Task.cancel must be the direct operation beneath await", {
          code: "Z0701",
          notes: ["cancel requests cancellation and joins cleanup as one structured operation"],
          helps: ["write `await task.cancel()` as its own expression statement"],
        });
      }
      const task = parseTaskType(String(awaited));
      if (task) {
        if (expression.expression.kind === "identifier") {
          consumeOwnedValue(expression.expression, awaited, locals, structs, enums, fileName, state, true);
          releaseAsyncTaskBorrows(expression.expression.name, state);
        }
        if (task.errorType) {
          if (!allowThrowingCall) {
            throw new DiagnosticError(fileName, expression.location, "awaiting a throwing task requires `attempt` or `try`", {
              code: "Z0701",
              helps: ["write `try await task` to propagate the error, or `attempt await task` to inspect Result<T, E>"],
            });
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
      const context = {
        mode: "spawn" as const,
        spawnOffset: expression.location.offset,
        calls: 0,
        cancellationCalls: 0,
      };
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
      if (expression.object.kind === "identifier" && !locals.has(expression.object.name)) {
        const standard = globals.get(expression.object.name);
        if (standard?.kind === "standardModule" && standard.module === "thread" && expression.property === "main") {
          return "__z_executor:main";
        }
      }
      const foreignConstant = getForeignConstant(expression, globals);
      if (foreignConstant) {
        checkForeignAvailability(foreignConstant.metadata, foreignConstant.name, expression.location, fileName, state);
        state.foreignConstantNames.set(expression.location.offset, foreignConstant.cName);
        state.foreignExpressionTypes.set(expression.location.offset, foreignConstant.typeName);
        return foreignConstant.typeName;
      }
      const objcClass = getObjCClass(expression, globals);
      if (objcClass) {
        checkForeignAvailability(objcClass.metadata, objcClass.className, expression.location, fileName, state);
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
          state.observer?.onEnumVariantResolution?.({ location: expression.location, enumeration: enumDeclaration, variant });
          return enumDeclaration.name;
        }
      }
      const receiverType = inferExpression(expression.object, locals, globals, structs, enums, fileName, state);
      const receiverView = parseViewType(String(receiverType));
      if (receiverView && expression.object.kind !== "identifier") {
        throw new DiagnosticError(fileName, expression.object.location, "bind a returned view to const before reading its fields", {
          code: "Z0206",
          helps: ["use `const projected = owner.viewMethod();`"],
        });
      }
      const receiverValueType = receiverView?.target ?? String(receiverType);
      if (receiverValueType === "Arena") {
        throw new DiagnosticError(fileName, expression.location, `Arena has no property ${JSON.stringify(expression.property)}; call create or reset instead`);
      }
      if (receiverValueType === "TextBuffer") {
        if (!isNamedStorageExpression(expression.object)) {
          throw new DiagnosticError(fileName, expression.object.location, "a TextBuffer temporary must be bound before reading one of its properties");
        }
        if (expression.property === "byteLength") return "usize";
        if (expression.property === "isEmpty") return "boolean";
        throw new DiagnosticError(fileName, expression.location, `TextBuffer has no property ${JSON.stringify(expression.property)}`);
      }
      if (receiverValueType === "String") {
        if (hasOwnershipType(receiverType, structs, enums, state) && !isNamedStorageExpression(expression.object)) {
          throw new DiagnosticError(fileName, expression.object.location, "a String temporary must be bound before reading one of its properties");
        }
        if (expression.property === "byteLength") return "usize";
        if (expression.property === "isEmpty") return "boolean";
        throw new DiagnosticError(fileName, expression.location, `String has no property ${JSON.stringify(expression.property)}`);
      }
      const array = parseFixedArrayType(receiverValueType);
      const slice = parseSliceType(receiverValueType);
      const dynamic = parseDynamicArrayType(receiverValueType);
      if (array || slice || dynamic) {
        if (hasOwnershipType(receiverType, structs, enums, state) && !isNamedStorageExpression(expression.object)) {
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
        checkForeignAvailability(property.metadata, property.name, expression.location, fileName, state);
        state.objcProperties.set(expression.location.offset, {
          getter: property.getter,
          setter: property.setter,
          type: property.type,
        });
        state.foreignExpressionTypes.set(expression.location.offset, String(propertyType));
        return propertyType;
      }
      if (hasOwnershipType(receiverType, structs, enums, state) && !isNamedStorageExpression(expression.object)) {
        throw new DiagnosticError(fileName, expression.object.location, "a cleanup-bearing temporary must be bound before borrowing one of its members");
      }
      const declaration = structs.get(receiverValueType);
      const foreignRecord = state.foreignNamedTypes.get(receiverValueType);
      if (foreignRecord?.kind === "record") {
        const field = foreignRecord.fields.find((candidate) => candidate.name === expression.property);
        if (field) {
          state.foreignExpressionTypes.set(expression.location.offset, field.typeName);
          return field.typeName;
        }
        throw new DiagnosticError(fileName, expression.location, `record ${JSON.stringify(foreignRecord.typeName)} has no field ${JSON.stringify(expression.property)}`);
      }
      if (foreignRecord?.kind === "value") {
        const method = foreignRecord.methods.find((candidate) => candidate.name === expression.property);
        if (method) throw new DiagnosticError(fileName, expression.location, "native method values are not implemented; call the method instead");
        throw new DiagnosticError(fileName, expression.location, `native value ${JSON.stringify(foreignRecord.typeName)} has no member ${JSON.stringify(expression.property)}`);
      }
      if (!declaration) {
        throw new DiagnosticError(fileName, expression.location, `type ${JSON.stringify(receiverType)} has no members`);
      }
      const field = declaration.fields.find((candidate) => candidate.name === expression.property);
      if (field) {
        if (field.visibility === "private" && state.activeReceiver !== declaration.name) {
          throw new DiagnosticError(fileName, expression.location, `field ${JSON.stringify(field.name)} is private to class ${JSON.stringify(declaration.name)}`);
        }
        state.observer?.onFieldResolution?.({ location: expression.location, aggregate: declaration, field });
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
        const standardType = globals.get(expression.callee.name);
        if (standardType?.kind === "standardType") {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (standardType.type === "TextBuffer") {
            if (expression.arguments.length !== 0) {
              throw new DiagnosticError(fileName, expression.location, `TextBuffer() expects no arguments, received ${expression.arguments.length}`);
            }
            return standardType.type;
          }
          if (expression.arguments.length === 0) return standardType.type;
          if (expression.arguments.length !== 1 || expression.arguments[0].kind !== "objectExpression") {
            throw new DiagnosticError(fileName, expression.location, "Arena() expects no arguments or one options object", {
              helps: ["use `Arena()` or `Arena({ initialCapacity: 65536 })`"],
            });
          }
          const options = expression.arguments[0];
          if (options.fields.length !== 1 || options.fields[0].name !== "initialCapacity") {
            const field = options.fields[0];
            throw new DiagnosticError(fileName, field?.location ?? options.location, "Arena options require exactly initialCapacity", {
              helps: ["use `Arena({ initialCapacity: 65536 })`"],
            });
          }
          const capacity = options.fields[0].expression;
          const actual = inferExpression(capacity, locals, globals, structs, enums, fileName, state);
          requireAssignable("usize", actual, capacity, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
          return standardType.type;
        }
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
        if (imported?.kind === "foreignType") {
          if (imported.declaration.kind === "record") {
            rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
            if (expression.arguments.length !== 1 || expression.arguments[0].kind !== "objectExpression") {
              throw new DiagnosticError(fileName, expression.location, `${expression.callee.name} construction requires one object literal`);
            }
            inferContextualObjectExpression(expression.arguments[0], imported.declaration.typeName, locals, globals, structs, enums, fileName, state);
            return imported.declaration.typeName;
          }
          if (imported.declaration.kind === "value") {
            rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
            return checkForeignCxxConstructorCall(
              imported.declaration,
              expression.arguments,
              locals,
              globals,
              structs,
              enums,
              fileName,
              expression.location,
              expression.callee.location.offset,
              state,
            );
          }
        }
      }
      if (expression.callee.kind === "member") {
        const imported = foreignMemberTarget(expression.callee, globals);
        const named = imported ? resolveForeignNamedType(imported.module, imported.path) : null;
        if (named?.kind === "record") {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.arguments.length !== 1 || expression.arguments[0].kind !== "objectExpression") {
            throw new DiagnosticError(fileName, expression.location, `${named.qualifiedName} construction requires one object literal`);
          }
          inferContextualObjectExpression(expression.arguments[0], named.typeName, locals, globals, structs, enums, fileName, state);
          return named.typeName;
        }
        if (named?.kind === "value") {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          return checkForeignCxxConstructorCall(
            named,
            expression.arguments,
            locals,
            globals,
            structs,
            enums,
            fileName,
            expression.location,
            expression.callee.location.offset,
            state,
          );
        }
        if (imported && imported.path.length > 1) {
          const owner = resolveForeignNamedType(imported.module, imported.path.slice(0, -1));
          const method = owner?.kind === "value"
            ? owner.staticMethods.find((candidate) => candidate.name === imported.path.at(-1))
            : null;
          if (owner?.kind === "value" && method) {
            rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
            return checkForeignCxxStaticMethodCall(
              owner,
              method,
              expression.arguments,
              locals,
              globals,
              structs,
              enums,
              fileName,
              expression.location,
              expression.callee.location.offset,
              state,
            );
          }
          if (owner?.kind === "value") {
            const instanceMethod = owner.methods.find((candidate) => candidate.name === imported.path.at(-1));
            if (instanceMethod) {
              throw new DiagnosticError(
                fileName,
                expression.callee.location,
                `native instance method ${JSON.stringify(instanceMethod.name)} must be called through a ${owner.typeName} value`,
              );
            }
            throw new DiagnosticError(
              fileName,
              expression.callee.location,
              `native value type ${JSON.stringify(owner.typeName)} has no static method ${JSON.stringify(imported.path.at(-1))}`,
            );
          }
        }
        if (imported && imported.path.length === 1) {
          const matches = [...imported.module.namedTypes.values()].filter((candidate) => (
            candidate.exportName === imported.path[0]
          ));
          if (matches.length > 1) {
            throw new DiagnosticError(
              fileName,
              expression.callee.location,
              `native type ${JSON.stringify(imported.path[0])} is ambiguous across C++ namespaces`,
              {
                notes: matches.map((candidate) => `${candidate.qualifiedName}: ${candidate.cName}`),
                helps: ["construct the type through its fully qualified native namespace path"],
              },
            );
          }
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
        if (expression.callee.object.kind === "identifier" && !locals.has(expression.callee.object.name)) {
          const localModuleName = expression.callee.object.name;
          const owner = globals.get(localModuleName);
          if (owner?.kind === "standardModule") {
            if (owner.module === "thread") {
              if (expression.callee.property !== "spawn") {
                throw new DiagnosticError(fileName, expression.callee.location, `thread has no method ${JSON.stringify(expression.callee.property)}`, {
                  helps: [`use ${localModuleName}.spawn(move () => operation())`],
                });
              }
              rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
              if (!state.activeFunction?.async) {
                throw new DiagnosticError(fileName, expression.location, "thread.spawn requires an enclosing async function", {
                  code: "Z0703",
                  helps: ["call thread.spawn from an async function so its Task can be awaited"],
                });
              }
              if (expression.arguments.length !== 1 || expression.arguments[0].kind !== "closure") {
                throw new DiagnosticError(fileName, expression.location, "thread.spawn expects one synchronous closure", {
                  code: "Z0703",
                  helps: [`use \`${localModuleName}.spawn(move () => operation())\``],
                });
              }
              const operation = expression.arguments[0];
              inferClosureExpression(operation, locals, globals, structs, enums, fileName, state, null, false, true, true);
              const closure = state.closures.get(operation.location.offset)!;
              if (closure.parameterCount !== 0) {
                throw new DiagnosticError(fileName, operation.location, "thread.spawn closure cannot declare parameters in the first thread tier", {
                  code: "Z0704",
                  helps: ["capture transferable inputs with `move` instead"],
                });
              }
              if (closure.captures.length > 0 && operation.captureMode !== "move") {
                throw new DiagnosticError(fileName, operation.location, "thread.spawn requires `move` for a capturing closure", {
                  code: "Z0704",
                  notes: ["cross-thread work owns a snapshot of every captured value"],
                  helps: ["write `move () => ...`"],
                });
              }
              const captureTransfers: { readonly capture: ClosureCaptureInfo; readonly kind: ThreadTransferKind }[] = [];
              for (const capture of closure.captures) {
                const outerBinding = locals.get(capture.name);
                if (outerBinding && isBorrowedBinding(outerBinding)) {
                  throw new DiagnosticError(fileName, capture.location, `borrowed capture ${JSON.stringify(capture.name)} cannot cross a native thread boundary`, {
                    code: "Z0704",
                    notes: ["thread.spawn must own its inputs; an in, inout, out, view, or other borrowed binding remains tied to the calling task"],
                    helps: ["make an owned value snapshot before thread.spawn, then capture that snapshot with move"],
                  });
                }
                const transfer = initialThreadTransferKind(capture.type, structs, enums, state);
                if (!transfer) {
                  const capturedClass = structs.get(String(underlyingType(capture.type)));
                  const shareability = capturedClass?.kind === "class"
                    ? shareableTypeIssue(capturedClass.name, structs, enums, state)
                    : null;
                  const foreignIssue = foreignThreadTransferIssue(capture.type, state);
                  const issue = shareability ?? foreignIssue;
                  const detail = issue ? `: ${issue.reason}` : " yet";
                  throw new DiagnosticError(fileName, capture.location, `capture ${JSON.stringify(capture.name)} of type ${JSON.stringify(capture.type)} cannot cross a native thread boundary${detail}`, {
                    code: "Z0704",
                    notes: [issue?.reason ?? "the current tier copies plain values, shares deeply readonly ARC identity, and moves supported Array, String, TextBuffer, and containing aggregate owners"],
                    helps: [issue?.help ?? "capture a transferable owned value, or keep this work on the inherited executor with `spawn`"],
                  });
                }
                captureTransfers.push({ capture, kind: transfer });
              }
              const returnType = closure.declaration.returnType.name;
              if (!initialThreadTransferKind(returnType, structs, enums, state)) {
                throw new DiagnosticError(fileName, operation.location, `thread.spawn result type ${JSON.stringify(returnType)} cannot cross a native thread boundary yet`, {
                  code: "Z0704",
                  helps: ["return a transferable value or supported unique owner"],
                });
              }
              const errorType = closure.declaration.errorType?.name ?? null;
              if (errorType) {
                const transfer = initialThreadTransferKind(errorType, structs, enums, state);
                if (!transfer) {
                  const errorClass = structs.get(String(underlyingType(errorType)));
                  const shareability = errorClass?.kind === "class"
                    ? shareableTypeIssue(errorClass.name, structs, enums, state)
                    : null;
                  const foreignIssue = foreignThreadTransferIssue(errorType, state);
                  const issue = shareability ?? foreignIssue;
                  throw new DiagnosticError(fileName, operation.errorType!.location, `thread.spawn error type ${JSON.stringify(errorType)} cannot cross a native thread boundary yet`, {
                    code: "Z0704",
                    notes: [issue?.reason ?? "worker errors must be transferable values, unique owners, or deeply readonly ARC identity"],
                    helps: [issue?.help ?? "use a transferable owned error value, or translate it to a thread-safe error before throwing"],
                  });
                }
                const errorClass = structs.get(String(underlyingType(errorType)));
                if (transfer === "copy" && errorClass?.kind === "class") {
                  state.threadSharedClassUses.set(errorClass.name, operation.errorType!.location);
                }
              }
              for (const { capture, kind } of captureTransfers) {
                const capturedClass = structs.get(String(underlyingType(capture.type)));
                if (kind === "copy" && capturedClass?.kind === "class") {
                  state.managedCopies.add(capture.location.offset);
                  state.threadSharedClassUses.set(capturedClass.name, capture.location);
                }
                if (kind !== "move") continue;
                consumeOwnedValue(
                  { kind: "identifier", name: capture.name, location: expression.location },
                  capture.type,
                  locals,
                  structs,
                  enums,
                  fileName,
                  state,
                );
              }
              state.threadSpawnCalls.set(expression.location.offset, operation.location.offset);
              const taskType = taskTypeName(returnType, errorType);
              return taskType;
            }
            const name = standardModuleFunction(owner.module, expression.callee.property);
            if (!name) {
              throw new DiagnosticError(
                fileName,
                expression.callee.location,
                `${owner.module} has no method ${JSON.stringify(expression.callee.property)}`,
                { helps: [`use ${standardModuleMemberNames(owner.module).map((member) => `${localModuleName}.${member}`).join(", ")}`] },
              );
            }
            rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
            const declaration = standardFunctionDeclaration(expression.callee.property, name, expression.callee.location);
            state.standardFunctionReferences.set(expression.callee.location.offset, name);
            state.expressionTypes.set(
              expression.callee.location.offset,
              functionTypeName(
                declaration.parameters.map((parameter) => ({
                  name: parameter.name,
                  mode: parameter.mode,
                  type: parameter.type.name,
                })),
                declaration.returnType.name,
              ),
            );
            checkArguments(declaration, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
            if (declaration.errorType) {
              if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
              return resultTypeName(declaration.returnType.name, declaration.errorType.name);
            }
            return declaration.returnType.name;
          }
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
          const foreignOwner = !locals.has(expression.callee.object.name)
            ? globals.get(expression.callee.object.name)
            : null;
          if (foreignOwner?.kind === "foreignType" && foreignOwner.declaration.kind === "value") {
            const method = foreignOwner.declaration.staticMethods.find((candidate) => candidate.name === expression.callee.property);
            if (!method) {
              throw new DiagnosticError(fileName, expression.callee.location, `native value type ${JSON.stringify(foreignOwner.declaration.typeName)} has no static method ${JSON.stringify(expression.callee.property)}`);
            }
            rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
            return checkForeignCxxStaticMethodCall(
              foreignOwner.declaration,
              method,
              expression.arguments,
              locals,
              globals,
              structs,
              enums,
              fileName,
              expression.location,
              expression.callee.location.offset,
              state,
            );
          }
          const aggregate = !locals.has(expression.callee.object.name)
            ? structs.get(expression.callee.object.name)
            : null;
          if (aggregate) {
            const method = aggregate.methods.find((candidate) => candidate.name === expression.callee.property);
            if (!method) {
              throw new DiagnosticError(fileName, expression.callee.location, `${aggregate.kind} ${JSON.stringify(aggregate.name)} has no static method ${JSON.stringify(expression.callee.property)}`);
            }
            const resolution = { location: expression.location, aggregate, declaration: method };
            const callable = state.observer?.resolveMethodCall?.(resolution) ?? method;
            if (!callable.static) {
              throw new DiagnosticError(fileName, expression.callee.location, `instance method ${JSON.stringify(callable.name)} must be called through a ${aggregate.name} value`);
            }
            if (callable.visibility === "private" && state.activeReceiver !== aggregate.name) {
              throw new DiagnosticError(fileName, expression.callee.location, `static method ${JSON.stringify(callable.name)} is private to ${aggregate.kind} ${JSON.stringify(aggregate.name)}`);
            }
            rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
            checkArguments(callable, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
            registerAsyncCall(callable, expression.location, fileName, state);
            state.observer?.onMethodCall?.(resolution);
            if (callable.errorType) {
              if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
              return resultTypeName(callable.returnType.name, callable.errorType.name);
            }
            return callable.returnType.name;
          }
          const enumDeclaration = enums.get(expression.callee.object.name);
          if (enumDeclaration) {
            rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
            const option = parseOptionType(enumDeclaration.name);
            if (option && expression.callee.property === "fromNullable") {
              if (expression.arguments.length !== 1) {
                throw new DiagnosticError(fileName, expression.location, `Option.fromNullable expects 1 argument, received ${expression.arguments.length}`);
              }
              const argument = expression.arguments[0];
              const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
              const object = foreignObject(actual, state);
              const pointer = foreignPointer(actual, state);
              const optionPointer = parsePointerTypeName(option.target);
              const contextualNull = actual === "null";
              const compatibleObject = object?.nullable && publicObjCTypeName(object.typeName) === option.target;
              const compatiblePointer = pointer?.nullable
                && optionPointer
                && !optionPointer.nullable
                && pointer.identity === optionPointer.identity
                && pointer.ownership === optionPointer.ownership;
              if (!contextualNull && !compatibleObject && !compatiblePointer) {
                const expectedPointer = state.foreignTypes.get(option.target);
                const expected = expectedPointer ? `${expectedPointer.cName} | null` : `${option.target} | null`;
                throw new DiagnosticError(
                  fileName,
                  argument.location,
                  `Option.fromNullable requires ${expected}, found ${describeValueType(actual, state)}`,
                );
              }
              state.optionFromNullable.add(expression.location.offset);
              return enumDeclaration.name;
            }
            const variant = enumDeclaration.variants.find((candidate) => candidate.name === expression.callee.property);
            if (!variant) throw new DiagnosticError(fileName, expression.callee.location, `enum ${JSON.stringify(enumDeclaration.name)} has no variant ${JSON.stringify(expression.callee.property)}`);
            const expectedCount = variant.payload ? 1 : 0;
            if (expression.arguments.length !== expectedCount) throw new DiagnosticError(fileName, expression.location, `variant ${JSON.stringify(variant.name)} expects ${expectedCount} argument(s)`);
            if (variant.payload) {
              const argument = expression.arguments[0];
              const payloadView = parseViewType(variant.payload.name);
              if (payloadView) {
                validateReceiverViewProjection(argument, enumDeclaration.name, payloadView.target, locals, globals, structs, enums, fileName, state);
                state.observer?.onEnumVariantResolution?.({ location: expression.location, enumeration: enumDeclaration, variant });
                return enumDeclaration.name;
              }
              const actual = argument.kind === "objectExpression"
                ? inferContextualObjectExpression(argument, variant.payload.name, locals, globals, structs, enums, fileName, state)
                : inferExpression(argument, locals, globals, structs, enums, fileName, state);
              requireAssignable(variant.payload.name, actual, expression.arguments[0], fileName, state.foreignNamedTypes, state.numericLiteralTypes);
              consumeOwnedValue(expression.arguments[0], variant.payload.name, locals, structs, enums, fileName, state);
            }
            state.observer?.onEnumVariantResolution?.({ location: expression.location, enumeration: enumDeclaration, variant });
            return enumDeclaration.name;
          }
        }
        if (isForeignMember(expression.callee, globals)) {
          const foreignFunction = getForeignFunction(expression.callee, globals);
          if (foreignFunction) {
            rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
            return checkForeignFunctionCall(
              foreignFunction,
              expression.arguments,
              locals,
              globals,
              structs,
              enums,
              fileName,
              expression.location,
              expression.callee.location.offset,
              state,
            );
          }
          const target = foreignMemberTarget(expression.callee, globals);
          if (target) {
            throw new DiagnosticError(fileName, expression.callee.location, `header ${JSON.stringify(target.module.declaration.header)} has no function ${JSON.stringify(target.path.join("."))}`);
          }
        }
        const receiverType = inferExpression(expression.callee.object, locals, globals, structs, enums, fileName, state);
        const receiverView = parseViewType(String(receiverType));
        const receiverValueType = receiverView?.target ?? String(receiverType);
        const task = parseTaskType(receiverValueType);
        if (task) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.callee.property !== "cancel") {
            throw new DiagnosticError(fileName, expression.callee.location, `Task has no method ${JSON.stringify(expression.callee.property)}`);
          }
          if (expression.arguments.length !== 0) {
            throw new DiagnosticError(fileName, expression.location, `"cancel" expects 0 arguments, received ${expression.arguments.length}`);
          }
          const context = state.asyncCallContexts.at(-1);
          if (!state.activeFunction?.async || !context) {
            throw new DiagnosticError(fileName, expression.location, "Task.cancel requires direct await", {
              code: "Z0702",
              notes: ["cancellation is a request-and-join operation; it never starts or detaches implicitly"],
              helps: ["write `await task.cancel()` inside an async function"],
            });
          }
          if (context.mode === "spawn") {
            throw new DiagnosticError(fileName, expression.location, "Task.cancel cannot be spawned", {
              code: "Z0703",
              notes: ["cancel already joins the task whose cancellation it requests"],
              helps: ["write `await task.cancel()`"],
            });
          }
          if (expression.callee.object.kind !== "identifier") {
            throw new DiagnosticError(fileName, expression.callee.object.location, "Task.cancel requires a named task handle");
          }
          context.calls += 1;
          context.cancellationCalls += 1;
          consumeOwnedValue(expression.callee.object, receiverType, locals, structs, enums, fileName, state, true);
          releaseAsyncTaskBorrows(expression.callee.object.name, state);
          return "void";
        }
        if (receiverValueType === "Arena") {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (state.activeFunction?.async) {
            throw new DiagnosticError(fileName, expression.location, "Arena access cannot cross suspension in the first region tier", {
              code: "Z0704",
              notes: ["arena views are synchronous and single-threaded while region provenance is established"],
              helps: ["perform arena allocation in a synchronous helper called before or after the awaited work"],
            });
          }
          const root = storageRoot(expression.callee.object);
          const stored = root ? locals.get(root.name) : null;
          if (!root || !stored) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "Arena methods require named storage");
          }
          if (!isMutableBinding(stored)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, `Arena.${expression.callee.property} requires addressable let storage`, {
              code: "Z0205",
              notes: ["create advances arena storage and reset invalidates its allocation region"],
              helps: ["bind the Arena with `let`"],
            });
          }
          if (expression.callee.property === "reset") {
            if (expression.arguments.length !== 0) {
              throw new DiagnosticError(fileName, expression.location, `"reset" expects 0 arguments, received ${expression.arguments.length}`);
            }
            rejectOwnerMutationWhileViewed(root.name, expression.callee.object.location, fileName, state, "reset");
            state.arenaResetCalls.add(expression.location.offset);
            return "void";
          }
          if (expression.callee.property !== "create") {
            throw new DiagnosticError(fileName, expression.callee.location, `Arena has no method ${JSON.stringify(expression.callee.property)}`);
          }
          if (expression.arguments.length !== 1) {
            throw new DiagnosticError(fileName, expression.location, `"create" expects 1 argument, received ${expression.arguments.length}`);
          }
          const argument = expression.arguments[0];
          const actual = String(inferExpression(argument, locals, globals, structs, enums, fileName, state));
          if (parseViewType(actual) || parseSliceType(actual)) {
            throw new DiagnosticError(fileName, argument.location, "Arena.create requires an owned value, not borrowed storage", {
              code: "Z0206",
              helps: ["create an owned value before transferring it into the arena"],
            });
          }
          if (actual === "void" || actual === "never" || actual === "Arena" || parseTaskType(actual)) {
            throw new DiagnosticError(fileName, argument.location, `Arena.create cannot store ${JSON.stringify(actual)}`);
          }
          if (structs.get(actual)?.kind === "class" || state.foreignNamedTypes.get(actual)?.kind === "object") {
            throw new DiagnosticError(fileName, argument.location, "Arena.create does not directly root reference-identity objects in the first tier", {
              code: "Z0206",
              notes: ["arena-owned structs may still contain ARC or Objective-C references and release them at reset"],
              helps: ["store the reference in a Z struct, or keep the class under ARC ownership"],
            });
          }
          if (hasOwnershipType(actual, structs, enums, state)) {
            consumeOwnedValue(argument, actual, locals, structs, enums, fileName, state);
          }
          state.arenaCreateCalls.set(expression.location.offset, actual);
          state.viewCallOrigins.set(expression.location.offset, { owner: root.name, location: expression.callee.object.location });
          return viewTypeName(actual);
        }
        if (receiverValueType === "TextBuffer") {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          const signatures: Readonly<Record<string, { readonly parameters: readonly string[]; readonly result: string }>> = {
            append: { parameters: ["String"], result: "void" },
            appendBytes: { parameters: ["String", "usize", "usize"], result: "void" },
            appendAscii: { parameters: ["u8"], result: "void" },
            finish: { parameters: [], result: "String" },
          };
          const signature = signatures[expression.callee.property];
          if (!signature) {
            throw new DiagnosticError(fileName, expression.callee.location, `TextBuffer has no method ${JSON.stringify(expression.callee.property)}`);
          }
          const root = storageRoot(expression.callee.object);
          const stored = root ? locals.get(root.name) : null;
          if (!root || !stored) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "TextBuffer methods require named storage");
          }
          const mutates = expression.callee.property !== "finish";
          if (mutates && !isMutableBinding(stored)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, `TextBuffer.${expression.callee.property} requires addressable let storage`, {
              helps: ["bind the TextBuffer with `let` before appending text"],
            });
          }
          if (expression.arguments.length !== signature.parameters.length) {
            throw new DiagnosticError(
              fileName,
              expression.location,
              `${JSON.stringify(expression.callee.property)} expects ${signature.parameters.length} argument(s), received ${expression.arguments.length}`,
            );
          }
          for (let index = 0; index < signature.parameters.length; index += 1) {
            const argument = expression.arguments[index];
            const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
            requireAssignable(
              signature.parameters[index],
              actual,
              argument,
              fileName,
              state.foreignNamedTypes,
              state.numericLiteralTypes,
            );
            if (signature.parameters[index] === "String") {
              state.nativeArgumentAccesses.set(argument.location.offset, "in");
            }
          }
          if (mutates) {
            rejectOwnerMutationWhileViewed(root.name, expression.callee.object.location, fileName, state);
          } else {
            consumeOwnedValue(expression.callee.object, receiverType, locals, structs, enums, fileName, state);
          }
          return signature.result;
        }
        if (receiverValueType === "String") {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          const signatures: Readonly<Record<string, { readonly parameters: readonly string[]; readonly result: string }>> = {
            byteAt: { parameters: ["usize"], result: "u8" },
            copyBytes: { parameters: ["usize", "usize"], result: "String" },
          };
          const signature = signatures[expression.callee.property];
          if (!signature) {
            throw new DiagnosticError(fileName, expression.callee.location, `String has no method ${JSON.stringify(expression.callee.property)}`);
          }
          if (!isNamedStorageExpression(expression.callee.object)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "a String temporary must be bound before calling one of its methods");
          }
          if (expression.arguments.length !== signature.parameters.length) {
            throw new DiagnosticError(
              fileName,
              expression.location,
              `${JSON.stringify(expression.callee.property)} expects ${signature.parameters.length} argument(s), received ${expression.arguments.length}`,
            );
          }
          for (let index = 0; index < signature.parameters.length; index += 1) {
            const argument = expression.arguments[index];
            const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
            requireAssignable(
              signature.parameters[index],
              actual,
              argument,
              fileName,
              state.foreignNamedTypes,
              state.numericLiteralTypes,
            );
          }
          return signature.result;
        }
        const integerReceiverType = canonicalType(receiverValueType, state.foreignNamedTypes);
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
        const dynamic = parseDynamicArrayType(receiverValueType);
        if (dynamic) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.callee.property !== "push") {
            throw new DiagnosticError(fileName, expression.callee.location, `Array has no method ${JSON.stringify(expression.callee.property)}`);
          }
          if (expression.arguments.length !== 1) {
            throw new DiagnosticError(fileName, expression.location, `"push" expects 1 argument, received ${expression.arguments.length}`);
          }
          const readonlyField = readonlyFieldOnPath(expression.callee.object, structs, state);
          if (readonlyField) {
            throw new DiagnosticError(fileName, expression.callee.object.location, `cannot mutate Array through readonly field ${JSON.stringify(readonlyField.name)}`, {
              code: "Z0214",
            });
          }
          const root = storageRoot(expression.callee.object);
          if (root) rejectOwnerMutationWhileViewed(root.name, expression.callee.location, fileName, state);
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
          state.dynamicArrayPushTypes.add(receiverValueType);
          return "void";
        }
        const weak = parseWeakType(receiverValueType);
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
        const objcReceiverType = objcReceiver(receiverValueType, state);
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
          checkForeignAvailability(method.metadata, method.selector, expression.callee.location, fileName, state);
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
        const foreignValue = state.foreignNamedTypes.get(receiverValueType);
        if (foreignValue?.kind === "value") {
          const method = foreignValue.methods.find((candidate) => candidate.name === expression.callee.property);
          if (!method) {
            throw new DiagnosticError(fileName, expression.callee.location, `native value ${JSON.stringify(foreignValue.typeName)} has no method ${JSON.stringify(expression.callee.property)}`);
          }
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (!isNamedStorageExpression(expression.callee.object)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "a native value temporary must be bound before borrowing it for a method call");
          }
          const receiverCapabilities = new Set(method.overloads.map((overload) => overload.receiverAccess));
          if (receiverCapabilities.size > 1) {
            throw new DiagnosticError(fileName, expression.callee.location, `native method ${JSON.stringify(method.name)} has receiver-qualified overloads that require an explicit receiver capability choice`, {
              code: "Z0803",
              notes: method.overloads.map((overload) => `${overload.cName}: ${overload.cSignature}`),
              helps: ["use a uniquely named native method until Z has syntax for selecting borrowed, mutable, or consuming receiver overloads"],
            });
          }
          let selected: ForeignCxxMethodOverload | null = null;
          const result = checkForeignFunctionCall(
            { name: method.name, namespacePath: foreignValue.namespacePath, qualifiedName: `${foreignValue.qualifiedName}.${method.name}`, overloads: method.overloads },
            expression.arguments,
            locals,
            globals,
            structs,
            enums,
            fileName,
            expression.location,
            expression.callee.location.offset,
            state,
            (overload) => { selected = overload as ForeignCxxMethodOverload; },
            "native method",
          );
          state.foreignFunctionNames.delete(expression.callee.location.offset);
          if (selected!.receiverAccess === "inout") {
            const root = storageRoot(expression.callee.object);
            const stored = root ? locals.get(root.name) : null;
            if (!root || !stored || !isMutableBinding(stored)) {
              throw new DiagnosticError(
                fileName,
                expression.callee.object.location,
                `mutable native method ${JSON.stringify(method.name)} requires addressable let storage`,
                { helps: ["bind the native value with `let` before calling this method"] },
              );
            }
            rejectOwnerMutationWhileViewed(root.name, expression.callee.object.location, fileName, state);
          }
          if (selected!.receiverAccess === "move") {
            if (!(foreignValue.lifecycle.move && !foreignValue.lifecycle.copy)) {
              throw new DiagnosticError(fileName, expression.callee.object.location, `consuming native method ${JSON.stringify(method.name)} currently requires a move-only native receiver`, {
                code: "Z0801",
                notes: ["copyable receiver rvalue calls need an explicit copy-versus-consume design before they can be exposed safely"],
              });
            }
            consumeOwnedValue(expression.callee.object, receiverType, locals, structs, enums, fileName, state, true);
          }
          state.foreignCxxMethodCalls.set(expression.location.offset, {
            name: selected!.cName,
            receiverAccess: selected!.receiverAccess,
          });
          return result;
        }
        const declaration = structs.get(receiverValueType);
        const field = declaration?.fields.find((candidate) => candidate.name === expression.callee.property);
        const fieldFunctionType = field ? parseFunctionType(field.type.name) : null;
        if (declaration && field && fieldFunctionType) {
          if (field.visibility === "private" && state.activeReceiver !== declaration.name) {
            throw new DiagnosticError(fileName, expression.callee.location, `field ${JSON.stringify(field.name)} is private to class ${JSON.stringify(declaration.name)}`);
          }
          if (hasOwnershipType(receiverType, structs, enums, state) && !isNamedStorageExpression(expression.callee.object)) {
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
        const resolution = { location: expression.location, aggregate: declaration, declaration: method };
        const callable = state.observer?.resolveMethodCall?.(resolution) ?? method;
        if (callable.static) {
          throw new DiagnosticError(fileName, expression.callee.location, `static method ${JSON.stringify(callable.name)} must be called as ${declaration.name}.${callable.name}()`);
        }
        if (receiverView && (callable.receiverMode === "inout" || callable.receiverMode === "move")) {
          throw new DiagnosticError(fileName, expression.callee.object.location, `view ${JSON.stringify(receiverView.target)} is read-only`, {
            code: "Z0205",
            helps: ["call the mutating or consuming method on the owner after the view's last use"],
          });
        }
        if (callable.visibility === "private" && state.activeReceiver !== declaration.name) {
          throw new DiagnosticError(fileName, expression.callee.location, `method ${JSON.stringify(callable.name)} is private to ${declaration.kind} ${JSON.stringify(declaration.name)}`);
        }
        rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
        if (
          callable.receiverMode !== "move"
          && hasOwnershipType(receiverType, structs, enums, state)
          && !isNamedStorageExpression(expression.callee.object)
        ) {
          throw new DiagnosticError(fileName, expression.callee.object.location, "a cleanup-bearing temporary must be bound before borrowing it for a method call");
        }
        const mutableReceiverRoot = callable.receiverMode === "inout"
          ? storageRoot(expression.callee.object)
          : null;
        const consumingReceiverRoot = callable.receiverMode === "move"
          ? storageRoot(expression.callee.object)
          : null;
        if (callable.receiverMode === "inout") {
          const readonlyField = readonlyFieldOnPath(expression.callee.object, structs, state);
          if (readonlyField) {
            throw new DiagnosticError(fileName, expression.callee.object.location, `mutable method ${JSON.stringify(callable.name)} cannot be called through readonly field ${JSON.stringify(readonlyField.name)}`, {
              code: "Z0214",
            });
          }
          if (!mutableReceiverRoot) {
            throw new DiagnosticError(
              fileName,
              expression.callee.object.location,
              declaration.kind === "class"
                ? `mutable method ${JSON.stringify(callable.name)} requires an addressable class reference`
                : `mutable method ${JSON.stringify(callable.name)} requires addressable let storage`,
            );
          }
          const storedReceiver = locals.get(mutableReceiverRoot.name);
          rejectOwnerMutationWhileViewed(mutableReceiverRoot.name, expression.callee.object.location, fileName, state);
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
              `mutable method ${JSON.stringify(callable.name)} cannot be called through immutable binding ${JSON.stringify(mutableReceiverRoot.name)}`,
            );
          }
        }
        checkArguments(
          callable,
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
        registerAsyncCall(callable, expression.location, fileName, state);
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
        if (callable.receiverMode === "move") {
          if (consumingReceiverRoot) rejectOwnerMutationWhileViewed(consumingReceiverRoot.name, expression.callee.object.location, fileName, state);
          consumeOwnedValue(expression.callee.object, receiverType, locals, structs, enums, fileName, state);
        }
        state.observer?.onMethodCall?.(resolution);
        if (callable.errorType) {
          if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
          return resultTypeName(callable.returnType.name, callable.errorType.name);
        }
        const returnedView = parseReceiverViewReturnType(callable.returnType.name);
        if (returnedView) {
          const root = storageRoot(expression.callee.object);
          if (!root || !locals.has(root.name)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "a view-returning method requires a named owner binding", {
              code: "Z0206",
              helps: ["bind the owner before requesting a view"],
            });
          }
          const ownerName = state.viewOrigins.get(root.name)?.owner ?? root.name;
          state.viewCallOrigins.set(expression.location.offset, { owner: ownerName, location: expression.callee.object.location });
        }
        return callable.returnType.name;
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
        if (closure!.declaration.errorType) {
          if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
          return resultTypeName(closure!.declaration.returnType.name, closure!.declaration.errorType.name);
        }
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
        if (target.declaration.errorType) {
          if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
          return resultTypeName(target.declaration.returnType.name, target.declaration.errorType.name);
        }
        return target.declaration.returnType.name;
      }
      if (target?.kind === "foreignFunction") {
        rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
        return checkForeignFunctionCall(
          target.declaration,
          expression.arguments,
          locals,
          globals,
          structs,
          enums,
          fileName,
          expression.location,
          expression.callee.location.offset,
          state,
        );
      }
      if (target?.kind !== "function") {
        throw new DiagnosticError(fileName, expression.callee.location, `unknown function ${JSON.stringify(expression.callee.name)}`);
      }
      const functionResolution = { location: expression.location, declaration: target.declaration };
      const callable = state.observer?.resolveFunctionCall?.(functionResolution) ?? target.declaration;
      rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
      checkArguments(callable, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
      registerAsyncCall(callable, expression.location, fileName, state);
      state.observer?.onFunctionCall?.(functionResolution);
      if (callable.errorType) {
        if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
        return resultTypeName(callable.returnType.name, callable.errorType.name);
      }
      return callable.returnType.name;
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
  const callLoans: AccessLoanSet = new Map();
  if (receiverUse) {
    registerAccessLoan(callLoans, {
      root: receiverUse.name,
      capability: receiverUse.mode,
      lifetime: { kind: "call" },
      location,
    });
  }
  for (let index = 0; index < target.parameters.length; index += 1) {
    const parameter = target.parameters[index];
    const useMode = parseSliceType(parameter.type.name) && parameter.mode === "value" ? "in" : parameter.mode;
    const argument = args[index];
    const root = argument.kind === "argumentReference"
      ? argument.name
      : storageRoot(argument)?.name ?? null;
    if (!root) continue;
    const conflict = registerAccessLoan(callLoans, {
      root,
      capability: useMode,
      lifetime: { kind: "call" },
      location: argument.location,
    });
    if (conflict) {
      throw new DiagnosticError(
        fileName,
        argument.location,
        `overlapping ${conflict.capability} and ${useMode} uses of ${JSON.stringify(root)} in one call are not allowed`,
      );
    }
  }
  for (let index = 0; index < target.parameters.length; index += 1) {
    const parameter = target.parameters[index];
    const argument = args[index];
    if (argument.kind === "identifier" && containsViewType(String(underlyingType(locals.get(argument.name) ?? "unknown")))) {
      if (parameter.mode !== "in" || target.async) {
        throw new DiagnosticError(fileName, argument.location, `view-bearing value ${JSON.stringify(argument.name)} can only enter a synchronous in parameter`, {
          code: "Z0206",
          notes: ["the call cannot store the view or suspend beyond the owner's proven region"],
          helps: ["accept the projected value with `in`, or create an explicitly owned snapshot"],
        });
      }
    }
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
      rejectOwnerMutationWhileViewed(argument.name, argument.location, fileName, state);
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
      state.expressionTypes.set(argument.location.offset, String(underlyingType(stored)));
      state.expressionTypes.set(argument.nameLocation.offset, String(underlyingType(stored)));
      const asyncContext = state.asyncCallContexts.at(-1);
      if (target.async && asyncContext?.mode === "spawn") {
        throw new DiagnosticError(fileName, argument.location, `spawned output borrow of ${JSON.stringify(argument.name)} is not supported`, {
          code: "Z0704",
          notes: ["direct await suspends the caller until initialization finishes; spawned output would leave caller storage concurrently observable"],
          helps: [`use \`await ${target.name}(out ${argument.name})\`, or return an owned result from the spawned task`],
        });
      }
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
      const asyncContext = state.asyncCallContexts.at(-1);
      const spawnedAsyncBorrow = Boolean(target.async && asyncContext?.mode === "spawn");
      if (!spawnedAsyncBorrow) {
        rejectOwnerMutationWhileViewed(argument.name, argument.location, fileName, state);
      }
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
      state.expressionTypes.set(argument.location.offset, String(storedType));
      state.expressionTypes.set(argument.nameLocation.offset, String(storedType));
      if (target.async && asyncContext?.mode === "spawn") {
        if (state.asyncScopeDepth === 0) {
          throw new DiagnosticError(fileName, argument.location, `spawned mutable borrow of ${JSON.stringify(argument.name)} requires an explicit async scope`, {
            code: "Z0704",
            notes: ["the scope join bounds exclusive child access before caller storage can be read, mutated, moved, or destroyed"],
            helps: ["place the spawn inside `async scope { ... }`, use direct `await`, or transfer ownership into the spawned task"],
          });
        }
        recordAsyncSpawnBorrow(argument.name, argument.location, "inout", asyncContext.spawnOffset!, fileName, state);
      }
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
      if (
        !isNamedStorageExpression(argument)
        && argument.kind !== "structExpression"
        && !aggregateTemporary
        && argument.kind !== "template"
        && argument.kind !== "string"
      ) {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `borrowed argument to ${JSON.stringify(target.name)} must be stored or a struct literal`,
        );
      }
      const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
      const borrowedActual = parseViewType(String(actual))?.target ?? actual;
      if (
        hasOwnershipType(borrowedActual, structs, enums, state)
        && !isNamedStorageExpression(argument)
        && argument.kind !== "template"
        && argument.kind !== "string"
      ) {
        throw new DiagnosticError(fileName, argument.location, "a cleanup-bearing borrowed temporary must be bound before the call");
      }
      requireAssignable(parameter.type.name, borrowedActual, argument, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      state.nativeArgumentAccesses.set(argument.location.offset, "in");
      const asyncContext = state.asyncCallContexts.at(-1);
      if (target.async && asyncContext?.mode === "spawn") {
        const borrowedRoot = storageRoot(argument)?.name ?? null;
        if (state.asyncScopeDepth === 0) {
          throw new DiagnosticError(fileName, argument.location, `spawned borrow of ${JSON.stringify(borrowedRoot ?? "value")} requires an explicit async scope`, {
            code: "Z0704",
            notes: ["the scope join bounds the child task before borrowed caller storage can be destroyed"],
            helps: ["place the spawn and its uses inside `async scope { ... }`, or pass ownership instead"],
          });
        }
        if (!borrowedRoot) {
          throw new DiagnosticError(fileName, argument.location, "a spawned async borrow requires named storage", {
            code: "Z0704",
            helps: ["bind the value before borrowing it into the spawned task"],
          });
        }
        recordAsyncSpawnBorrow(borrowedRoot, argument.location, "in", asyncContext.spawnOffset!, fileName, state);
      }
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
      const asyncContext = state.asyncCallContexts.at(-1);
      if (target.async && asyncContext?.mode === "spawn") {
        const borrowedRoot = storageRoot(argument)?.name ?? null;
        if (state.asyncScopeDepth === 0) {
          throw new DiagnosticError(fileName, argument.location, `spawned Slice borrow of ${JSON.stringify(borrowedRoot ?? "value")} requires an explicit async scope`, {
            code: "Z0704",
            notes: ["the scope join keeps the Slice backing storage alive and stable until the child finishes"],
            helps: ["place the spawn inside `async scope { ... }`, or use direct `await`"],
          });
        }
        if (!borrowedRoot) {
          throw new DiagnosticError(fileName, argument.location, "a spawned async Slice borrow requires named storage", {
            code: "Z0704",
            helps: ["bind the backing collection before borrowing it into the spawned task"],
          });
        }
        recordAsyncSpawnBorrow(borrowedRoot, argument.location, "in", asyncContext.spawnOffset!, fileName, state);
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
  force = false,
): void {
  if (!force && !hasOwnershipType(type, structs, enums, state)) return;
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
    throw new DiagnosticError(fileName, expression.location, "cannot move an ownership-bearing field or element out of its owner", {
      code: "Z0204",
      notes: [
        "the containing aggregate still owns this value and remains responsible for its deterministic cleanup",
        "moving the field would leave the containing aggregate responsible for emptied storage",
      ],
      helps: [
        "inspect it through `in`, a non-escaping callback, or a value-struct `view`; use an explicitly owned snapshot when it must escape",
      ],
    });
  }
  if (expression.kind !== "identifier") return;
  rejectOwnerMutationWhileViewed(expression.name, expression.location, fileName, state, "move");
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

function accessCapabilitiesConflict(left: AccessCapability, right: AccessCapability): boolean {
  return !((left === "in" && right === "in") || (left === "value" && right === "value"));
}

function registerAccessLoan(loans: AccessLoanSet, loan: AccessLoan): AccessLoan | null {
  const active = loans.get(loan.root) ?? [];
  const conflict = active.find((candidate) => (
    accessCapabilitiesConflict(candidate.capability, loan.capability)
  ));
  if (conflict) return conflict;
  loans.set(loan.root, [...active, loan]);
  return null;
}

function bindViewOrigin(
  binding: string,
  origin: { readonly owner: string; readonly location: SourceLocation },
  fileName: string,
  state: AnalysisState,
): void {
  unbindViewOrigin(binding, state);
  const conflict = registerAccessLoan(state.activeLoans, {
    root: origin.owner,
    capability: "in",
    lifetime: { kind: "view", binding },
    location: origin.location,
  });
  if (conflict) {
    throw new DiagnosticError(fileName, origin.location, `cannot create view ${JSON.stringify(binding)} while ${JSON.stringify(origin.owner)} has an active ${conflict.capability} loan`, {
      code: conflict.lifetime.kind === "task" ? "Z0704" : "Z0205",
      labels: [{ location: conflict.location, message: `active ${conflict.capability} loan begins here`, length: origin.owner.length }],
      notes: ["views and call- or task-lifetime access use the same exclusivity rules"],
      helps: ["finish the conflicting access before creating the view"],
    });
  }
  state.viewOrigins.set(binding, origin);
}

function unbindViewOrigin(binding: string, state: AnalysisState): void {
  const origin = state.viewOrigins.get(binding);
  if (!origin) return;
  const remaining = (state.activeLoans.get(origin.owner) ?? []).filter((loan) => (
    loan.lifetime.kind !== "view" || loan.lifetime.binding !== binding
  ));
  if (remaining.length > 0) state.activeLoans.set(origin.owner, remaining);
  else state.activeLoans.delete(origin.owner);
  state.viewOrigins.delete(binding);
}

function snapshotAccessLoanState(state: AnalysisState): AccessLoanState {
  return {
    activeLoans: new Map(state.activeLoans),
    taskBorrowSpawns: new Map(state.asyncTaskBorrowSpawns),
  };
}

function restoreAccessLoanState(state: AnalysisState, snapshot: AccessLoanState): void {
  state.activeLoans.clear();
  for (const [root, loans] of snapshot.activeLoans) state.activeLoans.set(root, loans);

  state.asyncSpawnBorrowRoots.clear();
  for (const [root, loans] of snapshot.activeLoans) {
    for (const loan of loans) {
      if (loan.lifetime.kind !== "task") continue;
      const roots = state.asyncSpawnBorrowRoots.get(loan.lifetime.spawnOffset) ?? [];
      if (!roots.includes(root)) {
        state.asyncSpawnBorrowRoots.set(loan.lifetime.spawnOffset, [...roots, root]);
      }
    }
  }

  const activeSpawns = new Set(state.asyncSpawnBorrowRoots.keys());
  state.asyncTaskBorrowSpawns.clear();
  for (const [task, spawnOffset] of snapshot.taskBorrowSpawns) {
    if (activeSpawns.has(spawnOffset)) state.asyncTaskBorrowSpawns.set(task, spawnOffset);
  }
}

function mergeAccessLoanStates(state: AnalysisState, paths: readonly AccessLoanState[]): void {
  const activeLoans: AccessLoanSet = new Map();
  const seen = new Set<string>();
  for (const path of paths) {
    for (const [root, loans] of path.activeLoans) {
      for (const loan of loans) {
        const lifetime = loan.lifetime.kind === "task"
          ? `task:${loan.lifetime.spawnOffset}`
          : loan.lifetime.kind === "view"
            ? `view:${loan.lifetime.binding}`
            : "call";
        const key = `${root}:${loan.capability}:${lifetime}:${loan.location.offset}`;
        if (seen.has(key)) continue;
        seen.add(key);
        activeLoans.set(root, [...(activeLoans.get(root) ?? []), loan]);
      }
    }
  }

  const activeSpawns = new Set<number>();
  for (const loans of activeLoans.values()) {
    for (const loan of loans) {
      if (loan.lifetime.kind === "task") activeSpawns.add(loan.lifetime.spawnOffset);
    }
  }
  const taskBorrowSpawns = new Map<string, number>();
  for (const path of paths) {
    for (const [task, spawnOffset] of path.taskBorrowSpawns) {
      if (activeSpawns.has(spawnOffset)) taskBorrowSpawns.set(task, spawnOffset);
    }
  }
  restoreAccessLoanState(state, { activeLoans, taskBorrowSpawns });
}

function recordAsyncSpawnBorrow(
  root: string,
  location: SourceLocation,
  mode: "in" | "inout",
  spawnOffset: number,
  fileName: string,
  state: AnalysisState,
): void {
  const active = state.activeLoans.get(root) ?? [];
  const duplicate = active.some((loan) => (
    loan.lifetime.kind === "task" && loan.lifetime.spawnOffset === spawnOffset
  ));
  if (!duplicate) {
    const conflict = registerAccessLoan(state.activeLoans, {
      root,
      capability: mode,
      lifetime: { kind: "task", spawnOffset },
      location,
    });
    if (conflict) {
      throw new DiagnosticError(fileName, location, `cannot borrow ${JSON.stringify(root)} as ${mode} while an active ${conflict.capability} loan exists`, {
        code: "Z0704",
        labels: [{ location: conflict.location, message: `active ${conflict.capability} loan begins here`, length: root.length }],
        notes: ["call- and task-lifetime access use the same exclusivity rules"],
        helps: ["join the active task before starting an overlapping borrow"],
      });
    }
  }
  const roots = state.asyncSpawnBorrowRoots.get(spawnOffset) ?? [];
  if (!roots.includes(root)) state.asyncSpawnBorrowRoots.set(spawnOffset, [...roots, root]);
}

function releaseAsyncTaskBorrows(task: string, state: AnalysisState): void {
  if (state.asyncLoopDepth > 0) return;
  const spawnOffset = state.asyncTaskBorrowSpawns.get(task);
  if (spawnOffset === undefined) return;
  for (const root of state.asyncSpawnBorrowRoots.get(spawnOffset) ?? []) {
    const remaining = (state.activeLoans.get(root) ?? []).filter((loan) => (
      loan.lifetime.kind !== "task" || loan.lifetime.spawnOffset !== spawnOffset
    ));
    if (remaining.length > 0) state.activeLoans.set(root, remaining);
    else state.activeLoans.delete(root);
  }
  state.asyncSpawnBorrowRoots.delete(spawnOffset);
  state.asyncTaskBorrowSpawns.delete(task);
}

function rejectOwnerMutationWhileViewed(
  owner: string,
  location: SourceLocation,
  fileName: string,
  state: AnalysisState,
  action = "mutate",
): void {
  const asyncBorrow = state.activeLoans.get(owner)?.find((loan) => loan.lifetime.kind === "task");
  if (asyncBorrow) {
    throw new DiagnosticError(fileName, location, `cannot ${action} ${JSON.stringify(owner)} while a spawned task borrows it`, {
      code: "Z0704",
      labels: [{
        location: asyncBorrow.location,
        message: `spawned ${asyncBorrow.capability === "inout" ? "mutable" : "immutable"} borrow begins here`,
        length: owner.length,
      }],
      notes: [`the ${asyncBorrow.capability === "inout" ? "exclusive borrow" : "borrow"} remains live until the enclosing async scope joins its child tasks`],
      helps: ["finish the async scope before mutating or moving the borrowed value"],
    });
  }
  const active = state.activeLoans.get(owner)?.find((loan) => loan.lifetime.kind === "view");
  if (!active || active.lifetime.kind !== "view") return;
  const viewName = active.lifetime.binding;
  throw new DiagnosticError(fileName, location, `cannot ${action} ${JSON.stringify(owner)} while view ${JSON.stringify(viewName)} is live`, {
    code: "Z0205",
    labels: [{ location: active.location, message: `view ${JSON.stringify(viewName)} begins here`, length: owner.length }],
    notes: ["a receiver-tied view reads directly from its owner's storage"],
    helps: [`finish using ${JSON.stringify(viewName)} before mutating or moving ${JSON.stringify(owner)}`],
  });
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
      notes: ["ownership-bearing values have a single owner and cannot be used after ownership transfers"],
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
  if (!hasOwnershipType(type, structs, enums, state)) return;
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
  return type.startsWith(borrowedPrefix) || Boolean(parseViewType(String(type)));
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
  const incomingLoans = snapshotAccessLoanState(state);
  const continuingLoans: AccessLoanState[] = [];

  const thenLocals = narrowedConditionLocals(original, statement.condition, true, state);
  analyzeStatement(statement.thenBranch, owner, thenLocals, globals, structs, enums, fileName, state);
  if (!statementStopsFlow(statement.thenBranch)) {
    continuing.push(thenLocals);
    continuingLoans.push(snapshotAccessLoanState(state));
  }

  restoreAccessLoanState(state, incomingLoans);
  if (statement.elseBranch) {
    const elseLocals = narrowedConditionLocals(original, statement.condition, false, state);
    analyzeStatement(statement.elseBranch, owner, elseLocals, globals, structs, enums, fileName, state);
    if (!statementStopsFlow(statement.elseBranch)) {
      continuing.push(elseLocals);
      continuingLoans.push(snapshotAccessLoanState(state));
    }
  } else {
    continuing.push(narrowedConditionLocals(original, statement.condition, false, state));
    continuingLoans.push(snapshotAccessLoanState(state));
  }
  mergeOwnershipStates(locals, continuing, state);
  if (continuingLoans.length > 0) mergeAccessLoanStates(state, continuingLoans);
  else restoreAccessLoanState(state, incomingLoans);
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
    if (conditionType !== "boolean") {
      requireAssignable(
        "boolean",
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
    const elementBinding = hasOwnershipType(collection.elementType, structs, enums, state)
      ? `${borrowedPrefix}${collection.elementType}`
      : collection.elementType;
    bodyLocals.set(statement.binding, elementBinding);

    const frame: LoopAnalysisFrame = { breaks: [], continues: [] };
    const previousIterationBorrow = state.iterationBorrowOrigins.get(root.name);
    const previousElementBorrow = state.borrowOrigins.get(statement.binding);
    state.iterationBorrowOrigins.set(root.name, statement.location);
    if (hasOwnershipType(collection.elementType, structs, enums, state)) {
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
  if (actual === "String" || actual === "TextBuffer" || actual === "Arena") return true;
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

function hasOwnershipType(
  type: ValueType,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  state: AnalysisState,
): boolean {
  return hasCleanupType(type, structs, enums, state.foreignTypes)
    || hasMoveOnlyForeignType(type, structs, enums, state.foreignNamedTypes);
}

type ThreadTransferKind = "copy" | "move";

type ShareabilityIssue = {
  readonly reason: string;
  readonly help: string;
};

function foreignThreadTransferIssue(type: ValueType, state: AnalysisState): ShareabilityIssue | null {
  const actual = String(underlyingType(type));
  const named = state.foreignNamedTypes.get(actual);
  if (named?.kind === "value") {
    if (named.thread.share) {
      return {
        reason: `${named.cName} declares native thread sharing, which is reserved but not executable yet`,
        help: "use a uniquely owned transfer contract today; shared native identity needs a retained/thread-safe representation",
      };
    }
    if (named.lifecycle.copy || !named.lifecycle.move) {
      return {
        reason: `${named.cName} is not a uniquely movable native value in the first thread tier`,
        help: "use a move-only native value, or wait for native copy/share capture lowering",
      };
    }
    if (!named.thread.transfer) {
      return {
        reason: `${named.cName} has no thread transfer contract`,
        help: `add \`thread { transfer; deinit; }\` to its trusted .zd type contract after verifying the native guarantee`,
      };
    }
    if (!named.thread.deinit) {
      return {
        reason: `${named.cName} cannot be destroyed on the receiving thread`,
        help: "add deinit to its thread contract only when native destruction is safe there",
      };
    }
  }
  const pointer = state.foreignTypes.get(actual);
  if (pointer) {
    if (pointer.thread.share) {
      return {
        reason: `${pointer.cName} declares native thread sharing, which is reserved but not executable yet`,
        help: "use an owned transfer contract today; shared native handles need an explicit retain/release representation",
      };
    }
    if (pointer.ownership !== "owned") {
      return {
        reason: `${pointer.cName} is a borrowed native pointer`,
        help: "return or construct an owned handle before crossing the thread boundary",
      };
    }
    if (!pointer.thread.transfer) {
      return {
        reason: `${pointer.cName} has no thread transfer contract`,
        help: "add a trusted thread transfer contract to the owned producer result",
      };
    }
    if (!pointer.thread.deinit) {
      return {
        reason: `${pointer.cName} release is not declared safe on the receiving thread`,
        help: "add deinit to the result thread contract only when its release function is safe there",
      };
    }
  }
  return null;
}

function shareableTypeIssue(
  type: ValueType,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  state: AnalysisState,
  visiting: Set<string> = new Set(),
  path = String(underlyingType(type)),
): ShareabilityIssue | null {
  const actual = String(underlyingType(type));
  if (actual === "void" || actual === "boolean" || integerTypes.has(actual) || floatTypes.has(actual) || actual === "String") {
    return null;
  }
  if (actual === "TextBuffer" || parseDynamicArrayType(actual)) {
    return {
      reason: `${path} contains mutable ${displayArrayType(actual)} storage`,
      help: ["store an immutable owned snapshot such as String", "or keep this class on one thread"].join(", "),
    };
  }
  if (actual === "Arena" || parseViewType(actual) || parseSliceType(actual) || parseTaskType(actual) || parseWeakType(actual)) {
    return {
      reason: `${path} contains thread-local type ${displayArrayType(actual)}`,
      help: "replace the field with owned immutable state, or keep this class on one thread",
    };
  }
  if (state.foreignNamedTypes.has(actual) || state.foreignTypes.has(actual) || state.foreignObjectTypes.has(actual)) {
    return {
      reason: `${path} contains native type ${actual} without a cross-thread contract`,
      help: "pass an owned Z snapshot, or keep the native value on its required thread",
    };
  }
  if (visiting.has(actual)) return null;
  const fixed = parseFixedArrayType(actual);
  if (fixed) {
    return {
      reason: `${path} contains mutable fixed-array storage`,
      help: "store an immutable value aggregate, or keep this class on one thread",
    };
  }
  const aggregate = structs.get(actual);
  if (aggregate) {
    if (aggregate.deinitializer) {
      return {
        reason: `${path} has a custom deinit whose thread affinity is unknown`,
        help: "remove custom deinit from the shared graph, or keep this class on one thread",
      };
    }
    const mutableMethod = aggregate.methods.find((method) => !method.static && method.receiverMode === "inout");
    if (mutableMethod) {
      return {
        reason: `${path} exposes mutable method ${JSON.stringify(mutableMethod.name)}`,
        help: "use readonly behavior for shared identity, or keep mutable identity on one thread",
      };
    }
    visiting.add(actual);
    for (const field of aggregate.fields) {
      if (!field.readonly) {
        visiting.delete(actual);
        return {
          reason: `${path} has mutable field ${JSON.stringify(field.name)}`,
          help: `mark ${JSON.stringify(field.name)} readonly after confirming its reachable value is immutable`,
        };
      }
      const issue = shareableTypeIssue(field.type.name, structs, enums, state, visiting, `${path}.${field.name}`);
      if (issue) {
        visiting.delete(actual);
        return issue;
      }
    }
    visiting.delete(actual);
    return null;
  }
  const enumeration = enums.get(actual);
  if (enumeration) {
    visiting.add(actual);
    for (const variant of enumeration.variants) {
      if (!variant.payload) continue;
      const issue = shareableTypeIssue(variant.payload.name, structs, enums, state, visiting, `${path}.${variant.name}`);
      if (issue) {
        visiting.delete(actual);
        return issue;
      }
    }
    visiting.delete(actual);
    return null;
  }
  return {
    reason: `${path} has unknown cross-thread representation ${actual}`,
    help: "use a primitive, String, or deeply readonly Z aggregate",
  };
}

function initialThreadTransferKind(
  type: ValueType,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  state: AnalysisState,
  visiting: Set<string> = new Set(),
): ThreadTransferKind | null {
  const actual = String(underlyingType(type));
  if (actual === "void" || actual === "boolean" || integerTypes.has(actual) || floatTypes.has(actual)) return "copy";
  if (actual === "String" || actual === "TextBuffer") return "move";
  if (parseViewType(actual) || parseSliceType(actual) || parseTaskType(actual)) return null;
  const fixed = parseFixedArrayType(actual);
  if (fixed) return initialThreadTransferKind(fixed.elementType, structs, enums, state, visiting);
  const dynamic = parseDynamicArrayType(actual);
  if (dynamic) {
    return initialThreadTransferKind(dynamic.elementType, structs, enums, state, visiting) ? "move" : null;
  }
  const foreignNamed = state.foreignNamedTypes.get(actual);
  if (foreignNamed) {
    return foreignNamed.kind === "value"
      && foreignNamed.lifecycle.move
      && !foreignNamed.lifecycle.copy
      && foreignNamed.thread.transfer
      && foreignNamed.thread.deinit
      ? "move"
      : null;
  }
  const foreignPointer = state.foreignTypes.get(actual);
  if (foreignPointer) {
    return foreignPointer.ownership === "owned"
      && foreignPointer.thread.transfer
      && foreignPointer.thread.deinit
      ? "move"
      : null;
  }
  if (state.foreignObjectTypes.has(actual)) return null;
  if (visiting.has(actual)) return null;
  const aggregate = structs.get(actual);
  if (aggregate) {
    if (aggregate.kind === "class") return state.shareableClasses.has(actual) ? "copy" : null;
    if (aggregate.deinitializer) return null;
    visiting.add(actual);
    const fields = aggregate.fields.map((field) => (
      initialThreadTransferKind(field.type.name, structs, enums, state, visiting)
    ));
    visiting.delete(actual);
    if (fields.some((field) => field === null)) return null;
    return fields.some((field) => field === "move") ? "move" : "copy";
  }
  const enumeration = enums.get(actual);
  if (enumeration) {
    visiting.add(actual);
    const variants = enumeration.variants.map((variant) => (
      variant.payload ? initialThreadTransferKind(variant.payload.name, structs, enums, state, visiting) : "copy"
    ));
    visiting.delete(actual);
    if (variants.some((variant) => variant === null)) return null;
    return variants.some((variant) => variant === "move") ? "move" : "copy";
  }
  return null;
}

function hasMoveOnlyForeignType(
  type: ValueType,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  visiting = new Set<string>(),
): boolean {
  const actual = String(underlyingType(type));
  if (actual === "unknown" || actual === "never" || visiting.has(actual)) return false;
  const foreign = foreignNamedTypes.get(actual);
  if (foreign?.kind === "value") return foreign.lifecycle.move && !foreign.lifecycle.copy;
  const array = parseFixedArrayType(actual);
  if (array) return hasMoveOnlyForeignType(array.elementType, structs, enums, foreignNamedTypes, visiting);
  const dynamic = parseDynamicArrayType(actual);
  if (dynamic) return hasMoveOnlyForeignType(dynamic.elementType, structs, enums, foreignNamedTypes, visiting);
  const declaration = structs.get(actual);
  const enumDeclaration = enums.get(actual);
  if (!declaration && !enumDeclaration) return false;
  if (declaration?.kind === "class") return false;
  visiting.add(actual);
  const result = declaration
    ? declaration.fields.some((field) => hasMoveOnlyForeignType(field.type.name, structs, enums, foreignNamedTypes, visiting))
    : enumDeclaration!.variants.some((variant) => (
      variant.payload && hasMoveOnlyForeignType(variant.payload.name, structs, enums, foreignNamedTypes, visiting)
    ));
  visiting.delete(actual);
  return Boolean(result);
}

function isForeignMember(
  expression: Extract<Expression, { kind: "member" }>,
  globals: Map<string, SymbolValue>,
): boolean {
  const target = foreignMemberTarget(expression, globals);
  if (!target) return false;
  return target.path.length === 1
    || resolveForeignFunction(target.module, target.path) !== null
    || target.module.namespaces.has(target.path.slice(0, -1).join("."));
}

function foreignMemberTarget(
  expression: Extract<Expression, { kind: "member" }>,
  globals: Map<string, SymbolValue>,
): { readonly module: ForeignModule; readonly path: readonly string[] } | null {
  const path = [expression.property];
  let object: Expression = expression.object;
  while (object.kind === "member") {
    path.unshift(object.property);
    object = object.object;
  }
  if (object.kind !== "identifier") return null;
  const symbol = globals.get(object.name);
  if (symbol?.kind === "foreignModule") return { module: symbol.module, path };
  if (symbol?.kind === "foreignNamespace") {
    return { module: symbol.module, path: [...symbol.namespacePath, ...path] };
  }
  return null;
}

function resolveForeignFunction(module: ForeignModule, path: readonly string[]): ForeignFunction | null {
  const qualifiedName = path.join(".");
  const direct = module.functions.get(qualifiedName);
  if (direct) return direct;
  if (path.length !== 1) return null;
  const alias = module.functionAliases.get(path[0]);
  return alias ? module.functions.get(alias) ?? null : null;
}

function resolveForeignNamedType(module: ForeignModule, path: readonly string[]): ForeignNamedType | null {
  const qualifiedName = path.join(".");
  const direct = module.namedTypes.get(qualifiedName);
  if (direct) return direct;
  if (path.length !== 1) return null;
  const alias = module.namedTypeAliases.get(path[0]);
  return alias ? module.namedTypes.get(alias) ?? null : null;
}

function getForeignFunction(
  expression: Extract<Expression, { kind: "member" }>,
  globals: Map<string, SymbolValue>,
): ForeignFunction | null {
  const target = foreignMemberTarget(expression, globals);
  return target ? resolveForeignFunction(target.module, target.path) : null;
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

function checkForeignAvailability(
  metadata: ForeignDeclarationMetadata,
  name: string,
  location: SourceLocation,
  fileName: string,
  state: AnalysisState,
): void {
  const unavailable = metadata.availability.find((item) => (
    item.unavailable && foreignPlatformApplies(item.platform, state.deploymentTarget)
  ));
  if (unavailable) {
    const platform = unavailable.platform ? ` on ${displayTargetPlatform(normalizeTargetPlatform(unavailable.platform))}` : "";
    throw nativeAvailabilityError(fileName, location, metadata, name, `foreign declaration ${JSON.stringify(name)} is unavailable${platform}`, unavailable.message);
  }
  const target = state.deploymentTarget;
  if (!target) return;
  const availability = metadata.availability.filter((item) => foreignPlatformApplies(item.platform, target));
  const introduced = availability.find((item) => item.introduced)?.introduced ?? null;
  if (introduced && compareTargetVersions(target.minimumVersion, introduced) < 0) {
    throw nativeAvailabilityError(
      fileName,
      location,
      metadata,
      name,
      `foreign declaration ${JSON.stringify(name)} requires ${displayTargetPlatform(target.platform)} ${introduced}, but the deployment target is ${displayTargetPlatform(target.platform)} ${target.minimumVersion}`,
      availability.find((item) => item.introduced === introduced)?.message ?? null,
      [`raise target.minimumVersion to ${JSON.stringify(introduced)} or choose an API available on ${target.minimumVersion}`],
    );
  }
  const obsoleted = availability.find((item) => item.obsoleted)?.obsoleted ?? null;
  if (obsoleted && compareTargetVersions(target.minimumVersion, obsoleted) >= 0) {
    throw nativeAvailabilityError(
      fileName,
      location,
      metadata,
      name,
      `foreign declaration ${JSON.stringify(name)} was obsoleted in ${displayTargetPlatform(target.platform)} ${obsoleted}; the deployment target is ${target.minimumVersion}`,
      availability.find((item) => item.obsoleted === obsoleted)?.message ?? null,
      ["use the native replacement API for this deployment target"],
    );
  }
  const deprecated = availability.find((item) => (
    item.deprecated
    && (!item.deprecatedVersion || compareTargetVersions(target.minimumVersion, item.deprecatedVersion) >= 0)
  ));
  if (!deprecated) return;
  const warningKey = `${location.fileName ?? fileName}:${location.offset}:${name}:deprecated`;
  if (state.warningKeys.has(warningKey)) return;
  state.warningKeys.add(warningKey);
  const version = deprecated.deprecatedVersion ? ` in ${displayTargetPlatform(target.platform)} ${deprecated.deprecatedVersion}` : "";
  state.warnings.push(new DiagnosticError(
    fileName,
    location,
    `foreign declaration ${JSON.stringify(name)} is deprecated${version}`,
    {
      severity: "warning",
      code: "Z0804",
      length: name.split(":")[0].length,
      labels: nativeAvailabilityLabels(metadata, "native declaration is deprecated here"),
      notes: deprecated.message ? [deprecated.message] : [],
    },
  ));
}

function nativeAvailabilityError(
  fileName: string,
  location: SourceLocation,
  metadata: ForeignDeclarationMetadata,
  name: string,
  summary: string,
  note: string | null,
  helps: readonly string[] = [],
): DiagnosticError {
  return new DiagnosticError(fileName, location, summary, {
    code: "Z0802",
    length: name.split(":")[0].length,
    labels: nativeAvailabilityLabels(metadata, "native availability is declared here"),
    notes: note ? [note] : [],
    helps,
  });
}

function nativeAvailabilityLabels(metadata: ForeignDeclarationMetadata, message: string): DiagnosticLabel[] {
  return metadata.source ? [{
    location: {
      offset: 0,
      line: metadata.source.line,
      column: metadata.source.column,
      fileName: metadata.source.fileName,
    },
    message,
    length: metadata.source.length,
  }] : [];
}

function foreignPlatformApplies(platform: string | null, target: DeploymentTarget | null): boolean {
  if (!platform) return true;
  if (target) return normalizeTargetPlatform(platform) === target.platform;
  return normalizeTargetPlatform(platform) === normalizeTargetPlatform(process.platform);
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
  if (type.kind === "swiftString") return swiftStringTypeName;
  if (type.kind === "named") return type.type.typeName;
  if (type.kind === "reference") return type.type.kind === "scalar" ? type.type.underlying : type.type.typeName;
  if (type.kind === "pointer" || type.kind === "object") return type.typeName;
  if (type.kind === "pointerOut") return type.pointer.typeName;
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

function contextualSwiftStringToZ(
  expected: ValueType,
  actual: ValueType,
  expression: Expression,
  state: AnalysisState,
): ValueType | null {
  if (underlyingType(expected) !== "String" || actual !== swiftStringTypeName) return null;
  state.swiftStringsToZ.add(expression.location.offset);
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

function checkForeignFunctionCall(
  target: ForeignFunction,
  args: Expression[],
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  location: SourceLocation,
  calleeOffset: number,
  state: AnalysisState,
  onSelected?: (overload: ForeignFunctionOverload) => void,
  subject = "foreign function",
): ValueType {
  if (target.overloads.length === 1) {
    const selected = target.overloads[0];
    checkForeignAvailability(selected.metadata, target.qualifiedName, location, fileName, state);
    state.foreignFunctionNames.set(calleeOffset, selected.cName);
    state.foreignFunctionDefinitions.set(calleeOffset, selected.metadata);
    onSelected?.(selected);
    return checkForeignCall(selected, args, locals, globals, structs, enums, fileName, location, state);
  }
  const matches: { readonly overload: ForeignFunctionOverload; readonly score: number }[] = [];
  for (const overload of target.overloads) {
    const trialLocals = new Map(locals);
    const trialState = cloneAnalysisState(state);
    try {
      checkForeignCall(overload, args, trialLocals, globals, structs, enums, fileName, location, trialState);
      matches.push({ overload, score: foreignOverloadScore(overload, args, trialState) });
    } catch (error) {
      if (!(error instanceof DiagnosticError)) throw error;
    }
  }
  if (matches.length === 0) {
    throw new DiagnosticError(
      fileName,
      location,
      `no overload of ${subject} ${JSON.stringify(target.qualifiedName)} accepts these arguments`,
      {
        code: "Z0803",
        notes: target.overloads.map((candidate) => `${candidate.cName}: ${candidate.cSignature}`),
        helps: ["check the argument count and types against one of the native signatures"],
      },
    );
  }
  const bestScore = Math.max(...matches.map((match) => match.score));
  const best = matches.filter((match) => match.score === bestScore);
  if (best.length !== 1) {
    const capabilityShapes = new Set(best.map(({ overload }) => overload.parameters.map((parameter) => (
      parameter.type.kind === "reference" ? parameter.type.access : "value"
    )).join(",")));
    const capabilityChoice = capabilityShapes.size > 1;
    throw new DiagnosticError(
      fileName,
      location,
      capabilityChoice
        ? `call to ${subject} ${JSON.stringify(target.qualifiedName)} requires an explicit argument capability choice`
        : `call to ${subject} ${JSON.stringify(target.qualifiedName)} is ambiguous`,
      {
        code: "Z0803",
        notes: best.map(({ overload }) => `${overload.cName}: ${overload.cSignature}`),
        helps: [capabilityChoice
          ? "use a uniquely named native function until Z has syntax for selecting borrowed, mutable, or consuming reference overloads"
          : "bind an argument to an explicit Z type or use the fully qualified native namespace path"],
      },
    );
  }
  const selected = best[0].overload;
  checkForeignAvailability(selected.metadata, target.qualifiedName, location, fileName, state);
  state.foreignFunctionNames.set(calleeOffset, selected.cName);
  state.foreignFunctionDefinitions.set(calleeOffset, selected.metadata);
  onSelected?.(selected);
  return checkForeignCall(selected, args, locals, globals, structs, enums, fileName, location, state);
}

function checkForeignCxxConstructorCall(
  declaration: Extract<ForeignNamedType, { readonly kind: "value" }>,
  args: Expression[],
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  location: SourceLocation,
  calleeOffset: number,
  state: AnalysisState,
): ValueType {
  if (declaration.constructors.length === 0) {
    throw new DiagnosticError(
      fileName,
      location,
      `native value ${JSON.stringify(declaration.typeName)} has no imported public constructor`,
    );
  }
  return checkForeignFunctionCall(
    {
      name: declaration.exportName,
      namespacePath: declaration.namespacePath,
      qualifiedName: declaration.qualifiedName,
      overloads: declaration.constructors,
    },
    args,
    locals,
    globals,
    structs,
    enums,
    fileName,
    location,
    calleeOffset,
    state,
    undefined,
    "native constructor",
  );
}

function checkForeignCxxStaticMethodCall(
  declaration: Extract<ForeignNamedType, { readonly kind: "value" }>,
  method: Extract<ForeignNamedType, { readonly kind: "value" }>["staticMethods"][number],
  args: Expression[],
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  location: SourceLocation,
  calleeOffset: number,
  state: AnalysisState,
): ValueType {
  return checkForeignFunctionCall(
    {
      name: method.name,
      namespacePath: declaration.namespacePath,
      qualifiedName: `${declaration.qualifiedName}.${method.name}`,
      overloads: method.overloads,
    },
    args,
    locals,
    globals,
    structs,
    enums,
    fileName,
    location,
    calleeOffset,
    state,
    undefined,
    "native static method",
  );
}

function cloneAnalysisState(state: AnalysisState): AnalysisState {
  const clone: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(state)) {
    clone[name] = value instanceof Map ? new Map(value) : value instanceof Set ? new Set(value) : value;
  }
  return clone as AnalysisState;
}

function foreignOverloadScore(
  target: ForeignFunctionOverload,
  args: readonly Expression[],
  state: AnalysisState,
): number {
  const parameters = target.parameters.filter((parameter) => (
    parameter.type.kind !== "callbackContext" && parameter.type.kind !== "callbackRelease"
  ));
  let score = target.variadic ? 0 : 2;
  for (let index = 0; index < args.length; index += 1) {
    const parameter = parameters[index];
    if (!parameter) continue;
    const expected = canonicalType(foreignValueType(parameter.type), state.foreignNamedTypes);
    const argument = args[index];
    if (argument.kind === "number" && isNumericType(expected)) {
      if (isIntegerLiteral(argument.value)) {
        score += expected === "i32" ? 8 : isIntegerType(expected) ? 5 : 1;
      } else {
        score += expected === "f64" ? 8 : expected === "f32" ? 5 : 0;
      }
      continue;
    }
    const actual = state.expressionTypes.get(argument.location.offset);
    if (actual && canonicalType(actual, state.foreignNamedTypes) === expected) score += 8;
    else score += 1;
  }
  return score;
}

function checkForeignCall(
  target: ForeignFunctionOverload,
  args: Expression[],
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  location: SourceLocation,
  state: AnalysisState,
): ValueType {
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
      if (parameter?.type.kind === "pointerOut") {
        if (argument.access !== "out") {
          throw new DiagnosticError(
            fileName,
            argument.location,
            `C function ${JSON.stringify(target.name)} expects out ${argument.name}, found ${argument.access} ${argument.name}`,
          );
        }
        let stored = locals.get(argument.name);
        if (!stored) throw new DiagnosticError(fileName, argument.location, `unknown name ${JSON.stringify(argument.name)}`);
        if (underlyingType(stored) === "unknown") {
          const declarationLocation = state.inferredOutBindingLocations.get(argument.name);
          if (!declarationLocation) {
            throw new DiagnosticError(fileName, argument.location, `cannot infer storage type for out argument ${JSON.stringify(argument.name)}`);
          }
          stored = `${uninitializedPrefix}${mutablePrefix}${parameter.type.pointer.typeName}`;
          locals.set(argument.name, stored);
          state.bindingTypes.set(declarationLocation.offset, parameter.type.pointer.typeName);
          state.inferredOutBindingLocations.delete(argument.name);
        }
        if (!isMutableBinding(stored)) {
          throw new DiagnosticError(fileName, argument.location, `out argument ${JSON.stringify(argument.name)} requires a mutable let binding`);
        }
        requireAssignable(
          parameter.type.pointer.typeName,
          underlyingType(stored),
          argument,
          fileName,
          state.foreignNamedTypes,
          state.numericLiteralTypes,
        );
        state.foreignArgumentAccesses.set(argument.location.offset, "out");
        state.expressionTypes.set(argument.location.offset, parameter.type.pointer.typeName);
        state.expressionTypes.set(argument.nameLocation.offset, parameter.type.pointer.typeName);
        locals.set(argument.name, initializedAvailableBinding(stored));
        state.moveOrigins.delete(argument.name);
        continue;
      }
      if (parameter?.type.kind === "reference") {
        if (parameter.type.access !== "inout" || argument.access !== "inout") {
          throw new DiagnosticError(
            fileName,
            argument.location,
            `C++ reference parameter expects ${parameter.type.access === "move" ? "an owned value" : parameter.type.access}, found ${argument.access} ${argument.name}`,
          );
        }
        const stored = locals.get(argument.name);
        if (!stored) throw new DiagnosticError(fileName, argument.location, `unknown name ${JSON.stringify(argument.name)}`);
        if (initializationState(stored) !== "initialized") {
          throw new DiagnosticError(fileName, argument.location, `inout argument ${JSON.stringify(argument.name)} must be initialized before the call`);
        }
        if (ownershipState(stored) !== "available") {
          throw movedValueError(fileName, { name: argument.name, location: argument.location }, state, ownershipState(stored) === "maybeMoved");
        }
        if (!isMutableBinding(stored)) {
          throw new DiagnosticError(fileName, argument.location, `inout argument ${JSON.stringify(argument.name)} requires a mutable let binding`);
        }
        requireAssignable(
          foreignValueType(parameter.type),
          underlyingType(stored),
          argument,
          fileName,
          state.foreignNamedTypes,
          state.numericLiteralTypes,
        );
        rejectOwnerMutationWhileViewed(argument.name, argument.location, fileName, state);
        state.foreignCxxArgumentAccesses.set(argument.location.offset, "inout");
        state.expressionTypes.set(argument.location.offset, String(underlyingType(stored)));
        state.expressionTypes.set(argument.nameLocation.offset, String(underlyingType(stored)));
        continue;
      }
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
      state.expressionTypes.set(argument.location.offset, String(underlyingType(stored)));
      state.expressionTypes.set(argument.nameLocation.offset, String(underlyingType(stored)));
      if (argument.access === "out") {
        locals.set(argument.name, initializedAvailableBinding(stored));
        state.moveOrigins.delete(argument.name);
      }
      continue;
    }
    if (parameter?.type.kind === "pointerOut") {
      throw new DiagnosticError(
        fileName,
        argument.location,
        `C function ${JSON.stringify(target.name)} requires out <mutable binding> for parameter ${index + 1}`,
      );
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
    if (parameter?.type.kind === "reference") {
      if (parameter.type.access === "inout") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C++ mutable reference parameter requires inout <mutable binding> for parameter ${index + 1}`,
        );
      }
      const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
      const expectedReference = foreignValueType(parameter.type);
      requireAssignable(expectedReference, actual, argument, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
      state.foreignCxxArgumentAccesses.set(argument.location.offset, parameter.type.access);
      if (parameter.type.access === "move") {
        consumeOwnedValue(argument, actual, locals, structs, enums, fileName, state, true);
      }
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
    if (!parameter && !isNumericType(canonicalType(actual, state.foreignNamedTypes)) && actual !== "boolean" && actual !== "cstring") {
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
    : target.returnType.kind === "swiftString"
      ? swiftStringTypeName
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
  if (isNullableObjCTypeName(name)) return `${publicObjCTypeName(name)} | null`;
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
  const view = parseViewType(type.name);
  if (view) {
    if (parseViewType(view.target)) {
      throw new DiagnosticError(fileName, type.location, "nested view types are not valid", { code: "Z0206" });
    }
    validateType({ name: view.target, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    return;
  }
  if (isNullableObjCTypeName(type.name)) {
    const target = foreignNamedTypes.get(publicObjCTypeName(type.name));
    if (target?.kind !== "object") {
      throw new DiagnosticError(
        fileName,
        type.location,
        `${JSON.stringify(`${publicObjCTypeName(type.name)} | null`)} currently requires an imported Objective-C reference type`,
        { helps: [`use Option<${publicObjCTypeName(type.name)}> for an optional Z value`] },
      );
    }
    return;
  }
  const functionType = parseFunctionType(type.name);
  if (functionType) {
    if (functionType.parameters.some((parameter) => containsViewType(parameter.type)) || containsViewType(functionType.returnType)) {
      throw new DiagnosticError(fileName, type.location, "function values cannot store or return receiver-tied views", { code: "Z0206" });
    }
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
  if (parsePointerTypeName(type.name)) return;
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

function observeTypeResolution(
  type: TypeReference,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  state: AnalysisState,
): void {
  const observeName = (name: string): void => {
    const view = parseViewType(name);
    if (view) {
      observeName(view.target);
      return;
    }
    const functionType = parseFunctionType(name);
    if (functionType) {
      for (const parameter of functionType.parameters) observeName(parameter.type);
      observeName(functionType.returnType);
      return;
    }
    const weak = parseWeakType(name);
    if (weak) {
      observeName(weak.target);
      return;
    }
    const task = parseTaskType(name);
    if (task) {
      observeName(task.successType);
      if (task.errorType) observeName(task.errorType);
      return;
    }
    const option = parseOptionType(name);
    if (option) {
      observeName(option.target);
      return;
    }
    const container = parseSliceType(name) ?? parseDynamicArrayType(name) ?? parseFixedArrayType(name);
    if (container) {
      observeName(container.elementType);
      return;
    }
    const declaration = structs.get(name) ?? enums.get(name);
    if (declaration) state.observer?.onTypeResolution?.({ location: type.location, declaration });
  };
  observeName(type.name);
}

function containsSliceType(name: string): boolean {
  if (parseSliceType(name)) return true;
  const dynamic = parseDynamicArrayType(name);
  if (dynamic) return containsSliceType(dynamic.elementType);
  const array = parseFixedArrayType(name);
  return array ? containsSliceType(array.elementType) : false;
}

function validateOptionalViewReturn(
  expression: Expression,
  expected: string,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  const variant = optionalViewReturnVariant(expression, expected);
  if (!variant) {
    throw new DiagnosticError(fileName, expression.location, "an optional view method must return Option.some(this projection) or Option.none directly", {
      code: "Z0206",
      notes: ["forwarding optional view storage could detach its provenance from the receiver"],
      helps: ["return a direct field or indexed element with Option.some(...), or return Option.none"],
    });
  }
  const actual = inferDirectValue(expression, owner, locals, globals, structs, enums, fileName, state);
  requireAssignable(expected, actual, expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
}

function optionalViewReturnVariant(expression: Expression, expected: string): "some" | "none" | null {
  if (expression.kind === "variantExpression" && expression.enumName === expected) {
    return expression.variantName === "some" || expression.variantName === "none" ? expression.variantName : null;
  }
  if (expression.kind === "member" && expression.object.kind === "identifier" && expression.object.name === expected) {
    return expression.property === "none" ? "none" : null;
  }
  if (
    expression.kind === "call"
    && expression.callee.kind === "member"
    && expression.callee.object.kind === "identifier"
    && expression.callee.object.name === expected
    && expression.callee.property === "some"
  ) return "some";
  return null;
}

function validateReceiverViewProjection(
  expression: Expression,
  optionType: string,
  target: string,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  if (state.activeFunction?.returnType.name !== optionType || !parseOptionalViewType(optionType)) {
    throw new DiagnosticError(fileName, expression.location, "a view can only enter Option as the direct result of its receiver method", {
      code: "Z0206",
      helps: ["return Option.some(this.field) or Option.some(this.items[index]) from a borrowed value-struct method"],
    });
  }
  const root = storageRoot(expression);
  if (!root || root.name !== "this" || (expression.kind !== "member" && expression.kind !== "index")) {
    throw new DiagnosticError(fileName, expression.location, "an optional view method must project a field or indexed element derived directly from this", {
      code: "Z0206",
      notes: ["forwarding another view or returning local storage would let it escape the wrong owner"],
    });
  }
  const actual = inferExpression(expression, locals, globals, structs, enums, fileName, state);
  requireAssignable(target, actual, expression, fileName, state.foreignNamedTypes, state.numericLiteralTypes);
  state.viewReturnExpressions.add(expression.location.offset);
}

function containsViewType(name: string): boolean {
  if (parseViewType(name)) return true;
  const option = parseOptionType(name);
  if (option) return containsViewType(option.target);
  const functionType = parseFunctionType(name);
  if (functionType) {
    return functionType.parameters.some((parameter) => containsViewType(parameter.type))
      || containsViewType(functionType.returnType);
  }
  const dynamic = parseDynamicArrayType(name);
  if (dynamic) return containsViewType(dynamic.elementType);
  const slice = parseSliceType(name);
  if (slice) return containsViewType(slice.elementType);
  const array = parseFixedArrayType(name);
  return array ? containsViewType(array.elementType) : false;
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
      `expected ${displayAssignableType(expected)}, found ${displayAssignableType(actual)}`,
    );
  }
}

function displayAssignableType(type: ValueType): string {
  const name = String(underlyingType(type));
  return isNullableObjCTypeName(name) ? `${publicObjCTypeName(name)} | null` : displayArrayType(name);
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
  if (!expectedNamed || !actualNamed || expectedNamed.kind !== actualNamed.kind || expectedNamed.cName !== actualNamed.cName) {
    return false;
  }
  if (expectedNamed.kind === "object" && actualNamed.kind === "object") {
    const expectedNullable = isNullableObjCTypeName(String(underlyingType(expected)));
    const actualNullable = isNullableObjCTypeName(String(underlyingType(actual)));
    if (actualNullable && !expectedNullable) return false;
  }
  return true;
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
  return isNullableObjCTypeName(type) || (type.startsWith("__z_ffi:") && type.includes(":nullable:"));
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
