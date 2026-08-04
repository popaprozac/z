import type {
  BlockStatement,
  Expression,
  EnumDeclaration,
  FunctionDeclaration,
  MatchObjectBinding,
  FieldDeclaration,
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
  sliceTypeName,
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
  type ForeignObjCProtocol,
  type ForeignObjCProtocolMethod,
  type ForeignObjectType,
  type ForeignPointerType,
  type ForeignType,
} from "./foreign.ts";
import {
  isStandardModuleSpecifier,
  objcBindingTypeName,
  objcConnectionTypeName,
  objcSelectorTypeName,
  fsLockTypeName,
  nativeConnectionTypeName,
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
import { collectPlacementCaptures } from "./placement-captures.ts";
import {
  isNullableObjCTypeName,
  nullableObjCTypeName,
  publicObjCTypeName,
} from "./objc-types.ts";
import { optionTypeName, parseOptionType } from "./option-types.ts";
import { mapEntryTypeName, parseMapType } from "./map-types.ts";
import { parseSetType } from "./set-types.ts";
import { genericTypeName, parseGenericType } from "./generic-types.ts";
import {
  onceLifetimeTypeName,
  parseOnceLifetimeType,
  parseOnceType,
} from "./once-types.ts";
import { mutexTypeName, parseMutexType } from "./mutex-types.ts";
import type { GenericAggregateMaterialization } from "./generics.ts";
import { parseOptionalViewType, parseReceiverViewReturnType, parseViewType, viewTypeName } from "./view-types.ts";
import { hashableSelfTypeName, hashableTraitDeclaration } from "./hash-types.ts";
import { iteratorTraitDeclaration } from "./iterator-types.ts";
import {
  asyncGeneratorTypeName,
  generatorStepTypeName,
  isAsyncGeneratorFunction,
  isGeneratorFunction,
  parseAsyncGeneratorType,
  parseGeneratorType,
} from "./generator-types.ts";
import {
  displayUnsafeNativeType,
  isUnsafeCStringSpelling,
  isUnsafeNativePointerSpelling,
  normalizeUnsafeNativeSpelling,
  parseUnsafeNativeType,
  unsafeNativeTypeName,
} from "./unsafe-types.ts";

export type ObjCCallInfo = {
  readonly selector: string;
  readonly instance: boolean;
  readonly className: string;
  readonly async: {
    readonly callbackParameter: number;
    readonly resultType: string;
    readonly errorType: string | null;
    readonly parameterTypes: readonly string[];
    readonly method: ForeignObjCMethod;
  } | null;
};

export type ObjCPropertyInfo = {
  readonly getter: string;
  readonly setter: string | null;
  readonly ownership: ForeignObjCProperty["ownership"];
  readonly type: ForeignType;
};

export type ForeignStatusCallInfo = {
  readonly errorType: string;
  readonly success: readonly (number | string)[];
};

export type ForeignConnectionCallInfo = {
  readonly target: ForeignFunctionOverload;
  readonly functionType: string;
  readonly ownerSource: number;
  readonly callbackSource: number;
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
  readonly threadSafe: boolean;
};

export type MutexWithLockCallInfo = {
  readonly valueType: string;
  readonly access: "in" | "inout";
  readonly closureOffset: number;
  readonly functionType: string;
  readonly returnType: string;
  readonly errorType: string | null;
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

export type SemanticBindingResolution = {
  readonly location: SourceLocation;
  readonly name: string;
  readonly mutable: boolean;
  readonly inferredType: string;
  readonly typeIdentities: readonly SemanticTypeIdentity[];
};

export type SemanticExpressionResolution = {
  readonly location: SourceLocation;
  readonly inferredType: string;
  readonly typeIdentities: readonly SemanticTypeIdentity[];
};

export type SemanticTypeIdentity = {
  readonly path: string;
  readonly declaration: StructDeclaration | EnumDeclaration;
};

export type SemanticObserver = {
  readonly resolveFunctionCall?: (resolution: SemanticFunctionCallResolution) => FunctionDeclaration | null;
  readonly resolveMethodCall?: (resolution: SemanticMethodCallResolution) => FunctionDeclaration | null;
  readonly resolveConstructorCall?: (resolution: SemanticConstructorCallResolution) => FunctionDeclaration | null;
  readonly resolveAggregateConstruction?: (resolution: SemanticAggregateConstructionResolution) => StructDeclaration | null;
  readonly resolveField?: (resolution: SemanticFieldResolution) => StructDeclaration["fields"][number] | null;
  readonly resolveEnumVariant?: (resolution: SemanticEnumVariantResolution) => EnumDeclaration["variants"][number] | null;
  readonly resolveType?: (resolution: SemanticTypeResolution) => StructDeclaration | EnumDeclaration | null;
  readonly resolveBindingType?: (resolution: SemanticBindingResolution) => string | null;
  readonly resolveExpressionType?: (resolution: SemanticExpressionResolution) => string | null;
  readonly onFunctionCall?: (resolution: SemanticFunctionCallResolution) => void;
  readonly onMethodCall?: (resolution: SemanticMethodCallResolution) => void;
  readonly onConstructorCall?: (resolution: SemanticConstructorCallResolution) => void;
  readonly onAggregateConstruction?: (resolution: SemanticAggregateConstructionResolution) => void;
  readonly onFieldResolution?: (resolution: SemanticFieldResolution) => void;
  readonly onEnumVariantResolution?: (resolution: SemanticEnumVariantResolution) => void;
  readonly onTypeResolution?: (resolution: SemanticTypeResolution) => void;
  readonly onBindingResolution?: (resolution: SemanticBindingResolution) => void;
  readonly onExpressionResolution?: (resolution: SemanticExpressionResolution) => void;
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

export type IntegerConversion = {
  readonly sourceType: string;
  readonly sourceDisplayType?: string;
  readonly targetType: string;
  readonly checked: boolean;
};

export type ForeignCallArgumentPlan =
  | { readonly kind: "argument"; readonly source: number }
  | { readonly kind: "cast"; readonly source: number; readonly cName: string }
  | { readonly kind: "sliceData"; readonly source: number }
  | { readonly kind: "sliceLength"; readonly source: number }
  | { readonly kind: "fixed"; readonly expression: string }
  | { readonly kind: "callback"; readonly source: number; readonly callback: ForeignCallbackType; readonly functionType: string }
  | { readonly kind: "context"; readonly source: number; readonly callback: ForeignCallbackType; readonly functionType: string }
  | { readonly kind: "release"; readonly source: number; readonly callback: ForeignCallbackType; readonly functionType: string };

export type ExplicitCopyPlan = {
  readonly kind: "trivial" | "string" | "native" | "aggregate";
  readonly type: string;
  readonly sourceIsView: boolean;
};

export type RawExpressionPlan = {
  readonly returnType: string;
  readonly expression: Extract<Expression, { kind: "raw" }>;
  readonly captures: readonly {
    readonly mode: "in" | "inout" | "out";
    readonly name: string;
    readonly type: string;
  }[];
};

export type OptionalChainPlan = {
  readonly receiver: Expression;
  readonly access: Extract<Expression, { kind: "member" | "call" }>;
  readonly sourceType: string;
  readonly payloadType: string;
  readonly valueType: string;
  readonly resultType: string;
  readonly sourceKind: "option" | "nullableObject" | "nullablePointer";
  readonly flatten: boolean;
  readonly view: boolean;
  readonly throwing: {
    readonly successType: string;
    readonly errorType: string;
  } | null;
};

export type StructSpreadPlan = {
  readonly mode: "value" | "copy" | "move";
  readonly sourceName: string;
  readonly type: string;
  readonly retained: readonly {
    readonly name: string;
    readonly type: string;
    readonly action: "value" | "retain" | "copy" | "move";
    readonly copy?: ExplicitCopyPlan["kind"];
  }[];
  readonly overridden: readonly {
    readonly name: string;
    readonly type: string;
  }[];
};

export type ArrayDestructurePlan = {
  readonly sourceType: string;
  readonly elementType: string;
  readonly fixedLength: number | null;
  readonly viewed: boolean;
  readonly bindings: readonly {
    readonly kind: "binding" | "discard" | "rest";
    readonly name: string | null;
    readonly index: number;
    readonly type: string | null;
    readonly borrowed: boolean;
  }[];
};

export type ObjCProtocolConformance = {
  readonly declaration: StructDeclaration;
  readonly protocols: readonly ForeignObjCProtocol[];
  readonly methods: ReadonlyMap<number, ForeignObjCProtocolMethod>;
};

export type ObjCBindingPlan = {
  readonly objectType: string;
  readonly bindings: readonly {
    readonly property: ForeignObjCProperty;
    readonly ownerType: string;
    readonly ownerExpression: Expression;
  }[];
};

export type ThreadTransferKind = "copy" | "move" | "share" | "executorBound";

export type SemanticInfo = {
  readonly warnings: readonly DiagnosticError[];
  readonly deploymentTarget: DeploymentTarget | null;
  readonly viewReturnExpressions: ReadonlySet<number>;
  readonly viewLoadExpressions: ReadonlySet<number>;
  readonly viewBindingOwners: ReadonlyMap<number, string>;
  readonly movedExpressions: ReadonlySet<number>;
  readonly managedCopies: ReadonlySet<number>;
  readonly explicitCopies: ReadonlyMap<number, ExplicitCopyPlan>;
  readonly rawExpressions: ReadonlyMap<number, RawExpressionPlan>;
  readonly optionalChains: ReadonlyMap<number, OptionalChainPlan>;
  readonly structSpreads: ReadonlyMap<number, StructSpreadPlan>;
  readonly arrayDestructures: ReadonlyMap<number, ArrayDestructurePlan>;
  readonly sliceConversions: ReadonlyMap<number, { readonly sourceType: string; readonly targetType: string }>;
  readonly foreignTypes: ReadonlyMap<string, ForeignPointerType>;
  readonly foreignCallTypes: ReadonlyMap<number, string>;
  readonly foreignStatusCalls: ReadonlyMap<number, ForeignStatusCallInfo>;
  readonly foreignConnectionCalls: ReadonlyMap<number, ForeignConnectionCallInfo>;
  readonly foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly foreignExpressionTypes: ReadonlyMap<number, string>;
  readonly numericLiteralTypes: ReadonlyMap<number, string>;
  readonly integerOperations: ReadonlyMap<number, IntegerOperation>;
  readonly integerConversions: ReadonlyMap<number, IntegerConversion>;
  readonly dynamicArrayPushTypes: ReadonlySet<string>;
  readonly arenaCreateCalls: ReadonlyMap<number, string>;
  readonly arenaResetCalls: ReadonlySet<number>;
  readonly threadSpawnCalls: ReadonlyMap<number, number>;
  readonly threadSpawnCaptureTransfers: ReadonlyMap<number, readonly ThreadTransferKind[]>;
  readonly taskScopeSpawnCalls: ReadonlyMap<number, number>;
  readonly taskScopeAsyncCalls: ReadonlyMap<number, number>;
  readonly taskScopeConstructors: ReadonlySet<number>;
  readonly onceConstructors: ReadonlyMap<number, string>;
  readonly onceInitializeCalls: ReadonlyMap<number, string>;
  readonly onceGetCalls: ReadonlyMap<number, string>;
  readonly mutexConstructors: ReadonlyMap<number, string>;
  readonly mutexWithLockCalls: ReadonlyMap<number, MutexWithLockCallInfo>;
  readonly aggregateExecutorAffinities: ReadonlyMap<string, ExecutorAffinityInfo>;
  readonly fieldExecutorAffinities: ReadonlyMap<string, ExecutorAffinityInfo>;
  readonly shareableClasses: ReadonlySet<string>;
  readonly foreignArgumentAccesses: ReadonlyMap<number, "in" | "out" | "inout">;
  readonly foreignCxxArgumentAccesses: ReadonlyMap<number, "in" | "inout" | "move">;
  readonly foreignCallbackTargets: ReadonlyMap<number, string>;
  readonly foreignCallArgumentPlans: ReadonlyMap<number, readonly ForeignCallArgumentPlan[]>;
  readonly foreignFunctionNames: ReadonlyMap<number, string>;
  readonly foreignFunctionDefinitions: ReadonlyMap<number, ForeignDeclarationMetadata>;
  readonly foreignCxxMethodCalls: ReadonlyMap<number, { readonly name: string; readonly receiverAccess: "in" | "inout" | "move" }>;
  readonly foreignConstantNames: ReadonlyMap<number, string>;
  readonly moduleConstantReferences: ReadonlyMap<number, string>;
  readonly nativeArgumentAccesses: ReadonlyMap<number, "in" | "inout" | "out">;
  readonly foreignObjectTypes: ReadonlyMap<string, ForeignObjectType>;
  readonly foreignInterfaces: ReadonlyMap<string, ForeignObjCInterface>;
  readonly foreignProtocols: ReadonlyMap<string, ForeignObjCProtocol>;
  readonly objcProtocolConformances: ReadonlyMap<string, ObjCProtocolConformance>;
  readonly objcBindingCalls: ReadonlyMap<number, ObjCBindingPlan>;
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
  readonly objcConnectionCalls: ReadonlySet<number>;
  readonly expressionTypes: ReadonlyMap<number, string>;
  readonly bindingTypes: ReadonlyMap<number, string>;
  readonly borrowedMatches: ReadonlySet<number>;
  readonly constructorFieldInitializations: ReadonlySet<number>;
  readonly closures: ReadonlyMap<number, ClosureInfo>;
  readonly consoleCalls: ReadonlySet<number>;
  readonly consoleBindings: ReadonlySet<string>;
  readonly testExpectationCalls: ReadonlyMap<number, TestExpectationPlan>;
  readonly testFailureCalls: ReadonlyMap<number, TestFailurePlan>;
  readonly testBindings: ReadonlyMap<string, "expect" | "fail">;
  readonly standardFunctionReferences: ReadonlyMap<number, StandardFunctionName>;
  readonly standardFunctionBindings: ReadonlyMap<string, StandardFunctionName>;
  readonly standardModuleBindings: ReadonlyMap<string, StandardModuleName>;
  readonly standardTypeBindings: ReadonlyMap<string, StandardTypeName>;
  readonly iteratorElementTypes: ReadonlyMap<string, string>;
  readonly hasherAddTypes: ReadonlyMap<number, string>;
  readonly typeDisplayNames: ReadonlyMap<string, string>;
  readonly objectiveC: boolean;
  readonly cPlusPlus: boolean;
  readonly frameworks: readonly string[];
};

export type ExecutorAffinityInfo = {
  readonly executor: "main";
  readonly declared: boolean;
  readonly originType: string;
  readonly fieldPath: readonly string[];
  readonly reason?: "mixedClassSafety";
};

export type TestExpectationPlan = {
  readonly actual: Expression;
  readonly expected: Expression;
  readonly actualType: string;
  readonly expectedType: string;
  readonly location: SourceLocation;
};

export type TestFailurePlan = {
  readonly message: Expression;
  readonly location: SourceLocation;
};

type ViewOriginSource = {
  readonly owner: string;
  readonly location: SourceLocation;
};

type ViewOrigin = {
  readonly sources: readonly ViewOriginSource[];
};

type StandardTypeName =
  | "TextBuffer"
  | "Arena"
  | "Map"
  | "Set"
  | "Hashable"
  | "Hasher"
  | "Iterator"
  | "Generator"
  | "AsyncGenerator"
  | "TaskScope"
  | "TaskControl"
  | "Once"
  | "OnceLifetime"
  | "Mutex";

type AnalysisState = {
  readonly warnings: DiagnosticError[];
  readonly warningKeys: Set<string>;
  readonly deploymentTarget: DeploymentTarget | null;
  readonly viewReturnExpressions: Set<number>;
  readonly viewLoadExpressions: Set<number>;
  readonly viewBindingOwners: Map<number, string>;
  readonly viewCallOrigins: Map<number, ViewOrigin>;
  readonly viewOrigins: Map<string, ViewOrigin>;
  readonly localViewInitializers: Set<number>;
  readonly arrayViewInitializers: Set<number>;
  readonly connectionCallOrigins: Map<number, { readonly owner: string; readonly location: SourceLocation }>;
  readonly connectionOrigins: Map<string, { readonly owner: string; readonly location: SourceLocation }>;
  readonly movedExpressions: Set<number>;
  readonly managedCopies: Set<number>;
  readonly explicitCopies: Map<number, ExplicitCopyPlan>;
  readonly rawExpressions: Map<number, RawExpressionPlan>;
  readonly optionalChains: Map<number, OptionalChainPlan>;
  readonly structSpreads: Map<number, StructSpreadPlan>;
  readonly arrayDestructures: Map<number, ArrayDestructurePlan>;
  readonly generatedOptionalEnums: Map<string, EnumDeclaration>;
  unsafeDepth: number;
  readonly unsafeExpectedTypes: Map<number, string>;
  readonly unsafeUnverifiedExpressions: Set<number>;
  readonly unsafeUnverifiedBindings: Set<string>;
  readonly unsafeLocalBindingScopes: Set<string>[];
  readonly sliceConversions: Map<number, { readonly sourceType: string; readonly targetType: string }>;
  readonly foreignTypes: ReadonlyMap<string, ForeignPointerType>;
  readonly foreignCallTypes: Map<number, string>;
  readonly foreignStatusCalls: Map<number, ForeignStatusCallInfo>;
  readonly foreignConnectionCalls: Map<number, ForeignConnectionCallInfo>;
  readonly foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly foreignExpressionTypes: Map<number, string>;
  readonly numericLiteralTypes: Map<number, string>;
  readonly integerOperations: Map<number, IntegerOperation>;
  readonly integerConversions: Map<number, IntegerConversion>;
  readonly dynamicArrayPushTypes: Set<string>;
  readonly arenaCreateCalls: Map<number, string>;
  readonly arenaResetCalls: Set<number>;
  readonly threadSpawnCalls: Map<number, number>;
  readonly threadSpawnCaptureTransfers: Map<number, readonly ThreadTransferKind[]>;
  readonly taskScopeSpawnCalls: Map<number, number>;
  readonly taskScopeAsyncCalls: Map<number, number>;
  readonly taskScopeConstructors: Set<number>;
  readonly onceConstructors: Map<number, string>;
  readonly onceInitializeCalls: Map<number, string>;
  readonly onceGetCalls: Map<number, string>;
  readonly mutexConstructors: Map<number, string>;
  readonly mutexWithLockCalls: Map<number, MutexWithLockCallInfo>;
  readonly activeMutexLockRoots: Map<string, SourceLocation>;
  analyzingModuleConstant: boolean;
  readonly aggregateExecutorAffinities: Map<string, ExecutorAffinityInfo>;
  readonly fieldExecutorAffinities: Map<string, ExecutorAffinityInfo>;
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
  readonly moduleConstantReferences: Map<number, string>;
  readonly nativeArgumentAccesses: Map<number, "in" | "inout" | "out">;
  readonly foreignObjectTypes: ReadonlyMap<string, ForeignObjectType>;
  readonly foreignInterfaces: ReadonlyMap<string, ForeignObjCInterface>;
  readonly foreignProtocols: ReadonlyMap<string, ForeignObjCProtocol>;
  readonly objcProtocolConformances: Map<string, ObjCProtocolConformance>;
  readonly objcBindingCalls: Map<number, ObjCBindingPlan>;
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
  readonly objcConnectionCalls: Set<number>;
  readonly expressionTypes: Map<number, string>;
  readonly bindingTypes: Map<number, string>;
  readonly resolvedFields: Map<number, StructDeclaration["fields"][number]>;
  readonly borrowedMatches: Set<number>;
  readonly constructorFieldInitializations: Set<number>;
  readonly closures: Map<number, ClosureInfo>;
  readonly consoleCalls: Set<number>;
  readonly consoleBindings: Set<string>;
  readonly testExpectationCalls: Map<number, TestExpectationPlan>;
  readonly testFailureCalls: Map<number, TestFailurePlan>;
  readonly testBindings: Map<string, "expect" | "fail">;
  readonly standardFunctionReferences: Map<number, StandardFunctionName>;
  readonly standardFunctionBindings: Map<string, StandardFunctionName>;
  readonly standardModuleBindings: Map<string, StandardModuleName>;
  readonly standardTypeBindings: Map<string, StandardTypeName>;
  readonly iteratorElementTypes: Map<string, string>;
  readonly hasherAddTypes: Map<number, string>;
  readonly inferredOutBindingLocations: Map<string, SourceLocation>;
  readonly typeDisplayNames: ReadonlyMap<string, string>;
  readonly genericAggregateMaterializations: ReadonlyMap<
    string,
    GenericAggregateMaterialization
  >;
  readonly objectiveC: boolean;
  readonly cPlusPlus: boolean;
  readonly frameworks: readonly string[];
  readonly loopStack: LoopAnalysisFrame[];
  readonly valueLoopStack: ValueLoopAnalysisFrame[];
  readonly moveOrigins: Map<string, SourceLocation>;
  readonly borrowOrigins: Map<string, {
    readonly location: SourceLocation;
    readonly kind: "closure" | "iteration" | "match" | "ownedMatch";
  }>;
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
  readonly asyncLoopScopeFloors: number[];
  activeFunction: FunctionDeclaration | null;
  activeReceiver: string | null;
};

type AccessCapability = "value" | "in" | "inout" | "out" | "move";

type ClosureExecutionContext = "inherit" | "main" | "unknown";

type ClosureInferenceOptions = {
  readonly expectedFunction?: FunctionType | null;
  readonly transientBorrow?: boolean;
  readonly oneShotOwnedCaptures?: boolean;
  readonly nativeThreadBody?: boolean;
  readonly scheduledAsyncBody?: boolean;
  readonly executionContext?: ClosureExecutionContext;
};

type AccessLoan = {
  readonly root: string;
  readonly capability: AccessCapability;
  readonly lifetime:
    | { readonly kind: "call" }
    | { readonly kind: "view"; readonly binding: string }
    | { readonly kind: "connection"; readonly binding: string }
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
  readonly valueProducing?: boolean;
};

type ValueLoopAnalysisFrame = {
  readonly loopOffset: number;
  readonly expected: ValueType | null;
  selections: Array<{
    readonly type: ValueType;
    readonly locals: Map<string, ValueType>;
  }>;
};

type SymbolValue =
  | { readonly kind: "constant"; readonly type: string }
  | { readonly kind: "function"; readonly declaration: FunctionDeclaration }
  | { readonly kind: "foreignFunction"; readonly declaration: ForeignFunction }
  | { readonly kind: "foreignConstant"; readonly declaration: ForeignConstant }
  | { readonly kind: "foreignType"; readonly declaration: ForeignNamedType }
  | { readonly kind: "foreignModule"; readonly module: ForeignModule }
  | { readonly kind: "foreignNamespace"; readonly module: ForeignModule; readonly namespacePath: readonly string[] }
  | { readonly kind: "console" }
  | { readonly kind: "testExpect" }
  | { readonly kind: "testFail" }
  | { readonly kind: "standardModule"; readonly module: StandardModuleName }
  | { readonly kind: "standardFunction"; readonly name: StandardFunctionName; readonly declaration: FunctionDeclaration }
  | { readonly kind: "standardType"; readonly type: "TextBuffer" | "Arena" | "Map" | "Set" | "Hasher" | "TaskScope" | "TaskControl" | "Once" | "OnceLifetime" | "Mutex" }
  | { readonly kind: "struct"; readonly declaration: StructDeclaration }
  | { readonly kind: "trait"; readonly declaration: TraitDeclaration }
  | { readonly kind: "enum"; readonly declaration: EnumDeclaration };

const integerTypes = new Set(["i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "isize", "usize"]);
const floatTypes = new Set(["f32", "f64"]);
const primitiveTypes = new Set([
  ...integerTypes,
  ...floatTypes,
  "void",
  "boolean",
  "cstring",
  "String",
  "TextBuffer",
  "Arena",
  "Hasher",
  "TaskScope",
  "TaskControl",
  "fs.Lock",
  nativeConnectionTypeName,
  fsLockTypeName,
]);
const movedPrefix = "__z_moved:";
const maybeMovedPrefix = "__z_maybe_moved:";
const uninitializedPrefix = "__z_uninitialized:";
const maybeUninitializedPrefix = "__z_maybe_uninitialized:";
const mutablePrefix = "__z_mutable:";
const borrowedPrefix = "__z_borrowed:";
const callTargetPrefix = "__z_calltarget:";
const swiftStringTypeName = "__z_swift:String";

function collectRawNativeLanguages(program: Program): ReadonlySet<"c" | "cpp" | "objc"> {
  const languages = new Set<"c" | "cpp" | "objc">();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.source === "string"
      && (record.language === "c" || record.language === "cpp" || record.language === "objc")
    ) {
      languages.add(record.language);
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(program);
  return languages;
}

export function analyze(
  program: Program,
  fileName: string,
  foreignModules: ReadonlyMap<string, ForeignModule>,
  typeDisplayNames: ReadonlyMap<string, string> = new Map(),
  requireMain = true,
  deploymentTarget: DeploymentTarget | null = null,
  observer: SemanticObserver | null = null,
  genericAggregateMaterializations: ReadonlyMap<
    string,
    GenericAggregateMaterialization
  > = new Map(),
): SemanticInfo {
  typeDisplayNames = new Map([
    ...typeDisplayNames,
    [nativeConnectionTypeName, "native.Connection"],
    [fsLockTypeName, "fs.Lock"],
  ]);
  const foreignTypes = new Map<string, ForeignPointerType>();
  const foreignNamedTypes = new Map<string, ForeignNamedType>();
  const foreignObjectTypes = new Map<string, ForeignObjectType>();
  const foreignInterfaces = new Map<string, ForeignObjCInterface>();
  const foreignProtocols = new Map<string, ForeignObjCProtocol>();
  const frameworks = new Set<string>();
  let objectiveC = false;
  let cPlusPlus = false;
  const rawLanguages = collectRawNativeLanguages(program);
  if (rawLanguages.has("objc")) objectiveC = true;
  if (rawLanguages.has("cpp")) cPlusPlus = true;
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
    for (const protocol of module.protocols.values()) {
      foreignProtocols.set(protocol.typeName, protocol);
    }
    if (module.framework) frameworks.add(module.framework);
    if (module.objectiveC) objectiveC = true;
    if (module.cPlusPlus) cPlusPlus = true;
  }
  if (program.imports.some((declaration) => declaration.header === "std/objc")) {
    objectiveC = true;
    frameworks.add("Foundation");
    const metadata: ForeignDeclarationMetadata = { source: null, availability: [], executorAffinity: null };
    const connection: ForeignNamedType = {
      kind: "object",
      exportName: "Connection",
      namespacePath: ["objc"],
      qualifiedName: "objc.Connection",
      typeName: objcConnectionTypeName,
      cName: "ZObjCConnection *",
      className: "ZObjCConnection",
      metadata,
    };
    foreignNamedTypes.set(objcConnectionTypeName, connection);
    foreignNamedTypes.set(connection.qualifiedName, connection);
    foreignObjectTypes.set(objcConnectionTypeName, {
      kind: "object",
      typeName: objcConnectionTypeName,
      cName: connection.cName,
      className: connection.className,
      nullable: false,
    });
    const binding: ForeignNamedType = {
      kind: "object",
      exportName: "Binding",
      namespacePath: ["objc"],
      qualifiedName: "objc.Binding",
      typeName: objcBindingTypeName,
      cName: "ZObjCBinding *",
      className: "ZObjCBinding",
      metadata,
    };
    foreignNamedTypes.set(objcBindingTypeName, binding);
    foreignNamedTypes.set(binding.qualifiedName, binding);
    foreignObjectTypes.set(objcBindingTypeName, {
      kind: "object",
      typeName: objcBindingTypeName,
      cName: binding.cName,
      className: binding.className,
      nullable: false,
    });
    typeDisplayNames = new Map([
      ...typeDisplayNames,
      [objcConnectionTypeName, "objc.Connection"],
      [objcBindingTypeName, "objc.Binding"],
      [objcSelectorTypeName, "objc.Selector"],
    ]);
  }
  const state: AnalysisState = {
    warnings: [],
    warningKeys: new Set(),
    deploymentTarget,
    viewReturnExpressions: new Set(),
    viewLoadExpressions: new Set(),
    viewBindingOwners: new Map(),
    viewCallOrigins: new Map(),
    viewOrigins: new Map(),
    localViewInitializers: new Set(),
    arrayViewInitializers: new Set(),
    connectionCallOrigins: new Map(),
    connectionOrigins: new Map(),
    movedExpressions: new Set(),
    managedCopies: new Set(),
    explicitCopies: new Map(),
    rawExpressions: new Map(),
    optionalChains: new Map(),
    structSpreads: new Map(),
    arrayDestructures: new Map(),
    generatedOptionalEnums: new Map(),
    unsafeDepth: 0,
    unsafeExpectedTypes: new Map(),
    unsafeUnverifiedExpressions: new Set(),
    unsafeUnverifiedBindings: new Set(),
    unsafeLocalBindingScopes: [],
    sliceConversions: new Map(),
    foreignTypes,
    foreignCallTypes: new Map(),
    foreignStatusCalls: new Map(),
    foreignConnectionCalls: new Map(),
    foreignNamedTypes,
    foreignExpressionTypes: new Map(),
    numericLiteralTypes: new Map(),
    integerOperations: new Map(),
    integerConversions: new Map(),
    dynamicArrayPushTypes: new Set(),
    arenaCreateCalls: new Map(),
    arenaResetCalls: new Set(),
    threadSpawnCalls: new Map(),
    threadSpawnCaptureTransfers: new Map(),
    taskScopeSpawnCalls: new Map(),
    taskScopeAsyncCalls: new Map(),
    taskScopeConstructors: new Set(),
    onceConstructors: new Map(),
    onceInitializeCalls: new Map(),
    onceGetCalls: new Map(),
    mutexConstructors: new Map(),
    mutexWithLockCalls: new Map(),
    activeMutexLockRoots: new Map(),
    analyzingModuleConstant: false,
    aggregateExecutorAffinities: new Map(),
    fieldExecutorAffinities: new Map(),
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
    moduleConstantReferences: new Map(),
    nativeArgumentAccesses: new Map(),
    foreignObjectTypes,
    foreignInterfaces,
    foreignProtocols,
    objcProtocolConformances: new Map(),
    objcBindingCalls: new Map(),
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
    objcConnectionCalls: new Set(),
    expressionTypes: new Map(),
    bindingTypes: new Map(),
    resolvedFields: new Map(),
    borrowedMatches: new Set(),
    constructorFieldInitializations: new Set(),
    closures: new Map(),
    consoleCalls: new Set(),
    consoleBindings: new Set(),
    testExpectationCalls: new Map(),
    testFailureCalls: new Map(),
    testBindings: new Map(),
    standardFunctionReferences: new Map(),
    standardFunctionBindings: new Map(),
    standardModuleBindings: new Map(),
    standardTypeBindings: new Map(),
    iteratorElementTypes: new Map(),
    hasherAddTypes: new Map(),
    inferredOutBindingLocations: new Map(),
    typeDisplayNames,
    genericAggregateMaterializations,
    objectiveC,
    cPlusPlus,
    frameworks: [...frameworks],
    loopStack: [],
    valueLoopStack: [],
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
    asyncLoopScopeFloors: [],
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
      if (declaration.header === "std/test") {
        if (!declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, "std/test requires a selective import", {
            code: "Z0501",
            helps: ['use `import { expect, fail } from "std/test";`'],
          });
        }
        for (const binding of declaration.bindings) {
          if (binding.importedName !== "expect" && binding.importedName !== "fail") {
            throw new DiagnosticError(fileName, binding.location, `std/test has no export ${JSON.stringify(binding.importedName)}`, {
              code: "Z0501",
              helps: ["std/test currently exports `expect` and `fail`"],
            });
          }
          validateUserName(binding.localName, binding.location, fileName);
          declareGlobal(
            globals,
            binding.localName,
            { kind: binding.importedName === "expect" ? "testExpect" : "testFail" },
            binding.location,
            fileName,
          );
          state.testBindings.set(binding.localName, binding.importedName);
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
      if (declaration.header === "std/collections") {
        if (!declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, "std/collections requires a selective import", {
            code: "Z0501",
            helps: ["use `import { Map, Set } from \"std/collections\";`"],
          });
        }
        for (const binding of declaration.bindings) {
          if (binding.importedName !== "Map" && binding.importedName !== "Set") {
            throw new DiagnosticError(fileName, binding.location, `std/collections has no export ${JSON.stringify(binding.importedName)}`, {
              code: "Z0501",
              helps: ["std/collections currently exports `Map` and `Set`"],
            });
          }
          validateUserName(binding.localName, binding.location, fileName);
          declareGlobal(globals, binding.localName, { kind: "standardType", type: binding.importedName }, binding.location, fileName);
          state.standardTypeBindings.set(binding.localName, binding.importedName);
        }
        continue;
      }
      if (declaration.header === "std/hash") {
        if (!declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, "std/hash requires a selective import", {
            code: "Z0501",
            helps: ["use `import { Hashable, Hasher } from \"std/hash\";`"],
          });
        }
        for (const binding of declaration.bindings) {
          if (binding.importedName !== "Hashable" && binding.importedName !== "Hasher") {
            throw new DiagnosticError(fileName, binding.location, `std/hash has no export ${JSON.stringify(binding.importedName)}`, {
              code: "Z0501",
              helps: ["std/hash exports `Hashable` and `Hasher`"],
            });
          }
          validateUserName(binding.localName, binding.location, fileName);
          if (binding.importedName === "Hashable") {
            const trait = hashableTraitDeclaration(binding.location);
            declareGlobal(globals, binding.localName, { kind: "trait", declaration: trait }, binding.location, fileName);
            traits.set("Hashable", trait);
          } else {
            declareGlobal(globals, binding.localName, { kind: "standardType", type: "Hasher" }, binding.location, fileName);
          }
          state.standardTypeBindings.set(binding.localName, binding.importedName);
        }
        continue;
      }
      if (declaration.header === "std/iteration") {
        if (!declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, "std/iteration requires a selective import", {
            code: "Z0501",
            helps: ["use `import { Iterator, Generator, AsyncGenerator } from \"std/iteration\";`"],
          });
        }
        for (const binding of declaration.bindings) {
          if (
            binding.importedName !== "Iterator"
            && binding.importedName !== "Generator"
            && binding.importedName !== "AsyncGenerator"
          ) {
            throw new DiagnosticError(fileName, binding.location, `std/iteration has no export ${JSON.stringify(binding.importedName)}`, {
              code: "Z0501",
              helps: ["std/iteration exports `Iterator`, `Generator`, and `AsyncGenerator`"],
            });
          }
          validateUserName(binding.localName, binding.location, fileName);
          if (binding.importedName === "Iterator") {
            const trait = iteratorTraitDeclaration(binding.localName, binding.location);
            declareGlobal(globals, binding.localName, { kind: "trait", declaration: trait }, binding.location, fileName);
            state.standardTypeBindings.set(binding.localName, "Iterator");
          } else {
            declareGlobal(globals, binding.localName, { kind: "standardType", type: binding.importedName }, binding.location, fileName);
            state.standardTypeBindings.set(binding.localName, binding.importedName);
          }
        }
        continue;
      }
      if (declaration.header === "std/sync") {
        if (!declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, "std/sync requires a selective import", {
            code: "Z0501",
            helps: ["use `import { Mutex, Once } from \"std/sync\";`"],
          });
        }
        for (const binding of declaration.bindings) {
          if (binding.importedName !== "Once" && binding.importedName !== "OnceLifetime" && binding.importedName !== "Mutex") {
            throw new DiagnosticError(fileName, binding.location, `std/sync has no export ${JSON.stringify(binding.importedName)}`, {
              code: "Z0501",
              helps: ["std/sync exports `Mutex`, `Once`, and `OnceLifetime`"],
            });
          }
          validateUserName(binding.localName, binding.location, fileName);
          declareGlobal(globals, binding.localName, { kind: "standardType", type: binding.importedName }, binding.location, fileName);
          state.standardTypeBindings.set(binding.localName, binding.importedName);
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
      if (declaration.header === "std/async") {
        if (!declaration.bindings) {
          throw new DiagnosticError(fileName, declaration.location, "std/async requires a selective import", {
            code: "Z0501",
            helps: ["use `import { scheduler, TaskControl, TaskScope } from \"std/async\";`"],
          });
        }
        for (const binding of declaration.bindings) {
          if (binding.importedName === "scheduler") {
            validateUserName(binding.localName, binding.location, fileName);
            declareGlobal(globals, binding.localName, { kind: "standardModule", module: "scheduler" }, binding.location, fileName);
            state.standardModuleBindings.set(binding.localName, "scheduler");
            continue;
          }
          if (binding.importedName !== "TaskScope" && binding.importedName !== "TaskControl") {
            throw new DiagnosticError(fileName, binding.location, `std/async has no export ${JSON.stringify(binding.importedName)}`, {
              code: "Z0501",
              helps: ["std/async exports `scheduler`, `TaskScope`, and `TaskControl`"],
            });
          }
          validateUserName(binding.localName, binding.location, fileName);
          const standardType = binding.importedName as "TaskScope" | "TaskControl";
          declareGlobal(globals, binding.localName, { kind: "standardType", type: standardType }, binding.location, fileName);
          state.standardTypeBindings.set(binding.localName, standardType);
        }
        continue;
      }
      if (declaration.header === "std/fs" || declaration.header === "std/process" || declaration.header === "std/objc") {
        const module: StandardModuleName = declaration.header === "std/fs"
          ? "fs"
          : declaration.header === "std/process" ? "process" : "objc";
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
        helps: ["the bootstrap standard library currently provides `std`, `std/console`, `std/time`, `std/test`, `std/text`, `std/memory`, `std/collections`, `std/hash`, `std/iteration`, `std/sync`, `std/thread`, `std/async`, `std/fs`, `std/process`, and `std/objc`"],
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

  // Module-level Once<T> declarations need to recognize both explicitly
  // isolated classes and classes whose lifecycle becomes main-bound through an
  // executor-affine field. Collect that evidence before validating constants;
  // declaration-specific affinity diagnostics still run in the normal pass.
  collectAggregateExecutorAffinities(program, structs, enums, state);

  for (const declaration of program.constants) {
    if (!moduleConstantInitializerSupported(declaration.initializer)) {
      throw new DiagnosticError(
        declaration.location.fileName ?? fileName,
        declaration.initializer.location,
        `module constant ${JSON.stringify(declaration.name)} requires a compile-time literal initializer in the first tier`,
        {
          code: "Z0604",
          notes: ["module constants do not run initialization code and therefore introduce no module initialization order"],
          helps: ["use a boolean, numeric, String, or explicitly typed cstring literal"],
        },
      );
    }
    if (declaration.type) {
      validateType(declaration.type, structs, enums, foreignNamedTypes, fileName, false);
    }
    state.analyzingModuleConstant = true;
    let initializerType = inferExpression(
      declaration.initializer,
      new Map(),
      globals,
      structs,
      enums,
      declaration.location.fileName ?? fileName,
      state,
    );
    state.analyzingModuleConstant = false;
    const constantType = declaration.type
      ? resolveSemanticTypeName(declaration.type, structs, enums, state)
      : String(underlyingType(initializerType));
    if (!moduleConstantTypeSupported(constantType)) {
      throw new DiagnosticError(
        declaration.location.fileName ?? fileName,
        declaration.type?.location ?? declaration.initializer.location,
        `module constant ${JSON.stringify(declaration.name)} cannot store ${displayAssignableType(constantType, state)} in the first tier`,
        {
          code: "Z0604",
          notes: ["runtime-owned values require a separate module initialization and destruction model"],
          helps: ["use a boolean, numeric, String, or cstring constant"],
        },
      );
    }
    const once = parseOnceType(constantType);
    if (once) {
      const stored = structs.get(once.valueType);
      if (stored?.kind !== "class" || !state.aggregateExecutorAffinities.has(once.valueType)) {
        throw new DiagnosticError(
          declaration.location.fileName ?? fileName,
          declaration.type?.location ?? declaration.initializer.location,
          `Once<T> requires a class whose lifecycle belongs to thread.main in the first tier, found ${JSON.stringify(displayArrayType(once.valueType))}`,
          {
            code: "Z0604",
            notes: ["one-time initialization does not by itself make mutable identity safe to share across threads"],
            helps: ["declare the stored class with `on thread.main`, give it a main-bound field, or keep the owner local and pass it explicitly"],
          },
        );
      }
    }
    if (declaration.type) {
      initializerType = contextualCStringLiteral(constantType, declaration.initializer, state) ?? initializerType;
      requireAssignable(
        constantType,
        initializerType,
        declaration.initializer,
        declaration.location.fileName ?? fileName,
        structs,
        enums,
        state,
      );
    } else if (
      declaration.initializer.kind === "number"
      && isIntegerLiteral(declaration.initializer.value)
      && !integerLiteralFits(declaration.initializer.value, "i32")
    ) {
      throw new DiagnosticError(
        declaration.location.fileName ?? fileName,
        declaration.initializer.location,
        `integer literal ${declaration.initializer.value} does not fit default i32; add an explicit integer type`,
      );
    }
    state.bindingTypes.set(declaration.nameLocation.offset, constantType);
    declareGlobal(
      globals,
      declaration.name,
      { kind: "constant", type: constantType },
      declaration.location,
      declaration.location.fileName ?? fileName,
    );
  }

  const testNames = new Map<string, SourceLocation>();
  for (const declaration of program.functions) {
    if (!declaration.testName) continue;
    const declarationFile = declaration.location.fileName ?? fileName;
    const key = `${declarationFile}\0${declaration.testName}`;
    const existing = testNames.get(key);
    if (existing) {
      throw new DiagnosticError(declarationFile, declaration.location, `duplicate test name ${JSON.stringify(declaration.testName)}`, {
        code: "Z0900",
        labels: [{
          location: existing,
          message: "first test with this name is declared here",
          length: 4,
        }],
        helps: ["give every test in a source module a distinct descriptive name"],
      });
    }
    testNames.set(key, declaration.location);
  }

  for (const declaration of program.functions) {
    if (declaration.testName) continue;
    declareGlobal(globals, declaration.name, { kind: "function", declaration }, declaration.location, fileName);
  }

  for (const declaration of program.typeAliases) {
    validateType(declaration.target, structs, enums, foreignNamedTypes, fileName, true);
  }

  for (const declaration of program.structs) {
    const map = parseMapType(declaration.name);
    if (map) {
      validateCollectionKeyType("Map key", map.keyType, structs, enums, state, declaration.location, fileName);
      if (map.valueType === "void" || containsViewType(map.valueType) || containsSliceType(map.valueType) || map.valueType === "Arena" || parseTaskType(map.valueType)) {
        throw new DiagnosticError(fileName, declaration.location, `Map cannot own value type ${JSON.stringify(displayArrayType(map.valueType))} in the first collections tier`);
      }
      const nativeMapValue = state.foreignNamedTypes.get(map.valueType);
      if (nativeMapValue?.kind === "value" && !nativeMapValue.lifecycle.move) {
        throw new DiagnosticError(fileName, declaration.location, `Map native value type ${JSON.stringify(displayArrayType(map.valueType))} must provide move construction in the current storage tier`, {
          code: "Z0240",
          notes: ["Map growth and removal relocate stored native values without copying them"],
          helps: ["declare `move;` in the adjacent .zd contract when the C++ type is genuinely movable"],
        });
      }
      if (
        parseFunctionType(map.valueType)
        || parseWeakType(map.valueType)
      ) {
        throw new DiagnosticError(fileName, declaration.location, `Map value type ${JSON.stringify(displayArrayType(map.valueType))} needs a storage-specific lookup contract`, {
          code: "Z0206",
          notes: ["function values and weak references need distinct retention rules inside collection storage"],
          helps: ["store the identity or native value inside an ordinary Z value struct, or keep it outside Map until that storage tier lands"],
        });
      }
      if (
        hasMoveOnlyForeignType(map.keyType, structs, enums, state.foreignNamedTypes)
      ) {
        throw new DiagnosticError(fileName, declaration.location, "Map keys cannot be move-only native C++ values", {
          code: "Z0240",
          helps: ["use a stable Z-owned identifier or readonly Hashable value as the key"],
        });
      }
      continue;
    }
    const set = parseSetType(declaration.name);
    if (set) validateCollectionKeyType("Set element", set.elementType, structs, enums, state, declaration.location, fileName);
  }

  for (const declaration of program.structs) {
    validateExecutorAffinity(declaration.executorAffinity, declaration.location, globals, fileName);
    for (const field of declaration.fields) {
      validateExecutorAffinity(field.executorAffinity, field.location, globals, fileName);
    }
    for (const method of declaration.methods) {
      validateExecutorAffinity(method.executorAffinity, method.location, globals, fileName);
    }
    analyzeStructDeclaration(declaration, structs, enums, foreignNamedTypes, foreignTypes, fileName, state);
  }
  for (const declaration of program.traits) {
    for (const method of declaration.methods) {
      validateExecutorAffinity(method.executorAffinity, method.location, globals, fileName);
    }
    analyzeTraitDeclaration(declaration, structs, enums, foreignNamedTypes, foreignTypes, fileName, state);
  }
  for (const declaration of program.structs) {
    validateTraitConformance(declaration, traits, foreignProtocols, fileName, state);
  }
  for (const declaration of program.enums) {
    analyzeEnumDeclaration(declaration, structs, enums, foreignNamedTypes, fileName, state);
  }
  validateNativeLayouts(program.structs, program.enums, structs, enums, fileName);

  for (const declaration of program.functions) {
    validateExecutorAffinity(declaration.executorAffinity, declaration.location, globals, fileName);
    if (declaration.receiverMode) {
      throw new DiagnosticError(
        fileName,
        declaration.location,
        `\`${declaration.receiverMode} this\` is only valid on a struct method (or class method)`,
      );
    }
    validateFunctionSignature(declaration, structs, enums, foreignNamedTypes, foreignTypes, fileName, state);
    validateNativeExport(declaration, structs, enums, fileName);
    const returnedView = parseReceiverViewReturnType(
      declaration.returnType.name,
    );
    if (returnedView) {
      if (
        declaration.async
        || declaration.errorType
        || declaration.rawBody
        || isGeneratorFunction(declaration)
        || isAsyncGeneratorFunction(declaration)
      ) {
        throw new DiagnosticError(fileName, declaration.returnType.location, "a parameter-provenanced view return requires a synchronous, non-throwing Z function", {
          code: "Z0206",
        });
      }
      if (structs.get(returnedView.target)?.kind !== "struct") {
        throw new DiagnosticError(fileName, declaration.returnType.location, "the first parameter-view tier requires a concrete Z struct target", {
          code: "Z0206",
        });
      }
      const sources = parameterViewSourceIndices(declaration);
      if (sources.length === 0) {
        throw new DiagnosticError(fileName, declaration.returnType.location, "a parameter-provenanced view requires at least one direct return from an immutable `in` parameter", {
          code: "Z0206",
          helps: ["return the borrowed parameter itself, one of its fields, or one of its indexed elements"],
        });
      }
      for (const source of sources) {
        const parameter = declaration.parameters[source];
        const parameterType = parameter.type.name;
        if (
          structs.get(parameterType)?.kind === "class"
          || state.foreignNamedTypes.get(parameterType)?.kind === "object"
          || parameterType.startsWith("__z_objc:")
        ) {
          throw new DiagnosticError(fileName, parameter.location, "parameter-provenanced views require value-storage owners", {
            code: "Z0206",
            notes: ["class aliases could mutate projected storage without passing through this loan"],
            helps: ["use a value struct or return an owned snapshot"],
          });
        }
      }
    }
  }

  for (const declaration of program.structs) {
    for (const field of declaration.fields) {
      if (!field.defaultValue) continue;
      const defaultLocals = new Map<string, ValueType>();
      let actual = inferExpression(
        field.defaultValue,
        defaultLocals,
        globals,
        structs,
        enums,
        fileName,
        state,
      );
      actual = contextualCStringLiteral(field.type.name, field.defaultValue, state) ?? actual;
      rejectBorrowedNativeResourceEscape(
        actual,
        field.defaultValue,
        defaultLocals,
        fileName,
        state,
        "stored as a field default",
      );
      requireAssignable(
        field.type.name,
        actual,
        field.defaultValue,
        fileName,
        structs,
        enums,
        state,
      );
      consumeOwnedValue(
        field.defaultValue,
        field.type.name,
        defaultLocals,
        structs,
        enums,
        fileName,
        state,
      );
    }
  }

  validateValueLayouts(program.structs, program.enums, structs, enums, fileName);
  for (const declaration of program.structs) {
    if (
      declaration.kind === "class"
      && !state.aggregateExecutorAffinities.has(declaration.name)
      && !shareableTypeIssue(declaration.name, structs, enums, state)
    ) {
      state.shareableClasses.add(declaration.name);
    }
  }
  collectMixedAffinityFieldAccesses(program, structs, enums, state);

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

  for (const declaration of program.functions) {
    const generator = parseGeneratorType(declaration.returnType.name);
    if (generator && !generator.returnType && !generator.errorType) {
      state.iteratorElementTypes.set(declaration.returnType.name, generator.elementType);
    }
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
  if (state.generatedOptionalEnums.size > 0) {
    (program.enums as EnumDeclaration[]).push(...state.generatedOptionalEnums.values());
  }
  return state;
}

const nativeExportScalarTypes = new Set([
  "i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64",
  "isize", "usize", "f32", "f64", "boolean", "void",
]);

const cFamilyReservedIdentifiers = new Set(
  "alignas alignof and and_eq asm atomic_cancel atomic_commit atomic_noexcept auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false final float for friend goto if import inline int long module mutable namespace new noexcept not not_eq nullptr operator or or_eq override private protected public reflexpr register reinterpret_cast requires restrict return short signed sizeof static static_assert static_cast struct switch synchronized template this thread_local throw true try typedef typeid typename typeof typeof_unqual union unsigned using virtual void volatile wchar_t while xor xor_eq _Alignas _Alignof _Atomic _BitInt _Bool _Complex _Decimal32 _Decimal64 _Decimal128 _Generic _Imaginary _Noreturn _Static_assert _Thread_local"
    .split(" "),
);
const cEnumIntegerTypes = new Set([
  "i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "isize", "usize",
]);

function validPublicCIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !cFamilyReservedIdentifiers.has(name);
}

function validateNativeLayouts(
  declarations: readonly StructDeclaration[],
  enumDeclarations: readonly EnumDeclaration[],
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  fileName: string,
): void {
  const reject = (location: SourceLocation, summary: string, help?: string): never => {
    throw new DiagnosticError(location.fileName ?? fileName, location, summary, {
      code: "Z0831",
      notes: ["a `c struct` or `c enum` is an exact public C representation contract"],
      helps: help ? [help] : undefined,
    });
  };
  const visiting = new Set<string>();
  const validated = new Set<string>();
  const publicNames = new Set<string>();
  for (const declaration of [...declarations, ...enumDeclarations]) {
    if (!declaration.nativeLayout) continue;
    if (publicNames.has(declaration.nativeLayout.name)) {
      reject(
        declaration.nativeLayout.location,
        `duplicate public C type name ${JSON.stringify(declaration.nativeLayout.name)}`,
        "give every C-layout type a unique name across the linked module graph",
      );
    }
    publicNames.add(declaration.nativeLayout.name);
  }
  const validateCType = (type: string, location: SourceLocation): void => {
    if (nativeExportScalarTypes.has(type) && type !== "void") return;
    if (enums.get(type)?.nativeLayout?.language === "c") return;
    const nested = structs.get(type);
    if (!nested?.nativeLayout || nested.kind !== "struct") {
      reject(
        location,
        `C-layout field type ${JSON.stringify(type)} does not have a C representation`,
        "use a fixed-width scalar, `c struct`, or fixed-representation `c enum`",
      );
    }
    validateStruct(nested);
  };
  const validateStruct = (declaration: StructDeclaration): void => {
    if (!declaration.nativeLayout || validated.has(declaration.name)) return;
    const location = declaration.nativeLayout.location;
    if (!validPublicCIdentifier(declaration.nativeLayout.name)) {
      reject(location, `C-layout type name ${JSON.stringify(declaration.nativeLayout.name)} is not a valid public C identifier`);
    }
    if (visiting.has(declaration.name)) {
      reject(location, `C-layout struct ${JSON.stringify(declaration.nativeLayout.name)} contains itself by value`);
    }
    visiting.add(declaration.name);
    if (declaration.kind !== "struct") reject(location, "`c class` is not supported");
    if ((declaration.typeParameters?.length ?? 0) > 0) reject(location, "a C-layout struct cannot be generic");
    if (declaration.executorAffinity) reject(location, "a C-layout struct cannot have executor affinity");
    if (declaration.implements.length > 0) reject(location, "a C-layout struct cannot implement traits in the first ABI tier");
    if (declaration.constructor) reject(location, "a C-layout struct cannot declare a constructor in the first ABI tier");
    if (declaration.deinitializer) {
      reject(
        location,
        "a C-layout struct cannot declare `deinit`",
        "export explicit create/use/destroy functions when the value owns a resource",
      );
    }
    if (declaration.fields.length === 0) reject(location, "a C-layout struct must declare at least one field");
    for (const field of declaration.fields) {
      if (field.executorAffinity) {
        reject(field.location, `C-layout field ${JSON.stringify(field.name)} cannot have executor affinity`);
      }
      if (!validPublicCIdentifier(field.name)) {
        reject(field.location, `C-layout field name ${JSON.stringify(field.name)} is not a valid public C identifier`);
      }
      if (field.visibility !== "public") reject(field.location, `C-layout field ${JSON.stringify(field.name)} cannot be private`);
      if (field.readonly) reject(field.location, `C-layout field ${JSON.stringify(field.name)} cannot be readonly`);
      if (field.optional) reject(field.location, `C-layout field ${JSON.stringify(field.name)} cannot use Z optional-field storage`);
      if (field.defaultValue) reject(field.location, `C-layout field ${JSON.stringify(field.name)} cannot declare a Z default value`);
      validateCType(field.type.name, field.location);
    }
    visiting.delete(declaration.name);
    validated.add(declaration.name);
  };
  for (const declaration of declarations) validateStruct(declaration);
  for (const declaration of enumDeclarations) {
    if (!declaration.nativeLayout) continue;
    const location = declaration.nativeLayout.location;
    if (!validPublicCIdentifier(declaration.nativeLayout.name)) {
      reject(location, `C enum name ${JSON.stringify(declaration.nativeLayout.name)} is not a valid public C identifier`);
    }
    if (!declaration.underlyingType || !cEnumIntegerTypes.has(declaration.underlyingType.name)) {
      reject(
        declaration.underlyingType?.location ?? location,
        `C enum ${JSON.stringify(declaration.nativeLayout.name)} requires a fixed integer representation`,
        "use `c enum Name: i32` or another fixed-width integer type",
      );
    }
    if (declaration.variants.length === 0) reject(location, "a C enum must declare at least one variant");
    for (const variant of declaration.variants) {
      if (!validPublicCIdentifier(variant.name)) {
        reject(variant.location, `C enum variant ${JSON.stringify(variant.name)} is not a valid public C identifier`);
      }
      if (variant.payload) {
        reject(
          variant.location,
          `C enum variant ${JSON.stringify(variant.name)} cannot carry a payload`,
          "use an ordinary Z enum internally and project it through explicit C-layout values",
        );
      }
    }
  }
}

function validateNativeExport(
  declaration: FunctionDeclaration,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  fileName: string,
): void {
  if (!declaration.nativeExport) return;
  const location = declaration.nativeExport.location;
  const reject = (summary: string, help?: string): never => {
    throw new DiagnosticError(location.fileName ?? fileName, location, summary, {
      code: "Z0830",
    notes: ["the current C-export tier supports synchronous, non-throwing, non-generic functions over scalars and checked C-layout values"],
      helps: help ? [help] : undefined,
    });
  };
  if (declaration.nativeExport.language !== "c") reject("unsupported native export language");
  if (!validPublicCIdentifier(declaration.nativeExport.name)) {
    reject(`C export name ${JSON.stringify(declaration.nativeExport.name)} is not a valid public C identifier`);
  }
  if (declaration.nativeExport.name === "main") reject("`main` cannot also be published as a C export");
  if (declaration.async) reject("a C-exported function cannot be async in the first ABI tier");
  if (declaration.errorType) reject("a C-exported function cannot throw in the first ABI tier");
  if ((declaration.typeParameters?.length ?? 0) > 0) reject("a C-exported function cannot be generic in the first ABI tier");
  if (declaration.executorAffinity) reject("a C-exported function cannot have executor affinity in the first ABI tier");
  if (declaration.rawBody) reject("a C-exported function must have an ordinary checked Z body in the first ABI tier");
  for (const parameter of declaration.parameters) {
    if (parameter.mode !== "value") {
      reject(
        `C export parameter ${JSON.stringify(parameter.name)} cannot use \`${parameter.mode}\` in the first ABI tier`,
        "pass an ordinary by-value scalar parameter; explicit pointer ABI contracts are a later tier",
      );
    }
    const aggregate = structs.get(parameter.type.name);
    const cLayoutStruct = aggregate?.kind === "struct" && Boolean(aggregate.nativeLayout);
    const cLayoutEnum = Boolean(enums.get(parameter.type.name)?.nativeLayout);
    if (
      (!nativeExportScalarTypes.has(parameter.type.name) && !cLayoutStruct && !cLayoutEnum)
      || parameter.type.name === "void"
    ) {
      reject(`C export parameter ${JSON.stringify(parameter.name)} has unsupported boundary type ${JSON.stringify(parameter.type.name)}`);
    }
  }
  const resultStruct = structs.get(declaration.returnType.name);
  const cLayoutResultStruct = resultStruct?.kind === "struct" && Boolean(resultStruct.nativeLayout);
  const cLayoutResultEnum = Boolean(enums.get(declaration.returnType.name)?.nativeLayout);
  if (
    !nativeExportScalarTypes.has(declaration.returnType.name)
    && !cLayoutResultStruct
    && !cLayoutResultEnum
  ) {
    reject(`C export return type ${JSON.stringify(declaration.returnType.name)} is unsupported in the first ABI tier`);
  }
}

function validateExecutorAffinity(
  affinity: StructDeclaration["executorAffinity"] | FunctionDeclaration["executorAffinity"],
  declarationLocation: SourceLocation,
  globals: Map<string, SymbolValue>,
  fileName: string,
): void {
  if (!affinity) return;
  if (
    affinity.executor.location.fileName
    && affinity.executor.location.fileName !== fileName
    && affinity.executor.kind === "member"
    && affinity.executor.object.kind === "identifier"
    && affinity.executor.object.name === "thread"
    && affinity.executor.property === "main"
  ) {
    // Source-module loading has already parsed the dependency in its own import
    // environment. Preserve the canonical executor contract after linking,
    // where the dependency's local `thread` binding is intentionally absent.
    return;
  }
  if (
    affinity.executor.kind === "member"
    && affinity.executor.object.kind === "identifier"
    && affinity.executor.property === "main"
  ) {
    const binding = globals.get(affinity.executor.object.name);
    if (binding?.kind === "standardModule" && binding.module === "thread") return;
  }
  throw new DiagnosticError(fileName, affinity.executor.location, "declaration affinity currently requires the thread.main executor capability", {
    code: "Z0710",
    labels: [{ location: declarationLocation, message: "declaration begins here" }],
    helps: ["import { thread } from \"std/thread\" and write `on thread.main` in the declaration header"],
  });
}

function collectAggregateExecutorAffinities(
  program: Program,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  state: AnalysisState,
): void {
  const aliases = new Map(program.typeAliases.map((declaration) => [declaration.name, declaration.target.name]));
  const visiting = new Set<string>();

  const typeAffinity = (type: string, path: readonly string[]): ExecutorAffinityInfo | null => {
    const alias = aliases.get(type);
    if (alias) return typeAffinity(alias, path);
    const foreign = foreignExecutorAffinityForTypeName(type, state);
    if (foreign) return { ...foreign, fieldPath: [...path, ...foreign.fieldPath] };
    const generic = parseGenericType(type);
    if (generic) {
      const base = aggregateAffinity(generic.base);
      if (base) return { ...base, fieldPath: [...path, ...base.fieldPath] };
      for (const argument of generic.arguments) {
        const inherited = typeAffinity(argument, path);
        if (inherited) return inherited;
      }
    }
    const dynamic = parseDynamicArrayType(type);
    if (dynamic) return typeAffinity(dynamic.elementType, path);
    const fixed = parseFixedArrayType(type);
    if (fixed) return typeAffinity(fixed.elementType, path);
    const option = parseOptionType(type);
    if (option) return typeAffinity(option.target, path);
    const map = parseMapType(type);
    if (map) return typeAffinity(map.keyType, path) ?? typeAffinity(map.valueType, path);
    const set = parseSetType(type);
    if (set) return typeAffinity(set.elementType, path);
    const weak = parseWeakType(type);
    if (weak) return typeAffinity(weak.target, path);
    const declaration = structs.get(type);
    if (declaration) {
      const inherited = aggregateAffinity(type);
      return inherited ? { ...inherited, fieldPath: [...path, ...inherited.fieldPath] } : null;
    }
    const enumeration = enums.get(type);
    if (enumeration) {
      for (const variant of enumeration.variants) {
        if (!variant.payload) continue;
        const inherited = typeAffinity(variant.payload.name, [...path, variant.name]);
        if (inherited) return inherited;
      }
    }
    return null;
  };

  const aggregateAffinity = (name: string): ExecutorAffinityInfo | null => {
    const known = state.aggregateExecutorAffinities.get(name);
    if (known) return known;
    const declaration = structs.get(name);
    if (!declaration || visiting.has(name)) return null;
    if (declaration.executorAffinity) {
      const declared: ExecutorAffinityInfo = {
        executor: "main",
        declared: true,
        originType: name,
        fieldPath: [],
      };
      state.aggregateExecutorAffinities.set(name, declared);
      return declared;
    }
    visiting.add(name);
    for (const field of declaration.fields) {
      const explicit: ExecutorAffinityInfo | null = field.executorAffinity
        ? {
            executor: "main",
            declared: true,
            originType: name,
            fieldPath: [field.name],
          }
        : null;
      const inherited = explicit ?? typeAffinity(field.type.name, [field.name]);
      if (!inherited) continue;
      state.fieldExecutorAffinities.set(`${name}.${field.name}`, inherited);
      const inferred: ExecutorAffinityInfo = {
        ...inherited,
        declared: false,
      };
      state.aggregateExecutorAffinities.set(name, inferred);
      visiting.delete(name);
      return inferred;
    }
    visiting.delete(name);
    return null;
  };

  for (const declaration of program.structs) aggregateAffinity(declaration.name);
  // The first lifecycle-affine field ends aggregate discovery early. Populate
  // every member contract in a second pass so editor and access checks retain
  // the complete field-level surface.
  for (const declaration of program.structs) {
    for (const field of declaration.fields) {
      const explicit: ExecutorAffinityInfo | null = field.executorAffinity
        ? {
            executor: "main",
            declared: true,
            originType: declaration.name,
            fieldPath: [field.name],
          }
        : null;
      const inherited = explicit ?? typeAffinity(field.type.name, [field.name]);
      if (inherited) {
        state.fieldExecutorAffinities.set(`${declaration.name}.${field.name}`, inherited);
      }
    }
  }
}

function collectMixedAffinityFieldAccesses(
  program: Program,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  state: AnalysisState,
): void {
  for (const declaration of program.structs) {
    if (
      declaration.kind !== "class"
      || declaration.executorAffinity
      || !state.aggregateExecutorAffinities.has(declaration.name)
    ) continue;
    for (const field of declaration.fields) {
      const key = `${declaration.name}.${field.name}`;
      if (state.fieldExecutorAffinities.has(key)) continue;
      const mutex = parseMutexType(field.type.name);
      const mutexShareable = Boolean(
        mutex
        && initialThreadTransferKind(field.type.name, structs, enums, state) === "share",
      );
      const threadReadable = field.readonly && (
        mutexShareable
        || shareableTypeIssue(field.type.name, structs, enums, state) === null
      );
      if (threadReadable) continue;
      state.fieldExecutorAffinities.set(key, {
        executor: "main",
        declared: false,
        originType: declaration.name,
        fieldPath: [field.name],
        reason: "mixedClassSafety",
      });
    }
  }
}

function analyzeStructDeclaration(
  declaration: StructDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  foreignTypes: ReadonlyMap<string, ForeignPointerType>,
  fileName: string,
  state: AnalysisState,
): void {
  if (declaration.constructor && declaration.kind !== "class") {
    throw new DiagnosticError(fileName, declaration.constructor.location, "constructors are currently class-only; structs use Type({ ... }) value construction");
  }
  if (declaration.kind === "class" && declaration.fields.some((field) => field.defaultValue)) {
    const field = declaration.fields.find((candidate) => candidate.defaultValue)!;
    throw new DiagnosticError(fileName, field.location, "class field defaults are deferred until synthesized and custom constructor initialization share one cleanup-safe rule", {
      helps: ["initialize the field in the class constructor for now"],
    });
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
    if (parseOnceType(field.type.name)) {
      throw new DiagnosticError(fileName, field.type.location, `${displayAssignableType(field.type.name, state)} cannot be stored in a field`, {
        code: "Z0604",
        notes: ["a Once<T> is an address-stable module cell"],
        helps: ["keep the Once<T> cell as a private module const and expose narrow initialize/get wrapper functions"],
      });
    }
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
    if (method.rawBody) {
      throw new DiagnosticError(fileName, method.rawBody.location, "raw native method bodies are deferred beyond the first raw interop tier", {
        code: "Z0820",
        helps: ["move the boundary into a module function and pass the receiver state explicitly"],
      });
    }
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
    if (isGeneratorFunction(method)) {
      throw new DiagnosticError(fileName, method.returnType.location, "generator methods are deferred beyond the first generator tier", {
        notes: ["retaining or consuming `this` in a cold suspended frame needs an explicit receiver-ownership rule"],
        helps: ["pass the needed owned state to a module function returning Generator<T>"],
      });
    }
    if (isAsyncGeneratorFunction(method)) {
      throw new DiagnosticError(fileName, method.returnType.location, "async generator methods are deferred beyond the first module-function tier", {
        notes: ["the reusable stream frame needs an explicit retained or consuming receiver contract"],
        helps: ["pass owned state to a module async function returning AsyncGenerator<T>"],
      });
    }
    validateFunctionSignature(method, structs, enums, foreignNamedTypes, foreignTypes, fileName, state);
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
    validateFunctionSignature(constructorFunction(declaration), structs, enums, foreignNamedTypes, foreignTypes, fileName, state);
  }
}

function analyzeTraitDeclaration(
  declaration: TraitDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  foreignTypes: ReadonlyMap<string, ForeignPointerType>,
  fileName: string,
  state: AnalysisState,
): void {
  const methods = new Set<string>();
  for (const method of declaration.methods) {
    validateUserName(method.name, method.location, fileName);
    if (methods.has(method.name)) {
      throw new DiagnosticError(fileName, method.location, `duplicate method ${JSON.stringify(method.name)} in trait ${JSON.stringify(declaration.name)}`);
    }
    methods.add(method.name);
    validateFunctionSignature(method, structs, enums, foreignNamedTypes, foreignTypes, fileName, state);
    if (containsViewType(method.returnType.name)) {
      throw new DiagnosticError(fileName, method.returnType.location, "trait requirements cannot expose receiver-tied views in the first view tier", { code: "Z0206" });
    }
  }
}

function validateTraitConformance(
  declaration: StructDeclaration,
  traits: Map<string, TraitDeclaration>,
  foreignProtocols: ReadonlyMap<string, ForeignObjCProtocol>,
  fileName: string,
  state: AnalysisState,
): void {
  const implemented = new Set<string>();
  const protocols: ForeignObjCProtocol[] = [];
  const protocolMethods = new Map<number, ForeignObjCProtocolMethod>();
  for (const reference of declaration.implements) {
    if (implemented.has(reference.name)) {
      throw new DiagnosticError(fileName, reference.location, `${declaration.kind} ${JSON.stringify(declaration.name)} repeats interface ${JSON.stringify(reference.name)}`);
    }
    implemented.add(reference.name);
    const protocol = foreignProtocols.get(reference.name);
    if (protocol) {
      if (declaration.kind !== "class") {
        throw new DiagnosticError(fileName, reference.location, `Objective-C protocol ${JSON.stringify(reference.name)} can only be implemented by a Z class`, {
          code: "Z0810",
          notes: ["Z generates an Objective-C adapter that retains and forwards to the ARC class instance"],
        });
      }
      protocols.push(protocol);
      continue;
    }
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
      if (!sameMethodSignature(method, requirement, declaration.name)) {
        throw new DiagnosticError(
          fileName,
          method.location,
          `method ${declaration.name}.${method.name} does not match trait requirement ${reference.name}.${requirement.name}`,
        );
      }
    }
    if (trait.intrinsic === "iterator") {
      const next = trait.methods.find((method) => method.name === "next");
      const option = next ? parseOptionType(next.returnType.name) : null;
      if (!option) {
        throw new DiagnosticError(fileName, reference.location, "Iterator<T>.next must return Option<T>");
      }
      state.iteratorElementTypes.set(declaration.name, option.target);
    }
  }
  if (protocols.length === 0) {
    const exported = declaration.methods.find((method) => method.nativeSelector);
    if (exported) {
      throw new DiagnosticError(fileName, exported.location, "an Objective-C selector export requires an implemented Objective-C protocol", {
        code: "Z0810",
        helps: ["add the imported protocol after `implements`, or remove the `as \"selector:\"` clause"],
      });
    }
    return;
  }

  const allRequirements = protocols.flatMap((protocol) => objcProtocolRequirements(protocol, foreignProtocols));
  const selectors = new Set<string>();
  for (const method of declaration.methods) {
    if (!method.nativeSelector) continue;
    if (method.static || method.async || method.errorType) {
      throw new DiagnosticError(fileName, method.location, "an Objective-C protocol method must be a synchronous, non-throwing instance method", {
        code: "Z0810",
      });
    }
    if (selectors.has(method.nativeSelector)) {
      throw new DiagnosticError(fileName, method.location, `duplicate Objective-C selector export ${JSON.stringify(method.nativeSelector)}`, {
        code: "Z0810",
      });
    }
    selectors.add(method.nativeSelector);
    const candidates = allRequirements.filter((requirement) => (
      requirement.instance && requirement.selector === method.nativeSelector
    ));
    if (candidates.length === 0) {
      throw new DiagnosticError(
        fileName,
        method.location,
        `selector ${JSON.stringify(method.nativeSelector)} is not declared by an implemented Objective-C protocol`,
        {
          code: "Z0810",
          notes: protocols.map((protocol) => `implemented protocol: ${protocol.typeName}`),
        },
      );
    }
    const requirement = candidates[0];
    validateObjCProtocolMethodSignature(declaration, method, requirement, fileName, state);
    protocolMethods.set(method.location.offset, requirement);
  }
  for (const requirement of allRequirements) {
    if (!requirement.required || !requirement.instance || selectors.has(requirement.selector)) continue;
    throw new DiagnosticError(
      fileName,
      declaration.location,
      `class ${JSON.stringify(declaration.name)} does not implement required Objective-C selector ${JSON.stringify(requirement.selector)}`,
      {
        code: "Z0810",
        labels: requirement.metadata.source ? [{
          location: {
            offset: 0,
            line: requirement.metadata.source.line,
            column: requirement.metadata.source.column,
            fileName: requirement.metadata.source.fileName,
          },
          message: "required protocol method is declared here",
          length: requirement.metadata.source.length,
        }] : [],
        helps: ["use protocol-aware completion inside the class body to insert the method scaffold"],
      },
    );
  }
  state.objcProtocolConformances.set(declaration.name, {
    declaration,
    protocols,
    methods: protocolMethods,
  });
}

function objcProtocolRequirements(
  protocol: ForeignObjCProtocol,
  protocols: ReadonlyMap<string, ForeignObjCProtocol>,
  seen = new Set<string>(),
): ForeignObjCProtocolMethod[] {
  if (seen.has(protocol.typeName)) return [];
  seen.add(protocol.typeName);
  const separator = protocol.typeName.lastIndexOf(".");
  const moduleName = separator < 0 ? "" : protocol.typeName.slice(0, separator);
  return [
    ...protocol.methods,
    ...protocol.inherited.flatMap((name) => {
      // Generated protocol adapters inherit NSObject and therefore already
      // satisfy the root NSObject protocol without forwarding those selectors
      // into the Z controller.
      if (name === "NSObject") return [];
      const inherited = protocols.get(moduleName ? `${moduleName}.${name}` : name);
      return inherited ? objcProtocolRequirements(inherited, protocols, seen) : [];
    }),
  ];
}

function validateObjCProtocolMethodSignature(
  owner: StructDeclaration,
  method: FunctionDeclaration,
  requirement: ForeignObjCProtocolMethod,
  fileName: string,
  state: AnalysisState,
): void {
  const expectedReturn = String(foreignValueType(requirement.returnType));
  if (method.returnType.name !== expectedReturn) {
    throw new DiagnosticError(
      fileName,
      method.returnType.location,
      `Objective-C selector ${JSON.stringify(requirement.selector)} returns ${describeValueType(expectedReturn, state)}, but ${owner.name}.${method.name} returns ${describeValueType(method.returnType.name, state)}`,
      { code: "Z0810" },
    );
  }
  if (method.parameters.length !== requirement.parameters.length) {
    throw new DiagnosticError(
      fileName,
      method.location,
      `Objective-C selector ${JSON.stringify(requirement.selector)} expects ${requirement.parameters.length} parameter(s), but ${owner.name}.${method.name} declares ${method.parameters.length}`,
      { code: "Z0810" },
    );
  }
  method.parameters.forEach((parameter, index) => {
    const expected = String(foreignValueType(requirement.parameters[index].type));
    if (parameter.type.name !== expected) {
      throw new DiagnosticError(
        fileName,
        parameter.location,
        `Objective-C selector ${JSON.stringify(requirement.selector)} parameter ${index + 1} expects ${describeValueType(expected, state)}, found ${describeValueType(parameter.type.name, state)}`,
        { code: "Z0810" },
      );
    }
    const object = requirement.parameters[index].type.kind === "object";
    const expectedMode = object ? "in" : "value";
    if (parameter.mode !== expectedMode) {
      throw new DiagnosticError(
        fileName,
        parameter.location,
        `Objective-C selector ${JSON.stringify(requirement.selector)} parameter ${JSON.stringify(parameter.name)} must use ${expectedMode === "in" ? "`in`" : "value"} passing`,
        {
          code: "Z0810",
          notes: [object
            ? "Objective-C references are borrowed for the duration of the callback"
            : "Objective-C scalar arguments are passed by value"],
        },
      );
    }
  });
}

function sameMethodSignature(actual: FunctionDeclaration, required: FunctionDeclaration, ownerType?: string): boolean {
  return Boolean(actual.async) === Boolean(required.async)
    // An implementation may be less isolated than its requirement: callers
    // that know only the trait still provide the required executor proof. The
    // reverse would strengthen the contract invisibly and is unsound.
    && (!actual.executorAffinity || Boolean(required.executorAffinity))
    && actual.receiverMode === required.receiverMode
    && actual.returnType.name === required.returnType.name
    && actual.errorType?.name === required.errorType?.name
    && actual.parameters.length === required.parameters.length
    && actual.parameters.every((parameter, index) => (
      parameter.mode === required.parameters[index].mode
      && parameter.type.name === (required.parameters[index].type.name === hashableSelfTypeName
        ? ownerType
        : required.parameters[index].type.name)
    ));
}

function analyzeEnumDeclaration(
  declaration: EnumDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
  state: AnalysisState,
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
      if (parseOnceType(variant.payload.name)) {
        throw new DiagnosticError(fileName, variant.payload.location, `${displayAssignableType(variant.payload.name, state)} cannot be stored in an enum payload`, {
          code: "Z0604",
          notes: ["a Once<T> is an address-stable module cell"],
        });
      }
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
  state: AnalysisState,
): void {
  validateType(declaration.returnType, structs, enums, foreignNamedTypes, fileName, true);
  if (parseOnceType(declaration.returnType.name)) {
    throw new DiagnosticError(fileName, declaration.returnType.location, `${displayAssignableType(declaration.returnType.name, state)} cannot be returned by value`, {
      code: "Z0604",
      notes: ["a Once<T> has one canonical address-stable module identity"],
      helps: ["return the stored class through a narrow getter instead"],
    });
  }
  if (declaration.rawBody) {
    if (declaration.async || declaration.errorType) {
      throw new DiagnosticError(fileName, declaration.rawBody.location, "a raw native function body must be synchronous and non-throwing in the first tier", {
        code: "Z0820",
      });
    }
    if ((declaration.typeParameters?.length ?? 0) > 0) {
      throw new DiagnosticError(fileName, declaration.rawBody.location, "a raw native function body cannot be generic in the first tier", {
        code: "Z0820",
        notes: ["the native body needs one concrete ABI signature"],
      });
    }
    validateRawBoundaryType(declaration.returnType, true, foreignNamedTypes, foreignTypes, fileName);
    for (const parameter of declaration.parameters) {
      validateRawBoundaryType(parameter.type, false, foreignNamedTypes, foreignTypes, fileName);
    }
  }
  if (declaration.async && parseGeneratorType(declaration.returnType.name)) {
    throw new DiagnosticError(fileName, declaration.returnType.location, "an async generator must return AsyncGenerator<T>, not Generator<T>", {
      code: "Z0704",
      helps: ["import AsyncGenerator from std/iteration and update the declared return type"],
    });
  }
  const generator = isGeneratorFunction(declaration) ? parseGeneratorType(declaration.returnType.name) : null;
  if (generator) {
    if (generator.errorType !== (declaration.errorType?.name ?? null)) {
      throw new DiagnosticError(
        fileName,
        declaration.returnType.location,
        generator.errorType
          ? `generator error capability ${displayArrayType(generator.errorType)} requires a matching throws declaration`
          : "a throwing generator must carry its declared error capability",
      );
    }
    if (declaration.async) {
      throw new DiagnosticError(fileName, declaration.location, "a synchronous Generator<T> function cannot be async", {
        notes: ["async generators require a separate scheduling and cancellation contract"],
      });
    }
    if (containsViewType(generator.elementType) || containsSliceType(generator.elementType)) {
      throw new DiagnosticError(fileName, declaration.returnType.location, "Generator<T> cannot yield borrowed storage in the first generator tier", {
        code: "Z0206",
        helps: ["yield an owned value or cleanup-free copy"],
      });
    }
    if (hasMoveOnlyForeignType(generator.elementType, structs, enums, foreignNamedTypes)) {
      throw new DiagnosticError(fileName, declaration.returnType.location, "Generator<T> cannot store move-only native C++ payloads in the first generator tier");
    }
    if (containsForeignValueStorage(generator.elementType, structs, enums, foreignNamedTypes)) {
      throw new DiagnosticError(fileName, declaration.returnType.location, "Generator<T> native value payloads require frame-aware C++ construction and are deferred");
    }
    for (const parameter of declaration.parameters) {
      if (parameter.mode !== "value") {
        throw new DiagnosticError(fileName, parameter.location, "a cold generator cannot retain borrowed parameter storage", {
          code: "Z0206",
          helps: ["pass an owned value parameter; borrowed generator inputs require an explicit lifetime contract"],
        });
      }
      if (containsViewType(parameter.type.name) || containsSliceType(parameter.type.name)) {
        throw new DiagnosticError(fileName, parameter.location, "a cold generator cannot retain borrowed parameter storage", {
          code: "Z0206",
          helps: ["pass an owned value parameter"],
        });
      }
      if (containsForeignValueStorage(parameter.type.name, structs, enums, foreignNamedTypes)) {
        throw new DiagnosticError(fileName, parameter.location, "cold generator frames cannot retain native C++ value parameters yet");
      }
    }
  }
  const asyncGenerator = parseAsyncGeneratorType(declaration.returnType.name);
  if (asyncGenerator) {
    if (!declaration.async) {
      throw new DiagnosticError(fileName, declaration.location, "AsyncGenerator<T> requires an async function", {
        code: "Z0701",
        helps: ["add `async` before `function`"],
      });
    }
    if (!isAsyncGeneratorFunction(declaration)) {
      throw new DiagnosticError(fileName, declaration.location, "an async generator body must contain yield", {
        helps: ["yield at least one value, or return an ordinary Task result from the async function"],
      });
    }
    if (asyncGenerator.errorType !== (declaration.errorType?.name ?? null)) {
      throw new DiagnosticError(
        fileName,
        declaration.returnType.location,
        asyncGenerator.errorType
          ? `async generator error capability ${displayArrayType(asyncGenerator.errorType)} requires a matching throws declaration`
          : "a throwing async generator must carry its declared error capability",
      );
    }
    if (containsViewType(asyncGenerator.elementType) || containsSliceType(asyncGenerator.elementType)) {
      throw new DiagnosticError(fileName, declaration.returnType.location, "AsyncGenerator<T> cannot yield borrowed storage", {
        code: "Z0206",
        helps: ["yield an owned value or cleanup-free copy"],
      });
    }
    for (const parameter of declaration.parameters) {
      if (
        parameter.mode !== "value"
        || containsViewType(parameter.type.name)
        || containsSliceType(parameter.type.name)
      ) {
        throw new DiagnosticError(fileName, parameter.location, "a cold async generator cannot retain borrowed parameter storage", {
          code: "Z0206",
          helps: ["pass an owned value parameter"],
        });
      }
    }
  }
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
    if (parseOnceType(parameter.type.name)) {
      throw new DiagnosticError(fileName, parameter.type.location, `${displayAssignableType(parameter.type.name, state)} cannot be passed as a function parameter`, {
        code: "Z0604",
        notes: ["methods operate directly on the canonical module cell"],
        helps: ["keep the cell private and expose a narrow wrapper function"],
      });
    }
    if (declaration.async && parseGeneratorType(parameter.type.name)) {
      throw new DiagnosticError(fileName, parameter.location, "async task frames cannot store Generator<T> parameters yet", { code: "Z0704" });
    }
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

function validateRawBoundaryType(
  type: TypeReference,
  allowVoid: boolean,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  foreignTypes: ReadonlyMap<string, ForeignPointerType>,
  fileName: string,
): void {
  const supportedPrimitive = type.name === "boolean"
    || type.name === "cstring"
    || integerTypes.has(type.name)
    || floatTypes.has(type.name)
    || (allowVoid && type.name === "void");
  if (supportedPrimitive || foreignNamedTypes.has(type.name) || foreignTypes.has(type.name)) return;
  throw new DiagnosticError(fileName, type.location, `type ${JSON.stringify(displayArrayType(type.name))} cannot cross a raw native boundary in the first tier`, {
    code: "Z0821",
    notes: ["raw boundaries currently accept ABI-stable scalars, cstring, and imported native types"],
    helps: ["keep Z-owned storage outside the block and expose an imported native representation through an adjacent .zd contract"],
  });
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
  const lifecycleBody = Boolean(
    receiver
    && (declaration.name === "constructor" || declaration.name === "deinit")
    && state.aggregateExecutorAffinities.has(receiver.name),
  );
  state.executorContext = (
    (!receiver && declaration.name === "main")
    || Boolean(declaration.executorAffinity)
    || Boolean(receiver?.executorAffinity)
    || lifecycleBody
  ) ? "main" : null;
  if (
    receiver?.kind === "class"
    && !receiver.executorAffinity
    && state.aggregateExecutorAffinities.has(receiver.name)
    && !declaration.static
    && !declaration.executorAffinity
    && declaration.name !== "constructor"
    && declaration.name !== "deinit"
  ) {
    const escapingReceiver = executorBoundCaptureUseOutsideMain(
      declaration.body,
      "this",
      false,
      true,
    );
    if (escapingReceiver) {
      throw new DiagnosticError(
        fileName,
        escapingReceiver,
        `mixed-affinity class ${JSON.stringify(receiver.name)} may use this off thread.main only through an accessible member`,
        {
          code: "Z0711",
          notes: ["the class identity carries main-thread destruction, so an unrestricted method cannot return, pass, copy, or otherwise escape `this`"],
          helps: ["access a readonly thread-safe field, call another unrestricted method, or mark this method `on thread.main`"],
        },
      );
    }
  }
  state.placementErrorTypes.length = 0;
  state.moveOrigins.clear();
  state.borrowOrigins.clear();
  state.iterationBorrowOrigins.clear();
  state.activeLoans.clear();
  state.asyncSpawnBorrowRoots.clear();
  state.asyncTaskBorrowSpawns.clear();
  state.asyncScopeDepth = 0;
  state.asyncLoopDepth = 0;
  state.asyncLoopScopeFloors.length = 0;
  state.viewCallOrigins.clear();
  state.viewOrigins.clear();
  state.connectionCallOrigins.clear();
  state.connectionOrigins.clear();
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

  if (declaration.rawBody) {
    state.activeReceiver = previousReceiver;
    state.activeFunction = previousFunction;
    state.executorContext = previousExecutorContext;
    return;
  }

  const synchronousGenerator = isGeneratorFunction(declaration)
    ? parseGeneratorType(declaration.returnType.name)
    : null;
  const generator = synchronousGenerator ?? (
    isAsyncGeneratorFunction(declaration)
      ? parseAsyncGeneratorType(declaration.returnType.name)
      : null
  );
  if (synchronousGenerator && !synchronousGenerator.returnType && !synchronousGenerator.errorType) {
    state.iteratorElementTypes.set(declaration.returnType.name, synchronousGenerator.elementType);
  }
  const returns = analyzeStatements(declaration.body, declaration, locals, globals, structs, enums, fileName, state);
  if (synchronousGenerator) {
    validateGeneratorBodyShape(declaration, fileName, state);
  }
  const unresolvedOutBinding = state.inferredOutBindingLocations.entries().next().value as [string, SourceLocation] | undefined;
  if (unresolvedOutBinding) {
    throw new DiagnosticError(fileName, unresolvedOutBinding[1], `cannot infer type of uninitialized let ${JSON.stringify(unresolvedOutBinding[0])}`, {
      notes: ["an untyped uninitialized let is reserved for initialization by a typed out argument"],
      helps: ["pass it as `out <name>` to a classified function or add an explicit type annotation"],
    });
  }
  if (!returns) requireOutParametersInitialized(declaration, locals, declaration.location, fileName);
  if ((!generator && declaration.returnType.name !== "void" || generator?.returnType) && !returns) {
    throw new DiagnosticError(fileName, declaration.location, `function ${JSON.stringify(declaration.name)} must end with a return value`);
  }
  state.activeReceiver = previousReceiver;
  state.activeFunction = previousFunction;
  state.executorContext = previousExecutorContext;
}

function validateGeneratorBodyShape(
  declaration: FunctionDeclaration,
  fileName: string,
  state: AnalysisState,
): void {
  const names = new Set(declaration.parameters.map((parameter) => parameter.name));
  const containsYield = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if ((value as { readonly kind?: string }).kind === "yield") return true;
    if ((value as { readonly kind?: string }).kind === "closure") return false;
    if (Array.isArray(value)) return value.some(containsYield);
    return Object.entries(value as Record<string, unknown>)
      .some(([key, child]) => key !== "location" && containsYield(child));
  };
  const containsYieldingMatchExpression = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (
      (value as { readonly kind?: string }).kind === "matchExpression"
      && containsYield(value)
    ) return true;
    if ((value as { readonly kind?: string }).kind === "closure") return false;
    if (Array.isArray(value)) return value.some(containsYieldingMatchExpression);
    return Object.entries(value as Record<string, unknown>)
      .some(([key, child]) => key !== "location" && containsYieldingMatchExpression(child));
  };
  const visit = (statement: Statement): void => {
    if (containsYieldingMatchExpression(statement)) {
      throw new DiagnosticError(fileName, statement.location, "yield inside a value-producing match expression is deferred beyond the persistent match-statement tier", {
        notes: ["the selected expression result must also become persistent suspension state"],
        helps: ["use a match statement around the yielding work"],
      });
    }
    if (statement.kind === "variable") {
      if (names.has(statement.name)) {
        throw new DiagnosticError(fileName, statement.nameLocation, `generator frame binding ${JSON.stringify(statement.name)} shadows another stored binding`, {
          notes: ["suspended locals have stable frame storage for the generator's complete lifetime"],
          helps: ["rename the inner binding"],
        });
      }
      names.add(statement.name);
      if (statement.initializer?.kind === "closure") {
        throw new DiagnosticError(fileName, statement.initializer.location, "closures inside generator frames are deferred beyond the first generator tier");
      }
      return;
    }
    if (statement.kind === "destructure") {
      throw new DiagnosticError(fileName, statement.location, "destructuring locals inside generators is deferred beyond the first frame tier");
    }
    if (statement.kind === "for" && containsYield(statement)) {
      const iterableType = state.expressionTypes.get(statement.iterable.location.offset);
      if (iterableType && !state.iteratorElementTypes.has(iterableType)) {
        // Built-in collections use a stable owner plus a persistent frame cursor,
        // so their borrowed element bindings remain valid across suspension.
      } else {
        throw new DiagnosticError(fileName, statement.location, "yield inside custom Iterator for...of is deferred beyond the persistent collection-loop tier", {
          notes: ["an owned iterator and its current Option payload must both become persistent frame state"],
          helps: ["iterate an Array, Slice, Map, or Set, or advance the iterator explicitly"],
        });
      }
    }
    if (statement.kind === "block") {
      statement.statements.forEach(visit);
    } else if (statement.kind === "if") {
      visit(statement.thenBranch);
      if (statement.elseBranch) visit(statement.elseBranch);
    } else if (statement.kind === "while") {
      visit(statement.body);
    } else if (statement.kind === "for") {
      visit(statement.body);
    } else if (statement.kind === "match") {
      for (const arm of statement.arms) visit(arm.body);
    }
  };
  declaration.body.forEach(visit);
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
      case "argumentReference":
        return;
      case "dynamicArrayExpression":
        for (const element of expression.elements) checkExpression(element, initialized);
        return;
      case "raw":
        for (const capture of expression.captures) {
          checkExpression({ kind: "identifier", name: capture.name, location: capture.nameLocation }, initialized);
        }
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
        if (expression.spread) checkExpression(expression.spread.expression, initialized);
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
        if (expression.call) checkExpression(expression.call, initialized);
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
      case "unsafeExpression":
        analyzeConstructorStatements(expression.body.statements, new Set(initialized));
        return;
      case "whileExpression":
        checkExpression(expression.condition, initialized);
        analyzeConstructorStatements(expression.body.statements, new Set(initialized));
        analyzeConstructorStatements(expression.elseBranch.statements, new Set(initialized));
        return;
      case "forExpression":
        checkExpression(expression.iterable, initialized);
        analyzeConstructorStatements(expression.body.statements, new Set(initialized));
        analyzeConstructorStatements(expression.elseBranch.statements, new Set(initialized));
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
      } else if (statement.kind === "destructure") {
        checkExpression(statement.initializer, initialized);
      } else if (statement.kind === "assignment") {
        checkExpression(statement.target, initialized);
        checkExpression(statement.expression, initialized);
      } else if (statement.kind === "throw" || statement.kind === "yield" || statement.kind === "select" || statement.kind === "expressionStatement") {
        checkExpression(statement.expression, initialized);
      } else if (statement.kind === "block") {
        const result = analyzeConstructorStatements(statement.statements, initialized);
        initialized = result.initialized;
        if (result.stops) return result;
      } else if (statement.kind === "unsafe") {
        const result = analyzeConstructorStatements(statement.body.statements, initialized);
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
  const inheritedConnections = new Set(state.connectionOrigins.keys());
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
  for (const name of state.connectionOrigins.keys()) {
    if (!inheritedConnections.has(name)) unbindConnectionOrigin(name, state);
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
  if (statement.kind === "unsafe") return statementReturns(statement.body);
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
  if (statement.kind === "unsafe") return statementStopsFlow(statement.body);
  if (statement.kind === "block") return statementStopsFlow(statement.statements.at(-1));
  if (statement.kind === "if") {
    return Boolean(statement.elseBranch)
      && statementStopsFlow(statement.thenBranch)
      && statementStopsFlow(statement.elseBranch!);
  }
  return statement.kind === "match" && statement.arms.length > 0
    && statement.arms.every((arm) => statementStopsFlow(arm.body));
}

function collectSemanticTypeIdentities(
  typeName: string,
  path: string,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  aggregateMaterializations: ReadonlyMap<
    string,
    GenericAggregateMaterialization
  >,
  identities: SemanticTypeIdentity[] = [],
): readonly SemanticTypeIdentity[] {
  const childPath = (segment: string): string => path.length === 0 ? segment : `${path}/${segment}`;
  const materialization = aggregateMaterializations.get(typeName);
  if (materialization) {
    identities.push({ path, declaration: materialization.declaration });
    materialization.arguments.forEach((argument, index) => {
      collectSemanticTypeIdentities(
        argument,
        childPath(String(index)),
        structs,
        enums,
        aggregateMaterializations,
        identities,
      );
    });
    return identities;
  }
  const option = parseOptionType(typeName);
  if (option) {
    collectSemanticTypeIdentities(
      option.target,
      childPath("0"),
      structs,
      enums,
      aggregateMaterializations,
      identities,
    );
    return identities;
  }
  const view = parseViewType(typeName);
  if (view) {
    collectSemanticTypeIdentities(
      view.target,
      childPath("0"),
      structs,
      enums,
      aggregateMaterializations,
      identities,
    );
    return identities;
  }
  const fixed = parseFixedArrayType(typeName);
  const slice = parseSliceType(typeName);
  const dynamic = parseDynamicArrayType(typeName);
  const arrayElement = fixed?.elementType ?? slice?.elementType ?? dynamic?.elementType;
  if (arrayElement) {
    collectSemanticTypeIdentities(
      arrayElement,
      childPath("0"),
      structs,
      enums,
      aggregateMaterializations,
      identities,
    );
    return identities;
  }
  const weak = parseWeakType(typeName);
  if (weak) {
    collectSemanticTypeIdentities(
      weak.target,
      childPath("0"),
      structs,
      enums,
      aggregateMaterializations,
      identities,
    );
    return identities;
  }
  const task = parseTaskType(typeName);
  if (task) {
    collectSemanticTypeIdentities(
      task.successType,
      childPath("0"),
      structs,
      enums,
      aggregateMaterializations,
      identities,
    );
    if (task.errorType) {
      collectSemanticTypeIdentities(
        task.errorType,
        childPath("1"),
        structs,
        enums,
        aggregateMaterializations,
        identities,
      );
    }
    return identities;
  }
  const functionType = parseFunctionType(typeName);
  if (functionType) {
    functionType.parameters.forEach((parameter, index) => {
      collectSemanticTypeIdentities(
        parameter.type,
        childPath(`p${index}`),
        structs,
        enums,
        aggregateMaterializations,
        identities,
      );
    });
    collectSemanticTypeIdentities(
      functionType.returnType,
      childPath("r"),
      structs,
      enums,
      aggregateMaterializations,
      identities,
    );
    if (functionType.errorType) {
      collectSemanticTypeIdentities(
        functionType.errorType,
        childPath("e"),
        structs,
        enums,
        aggregateMaterializations,
        identities,
      );
    }
    return identities;
  }
  const result = enums.get(typeName);
  if (typeName.startsWith("__z_Result_") && result) {
    const success = result.variants.find((variant) => variant.name === "success")?.payload?.name;
    const failure = result.variants.find((variant) => variant.name === "failure")?.payload?.name;
    if (success) {
      collectSemanticTypeIdentities(
        success,
        childPath("0"),
        structs,
        enums,
        aggregateMaterializations,
        identities,
      );
    }
    if (failure) {
      collectSemanticTypeIdentities(
        failure,
        childPath("1"),
        structs,
        enums,
        aggregateMaterializations,
        identities,
      );
    }
    return identities;
  }
  const declaration = structs.get(typeName) ?? enums.get(typeName);
  if (declaration) identities.push({ path, declaration });
  return identities;
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
    case "unsafe": {
      if (state.unsafeDepth > 0) {
        throw new DiagnosticError(fileName, statement.location, "unsafe blocks cannot be nested", {
          code: "Z0822",
          notes: ["the outer unsafe boundary already owns every unverified native assertion in this scope"],
        });
      }
      if (owner.async) {
        throw new DiagnosticError(fileName, statement.location, "unsafe blocks must be isolated in a synchronous function in the first tier", {
          code: "Z0822",
          notes: ["async task frames currently have no storage class for scope-confined opaque native values"],
          helps: ["move the unsafe operation into a synchronous Z function, then call that function from async code"],
        });
      }
      const deferred = findUnsafeDeferredOperation(statement.body);
      if (deferred) {
        throw new DiagnosticError(fileName, deferred.location, `${deferred.label} cannot cross an unsafe block in the first tier`, {
          code: "Z0822",
          notes: ["unsafe native proofs are synchronous and scoped; suspension or capture could outlive their asserted storage"],
          helps: ["finish the native operation synchronously inside unsafe, then move a supported Z value into asynchronous work"],
        });
      }
      const blockLocals = new Map(locals);
      const unsafeLocalBindings = new Set<string>();
      state.unsafeDepth += 1;
      state.unsafeLocalBindingScopes.push(unsafeLocalBindings);
      try {
        analyzeStatements(statement.body.statements, owner, blockLocals, globals, structs, enums, fileName, state);
      } finally {
        state.unsafeLocalBindingScopes.pop();
        for (const name of unsafeLocalBindings) state.unsafeUnverifiedBindings.delete(name);
        state.unsafeDepth -= 1;
      }
      propagateOuterOwnership(locals, blockLocals);
      return;
    }
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
        const declaredTypeName = resolveSemanticTypeName(declaredType, structs, enums, state);
        if (parseOnceType(declaredTypeName)) {
          throw new DiagnosticError(fileName, declaredType.location, `${displayAssignableType(declaredTypeName, state)} cannot be declared as local storage`, {
            code: "Z0604",
            notes: ["a Once<T> is one address-stable, statically empty module cell"],
            helps: ["declare the cell with module-level const"],
          });
        }
        if (hasMoveOnlyForeignType(declaredTypeName, structs, enums, state.foreignNamedTypes)) {
          throw new DiagnosticError(fileName, declaredType.location, "move-only native values must be initialized when their storage is declared", {
            code: "Z0240",
            notes: ["uninitialized Z locals do not run a non-trivial C++ constructor"],
            helps: ["initialize the binding from a native constructor, owned return, or moved value"],
          });
        }
        if (containsViewType(declaredTypeName)) {
          throw new DiagnosticError(fileName, declaredType.location, "view values cannot be declared as uninitialized storage", { code: "Z0206" });
        }
        if (containsSliceType(declaredTypeName)) {
          throw new DiagnosticError(fileName, declaredType.location, "Slice values cannot be stored in local bindings yet");
        }
        locals.set(statement.name, `${uninitializedPrefix}${mutablePrefix}${declaredTypeName}`);
        state.bindingTypes.set(statement.nameLocation.offset, declaredTypeName);
        return;
      }
      if (statement.type && parseViewType(statement.type.name)) {
        throw new DiagnosticError(fileName, statement.type.location, "view locals are inferred from their producing expression", {
          code: "Z0206",
          helps: ["omit the annotation and bind a view-producing call or `view projection` with `const`"],
        });
      }
      const localViewInitializer = statement.initializer.kind === "unary"
        && statement.initializer.operator === "view";
      if (localViewInitializer) {
        if (statement.mutable) {
          throw new DiagnosticError(fileName, statement.location, "`view expression` must initialize a const binding", {
            code: "Z0206",
            notes: ["the projection is read-only and tied to its named owner until last use"],
            helps: ["replace `let` with `const`"],
          });
        }
        if (statement.type) {
          throw new DiagnosticError(fileName, statement.type.location, "`view expression` uses an inferred view type", {
            code: "Z0206",
            helps: ["omit the type annotation; hover shows the projected type and owner"],
          });
        }
        state.localViewInitializers.add(statement.initializer.location.offset);
      }
      if (statement.initializer.kind === "closure") {
        if (statement.mutable) {
          throw new DiagnosticError(fileName, statement.location, "closure bindings are immutable in the initial non-escaping tier");
        }
        if (statement.type && !parseFunctionType(statement.type.name)) {
          throw new DiagnosticError(fileName, statement.type.location, "a closure annotation must be a function type");
        }
      }
      let declaredVariableType: ValueType | null = null;
      if (statement.type) {
        validateType(statement.type, structs, enums, state.foreignNamedTypes, fileName, false);
        declaredVariableType = resolveSemanticTypeName(statement.type, structs, enums, state);
      }
      const contextualFunction = statement.initializer.kind === "closure" && statement.type
        ? parseFunctionType(String(declaredVariableType))
        : null;
      let initializerType = statement.initializer.kind === "closure"
        ? inferClosureExpression(statement.initializer, locals, globals, structs, enums, fileName, state, {
            expectedFunction: contextualFunction,
          })
        : inferDirectValue(
          statement.initializer,
          owner,
          locals,
          globals,
          structs,
          enums,
          fileName,
          state,
          declaredVariableType,
        );
      if (isBorrowedNativeResource(initializerType, state)) {
        if (statement.mutable || statement.type) {
          throw new DiagnosticError(fileName, statement.location, "a borrowed native resource must be bound directly to an inferred const local", {
            code: "Z0206",
            notes: ["tier-one borrowed native resources are lexical, read-only, and non-escaping"],
            helps: ["use `const value = native.borrowedProducer()` and pass it only to `in` native parameters"],
          });
        }
      }
      const inferredBindingType = String(underlyingType(initializerType));
      const bindingResolution = statement.type ? null : {
        location: statement.nameLocation,
        name: statement.name,
        mutable: statement.mutable,
        inferredType: String(initializerType),
        typeIdentities: collectSemanticTypeIdentities(
          inferredBindingType,
          "",
          structs,
          enums,
          state.genericAggregateMaterializations,
        ),
      };
      let variableType = bindingResolution
        ? state.observer?.resolveBindingType?.(bindingResolution) ?? initializerType
        : initializerType;
      if (bindingResolution) state.observer?.onBindingResolution?.(bindingResolution);
      if (declaredVariableType) {
        variableType = declaredVariableType;
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
          requireAssignable(variableType, initializerType, statement.initializer, fileName, structs, enums, state);
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
      if (parseOnceType(String(underlyingType(variableType)))) {
        throw new DiagnosticError(fileName, statement.location, `${displayAssignableType(variableType, state)} cannot be copied into local storage`, {
          code: "Z0604",
          notes: ["a Once<T> is one address-stable module cell; copying it would split its initialization state"],
          helps: ["call initialize/get directly on the module cell or a source import alias"],
        });
      }
      const view = parseViewType(String(variableType));
      const optionalView = parseOptionalViewType(String(variableType));
      const foreignStringView = foreignPointer(variableType, state)?.stringView === true;
      if (view || optionalView || foreignStringView) {
        if (statement.mutable) {
          throw new DiagnosticError(fileName, statement.location, "a view binding must use const", { code: "Z0206" });
        }
        const origin = state.viewCallOrigins.get(statement.initializer.location.offset);
        if (!origin) {
          throw new DiagnosticError(fileName, statement.initializer.location, "a view-bearing value must be bound directly from its producing expression", {
            code: "Z0206",
            helps: ["bind a view-returning method call or `view projection` directly to const storage"],
          });
        }
        locals.set(statement.name, String(variableType));
        state.bindingTypes.set(statement.nameLocation.offset, String(variableType));
        bindViewOrigin(statement.name, origin, fileName, state);
        state.viewBindingOwners.set(
          statement.nameLocation.offset,
          viewOriginOwnerLabel(origin),
        );
        return;
      }
      if (String(variableType) === nativeConnectionTypeName) {
        if (statement.mutable) {
          throw new DiagnosticError(fileName, statement.location, "a native connection binding must use const", {
            code: "Z0205",
          });
        }
        const origin = foreignConnectionOrigin(statement.initializer, state);
        if (!origin) {
          throw new DiagnosticError(
            fileName,
            statement.initializer.location,
            "a native connection must be bound directly from its declaring foreign call",
            {
              code: "Z0205",
              notes: ["connection tokens cannot be copied, returned, or stored in another aggregate in the first tier"],
            },
          );
        }
        const conflict = registerAccessLoan(state.activeLoans, {
          root: origin.owner,
          capability: "in",
          lifetime: { kind: "connection", binding: statement.name },
          location: origin.location,
        });
        if (conflict) {
          throw new DiagnosticError(
            fileName,
            origin.location,
            `cannot connect ${JSON.stringify(statement.name)} while ${JSON.stringify(origin.owner)} has an active ${conflict.capability} loan`,
            { code: "Z0205" },
          );
        }
        state.connectionOrigins.set(statement.name, origin);
        locals.set(statement.name, nativeConnectionTypeName);
        state.bindingTypes.set(statement.nameLocation.offset, nativeConnectionTypeName);
        return;
      }
      if (isBorrowedNativeResource(variableType, state)) {
        locals.set(statement.name, String(variableType));
        state.bindingTypes.set(statement.nameLocation.offset, String(variableType));
        return;
      }
      const directForeignValue = state.foreignNamedTypes.get(String(underlyingType(variableType)));
      if (state.activeFunction?.async && parseGeneratorType(String(underlyingType(variableType)))) {
        throw new DiagnosticError(fileName, statement.location, "async task frames cannot store Generator<T> locals yet", {
          code: "Z0704",
          helps: ["consume the generator synchronously before or after the async operation"],
        });
      }
      if (
        state.activeFunction
        && isGeneratorFunction(state.activeFunction)
        && containsForeignValueStorage(String(underlyingType(variableType)), structs, enums, state.foreignNamedTypes)
      ) {
        throw new DiagnosticError(fileName, statement.location, "generator frame locals cannot contain native C++ value storage in the first tier", {
          code: "Z0240",
        });
      }
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
      if (state.unsafeDepth > 0) {
        state.unsafeLocalBindingScopes.at(-1)?.add(statement.name);
        if (isUnsafeUnverifiedValue(statement.initializer, state)) {
          state.unsafeUnverifiedBindings.add(statement.name);
        }
      }
      if (
        (
          statement.initializer.kind === "spawn"
          || (
            statement.initializer.kind === "executorPlacement"
            && statement.initializer.mode === "spawn"
          )
        )
        && state.asyncSpawnBorrowRoots.has(statement.initializer.location.offset)
      ) {
        state.asyncTaskBorrowSpawns.set(statement.name, statement.initializer.location.offset);
      }
      return;
    }
    case "destructure": {
      if (owner.async) {
        throw new DiagnosticError(fileName, statement.location, "destructuring is not executable in async functions yet", {
          code: "Z0700",
          helps: ["bind the aggregate normally in async code until destructuring is added to task-frame lowering"],
        });
      }
      const arrayViewInitializer = Boolean(
        statement.arrayBindings
        && statement.initializer.kind === "unary"
        && statement.initializer.operator === "view"
      );
      if (arrayViewInitializer) {
        if (statement.mutable) {
          throw new DiagnosticError(fileName, statement.location, "array view destructuring must use const", {
            code: "Z0206",
            notes: ["the projected elements and rest Slice are read-only and tied to their source owner"],
            helps: ["replace `let` with `const`"],
          });
        }
        if (statement.type) {
          throw new DiagnosticError(fileName, statement.type.location, "array view destructuring uses an inferred source type", {
            code: "Z0206",
            helps: ["omit the pattern type annotation; hover shows each inferred binding type"],
          });
        }
        state.localViewInitializers.add(statement.initializer.location.offset);
        state.arrayViewInitializers.add(statement.initializer.location.offset);
      }
      let expected: ValueType | null = null;
      if (statement.type) {
        validateType(statement.type, structs, enums, state.foreignNamedTypes, fileName, false);
        expected = resolveSemanticTypeName(statement.type, structs, enums, state);
      }
      const initializerType = inferDirectValue(
        statement.initializer,
        owner,
        locals,
        globals,
        structs,
        enums,
        fileName,
        state,
        expected,
      );
      if (expected) requireAssignable(expected, initializerType, statement.initializer, fileName, structs, enums, state);
      const inferredSourceType = String(underlyingType(expected ?? initializerType));
      const sourceType = parseViewType(inferredSourceType)?.target ?? inferredSourceType;
      if (statement.arrayBindings) {
        const fixed = parseFixedArrayType(sourceType);
        const dynamic = parseDynamicArrayType(sourceType);
        const slice = parseSliceType(sourceType);
        const collection = fixed ?? dynamic ?? slice;
        if (!collection) {
          throw new DiagnosticError(fileName, statement.location, `array destructuring requires a fixed array, Array<T>, or Slice<T>, found ${displayArrayType(sourceType)}`, {
            code: "Z0220",
          });
        }
        const rootExpression = arrayViewInitializer
          ? (statement.initializer as Extract<Expression, { kind: "unary" }>).operand
          : statement.initializer;
        const root = storageRoot(rootExpression);
        if (
          root
          && rootExpression.kind !== "identifier"
          && rootExpression.kind !== "member"
        ) {
          throw new DiagnosticError(fileName, rootExpression.location, "array destructuring requires a direct named collection or field", {
            code: "Z0220",
            notes: ["the first tier evaluates its source exactly once without retaining an indexed or computed owner path"],
            helps: ["bind the nested collection first, then destructure that binding"],
          });
        }
        if (!root && statement.initializer.kind !== "arrayExpression") {
          throw new DiagnosticError(fileName, statement.initializer.location, "array destructuring requires named collection storage or a fixed array literal in the first tier", {
            code: "Z0220",
            helps: ["bind the collection first, then destructure that binding"],
          });
        }
        const rest = statement.arrayBindings.find((binding) => binding.kind === "rest");
        if (rest && !arrayViewInitializer) {
          throw new DiagnosticError(fileName, rest.location, "array rest is a borrowed Slice and requires an explicit view source", {
            code: "Z0206",
            helps: ["write `const [first, ...remaining] = view values;`"],
          });
        }
        const requiredLength = statement.arrayBindings.filter((binding) => binding.kind !== "rest").length;
        if (fixed && requiredLength > fixed.length) {
          throw new DiagnosticError(fileName, statement.location, `array pattern requires ${requiredLength} elements, but ${displayArrayType(sourceType)} has length ${fixed.length}`, {
            code: "Z0220",
          });
        }
        const namedBindings = statement.arrayBindings.filter(
          (binding): binding is typeof binding & { readonly bindingName: string; readonly bindingLocation: SourceLocation } => (
            binding.bindingName !== null && binding.bindingLocation !== null
          ),
        );
        if (namedBindings.length === 0) {
          throw new DiagnosticError(fileName, statement.location, "array destructuring requires at least one named binding", {
            code: "Z0220",
            helps: ["keep `_` for skipped positions alongside a named element or rest binding"],
          });
        }
        const seen = new Set<string>();
        for (const binding of namedBindings) {
          validateUserName(binding.bindingName, binding.bindingLocation, fileName);
          if (seen.has(binding.bindingName) || locals.has(binding.bindingName)) {
            throw new DiagnosticError(fileName, binding.bindingLocation, `duplicate local ${JSON.stringify(binding.bindingName)}`);
          }
          seen.add(binding.bindingName);
        }
        const selectedElement = namedBindings.some((binding) => binding.kind === "binding");
        if (!arrayViewInitializer && selectedElement && hasOwnershipType(collection.elementType, structs, enums, state)) {
          throw new DiagnosticError(fileName, statement.initializer.location, `destructuring ownership-bearing ${displayArrayType(collection.elementType)} elements requires an explicit view`, {
            code: "Z0220",
            notes: ["plain array destructuring does not retain, copy, or move elements out of their collection"],
            helps: ["use `view values` for borrowed element bindings, or copy individual elements explicitly"],
          });
        }
        const origin = arrayViewInitializer
          ? state.viewCallOrigins.get(statement.initializer.location.offset)
          : null;
        if (arrayViewInitializer && !origin) {
          throw new DiagnosticError(fileName, statement.initializer.location, "array view destructuring requires named stable storage", {
            code: "Z0206",
          });
        }
        let elementIndex = 0;
        const planBindings: ArrayDestructurePlan["bindings"][number][] = [];
        for (const binding of statement.arrayBindings) {
          if (binding.kind === "discard") {
            planBindings.push({
              kind: "discard",
              name: null,
              index: elementIndex,
              type: null,
              borrowed: false,
            });
            elementIndex += 1;
            continue;
          }
          const name = binding.bindingName!;
          const bindingLocation = binding.bindingLocation!;
          if (binding.kind === "rest") {
            const type = sliceTypeName(collection.elementType);
            locals.set(name, type);
            state.bindingTypes.set(bindingLocation.offset, type);
            bindViewOrigin(name, origin!, fileName, state);
            state.viewBindingOwners.set(bindingLocation.offset, viewOriginOwnerLabel(origin!));
            planBindings.push({
              kind: "rest",
              name,
              index: elementIndex,
              type,
              borrowed: true,
            });
            continue;
          }
          const borrowed = arrayViewInitializer
            && hasOwnershipType(collection.elementType, structs, enums, state);
          const referenceIdentity = borrowed && (
            structs.get(collection.elementType)?.kind === "class"
            || state.foreignNamedTypes.get(collection.elementType)?.kind === "object"
            || collection.elementType.startsWith("__z_objc:")
          );
          const type = borrowed && !referenceIdentity
            ? viewTypeName(collection.elementType)
            : collection.elementType;
          locals.set(name, referenceIdentity ? `${borrowedPrefix}${type}` : type);
          state.bindingTypes.set(bindingLocation.offset, type);
          if (borrowed) {
            bindViewOrigin(name, origin!, fileName, state);
            state.viewBindingOwners.set(bindingLocation.offset, viewOriginOwnerLabel(origin!));
          }
          planBindings.push({
            kind: "binding",
            name,
            index: elementIndex,
            type,
            borrowed,
          });
          elementIndex += 1;
        }
        state.arrayDestructures.set(statement.location.offset, {
          sourceType,
          elementType: collection.elementType,
          fixedLength: fixed?.length ?? null,
          viewed: arrayViewInitializer,
          bindings: planBindings,
        });
        return;
      }
      const declaration = structs.get(sourceType);
      if (!declaration || declaration.kind !== "struct" || parseMapType(sourceType) || parseSetType(sourceType)) {
        throw new DiagnosticError(fileName, statement.location, `object destructuring requires a Z value struct, found ${displayArrayType(sourceType)}`, {
          code: "Z0220",
          notes: ["classes preserve shared identity and collections expose their storage through iteration instead"],
        });
      }
      const fields = resolveObjectBindingFields(
        statement.objectBindings,
        declaration,
        locals,
        fileName,
        state.activeReceiver,
      );
      if (declaration.deinitializer) {
        throw new DiagnosticError(fileName, statement.location, `cannot destructure ${declaration.name} because it defines deinit`, {
          code: "Z0220",
          notes: ["moving selected fields would leave the custom destructor with an incomplete value"],
          helps: ["read fields directly, or provide a type-specific method that returns the desired values"],
        });
      }
      if (containsForeignValueStorage(sourceType, structs, enums, state.foreignNamedTypes)) {
        throw new DiagnosticError(fileName, statement.location, `cannot destructure ${declaration.name} while it contains native value storage`, {
          code: "Z0240",
          notes: ["the first destructuring tier does not partially relocate native RAII fields, including copyable C++ and Swift values"],
          helps: ["move the complete aggregate or expose a type-specific extraction method"],
        });
      }
      if (containsOpaqueCleanupStorage(sourceType, structs, enums, state.foreignTypes)) {
        throw new DiagnosticError(fileName, statement.location, `cannot destructure ${declaration.name} while it contains custom or foreign cleanup storage`, {
          code: "Z0220",
          notes: ["the compiler cannot yet suppress cleanup for only the fields transferred by this pattern"],
          helps: ["move the complete aggregate or expose a type-specific extraction method"],
        });
      }
      const explicitOwnership = statement.initializer.kind === "unary"
        && (statement.initializer.operator === "copy" || statement.initializer.operator === "move");
      if (hasOwnershipType(sourceType, structs, enums, state)
        && isNamedStorageExpression(statement.initializer)
        && !explicitOwnership) {
        throw new DiagnosticError(fileName, statement.initializer.location, `destructuring owned ${sourceType} requires explicit copy or move`, {
          code: "Z0220",
          notes: ["plain destructuring must not hide an allocation or partial ownership transfer"],
          helps: ["use `copy value` to keep the source, or `move value` to consume it"],
        });
      }
      if (!explicitOwnership) {
        consumeOwnedValue(statement.initializer, sourceType, locals, structs, enums, fileName, state);
      }
      for (const { binding, field } of fields) {
        const stored = statement.mutable ? `${mutablePrefix}${field.type.name}` : field.type.name;
        locals.set(binding.bindingName, stored);
        state.bindingTypes.set(binding.bindingLocation.offset, field.type.name);
      }
      return;
    }
    case "assignment": {
      if (assignmentPathContainsOptionalChain(statement.target)) {
        throw new DiagnosticError(
          fileName,
          statement.target.location,
          "optional chaining is never an assignment target",
          {
            code: "Z0206",
            notes: ["an absent receiver cannot identify mutable storage"],
            helps: ["use an explicit `match` to unwrap the receiver before assigning"],
          },
        );
      }
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
          requireObjCAssignable(property.type, actual, statement.expression, structs, enums, fileName, state);
          if (state.unsafeDepth > 0 && isUnsafeUnverifiedValue(statement.expression, state)) {
            throw new DiagnosticError(fileName, statement.expression.location, "an unsafe native value cannot be stored outside its unsafe block", {
              code: "Z0822",
              notes: ["the local assertion has no reusable ownership or lifetime proof"],
              helps: ["consume the native value inside unsafe, or describe its reusable contract in an adjacent .zd file"],
            });
          }
          return;
        }
        const nativeOwnerType = inferExpression(statement.target.object, locals, globals, structs, enums, fileName, state);
        const nativeOwner = state.foreignNamedTypes.get(String(underlyingType(nativeOwnerType)));
        if (nativeOwner?.kind === "record" && nativeOwner.resource) {
          throw new DiagnosticError(fileName, statement.target.location, `native resource field ${JSON.stringify(statement.target.property)} is read-only in safe Z`, {
            code: "Z0823",
            notes: ["direct field mutation could violate invariants required by the native release function"],
            helps: ["use a contracted native `inout` operation to mutate the complete resource"],
          });
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
      let actual = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state, expected);
      actual = contextualCStringLiteral(expected, statement.expression, state) ?? actual;
      actual = contextualObjCStringToZ(expected, actual, statement.expression, state) ?? actual;
      actual = contextualSwiftStringToZ(expected, actual, statement.expression, state) ?? actual;
      rejectBorrowedNativeResourceEscape(actual, statement.expression, locals, fileName, state, "assigned into storage");
      requireAssignable(expected, actual, statement.expression, fileName, structs, enums, state);
      if (state.unsafeDepth > 0 && isUnsafeUnverifiedValue(statement.expression, state)) {
        const localBindings = state.unsafeLocalBindingScopes.at(-1);
        if (!localBindings?.has(root.name)) {
          throw new DiagnosticError(fileName, statement.expression.location, "an unsafe native value cannot be stored outside its unsafe block", {
            code: "Z0822",
            notes: ["the local assertion has no reusable ownership or lifetime proof"],
            helps: ["consume the native value inside unsafe, or describe its reusable contract in an adjacent .zd file"],
          });
        }
        state.unsafeUnverifiedBindings.add(root.name);
      } else if (state.unsafeDepth > 0 && statement.target.kind === "identifier") {
        state.unsafeUnverifiedBindings.delete(root.name);
      }
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
      const generator = isGeneratorFunction(owner)
        ? parseGeneratorType(owner.returnType.name)
        : isAsyncGeneratorFunction(owner)
          ? parseAsyncGeneratorType(owner.returnType.name)
          : null;
      if (generator) {
        if (!generator.returnType && statement.expression) {
          throw new DiagnosticError(fileName, statement.location, "a generator finishes with `return;` and cannot return a value", {
            notes: [`this generator yields ${displayArrayType(generator.elementType)} values`],
            helps: [`declare Generator<${displayArrayType(generator.elementType)}, ReturnType> to carry a terminal value`],
          });
        }
        if (generator.returnType && !statement.expression) {
          throw new DiagnosticError(fileName, statement.location, `Generator<${displayArrayType(generator.elementType)}, ${displayArrayType(generator.returnType)}> must return a terminal value`);
        }
        if (generator.returnType && statement.expression) {
          const actual = inferDirectValue(
            statement.expression,
            owner,
            locals,
            globals,
            structs,
            enums,
            fileName,
            state,
            generator.returnType,
          );
          requireAssignable(generator.returnType, actual, statement.expression, fileName, structs, enums, state);
          consumeOwnedValue(statement.expression, generator.returnType, locals, structs, enums, fileName, state);
        }
        requireOutParametersInitialized(owner, locals, statement.location, fileName);
        return;
      }
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
        const directProjection = statement.expression.kind === "identifier"
          || statement.expression.kind === "member"
          || statement.expression.kind === "index";
        if (state.activeReceiver) {
          if (
            !root
            || root.name !== "this"
            || (
              statement.expression.kind !== "member"
              && statement.expression.kind !== "index"
            )
          ) {
            throw new DiagnosticError(fileName, statement.expression.location, "a view method must return a field or indexed element derived directly from this", {
              code: "Z0206",
              notes: ["forwarding another view or returning local storage would let it escape the wrong owner"],
            });
          }
        } else {
          const parameter = root
            ? owner.parameters.find((candidate) => candidate.name === root.name)
            : null;
          if (!root || !parameter || parameter.mode !== "in" || !directProjection) {
            throw new DiagnosticError(fileName, statement.expression.location, "a parameter-provenanced view must return an immutable input, one of its fields, or one of its indexed elements", {
              code: "Z0206",
              notes: ["local storage and forwarded view bindings cannot escape their owner"],
              helps: ["derive the result directly from an `in` parameter"],
            });
          }
        }
        const actual = inferExpression(statement.expression, locals, globals, structs, enums, fileName, state);
        requireAssignable(view.target, actual, statement.expression, fileName, structs, enums, state);
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
      let actual = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state, expected);
      actual = contextualCStringLiteral(expected, statement.expression, state) ?? actual;
      actual = contextualObjCStringToZ(expected, actual, statement.expression, state) ?? actual;
      actual = contextualSwiftStringToZ(expected, actual, statement.expression, state) ?? actual;
      rejectBorrowedNativeResourceEscape(actual, statement.expression, locals, fileName, state, "returned from a function");
      requireAssignable(expected, actual, statement.expression, fileName, structs, enums, state);
      if (state.unsafeDepth > 0 && isUnsafeUnverifiedValue(statement.expression, state)) {
        throw new DiagnosticError(fileName, statement.expression.location, "an unsafe native value cannot be returned from its unsafe block", {
          code: "Z0822",
          notes: ["the local assertion has no reusable ownership or lifetime proof"],
          helps: ["consume the native value inside unsafe, or describe its reusable contract in an adjacent .zd file"],
        });
      }
      consumeOwnedValue(statement.expression, expected, locals, structs, enums, fileName, state);
      requireOutParametersInitialized(owner, locals, statement.location, fileName);
      return;
    }
    case "yield": {
      const generator = parseGeneratorType(owner.returnType.name)
        ?? parseAsyncGeneratorType(owner.returnType.name);
      if (!generator) {
        throw new DiagnosticError(fileName, statement.location, "yield requires a function returning Generator<T> or AsyncGenerator<T>", {
          helps: ["import Generator or AsyncGenerator from \"std/iteration\" and declare the function return type"],
        });
      }
      if (state.asyncScopeDepth > 0) {
        throw new DiagnosticError(fileName, statement.location, "yield cannot suspend through an async scope");
      }
      const liveView = state.viewOrigins.entries().next().value as [string, ViewOrigin] | undefined;
      if (liveView) {
        throw new DiagnosticError(fileName, statement.location, `generator cannot suspend while view ${JSON.stringify(liveView[0])} is live`, {
          code: "Z0206",
          notes: [`the view may borrow storage owned by ${JSON.stringify(viewOriginOwnerLabel(liveView[1]))}`],
          helps: ["copy the needed value before yield or end the view's last use before suspension"],
        });
      }
      const actual = inferDirectValue(
        statement.expression,
        owner,
        locals,
        globals,
        structs,
        enums,
        fileName,
        state,
        generator.elementType,
      );
      requireAssignable(generator.elementType, actual, statement.expression, fileName, structs, enums, state);
      if (containsViewType(String(actual)) || containsSliceType(String(actual))) {
        throw new DiagnosticError(fileName, statement.expression.location, "a generator cannot yield borrowed storage in the first generator tier", {
          code: "Z0206",
          helps: ["yield an owned value or a cleanup-free copy"],
        });
      }
      if (hasMoveOnlyForeignType(actual, structs, enums, state.foreignNamedTypes)) {
        throw new DiagnosticError(fileName, statement.expression.location, "generators cannot yield move-only native values in the first C++ tier");
      }
      consumeOwnedValue(statement.expression, generator.elementType, locals, structs, enums, fileName, state);
      return;
    }
    case "throw": {
      if (owner.testName) {
        throw new DiagnosticError(fileName, statement.location, "tests do not declare an ordinary throws channel", {
          code: "Z0901",
          notes: ["the runner's cleanup-preserving failure channel is an internal testing mechanism"],
          helps: ['import `fail` from "std/test" and call `fail("reason")`'],
        });
      }
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
      requireAssignable(errorType.name, actual, statement.expression, fileName, structs, enums, state);
      consumeOwnedValue(statement.expression, errorType.name, locals, structs, enums, fileName, state);
      return;
    }
    case "break": {
      const loop = state.loopStack.at(-1);
      if (!loop) throw new DiagnosticError(fileName, statement.location, "break requires an enclosing loop");
      if (loop.valueProducing) {
        throw new DiagnosticError(fileName, statement.location, "break cannot exit a value-producing loop without a value", {
          helps: ["use `select value;` to produce the loop expression result"],
        });
      }
      loop.breaks.push(new Map(locals));
      return;
    }
    case "continue": {
      const loop = state.loopStack.at(-1);
      if (!loop) throw new DiagnosticError(fileName, statement.location, "continue requires an enclosing loop");
      loop.continues.push(new Map(locals));
      return;
    }
    case "select": {
      const selection = state.valueLoopStack.at(-1);
      const loop = state.loopStack.at(-1);
      if (!selection || !loop?.valueProducing) {
        throw new DiagnosticError(fileName, statement.location, "select requires an enclosing value-producing block");
      }
      let type = inferDirectValue(
        statement.expression,
        owner,
        locals,
        globals,
        structs,
        enums,
        fileName,
        state,
        selection.expected,
      );
      if (selection.expected) {
        requireAssignable(selection.expected, type, statement.expression, fileName, structs, enums, state);
        type = selection.expected;
      } else {
        type = implicitlyLoadCopyableView(type, statement.expression, structs, enums, state);
      }
      consumeOwnedValue(statement.expression, type, locals, structs, enums, fileName, state);
      selection.selections.push({ type, locals: new Map(locals) });
      return;
    }
    case "asyncScope": {
      if (!owner.async) {
        throw new DiagnosticError(fileName, statement.location, "async scope requires an enclosing async function", {
          code: "Z0703",
          helps: [`add \`async\` before \`function ${owner.name}\``],
        });
      }
      const scopeLocals = new Map(locals);
      if (statement.name && statement.nameLocation) {
        validateUserName(statement.name, statement.nameLocation, fileName);
        if (scopeLocals.has(statement.name)) {
          throw new DiagnosticError(fileName, statement.nameLocation, `duplicate local ${JSON.stringify(statement.name)}`);
        }
        scopeLocals.set(statement.name, "TaskScope");
        state.bindingTypes.set(statement.nameLocation.offset, "TaskScope");
        state.taskScopeConstructors.add(statement.location.offset);
      }
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
        requireAssignable("boolean", conditionType, statement.condition, fileName, structs, enums, state);
      }
      analyzeIfBranches(statement, owner, locals, globals, structs, enums, fileName, state);
      return;
    }
    case "while": {
      state.asyncLoopDepth += 1;
      state.asyncLoopScopeFloors.push(state.asyncScopeDepth);
      try {
        analyzeWhileLoop(statement, owner, locals, globals, structs, enums, fileName, state);
      } finally {
        state.asyncLoopScopeFloors.pop();
        state.asyncLoopDepth -= 1;
      }
      return;
    }
    case "for": {
      state.asyncLoopDepth += 1;
      state.asyncLoopScopeFloors.push(state.asyncScopeDepth);
      try {
        analyzeForLoop(statement, owner, locals, globals, structs, enums, fileName, state);
      } finally {
        state.asyncLoopScopeFloors.pop();
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
        if (type === objcConnectionTypeName) {
          throw new DiagnosticError(fileName, statement.expression.location, "objc.Connection must be bound so its callback lifetime is explicit", {
            code: "Z0811",
            notes: ["the connection owns the native control and callback until the binding leaves scope"],
            helps: ["use `const connection = objc.connect(control, move () => operation());`"],
          });
        }
        if (type === nativeConnectionTypeName) {
          throw new DiagnosticError(fileName, statement.expression.location, "native.Connection must be bound so its callback lifetime is explicit", {
            code: "Z0811",
            notes: ["the connection keeps the callback registered and its closure environment alive until the binding leaves scope"],
            helps: ["bind the result with const so Z can unregister the callback before cleaning up its native owner"],
          });
        }
        if (parseOnceLifetimeType(String(underlyingType(type)))) {
          throw new DiagnosticError(
            fileName,
            statement.expression.location,
            `${displayAssignableType(type, state)} must be owned by a binding; discarding it would immediately end the published lifetime`,
            {
              code: "Z0604",
              helps: ["bind the result with const for the intended publication scope"],
            },
          );
        }
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
        const declaredVariant = declaration.variants.find((candidate) => candidate.name === arm.variantName);
        if (!declaredVariant) throw new DiagnosticError(fileName, arm.location, `unknown variant ${JSON.stringify(arm.variantName)}`);
        const variant = resolveSemanticEnumVariant(arm.location, declaration, declaredVariant, state);
        if (covered.has(variant.name)) throw new DiagnosticError(fileName, arm.location, `duplicate match arm ${JSON.stringify(variant.name)}`);
        covered.add(variant.name);
        const hasPattern = Boolean(arm.binding || arm.objectBindings);
        if (Boolean(variant.payload) !== hasPattern) {
          throw new DiagnosticError(fileName, arm.location, variant.payload ? "payload variant requires a binding" : "payloadless variant cannot bind a value");
        }
        if (arm.binding && arm.bindingLocation) validateUserName(arm.binding, arm.bindingLocation, fileName);
        const resolvedObjectFields = new Map<string, StructDeclaration["fields"][number]>();
        if (arm.objectBindings) {
          const payloadDeclaration = variant.payload ? structs.get(variant.payload.name) : null;
          if (!payloadDeclaration) {
            throw new DiagnosticError(fileName, arm.location, "an object pattern requires a struct or class payload");
          }
          const seen = new Set<string>();
          for (const fieldBinding of arm.objectBindings) {
            if (seen.has(fieldBinding.fieldName)) throw new DiagnosticError(fileName, fieldBinding.fieldLocation, `duplicate object pattern field ${JSON.stringify(fieldBinding.fieldName)}`);
            seen.add(fieldBinding.fieldName);
            const declaredField = payloadDeclaration.fields.find((candidate) => candidate.name === fieldBinding.fieldName);
            if (!declaredField) {
              throw new DiagnosticError(fileName, fieldBinding.fieldLocation, `${payloadDeclaration.kind} ${JSON.stringify(payloadDeclaration.name)} has no field ${JSON.stringify(fieldBinding.fieldName)}`);
            }
            const field = resolveSemanticField(fieldBinding.fieldLocation, payloadDeclaration, declaredField, state);
            if (field.visibility === "private" && state.activeReceiver !== payloadDeclaration.name) {
              throw new DiagnosticError(fileName, fieldBinding.fieldLocation, `field ${JSON.stringify(field.name)} is private to class ${JSON.stringify(payloadDeclaration.name)}`);
            }
            resolvedObjectFields.set(fieldBinding.fieldName, field);
            validateUserName(fieldBinding.bindingName, fieldBinding.bindingLocation, fileName);
          }
        }
        const armLocals = new Map(locals);
        if (borrowedRoot && borrowedRootType) {
          armLocals.set(borrowedRoot.name, `${borrowedPrefix}${underlyingType(borrowedRootType)}`);
        }
        if (variant.payload && arm.binding && arm.bindingLocation) {
          const payloadBorrowed = borrowed && hasOwnershipType(variant.payload.name, structs, enums, state);
          armLocals.set(arm.binding, payloadBorrowed ? `${borrowedPrefix}${variant.payload.name}` : variant.payload.name);
          state.bindingTypes.set(arm.bindingLocation.offset, variant.payload.name);
        }
        for (const fieldBinding of arm.objectBindings ?? []) {
          const field = resolvedObjectFields.get(fieldBinding.fieldName)!;
          const fieldBorrowed = hasOwnershipType(field.type.name, structs, enums, state);
          armLocals.set(fieldBinding.bindingName, fieldBorrowed ? `${borrowedPrefix}${field.type.name}` : field.type.name);
          state.bindingTypes.set(fieldBinding.bindingLocation.offset, field.type.name);
        }
        const patternNames = [arm.binding, ...(arm.objectBindings ?? []).map((field) => field.bindingName)].filter((name): name is string => Boolean(name));
        const previousBorrows = new Map(patternNames.map((name) => [name, state.borrowOrigins.get(name)]));
        const previousBorrowedRootOrigin = borrowedRoot
          ? state.borrowOrigins.get(borrowedRoot.name)
          : null;
        const previousPatternViews = new Map(patternNames.map((name) => [name, state.viewOrigins.get(name)]));
        if (borrowedRoot) {
          state.borrowOrigins.set(borrowedRoot.name, { location: statement.location, kind: "match" });
        }
        if (optionalViewOrigin && candidateRoot) unbindViewOrigin(candidateRoot.name, state);
        if (optionalViewOrigin && arm.binding && variant.payload && parseViewType(variant.payload.name)) {
          bindViewOrigin(arm.binding, optionalViewOrigin, fileName, state);
          if (arm.bindingLocation) {
            state.viewBindingOwners.set(
              arm.bindingLocation.offset,
              viewOriginOwnerLabel(optionalViewOrigin),
            );
          }
        }
        if (borrowed && arm.binding && variant.payload && hasOwnershipType(variant.payload.name, structs, enums, state)) {
          state.borrowOrigins.set(arm.binding, { location: statement.location, kind: "match" });
        }
        for (const fieldBinding of arm.objectBindings ?? []) {
          const field = resolvedObjectFields.get(fieldBinding.fieldName)!;
          if (hasOwnershipType(field.type.name, structs, enums, state)) {
            state.borrowOrigins.set(fieldBinding.bindingName, {
              location: statement.location,
              kind: borrowed ? "match" : "ownedMatch",
            });
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
          if (borrowedRoot) {
            if (previousBorrowedRootOrigin) state.borrowOrigins.set(borrowedRoot.name, previousBorrowedRootOrigin);
            else state.borrowOrigins.delete(borrowedRoot.name);
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
  expected: ValueType | null = null,
): ValueType {
  const expectedArray = expected === null
    ? null
    : parseFixedArrayType(String(underlyingType(expected)));
  if (expression.kind === "arrayExpression" && expectedArray) {
    for (const element of expression.elements) {
      const actual = inferDirectValue(
        element,
        owner,
        locals,
        globals,
        structs,
        enums,
        fileName,
        state,
        expectedArray.elementType,
      );
      requireAssignable(expectedArray.elementType, actual, element, fileName, structs, enums, state);
      consumeOwnedValue(element, expectedArray.elementType, locals, structs, enums, fileName, state);
    }
    const type = fixedArrayTypeName(expectedArray.elementType, expression.elements.length);
    state.expressionTypes.set(expression.location.offset, type);
    return type;
  }
  if (expression.kind === "try") {
    return inferTrySuccess(expression, owner, locals, globals, structs, enums, fileName, state);
  }
  if (expression.kind === "matchExpression") {
    return inferMatchExpression(expression, owner, locals, globals, structs, enums, fileName, state, expected);
  }
  if (expression.kind === "ifExpression") {
    return inferIfExpression(expression, owner, locals, globals, structs, enums, fileName, state, expected);
  }
  if (expression.kind === "unsafeExpression") {
    return inferUnsafeExpression(expression, owner, locals, globals, structs, enums, fileName, state, expected);
  }
  if (expression.kind === "whileExpression") {
    return inferWhileExpression(expression, owner, locals, globals, structs, enums, fileName, state, expected);
  }
  if (expression.kind === "forExpression") {
    return inferForExpression(expression, owner, locals, globals, structs, enums, fileName, state, expected);
  }
  if (expression.kind === "closure") {
    return inferClosureExpression(expression, locals, globals, structs, enums, fileName, state);
  }
  const contextualUnsafeCall = state.unsafeDepth > 0 && expected !== null && expression.kind === "call";
  if (contextualUnsafeCall) {
    state.unsafeExpectedTypes.set(expression.location.offset, String(underlyingType(expected)));
  }
  try {
    return inferExpression(expression, locals, globals, structs, enums, fileName, state);
  } finally {
    if (contextualUnsafeCall) state.unsafeExpectedTypes.delete(expression.location.offset);
  }
}

function findUnsafeDeferredOperation(value: unknown): { readonly label: string; readonly location: SourceLocation } | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const issue = findUnsafeDeferredOperation(item);
      if (issue) return issue;
    }
    return null;
  }
  const node = value as { readonly kind?: string; readonly location?: SourceLocation } & Record<string, unknown>;
  const label = node.kind === "await"
    ? "await"
    : node.kind === "spawn"
      ? "task creation"
      : node.kind === "executorPlacement"
        ? "executor placement"
        : node.kind === "closure"
          ? "closure construction"
          : node.kind === "asyncScope"
            ? "async scope"
            : node.kind === "yield"
              ? "generator suspension"
              : null;
  if (label && node.location) return { label, location: node.location };
  for (const [key, child] of Object.entries(node)) {
    if (key === "location" || key === "nameLocation" || key === "body" && node.kind === "raw") continue;
    const issue = findUnsafeDeferredOperation(child);
    if (issue) return issue;
  }
  return null;
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
    errorType: closure.declaration.errorType?.name ?? null,
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
    errorType: type.errorType ? { name: type.errorType, location } : null,
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
  options: ClosureInferenceOptions = {},
): ValueType {
  const expectedFunction = options.expectedFunction ?? null;
  const transientBorrow = options.transientBorrow ?? false;
  const oneShotOwnedCaptures = options.oneShotOwnedCaptures ?? false;
  const nativeThreadBody = options.nativeThreadBody ?? false;
  const scheduledAsyncBody = options.scheduledAsyncBody ?? false;
  const executionContext = options.executionContext ?? "unknown";
  if (expression.async && !nativeThreadBody && !scheduledAsyncBody) {
    throw new DiagnosticError(fileName, expression.location, "async closures are currently executable only through thread.spawn", {
      code: "Z0703",
      notes: ["an async closure requires an explicit owner and executor"],
      helps: [
        "pass this closure directly to thread.spawn for a dedicated worker",
        "or submit it through TaskScope.schedule for structured executor work",
      ],
    });
  }
  if (expectedFunction && expression.parameters.length !== expectedFunction.parameters.length) {
    throw new DiagnosticError(
      fileName,
      expression.location,
      `expected ${expectedFunction.parameters.length} closure parameter(s), found ${expression.parameters.length}`,
    );
  }

  const contextualParameters: Parameter[] = expression.parameters.map((parameter, index) => {
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
  const resolvedParameters = contextualParameters.map((parameter, parameterIndex): Parameter => {
    if (parameterNames.has(parameter.name)) {
      throw new DiagnosticError(fileName, parameter.location, `duplicate closure parameter ${JSON.stringify(parameter.name)}`);
    }
    parameterNames.add(parameter.name);
    validateUserName(parameter.name, parameter.location, fileName);
    validateType(parameter.type, structs, enums, state.foreignNamedTypes, fileName, false);
    const resolvedTypeName = expression.parameters[parameterIndex]?.type
      ? resolveSemanticTypeName(parameter.type, structs, enums, state)
      : parameter.type.name;
    const resolvedParameter = resolvedTypeName === parameter.type.name
      ? parameter
      : { ...parameter, type: { ...parameter.type, name: resolvedTypeName } };
    if (parameter.mode === "out") {
      throw new DiagnosticError(fileName, parameter.location, "out closure parameters are deferred until escaping function types are implemented");
    }
    const slice = parseSliceType(resolvedParameter.type.name);
    if (slice && parameter.mode === "in") {
      throw new DiagnosticError(fileName, parameter.location, "Slice parameters are already borrowed; omit `in`");
    }
    if (parameter.mode !== "value" && resolvedParameter.type.name === "cstring") {
      throw new DiagnosticError(fileName, parameter.location, "cstring already represents a borrowed C string; it cannot use in or inout");
    }
    return resolvedParameter;
  });

  const discovered = collectClosureCaptures(expression, locals, structs, state.foreignNamedTypes, parameterNames);
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
    const type = String(underlyingType(stored));
    if (isBorrowedNativeResource(stored, state)) {
      throw new DiagnosticError(fileName, capture.location, `borrowed native resource ${JSON.stringify(capture.name)} cannot be captured`, {
        code: "Z0206",
        notes: ["the native runtime lifetime has no capturable provenance in the first resource tier"],
        helps: ["use the borrowed resource directly in its lexical scope, or acquire an explicitly owned native copy"],
      });
    }
    if (capture.mutated && !isMutableBinding(stored) && structs.get(type)?.kind !== "class") {
      throw new DiagnosticError(fileName, capture.location, `closure cannot mutate immutable capture ${JSON.stringify(capture.name)}`, {
        code: "Z0210",
        length: capture.name.length,
        notes: ["capturing a const binding does not make that binding mutable"],
        helps: [`declare ${JSON.stringify(capture.name)} with \`let\` if mutation is intended`],
      });
    }
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

  let contextualReturn = expression.returnType
    ?? (expectedFunction ? { name: expectedFunction.returnType, location: expression.location } : null);
  if (expression.body.kind === "block" && !contextualReturn) {
    throw new DiagnosticError(fileName, expression.location, "a block-bodied closure requires an explicit or contextual return type");
  }
  if (contextualReturn && parseViewType(contextualReturn.name)) {
    throw new DiagnosticError(fileName, contextualReturn.location, "closures cannot return receiver-tied views", { code: "Z0206" });
  }
  if (expression.returnType) {
    validateType(expression.returnType, structs, enums, state.foreignNamedTypes, fileName, true);
    contextualReturn = {
      ...expression.returnType,
      name: resolveSemanticTypeName(expression.returnType, structs, enums, state),
    };
  }
  let resolvedErrorType = expression.errorType
    ?? (expectedFunction?.errorType ? { name: expectedFunction.errorType, location: expression.location } : null);
  if (expression.errorType) {
    validateType(expression.errorType, structs, enums, state.foreignNamedTypes, fileName, false);
    resolvedErrorType = {
      ...expression.errorType,
      name: resolveSemanticTypeName(expression.errorType, structs, enums, state),
    };
  }
  const provisionalReturn = contextualReturn ?? { name: "void", location: expression.location };
  const syntheticBase: FunctionDeclaration = {
    kind: "function",
    name: `__z_closure_call_${expression.location.offset}`,
    async: expression.async,
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
    errorType: resolvedErrorType,
    body: [],
    location: expression.location,
  };

  let returnType: ValueType;
  let body: Statement[];
  const previousFunction = state.activeFunction;
  const previousExecutorContext = state.executorContext;
  state.activeFunction = syntheticBase;
  state.executorContext = executionContext === "inherit"
    ? previousExecutorContext
    : executionContext === "main"
      ? "main"
      : null;
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
      returnType = inferDirectValue(
        expression.body,
        syntheticBase,
        closureLocals,
        globals,
        structs,
        enums,
        fileName,
        state,
        contextualReturn?.name ?? null,
      );
      if (contextualReturn) {
        returnType = contextualCStringLiteral(contextualReturn.name, expression.body, state) ?? returnType;
        requireAssignable(contextualReturn.name, returnType, expression.body, fileName, structs, enums, state);
        returnType = contextualReturn.name;
      }
      consumeOwnedValue(expression.body, returnType, closureLocals, structs, enums, fileName, state);
      body = [{ kind: "return", expression: expression.body, location: expression.body.location }];
    }
  } finally {
    if (nativeThreadBody) state.nativeThreadBodyDepth -= 1;
    state.executorContext = previousExecutorContext;
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
    threadSafe: false,
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
      `expected ${displayFunctionType(expectedType)}, found ${displayFunctionType(functionTypeName(
        actualFunction.parameters,
        actualFunction.returnType,
        actualFunction.errorType,
      ))}`,
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
    // Shared identities are retained explicitly when codegen stores them in
    // the owned environment. Marking the capture's source location as a
    // managed copy also affected ordinary reads at that same AST location.
    if (
      capture.type === "TaskScope"
      || capture.type === "TaskControl"
      || parseMutexType(capture.type)
      || structs.get(capture.type)?.kind === "class"
      || parseFunctionType(capture.type)
      || parseWeakType(capture.type)
    ) {
      continue;
    }
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

function validateForeignCallbackFunctionType(
  callback: ForeignCallbackType,
  actual: FunctionType,
  actualType: string,
  location: SourceLocation,
  fileName: string,
): void {
  const expectedType = String(foreignValueType(callback));
  const expected = parseFunctionType(expectedType)!;
  const actualWithoutError = { ...actual, errorType: null };
  if (!functionTypesCompatible(expected, actualWithoutError)) {
    throw new DiagnosticError(
      fileName,
      location,
      `native callback expects ${displayFunctionType(expectedType)}, found ${displayFunctionType(actualType)}`,
      { code: "Z0801" },
    );
  }
  if (actual.errorType && callback.failure === null) {
    throw new DiagnosticError(
      fileName,
      location,
      `throwing callback ${displayFunctionType(actualType)} has no native failure projection`,
      {
        code: "Z0801",
        notes: ["a native callback ABI cannot carry a Z error payload without an explicit boundary contract"],
        helps: ["add `failure <native-value>;` inside this callback's .zd contract, or handle the error inside the callback"],
      },
    );
  }
  if (actual.errorType && callback.context === null) {
    throw new DiagnosticError(
      fileName,
      location,
      "throwing native callbacks currently require a declared context parameter so Z can install a result-aware adapter",
      {
        code: "Z0801",
        helps: ["pair the callback with its native `void *` context in .zd, or handle the error inside a context-free callback"],
      },
    );
  }
}

function validateConcurrentForeignCallbackClosure(
  expression: Extract<Expression, { kind: "closure" }>,
  locals: ReadonlyMap<string, ValueType>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  const closure = state.closures.get(expression.location.offset)!;
  for (const capture of closure.captures) {
    const binding = locals.get(capture.name);
    if (binding && isBorrowedBinding(binding)) {
      throw new DiagnosticError(fileName, capture.location, `borrowed capture ${JSON.stringify(capture.name)} cannot enter an arbitrary-thread native callback`, {
        code: "Z0704",
        notes: ["thread any callbacks can outlive the registering call and may execute concurrently on native threads"],
        helps: ["capture an owned immutable snapshot with move, or keep the callback on thread caller"],
      });
    }
    if (capture.mode === "inout") {
      throw new DiagnosticError(fileName, capture.location, `mutable capture ${JSON.stringify(capture.name)} cannot enter an arbitrary-thread native callback`, {
        code: "Z0704",
        notes: ["thread any permits overlapping callback invocations, so captured state must be safe for concurrent read-only sharing"],
        helps: ["capture an immutable snapshot, use a deeply readonly ARC class, or keep the callback on thread caller"],
      });
    }
    const issue = shareableTypeIssue(capture.type, structs, enums, state);
    if (issue) {
      throw new DiagnosticError(
        fileName,
        capture.location,
        `capture ${JSON.stringify(capture.name)} of type ${JSON.stringify(capture.type)} cannot enter an arbitrary-thread native callback: ${issue.reason}`,
        {
          code: "Z0704",
          notes: ["the first thread any tier supports primitives, owned String snapshots, and deeply readonly atomic-ARC identity"],
          helps: [issue.help],
        },
      );
    }
    const capturedClass = structs.get(String(underlyingType(capture.type)));
    if (capturedClass?.kind === "class") {
      state.threadSharedClassUses.set(capturedClass.name, capture.location);
    }
  }
  state.closures.set(expression.location.offset, { ...closure, threadSafe: true });
}

function validateConcurrentForeignCallbackSignature(
  callback: ForeignCallbackType | ForeignBlockType,
  location: SourceLocation,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  const values = [
    ...callback.parameters.map((parameter, index) => ({
      label: `parameter ${index + 1}`,
      type: String(foreignValueType(parameter)),
    })),
    { label: "return value", type: String(foreignValueType(callback.returnType)) },
  ];
  for (const value of values) {
    const issue = shareableTypeIssue(value.type, structs, enums, state);
    if (!issue) continue;
    throw new DiagnosticError(
      fileName,
      location,
      `arbitrary-thread native callback ${value.label} of type ${JSON.stringify(value.type)} is not supported: ${issue.reason}`,
      {
        code: "Z0704",
        notes: ["the first thread any callback ABI tier accepts thread-independent primitive values"],
        helps: ["translate the native payload to a plain value in a trusted bridge, or keep the callback on thread caller"],
      },
    );
  }
}

function collectClosureCaptures(
  closure: Extract<Expression, { kind: "closure" }>,
  outerLocals: ReadonlyMap<string, ValueType>,
  structs: ReadonlyMap<string, StructDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
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
        return;
      case "dynamicArrayExpression":
        for (const element of expression.elements) {
          walkExpression(element, localNames);
        }
        return;
      case "raw":
        for (const capture of expression.captures) {
          record(capture.name, capture.nameLocation, capture.mode !== "in", localNames);
        }
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
      case "closure": {
        const nestedNames = new Set(localNames);
        for (const parameter of expression.parameters) nestedNames.add(parameter.name);
        if (expression.body.kind === "block") {
          walkStatements(expression.body.statements, nestedNames);
        } else {
          walkExpression(expression.body, nestedNames);
        }
        return;
      }
      case "call":
        if (expression.callee.kind === "member" && expression.callee.object.kind === "identifier") {
          const receiverType = outerLocals.get(expression.callee.object.name);
          const receiver = receiverType ? structs.get(String(underlyingType(receiverType))) : null;
          const method = receiver?.methods.find((candidate) => candidate.name === expression.callee.property);
          if (method?.receiverMode === "inout") {
            record(expression.callee.object.name, expression.callee.object.location, true, localNames);
          } else {
            walkExpression(expression.callee, localNames);
          }
        } else {
          walkExpression(expression.callee, localNames);
        }
        for (const argument of expression.arguments) walkExpression(argument, localNames);
        return;
      case "member":
        if (mutated && expression.object.kind === "identifier") {
          const stored = outerLocals.get(expression.object.name);
          const type = stored ? String(underlyingType(stored)) : null;
          const foreignReferenceIdentity = type && foreignNamedTypes.get(type)?.kind === "object";
          walkExpression(expression.object, localNames, !foreignReferenceIdentity);
        } else {
          walkExpression(expression.object, localNames, mutated);
        }
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
        if (expression.spread) walkExpression(expression.spread.expression, localNames);
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
        if (expression.call) walkExpression(expression.call, localNames);
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
      case "unsafeExpression":
        walkStatement(expression.body, new Set(localNames));
        return;
      case "whileExpression":
        walkExpression(expression.condition, localNames);
        walkStatement(expression.body, new Set(localNames));
        walkStatement(expression.elseBranch, new Set(localNames));
        return;
      case "forExpression": {
        walkExpression(expression.iterable, localNames);
        const bodyNames = new Set(localNames);
        if (expression.binding) bodyNames.add(expression.binding);
        for (const binding of expression.objectBindings ?? []) bodyNames.add(binding.bindingName);
        walkStatement(expression.body, bodyNames);
        walkStatement(expression.elseBranch, new Set(localNames));
        return;
      }
    }
  };

  const walkStatements = (statements: readonly Statement[], localNames: Set<string>): void => {
    for (const statement of statements) {
      if (statement.kind === "variable") {
        if (statement.initializer) walkExpression(statement.initializer, localNames);
        localNames.add(statement.name);
      } else if (statement.kind === "destructure") {
        walkExpression(statement.initializer, localNames);
        for (const binding of statement.objectBindings) localNames.add(binding.bindingName);
        for (const binding of statement.arrayBindings ?? []) {
          if (binding.bindingName) localNames.add(binding.bindingName);
        }
      } else walkStatement(statement, localNames);
    }
  };

  const walkStatement = (statement: Statement, localNames: Set<string>): void => {
    switch (statement.kind) {
      case "variable":
        if (statement.initializer) walkExpression(statement.initializer, localNames);
        localNames.add(statement.name);
        return;
      case "destructure":
        walkExpression(statement.initializer, localNames);
        for (const binding of statement.objectBindings) localNames.add(binding.bindingName);
        for (const binding of statement.arrayBindings ?? []) {
          if (binding.bindingName) localNames.add(binding.bindingName);
        }
        return;
      case "assignment":
        walkExpression(statement.target, localNames, true);
        walkExpression(statement.expression, localNames);
        return;
      case "return":
        if (statement.expression) walkExpression(statement.expression, localNames);
        return;
      case "throw":
      case "yield":
      case "select":
      case "expressionStatement":
        walkExpression(statement.expression, localNames);
        return;
      case "block":
        walkStatements(statement.statements, new Set(localNames));
        return;
      case "unsafe":
        walkStatement(statement.body, new Set(localNames));
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
        if (statement.binding) bodyNames.add(statement.binding);
        for (const binding of statement.objectBindings ?? []) bodyNames.add(binding.bindingName);
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
  expected: ValueType | null = null,
): ValueType {
  const conditionType = inferExpression(expression.condition, locals, globals, structs, enums, fileName, state);
  if (conditionType !== "boolean") {
    requireAssignable("boolean", conditionType, expression.condition, fileName, structs, enums, state);
  }

  const original = new Map(locals);
  const continuing: Map<string, ValueType>[] = [];
  const thenLocals = narrowedConditionLocals(original, expression.condition, true, state);
  const thenType = inferValueArm(expression.thenBranch, owner, thenLocals, globals, structs, enums, fileName, state, expected);
  if (thenType !== "never") continuing.push(thenLocals);

  const elseLocals = narrowedConditionLocals(original, expression.condition, false, state);
  const elseType = expression.elseBranch.kind === "ifExpression"
    ? inferIfExpression(expression.elseBranch, owner, elseLocals, globals, structs, enums, fileName, state, expected)
    : inferValueArm(expression.elseBranch, owner, elseLocals, globals, structs, enums, fileName, state, expected);
  if (elseType !== "never") continuing.push(elseLocals);

  const resultType = commonBranchType("if", thenType, elseType, expression.elseBranch.location, fileName);
  mergeOwnershipStates(locals, continuing, state);
  return resultType;
}

function inferUnsafeExpression(
  expression: Extract<Expression, { kind: "unsafeExpression" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  expected: ValueType | null = null,
): ValueType {
  if (state.unsafeDepth > 0) {
    throw new DiagnosticError(fileName, expression.location, "unsafe blocks cannot be nested", {
      code: "Z0822",
      notes: ["the outer unsafe boundary already owns every unverified native assertion in this scope"],
    });
  }
  if (owner.async) {
    throw new DiagnosticError(fileName, expression.location, "unsafe blocks must be isolated in a synchronous function in the first tier", {
      code: "Z0822",
      notes: ["async task frames currently have no storage class for scope-confined opaque native values"],
      helps: ["move the unsafe operation into a synchronous Z function, then call that function from async code"],
    });
  }
  const deferred = findUnsafeDeferredOperation(expression.body);
  if (deferred) {
    throw new DiagnosticError(fileName, deferred.location, `${deferred.label} cannot cross an unsafe block in the first tier`, {
      code: "Z0822",
      notes: ["unsafe native proofs are synchronous and scoped; suspension or capture could outlive their asserted storage"],
      helps: ["finish the native operation synchronously inside unsafe, then move a supported Z value into asynchronous work"],
    });
  }
  const finalStatement = expression.body.statements.at(-1);
  if (!finalStatement || finalStatement.kind !== "select") {
    throw new DiagnosticError(fileName, finalStatement?.location ?? expression.location, "an unsafe expression must finish with `select value;`", {
      code: "Z0822",
      notes: ["return still exits the enclosing function; select supplies the value of the unsafe expression"],
    });
  }

  const blockLocals = new Map(locals);
  const unsafeLocalBindings = new Set<string>();
  state.unsafeDepth += 1;
  state.unsafeLocalBindingScopes.push(unsafeLocalBindings);
  let type: ValueType;
  try {
    type = inferValueArm(expression.body, owner, blockLocals, globals, structs, enums, fileName, state, expected);
    if (isUnsafeUnverifiedValue(finalStatement.expression, state)) {
      throw new DiagnosticError(fileName, finalStatement.expression.location, "an unsafe native value cannot be selected from its unsafe block", {
        code: "Z0822",
        notes: ["copy or project the native data into independently safe Z storage before selecting it"],
        helps: ["use String.from for borrowed cstring text, select a representable scalar, or describe reusable ownership in .zd"],
      });
    }
  } finally {
    state.unsafeLocalBindingScopes.pop();
    for (const name of unsafeLocalBindings) state.unsafeUnverifiedBindings.delete(name);
    state.unsafeDepth -= 1;
  }
  propagateOuterOwnership(locals, blockLocals);
  return type!;
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

function inferWhileExpression(
  expression: Extract<Expression, { kind: "whileExpression" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  expected: ValueType | null = null,
): ValueType {
  if (owner.async) {
    throw new DiagnosticError(fileName, expression.location, "value-producing while expressions are not executable in async functions yet", {
      code: "Z0700",
      helps: ["use a statement loop and assign a local until task-frame loop selection is implemented"],
    });
  }
  const frame: ValueLoopAnalysisFrame = {
    loopOffset: expression.location.offset,
    expected,
    selections: [],
  };
  state.valueLoopStack.push(frame);
  state.asyncLoopDepth += 1;
  try {
    analyzeWhileLoop(
      {
        kind: "while",
        condition: expression.condition,
        body: expression.body,
        location: expression.location,
      },
      owner,
      locals,
      globals,
      structs,
      enums,
      fileName,
      state,
    );
  } finally {
    state.asyncLoopDepth -= 1;
    state.valueLoopStack.pop();
  }
  return finishLoopExpression(
    "while",
    expression.elseBranch,
    frame,
    owner,
    locals,
    globals,
    structs,
    enums,
    fileName,
    state,
    expected,
  );
}

function inferForExpression(
  expression: Extract<Expression, { kind: "forExpression" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  expected: ValueType | null = null,
): ValueType {
  if (owner.async) {
    throw new DiagnosticError(fileName, expression.location, "value-producing for expressions are not executable in async functions yet", {
      code: "Z0700",
      helps: ["use a statement loop and assign a local until task-frame loop selection is implemented"],
    });
  }
  const frame: ValueLoopAnalysisFrame = {
    loopOffset: expression.location.offset,
    expected,
    selections: [],
  };
  state.valueLoopStack.push(frame);
  state.asyncLoopDepth += 1;
  try {
    analyzeForLoop(
      {
        kind: "for",
        asynchronous: false,
        errorMode: "none",
        mode: expression.mode,
        binding: expression.binding,
        bindingLocation: expression.bindingLocation,
        objectBindings: expression.objectBindings,
        iterable: expression.iterable,
        body: expression.body,
        location: expression.location,
      },
      owner,
      locals,
      globals,
      structs,
      enums,
      fileName,
      state,
    );
  } finally {
    state.asyncLoopDepth -= 1;
    state.valueLoopStack.pop();
  }
  return finishLoopExpression(
    "for",
    expression.elseBranch,
    frame,
    owner,
    locals,
    globals,
    structs,
    enums,
    fileName,
    state,
    expected,
  );
}

function finishLoopExpression(
  construct: "for" | "while",
  elseBranch: BlockStatement,
  frame: ValueLoopAnalysisFrame,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  expected: ValueType | null,
): ValueType {
  const continuing: Map<string, ValueType>[] = frame.selections.map((selection) => selection.locals);
  const exhaustionLocals = new Map(locals);
  const exhaustionType = inferValueArm(
    elseBranch,
    owner,
    exhaustionLocals,
    globals,
    structs,
    enums,
    fileName,
    state,
    expected,
  );
  if (exhaustionType !== "never") continuing.push(exhaustionLocals);
  let resultType = exhaustionType;
  for (const selection of frame.selections) {
    resultType = commonBranchType(
      `${construct} expression`,
      resultType,
      selection.type,
      elseBranch.location,
      fileName,
    );
  }
  mergeOwnershipStates(locals, continuing, state);
  return resultType;
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
  expected: ValueType | null = null,
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
    const declaredVariant = declaration.variants.find((candidate) => candidate.name === arm.variantName);
    if (!declaredVariant) throw new DiagnosticError(fileName, arm.location, `unknown variant ${JSON.stringify(arm.variantName)}`);
    const variant = resolveSemanticEnumVariant(arm.location, declaration, declaredVariant, state);
    if (covered.has(variant.name)) throw new DiagnosticError(fileName, arm.location, `duplicate match arm ${JSON.stringify(variant.name)}`);
    covered.add(variant.name);
    const hasPattern = Boolean(arm.binding || arm.objectBindings);
    if (Boolean(variant.payload) !== hasPattern) {
      throw new DiagnosticError(fileName, arm.location, variant.payload ? "payload variant requires a binding" : "payloadless variant cannot bind a value");
    }
    if (arm.binding && arm.bindingLocation) validateUserName(arm.binding, arm.bindingLocation, fileName);
    const resolvedObjectFields = new Map<string, StructDeclaration["fields"][number]>();
    if (arm.objectBindings) {
      const payloadDeclaration = variant.payload ? structs.get(variant.payload.name) : null;
      if (!payloadDeclaration) throw new DiagnosticError(fileName, arm.location, "an object pattern requires a struct or class payload");
      const seen = new Set<string>();
      for (const fieldBinding of arm.objectBindings) {
        if (seen.has(fieldBinding.fieldName)) throw new DiagnosticError(fileName, fieldBinding.fieldLocation, `duplicate object pattern field ${JSON.stringify(fieldBinding.fieldName)}`);
        seen.add(fieldBinding.fieldName);
        const declaredField = payloadDeclaration.fields.find((candidate) => candidate.name === fieldBinding.fieldName);
        if (!declaredField) {
          throw new DiagnosticError(fileName, fieldBinding.fieldLocation, `${payloadDeclaration.kind} ${JSON.stringify(payloadDeclaration.name)} has no field ${JSON.stringify(fieldBinding.fieldName)}`);
        }
        const field = resolveSemanticField(fieldBinding.fieldLocation, payloadDeclaration, declaredField, state);
        if (field.visibility === "private" && state.activeReceiver !== payloadDeclaration.name) {
          throw new DiagnosticError(fileName, fieldBinding.fieldLocation, `field ${JSON.stringify(field.name)} is private to class ${JSON.stringify(payloadDeclaration.name)}`);
        }
        resolvedObjectFields.set(fieldBinding.fieldName, field);
        validateUserName(fieldBinding.bindingName, fieldBinding.bindingLocation, fileName);
      }
    }
    const armLocals = new Map(locals);
    if (borrowedRoot && borrowedRootType) {
      armLocals.set(borrowedRoot.name, `${borrowedPrefix}${underlyingType(borrowedRootType)}`);
    }
    if (variant.payload && arm.binding && arm.bindingLocation) {
      const payloadBorrowed = borrowed && hasOwnershipType(variant.payload.name, structs, enums, state);
      armLocals.set(arm.binding, payloadBorrowed ? `${borrowedPrefix}${variant.payload.name}` : variant.payload.name);
      state.bindingTypes.set(arm.bindingLocation.offset, variant.payload.name);
    }
    for (const fieldBinding of arm.objectBindings ?? []) {
      const field = resolvedObjectFields.get(fieldBinding.fieldName)!;
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
      if (arm.bindingLocation) {
        state.viewBindingOwners.set(
          arm.bindingLocation.offset,
          viewOriginOwnerLabel(optionalViewOrigin),
        );
      }
    }
    if (borrowed && arm.binding && variant.payload && hasOwnershipType(variant.payload.name, structs, enums, state)) {
      state.borrowOrigins.set(arm.binding, { location: expression.location, kind: "match" });
    }
    for (const fieldBinding of arm.objectBindings ?? []) {
      const field = resolvedObjectFields.get(fieldBinding.fieldName)!;
      if (hasOwnershipType(field.type.name, structs, enums, state)) {
        state.borrowOrigins.set(fieldBinding.bindingName, {
          location: expression.location,
          kind: borrowed ? "match" : "ownedMatch",
        });
      }
    }
    let armType: ValueType = "never";
    try {
      const transientViews = new Set(
        optionalViewOrigin && arm.binding && variant.payload && parseViewType(variant.payload.name)
          ? [arm.binding]
          : [],
      );
      armType = inferValueArm(
        arm.body,
        owner,
        armLocals,
        globals,
        structs,
        enums,
        fileName,
        state,
        expected,
        transientViews,
      );
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
  expected: ValueType | null = null,
  transientViews: ReadonlySet<string> = new Set(),
): ValueType {
  if (statement.kind === "expressionStatement" || statement.kind === "select") {
    let type = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state, expected);
    if (expected) {
      requireAssignable(expected, type, statement.expression, fileName, structs, enums, state);
      type = expected;
    } else {
      type = implicitlyLoadCopyableView(type, statement.expression, structs, enums, state);
    }
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
    const type = inferValueArm(
      finalStatement,
      owner,
      blockLocals,
      globals,
      structs,
      enums,
      fileName,
      state,
      expected,
      transientViews,
    );
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
      expected,
    );
  }
  throw new DiagnosticError(fileName, statement.location, "a value-producing block must produce a value with an expression or `select`");
}

type ExecutorCapturePlan = {
  readonly mode: "in" | "inout" | "move" | "copy";
  readonly name: string;
  readonly type: string;
  readonly outerBinding: ValueType;
  readonly location: SourceLocation;
};

function inferImplicitPlacementCopyType(
  type: string,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  state: AnalysisState,
  visiting = new Set<string>(),
): boolean {
  if (type === "String") return true;
  if (
    type === "void"
    || type === "boolean"
    || integerTypes.has(type)
    || floatTypes.has(type)
  ) return true;
  if (
    type === "cstring"
    || type === "TextBuffer"
    || type === "Arena"
    || type === "TaskScope"
    || type === "TaskControl"
    || type === fsLockTypeName
    || type === "fs.Lock"
    || parseViewType(type)
    || parseSliceType(type)
    || parseDynamicArrayType(type)
    || parseTaskType(type)
    || parseWeakType(type)
    || state.foreignTypes.has(type)
    || state.foreignNamedTypes.has(type)
    || state.foreignObjectTypes.has(type)
  ) return false;
  const fixed = parseFixedArrayType(type);
  if (fixed) return inferImplicitPlacementCopyType(fixed.elementType, structs, enums, state, visiting);
  if (visiting.has(type)) return true;
  const aggregate = structs.get(type);
  if (aggregate) {
    if (aggregate.kind === "class" || aggregate.deinitializer) return false;
    visiting.add(type);
    const copyable = aggregate.fields.every((field) => (
      inferImplicitPlacementCopyType(field.type.name, structs, enums, state, visiting)
    ));
    visiting.delete(type);
    return copyable;
  }
  const enumeration = enums.get(type);
  if (enumeration) {
    visiting.add(type);
    const copyable = enumeration.variants.every((variant) => (
      !variant.payload
      || inferImplicitPlacementCopyType(variant.payload.name, structs, enums, state, visiting)
    ));
    visiting.delete(type);
    return copyable;
  }
  return false;
}

function planExecutorPlacementCaptures(
  expression: Extract<Expression, { kind: "executorPlacement" }>,
  locals: Map<string, ValueType>,
  blockLocals: Map<string, ValueType>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): readonly ExecutorCapturePlan[] {
  if (expression.call) return [];
  const declared = new Map<string, typeof expression.captures[number]>();
  for (const capture of expression.captures) {
    if (declared.has(capture.name)) {
      throw new DiagnosticError(fileName, capture.nameLocation, `duplicate executor capture ${JSON.stringify(capture.name)}`, {
        code: "Z0704",
        labels: [{
          location: declared.get(capture.name)!.nameLocation,
          message: "first capture is declared here",
          length: capture.name.length,
        }],
      });
    }
    const stored = locals.get(capture.name);
    if (!stored) {
      throw new DiagnosticError(fileName, capture.nameLocation, `unknown executor capture ${JSON.stringify(capture.name)}`, {
        code: "Z0704",
        helps: ["capture a binding visible before the placement block"],
      });
    }
    if (initializationState(stored) !== "initialized") {
      throw new DiagnosticError(fileName, capture.nameLocation, `cannot capture uninitialized value ${JSON.stringify(capture.name)}`, {
        code: "Z0704",
      });
    }
    if (ownershipState(stored) !== "available") {
      throw movedValueError(fileName, { name: capture.name, location: capture.nameLocation }, state, false, "capture");
    }
    declared.set(capture.name, capture);
    state.bindingTypes.set(capture.nameLocation.offset, String(underlyingType(stored)));
  }

  const uses = collectPlacementCaptures(expression.body, new Set(locals.keys()));
  const usedNames = new Set(uses.map((capture) => capture.name));
  for (const capture of expression.captures) {
    if (!usedNames.has(capture.name)) {
      throw new DiagnosticError(fileName, capture.nameLocation, `executor capture ${JSON.stringify(capture.name)} is not used by the placement block`, {
        code: "Z0704",
        helps: ["remove the unused capture from `using (...)`"],
      });
    }
  }

  const plans: ExecutorCapturePlan[] = [];
  for (const use of uses) {
    const stored = locals.get(use.name)!;
    const type = String(underlyingType(stored));
    const capture = declared.get(use.name);
    if (!capture) {
      if (!inferImplicitPlacementCopyType(type, structs, enums, state)) {
        throw new DiagnosticError(fileName, use.location, `ownership-bearing executor capture ${JSON.stringify(use.name)} requires an explicit capability`, {
          code: "Z0704",
          notes: ["cleanup-free Copy values and owned String snapshots may be inferred; borrowing, mutation, and ownership transfer remain explicit"],
          helps: [`add \`using (in ${use.name})\`, \`using (inout ${use.name})\`, or \`using (move ${use.name})\` after the executor`],
        });
      }
      if (use.mutated) {
        throw new DiagnosticError(fileName, use.location, `inferred Copy capture ${JSON.stringify(use.name)} cannot mutate caller storage`, {
          code: "Z0704",
          notes: ["an omitted Copy capture is a private snapshot"],
          helps: [`declare \`using (inout ${use.name})\` when mutation must be visible to the caller`],
        });
      }
      plans.push({ mode: "copy", name: use.name, type, outerBinding: stored, location: use.location });
      continue;
    }

    if (capture.mode === "in" && use.mutated) {
      throw new DiagnosticError(fileName, use.location, `read-only executor capture ${JSON.stringify(use.name)} cannot be mutated`, {
        code: "Z0704",
        labels: [{ location: capture.location, message: "read-only capture declared here", length: 2 }],
        helps: [`use \`inout ${use.name}\` with a mutable let binding`],
      });
    }
    if (capture.mode === "inout") {
      if (!isMutableBinding(stored) && structs.get(type)?.kind !== "class") {
        throw new DiagnosticError(fileName, capture.nameLocation, `inout executor capture ${JSON.stringify(use.name)} requires a mutable let binding`, {
          code: "Z0704",
          helps: [`declare ${JSON.stringify(use.name)} with \`let\``],
        });
      }
      blockLocals.set(use.name, `${borrowedPrefix}${mutablePrefix}${type}`);
    } else if (capture.mode === "in") {
      blockLocals.set(use.name, `${borrowedPrefix}${type}`);
    } else {
      if (!hasOwnershipType(type, structs, enums, state)) {
        throw new DiagnosticError(fileName, capture.location, `type ${displayAssignableType(type, state)} has no unique ownership to move into executor placement`, {
          code: "Z0218",
          notes: ["cleanup-free values are inferred private snapshots and do not need a capture entry"],
          helps: [`remove \`move ${use.name}\` from the capture contract`],
        });
      }
      blockLocals.set(use.name, type);
    }

    if (state.nativeThreadBodyDepth > 0) {
      const aggregate = structs.get(type);
      const executorBound = aggregate?.kind === "class" && state.aggregateExecutorAffinities.has(type);
      if (executorBound) {
        if (capture.mode === "move") {
          throw new DiagnosticError(fileName, capture.location, `main-isolated capture ${JSON.stringify(use.name)} cannot move away from its owning executor`, {
            code: "Z0704",
            helps: [`use \`in ${use.name}\` for readonly behavior or \`inout ${use.name}\` for main-isolated mutation`],
          });
        }
      } else {
        const transfer = initialThreadTransferKind(type, structs, enums, state);
        if (!transfer || (capture.mode === "move" && transfer !== "move")) {
          const issue = aggregate?.kind === "class"
            ? shareableTypeIssue(type, structs, enums, state)
            : foreignThreadTransferIssue(type, state);
          throw new DiagnosticError(fileName, capture.location, `capture ${JSON.stringify(use.name)} of type ${JSON.stringify(type)} cannot cross from a native worker to thread.main${issue ? `: ${issue.reason}` : ""}`, {
            code: "Z0704",
            notes: [issue?.reason ?? "cross-thread captures require a transferable value, unique owner, or deeply readonly ARC identity"],
            helps: [issue?.help ?? "create an owned thread-independent snapshot before placement"],
          });
        }
      }
    }
    plans.push({
      mode: capture.mode,
      name: use.name,
      type,
      outerBinding: stored,
      location: capture.nameLocation,
    });
  }
  return plans;
}

function applyExecutorPlacementCaptureEffects(
  expression: Extract<Expression, { kind: "executorPlacement" }>,
  plans: readonly ExecutorCapturePlan[],
  locals: Map<string, ValueType>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  for (const capture of plans) {
    if (capture.mode === "move") {
      consumeOwnedValue(
        { kind: "identifier", name: capture.name, location: capture.location },
        capture.type,
        locals,
        structs,
        enums,
        fileName,
        state,
        true,
      );
      continue;
    }
    if (capture.mode !== "in" && capture.mode !== "inout") continue;
    if (expression.mode !== "spawn") continue;
    if (state.asyncScopeDepth === 0) {
      throw new DiagnosticError(fileName, capture.location, `child-task ${capture.mode} capture of ${JSON.stringify(capture.name)} requires an explicit async scope`, {
        code: "Z0704",
        notes: ["the scope join bounds the loan before caller storage may be used, moved, or destroyed"],
        helps: ["place the task inside `async scope { ... }`, use `await on`, or transfer ownership with `move`"],
      });
    }
    recordAsyncSpawnBorrow(
      capture.name,
      capture.location,
      capture.mode,
      expression.location.offset,
      fileName,
      state,
    );
  }
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
      helps: ["import { thread } from \"std/thread\" and use `await on thread.main { ... }` or `task on thread.main { ... }`"],
    });
  }
  if (expression.mode === "spawn") rejectLoopCarriedChildTask(expression.location, fileName, state);
  const synchronousNativePlacement = expression.mode === "spawn" && state.nativeThreadBodyDepth > 0;
  if (!state.activeFunction?.async && !synchronousNativePlacement) {
    if (expression.mode === "spawn") {
      throw new DiagnosticError(
        fileName,
        expression.location,
        "task on thread.main requires an enclosing async function or a direct synchronous thread.spawn closure",
        {
          code: "Z0711",
          notes: ["an ordinary synchronous helper does not inherit its caller's task scope or executor context"],
          helps: [
            "inside thread.spawn, call synchronous helpers first and keep `task on thread.main { ... }` directly in that closure",
            "otherwise make this helper async and call it from `thread.spawn(async () => await helper())`",
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
  let resolvedReturnType = expression.returnType;
  if (expression.returnType) {
    validateType(expression.returnType, structs, enums, state.foreignNamedTypes, fileName, true);
    resolvedReturnType = {
      ...expression.returnType,
      name: resolveSemanticTypeName(expression.returnType, structs, enums, state),
    };
  }
  let resolvedErrorType = expression.errorType;
  if (expression.errorType) {
    validateType(expression.errorType, structs, enums, state.foreignNamedTypes, fileName, false);
    resolvedErrorType = {
      ...expression.errorType,
      name: resolveSemanticTypeName(expression.errorType, structs, enums, state),
    };
  }

  const previousExecutor = state.executorContext;
  if (expression.call) {
    const context = {
      mode: expression.mode === "spawn" ? "spawn" as const : "await" as const,
      spawnOffset: expression.mode === "spawn" ? expression.location.offset : null,
      calls: 0,
      cancellationCalls: 0,
    };
    state.executorContext = "main";
    state.asyncCallContexts.push(context);
    let callType: ValueType;
    try {
      callType = inferExpression(expression.call, locals, globals, structs, enums, fileName, state, true);
    } finally {
      state.asyncCallContexts.pop();
      state.executorContext = previousExecutor;
    }
    if (context.calls > 1) {
      throw new DiagnosticError(fileName, expression.call.location, "direct executor placement accepts exactly one async call", {
        code: "Z0710",
        helps: ["use an executor-placement block when coordinating multiple asynchronous operations"],
      });
    }
    const result = enums.get(String(callType));
    const failure = result?.name.startsWith("__z_Result_")
      ? result.variants.find((variant) => variant.name === "failure")?.payload?.name ?? null
      : null;
    const success = result?.name.startsWith("__z_Result_")
      ? result.variants.find((variant) => variant.name === "success")?.payload?.name ?? "void"
      : String(callType);
    if (failure && context.calls === 0) {
      throw new DiagnosticError(fileName, expression.call.location, "a throwing synchronous call cannot be placed directly in the current runtime tier", {
        code: "Z0713",
        notes: ["direct placed async calls preserve typed failure without adding a wrapper Result layer"],
        helps: ["wrap the synchronous operation in an async function, then place that async call directly"],
      });
    }
    const escapingAffinity = previousExecutor === "main"
      ? null
      : executorAffinityForType(success, structs, enums, state);
    if (escapingAffinity) {
      throw new DiagnosticError(fileName, expression.location, `executor placement cannot return main-isolated type ${JSON.stringify(displayArrayType(success))} to a non-main continuation`, {
        code: "Z0712",
        notes: ["main-isolated identity, cleanup, and destruction must remain on thread.main"],
        helps: ["return a thread-independent owned snapshot, or consume the result inside an `on thread.main` block"],
      });
    }
    if (expression.mode === "spawn") return taskTypeName(success, failure);
    if (!failure) return success;
    if (!allowThrowingCall) {
      throw new DiagnosticError(fileName, expression.location, "throwing placed call requires `attempt` or `try`", {
        code: "Z0712",
        helps: ["write `try await on thread.main operation()` to propagate the error, or use `attempt` to inspect Result<T, E>"],
      });
    }
    return resultTypeName(success, failure);
  }

  const blockLocals = new Map(locals);
  const capturePlans = planExecutorPlacementCaptures(
    expression,
    locals,
    blockLocals,
    structs,
    enums,
    fileName,
    state,
  );
  state.executorContext = "main";
  state.placementErrorTypes.push(resolvedErrorType);
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

  if (resolvedReturnType) {
    requireAssignable(
      resolvedReturnType.name,
      successType,
      expression,
      fileName,
      structs,
      enums,
      state,
    );
    successType = resolvedReturnType.name;
  }
  const escapingAffinity = previousExecutor === "main"
    ? null
    : executorAffinityForType(successType, structs, enums, state);
  if (escapingAffinity) {
    throw new DiagnosticError(fileName, expression.location, `executor placement cannot return main-isolated type ${JSON.stringify(displayArrayType(String(successType)))} to a non-main continuation`, {
      code: "Z0712",
      notes: ["main-isolated identity, cleanup, and destruction must remain on thread.main"],
      helps: ["select a thread-independent owned snapshot, or consume the result inside the `on thread.main` block"],
    });
  }
  if (expression.mode !== "spawn") {
    propagateOuterOwnership(locals, blockLocals);
    for (const capture of capturePlans) locals.set(capture.name, capture.outerBinding);
  }
  applyExecutorPlacementCaptureEffects(
    expression,
    capturePlans,
    locals,
    structs,
    enums,
    fileName,
    state,
  );
  if (expression.mode === "spawn") {
    return taskTypeName(String(successType), resolvedErrorType?.name ?? null);
  }
  if (!resolvedErrorType) return successType;
  if (!allowThrowingCall) {
    throw new DiagnosticError(fileName, expression.location, "throwing executor block requires `attempt` or `try`", {
      code: "Z0712",
      helps: ["write `try await on ...` to propagate the error, or `attempt await on ...` to inspect Result<T, E>"],
    });
  }
  return resultTypeName(String(successType), resolvedErrorType.name);
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
  const stored = String(underlyingType(type));
  const actual = parseViewType(stored)?.target ?? stored;
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
    if (foreign.layout === "union") {
      throw new DiagnosticError(fileName, expression.location, `console cannot format native union ${actual} without an active-member proof`, {
        code: "Z0823",
        helps: ["read a scalar member inside unsafe after validating the native API's discriminator"],
      });
    }
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

function testBorrowExpression(
  expression: Expression,
  fileName: string,
): Expression {
  if (expression.kind !== "argumentReference") return expression;
  if (expression.access !== "in") {
    throw new DiagnosticError(fileName, expression.location, `${expression.access} is not valid for a read-only test value`, {
      code: "Z0901",
      helps: ["use the value directly or borrow named storage with `in`"],
    });
  }
  return {
    kind: "identifier",
    name: expression.name,
    location: expression.nameLocation,
  };
}

function requireTestBody(
  expression: Expression,
  fileName: string,
  state: AnalysisState,
): void {
  if (state.activeFunction?.testName) return;
  throw new DiagnosticError(fileName, expression.location, "std/test expectations are only available inside a test declaration", {
    code: "Z0901",
    helps: ['move this expectation into `test "name" { ... }`'],
  });
}

function requireTestBorrowable(
  type: ValueType,
  expression: Expression,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  const borrowedType = parseViewType(String(underlyingType(type)))?.target ?? type;
  if (
    hasOwnershipType(borrowedType, structs, enums, state)
    && !isNamedStorageExpression(expression)
    && expression.kind !== "string"
    && expression.kind !== "template"
  ) {
    throw new DiagnosticError(fileName, expression.location, "a cleanup-bearing test temporary must be bound before the expectation", {
      code: "Z0901",
      notes: ["expectation operands are borrowed for the statement and do not consume temporary owners"],
      helps: ["bind the value to const storage, then pass that binding to `expect` or `toEqual`"],
    });
  }
}

function inferTestExpectationCall(
  expression: Extract<Expression, { kind: "call" }>,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType | null {
  if (expression.callee.kind !== "member") return null;
  const expectation = expression.callee.object;
  if (
    expectation.kind !== "call"
    || expectation.callee.kind !== "identifier"
    || globals.get(expectation.callee.name)?.kind !== "testExpect"
  ) return null;
  requireTestBody(expression, fileName, state);
  rejectLabeledArguments(expectation.argumentLabels, expectation.location, fileName);
  rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
  if (expression.callee.property !== "toEqual") {
    throw new DiagnosticError(fileName, expression.callee.location, `expect has no matcher ${JSON.stringify(expression.callee.property)}`, {
      code: "Z0901",
      helps: ["the first matcher tier provides `toEqual`"],
    });
  }
  if (expectation.arguments.length !== 1) {
    throw new DiagnosticError(fileName, expectation.location, `expect expects 1 value, received ${expectation.arguments.length}`, {
      code: "Z0901",
    });
  }
  if (expression.arguments.length !== 1) {
    throw new DiagnosticError(fileName, expression.location, `toEqual expects 1 value, received ${expression.arguments.length}`, {
      code: "Z0901",
    });
  }
  const actual = testBorrowExpression(expectation.arguments[0], fileName);
  const expected = testBorrowExpression(expression.arguments[0], fileName);
  const comparison: Expression = {
    kind: "binary",
    operator: "==",
    left: actual,
    right: expected,
    location: expression.location,
  };
  inferExpression(comparison, locals, globals, structs, enums, fileName, state);
  const actualType = state.expressionTypes.get(actual.location.offset)
    ?? inferExpression(actual, locals, globals, structs, enums, fileName, state);
  const expectedType = state.expressionTypes.get(expected.location.offset)
    ?? inferExpression(expected, locals, globals, structs, enums, fileName, state);
  requireTestBorrowable(actualType, actual, structs, enums, fileName, state);
  requireTestBorrowable(expectedType, expected, structs, enums, fileName, state);
  requireConsoleFormattable(actualType, actual, structs, enums, fileName, state);
  requireConsoleFormattable(expectedType, expected, structs, enums, fileName, state);
  state.testExpectationCalls.set(expression.location.offset, {
    actual,
    expected,
    actualType: String(underlyingType(actualType)),
    expectedType: String(underlyingType(expectedType)),
    location: expression.location,
  });
  state.expressionTypes.set(expectation.location.offset, `__z_TestExpectation_${String(underlyingType(actualType))}`);
  state.expressionTypes.set(expression.location.offset, "void");
  return "void";
}

function inferTestFailureCall(
  expression: Extract<Expression, { kind: "call" }>,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType | null {
  if (
    expression.callee.kind !== "identifier"
    || globals.get(expression.callee.name)?.kind !== "testFail"
  ) return null;
  requireTestBody(expression, fileName, state);
  rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
  if (expression.arguments.length !== 1) {
    throw new DiagnosticError(fileName, expression.location, `fail expects 1 message, received ${expression.arguments.length}`, {
      code: "Z0901",
    });
  }
  const message = testBorrowExpression(expression.arguments[0], fileName);
  const type = inferExpression(message, locals, globals, structs, enums, fileName, state);
  requireAssignable("String", type, message, fileName, structs, enums, state);
  requireTestBorrowable(type, message, structs, enums, fileName, state);
  state.testFailureCalls.set(expression.location.offset, {
    message,
    location: expression.location,
  });
  state.expressionTypes.set(expression.location.offset, "void");
  return "void";
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
  const inferred = inferExpressionInner(
    expression,
    locals,
    globals,
    structs,
    enums,
    fileName,
    state,
    allowThrowingCall,
  );
  const inferredType = String(underlyingType(inferred));
  const resolution: SemanticExpressionResolution = {
    location: expression.location,
    inferredType,
    typeIdentities: collectSemanticTypeIdentities(
      inferredType,
      "",
      structs,
      enums,
      state.genericAggregateMaterializations,
    ),
  };
  const synthetic = expression.location.offset < 0;
  const type = synthetic
    ? inferred
    : state.observer?.resolveExpressionType?.(resolution) ?? inferred;
  if (!synthetic) state.observer?.onExpressionResolution?.(resolution);
  state.expressionTypes.set(expression.location.offset, String(type));
  return type as ValueType;
}

function ensureOptionalChainEnum(
  target: string,
  location: SourceLocation,
  enums: Map<string, EnumDeclaration>,
  state: AnalysisState,
): string {
  const name = optionTypeName(target);
  if (enums.has(name)) return name;
  const declaration: EnumDeclaration = {
    kind: "enum",
    name,
    location,
    variants: [
      {
        name: "some",
        payload: { name: target, location },
        location,
      },
      { name: "none", payload: null, location },
    ],
  };
  enums.set(name, declaration);
  state.generatedOptionalEnums.set(name, declaration);
  const display = state.typeDisplayNames.get(target) ?? target;
  (state.typeDisplayNames as Map<string, string>).set(name, `Option<${display}>`);
  return name;
}

function ensureOptionalChainResult(
  successType: string,
  errorType: string,
  location: SourceLocation,
  enums: Map<string, EnumDeclaration>,
  state: AnalysisState,
): string {
  const name = resultTypeName(successType, errorType);
  if (enums.has(name)) return name;
  const declaration: EnumDeclaration = {
    kind: "enum",
    name,
    location,
    variants: [
      {
        name: "success",
        payload: successType === "void" ? null : { name: successType, location },
        location,
      },
      {
        name: "failure",
        payload: { name: errorType, location },
        location,
      },
    ],
  };
  enums.set(name, declaration);
  state.generatedOptionalEnums.set(name, declaration);
  const successDisplay = state.typeDisplayNames.get(successType) ?? successType;
  const errorDisplay = state.typeDisplayNames.get(errorType) ?? errorType;
  (state.typeDisplayNames as Map<string, string>).set(name, `Result<${successDisplay}, ${errorDisplay}>`);
  return name;
}

function optionalChainReceiver(
  type: ValueType,
  state: AnalysisState,
): {
  readonly sourceType: string;
  readonly payloadType: string;
  readonly sourceKind: OptionalChainPlan["sourceKind"];
} | null {
  const sourceType = String(underlyingType(type));
  const option = parseOptionType(sourceType);
  if (option) return { sourceType, payloadType: option.target, sourceKind: "option" };
  const object = foreignObject(type, state);
  if (object?.nullable) {
    return {
      sourceType,
      payloadType: publicObjCTypeName(object.typeName),
      sourceKind: "nullableObject",
    };
  }
  const pointer = foreignPointer(type, state);
  if (pointer?.nullable) {
    return {
      sourceType,
      payloadType: pointerTypeName(pointer.identity, pointer.ownership, false),
      sourceKind: "nullablePointer",
    };
  }
  return null;
}

function optionalChainResultParts(
  type: string,
  enums: ReadonlyMap<string, EnumDeclaration>,
): { readonly successType: string; readonly errorType: string } | null {
  const declaration = enums.get(type);
  if (!declaration?.name.startsWith("__z_Result_")) return null;
  const success = declaration.variants.find((variant) => variant.name === "success");
  const failure = declaration.variants.find((variant) => variant.name === "failure");
  if (!success || !failure?.payload) return null;
  return {
    successType: success.payload?.name ?? "void",
    errorType: failure.payload.name,
  };
}

function inferOptionalChain(
  expression: Extract<Expression, { kind: "member" | "call" }>,
  member: Extract<Expression, { kind: "member" }>,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  allowThrowingCall: boolean,
): ValueType {
  const receiverType = inferExpression(member.object, locals, globals, structs, enums, fileName, state);
  const receiver = optionalChainReceiver(receiverType, state);
  if (!receiver) {
    throw new DiagnosticError(fileName, member.location, "optional chaining requires Option<T> or a nullable native reference", {
      code: "Z0206",
      helps: ["use ordinary `.` for a value that is always present"],
    });
  }
  const syntheticName = `__z_optional_receiver_${member.location.offset}`;
  const syntheticLocation = {
    ...member.object.location,
    offset: -Math.abs(member.location.offset) - 1,
  };
  const syntheticReceiver: Expression = {
    kind: "identifier",
    name: syntheticName,
    location: syntheticLocation,
  };
  const accessMember: Extract<Expression, { kind: "member" }> = {
    ...member,
    object: syntheticReceiver,
    optional: false,
  };
  const access: Extract<Expression, { kind: "member" | "call" }> = expression.kind === "call"
    ? { ...expression, callee: accessMember }
    : accessMember;
  const receiverPayloadView = parseViewType(receiver.payloadType);
  const receiverAggregateType = receiverPayloadView?.target ?? receiver.payloadType;

  if (expression.kind === "call") {
    const declaration = structs.get(receiverAggregateType);
    const method = declaration?.methods.find((candidate) => (
      !candidate.static && candidate.name === member.property
    ));
    if (method?.receiverMode === "inout" || method?.receiverMode === "move") {
      throw new DiagnosticError(
        fileName,
        member.location,
        `${method.receiverMode === "move" ? "consuming" : "mutable"} method ${JSON.stringify(method.name)} cannot be called through optional chaining`,
        {
          code: "Z0205",
          notes: ["the first optional-chaining tier is an immutable conditional borrow"],
          helps: [`use \`match (in value) { some(value) => value.${method.name}(...); none => ...; }\``],
        },
      );
    }
  }

  const accessLocals = new Map(locals);
  accessLocals.set(
    syntheticName,
    parseViewType(receiver.payloadType)
      ? receiver.payloadType
      : `${borrowedPrefix}${receiver.payloadType}`,
  );
  const valueType = String(inferExpression(
    access,
    accessLocals,
    globals,
    structs,
    enums,
    fileName,
    state,
    allowThrowingCall,
  ));
  const throwing = optionalChainResultParts(valueType, enums);
  const unwrappedValueType = throwing?.successType ?? valueType;
  const isVoid = unwrappedValueType === "void";
  const alreadyOptional = parseOptionType(unwrappedValueType);
  const returnedView = expression.kind === "call"
    ? parseReceiverViewReturnType(unwrappedValueType)
    : null;
  let view = false;
  let chainedValueType = unwrappedValueType;

  if (returnedView) {
    const root = storageRoot(member.object);
    if (!root || !locals.has(root.name)) {
      throw new DiagnosticError(
        fileName,
        member.object.location,
        "a view-returning optional method requires a named owner binding",
        {
          code: "Z0206",
          notes: ["the view must not outlive the storage held by the optional receiver"],
          helps: ["bind the Option or nullable owner before calling the method through `?.`"],
        },
      );
    }
    state.viewCallOrigins.set(
      expression.location.offset,
      viewOriginForRoot(root.name, member.object.location, state),
    );
  }

  if (!isVoid && !alreadyOptional && expression.kind === "member") {
    const owner = structs.get(receiverAggregateType);
    const field = owner?.fields.find((candidate) => candidate.name === member.property);
    if (field && hasOwnershipType(field.type.name, structs, enums, state)) {
      const root = storageRoot(member.object);
      if (!root || !locals.has(root.name)) {
        throw new DiagnosticError(fileName, member.object.location, "a cleanup-bearing optional field projection requires a named owner binding", {
          code: "Z0206",
          helps: ["bind the Option or nullable owner before using `?.`"],
        });
      }
      view = true;
      chainedValueType = viewTypeName(field.type.name);
      state.viewCallOrigins.set(
        expression.location.offset,
        viewOriginForRoot(root.name, member.object.location, state),
      );
    }
  }

  const optionalValueType = isVoid
    ? "void"
    : alreadyOptional
      ? unwrappedValueType
      : ensureOptionalChainEnum(chainedValueType, expression.location, enums, state);
  const resultType = throwing
    ? ensureOptionalChainResult(optionalValueType, throwing.errorType, expression.location, enums, state)
    : optionalValueType;

  state.optionalChains.set(expression.location.offset, {
    receiver: member.object,
    access,
    sourceType: receiver.sourceType,
    payloadType: receiver.payloadType,
    valueType: unwrappedValueType,
    resultType,
    sourceKind: receiver.sourceKind,
    flatten: Boolean(alreadyOptional),
    view,
    throwing,
  });
  return resultType;
}

function readonlyFieldOnPath(
  expression: Expression,
  structs: ReadonlyMap<string, StructDeclaration>,
  state: AnalysisState,
): StructDeclaration["fields"][number] | null {
  if (expression.kind === "index") return readonlyFieldOnPath(expression.object, structs, state);
  if (expression.kind !== "member") return null;
  const resolved = state.resolvedFields.get(expression.location.offset);
  const ownerType = resolved ? null : state.expressionTypes.get(expression.object.location.offset);
  const declaration = ownerType ? structs.get(String(underlyingType(ownerType))) : null;
  const field = resolved ?? declaration?.fields.find((candidate) => candidate.name === expression.property);
  return field?.readonly ? field : readonlyFieldOnPath(expression.object, structs, state);
}

function resolveSemanticField(
  location: SourceLocation,
  aggregate: StructDeclaration,
  field: StructDeclaration["fields"][number],
  state: AnalysisState,
): StructDeclaration["fields"][number] {
  const resolution = { location, aggregate, field };
  const resolved = state.observer?.resolveField?.(resolution) ?? field;
  state.resolvedFields.set(location.offset, resolved);
  state.observer?.onFieldResolution?.(resolution);
  return resolved;
}

function resolveSemanticEnumVariant(
  location: SourceLocation,
  enumeration: EnumDeclaration,
  variant: EnumDeclaration["variants"][number],
  state: AnalysisState,
): EnumDeclaration["variants"][number] {
  const resolution = { location, enumeration, variant };
  const resolved = state.observer?.resolveEnumVariant?.(resolution) ?? variant;
  state.observer?.onEnumVariantResolution?.(resolution);
  return resolved;
}

function registerAsyncCall(
  declaration: FunctionDeclaration,
  location: SourceLocation,
  fileName: string,
  state: AnalysisState,
): void {
  if (!declaration.async) return;
  if (isAsyncGeneratorFunction(declaration)) return;
  const context = state.asyncCallContexts.at(-1);
  if (!context) {
    throw new DiagnosticError(fileName, location, `async call to ${JSON.stringify(declaration.name)} requires \`await\` or \`task\``, {
      code: "Z0702",
      notes: ["Z never starts asynchronous work from a naked function call"],
      helps: ["use `await` for sequential work or `task` for concurrent work in an async function"],
    });
  }
  context.calls += 1;
}

function requireMainExecutorContext(
  required: boolean,
  location: SourceLocation,
  subject: string,
  fileName: string,
  state: AnalysisState,
  inherited: ExecutorAffinityInfo | null = null,
): void {
  if (!required || state.executorContext === "main") return;
  const sourceSubject = [...state.typeDisplayNames]
    .sort(([left], [right]) => right.length - left.length)
    .reduce((text, [internal, display]) => text.replaceAll(internal, display), subject);
  const path = inherited?.fieldPath.length
    ? ` through field ${inherited.fieldPath.join(".")}`
    : "";
  throw new DiagnosticError(fileName, location, `${sourceSubject} requires thread.main executor context`, {
    code: "Z0711",
    notes: inherited?.declared === false
      ? [`main-thread isolation is inherited from ${displayAssignableType(inherited.originType, state)}${path}`]
      : ["the declaration is isolated with `on thread.main`"],
    helps: [state.activeFunction?.async
      ? "perform this operation inside `await on thread.main { ... }`"
      : "call it from a function declared `on thread.main`, or make the caller async and hop to main"],
  });
}

function executorAffinityForType(
  type: ValueType,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  state: AnalysisState,
  visiting = new Set<string>(),
): ExecutorAffinityInfo | null {
  const actual = String(underlyingType(type));
  const direct = state.aggregateExecutorAffinities.get(actual);
  if (direct) return direct;
  const foreign = foreignExecutorAffinityForTypeName(actual, state);
  if (foreign) return foreign;
  if (visiting.has(actual)) return null;
  visiting.add(actual);
  const dynamic = parseDynamicArrayType(actual);
  const fixed = parseFixedArrayType(actual);
  const option = parseOptionType(actual);
  const map = parseMapType(actual);
  const set = parseSetType(actual);
  const weak = parseWeakType(actual);
  const view = parseViewType(actual);
  const task = parseTaskType(actual);
  const generic = parseGenericType(actual);
  const children = [
    dynamic?.elementType,
    fixed?.elementType,
    option?.target,
    map?.keyType,
    map?.valueType,
    set?.elementType,
    weak?.target,
    view?.target,
    task?.successType,
    task?.errorType,
    ...(generic?.arguments ?? []),
    ...(structs.get(actual)?.fields.map((field) => field.type.name) ?? []),
    ...(enums.get(actual)?.variants.flatMap((variant) => variant.payload ? [variant.payload.name] : []) ?? []),
  ].filter((child): child is string => Boolean(child));
  for (const child of children) {
    const inherited = executorAffinityForType(child, structs, enums, state, visiting);
    if (inherited) {
      visiting.delete(actual);
      return inherited;
    }
  }
  visiting.delete(actual);
  return null;
}

function foreignExecutorAffinityForTypeName(
  typeName: string,
  state: AnalysisState,
): ExecutorAffinityInfo | null {
  const publicName = typeName.replace(/^__z_objc:(?:nullable|nonnull):/, "");
  const interfaceType = state.foreignInterfaces.get(publicName);
  if (interfaceType && foreignInterfaceRequiresMain(interfaceType, state)) {
    return {
      executor: "main",
      declared: true,
      originType: interfaceType.typeName,
      fieldPath: [],
    };
  }
  const named = state.foreignNamedTypes.get(typeName) ?? state.foreignNamedTypes.get(publicName);
  if (named?.metadata.executorAffinity === "main") {
    return {
      executor: "main",
      declared: true,
      originType: named.typeName,
      fieldPath: [],
    };
  }
  return null;
}

function foreignInterfaceRequiresMain(
  declaration: ForeignObjCInterface,
  state: AnalysisState,
): boolean {
  let current: ForeignObjCInterface | undefined = declaration;
  while (current) {
    if (current.metadata.executorAffinity === "main") return true;
    if (!current.superName) break;
    const moduleName = current.typeName.slice(0, current.typeName.lastIndexOf("."));
    current = state.foreignInterfaces.get(`${moduleName}.${current.superName}`);
  }
  return false;
}

function isTaskCancellationCall(expression: Expression): expression is Extract<Expression, { kind: "call" }> {
  return expression.kind === "call"
    && expression.callee.kind === "member"
    && expression.callee.property === "cancel";
}

function firstLiveBorrow(
  locals: ReadonlyMap<string, ValueType>,
  activeFunction: FunctionDeclaration | null,
  viewOrigins: ReadonlyMap<string, ViewOrigin>,
  borrowOrigins: ReadonlyMap<string, {
    readonly location: SourceLocation;
    readonly kind: "closure" | "iteration" | "match" | "ownedMatch";
  }>,
  iterationBorrowOrigins: ReadonlyMap<string, SourceLocation>,
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
  const persistentGenerator = Boolean(activeFunction && isAsyncGeneratorFunction(activeFunction));
  for (const [name, type] of locals) {
    const view = parseViewType(String(underlyingType(type)));
    if (view && !viewOrigins.has(name)) continue;
    if (isBorrowedBinding(type)
      && initializationState(type) === "initialized"
      && ownershipState(type) === "available"
      && (!asyncParameters.has(name) || borrowOrigins.has(name))) {
      const origin = borrowOrigins.get(name);
      if (origin?.kind === "ownedMatch") continue;
      if (
        persistentGenerator
        && (
          origin?.kind === "iteration"
          || origin?.kind === "match"
          || iterationBorrowOrigins.has(name)
        )
      ) continue;
      return name;
    }
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
    case "unsafeExpression":
      throw new DiagnosticError(fileName, expression.location, "unsafe expressions must appear in a direct value-producing position", {
        code: "Z0822",
        helps: ["bind the unsafe expression to a local before composing it into a larger expression"],
      });
    case "raw": {
      if (state.activeFunction?.async) {
        throw new DiagnosticError(fileName, expression.location, "raw native expressions are not executable in async functions in the first tier", {
          code: "Z0820",
          notes: ["the native helper is synchronous, but async frame lowering does not compose with raw expressions yet"],
        });
      }
      validateRawBoundaryType(expression.returnType, true, state.foreignNamedTypes, state.foreignTypes, fileName);
      const captures: RawExpressionPlan["captures"][number][] = [];
      const declared = new Map<string, typeof expression.captures[number]>();
      for (const capture of expression.captures) {
        const first = declared.get(capture.name);
        if (first) {
          throw new DiagnosticError(fileName, capture.nameLocation, `duplicate raw operand ${JSON.stringify(capture.name)}`, {
            code: "Z0820",
            labels: [{ location: first.nameLocation, message: "first operand is declared here", length: capture.name.length }],
          });
        }
        const stored = locals.get(capture.name);
        if (!stored) {
          throw new DiagnosticError(fileName, capture.nameLocation, `unknown raw operand ${JSON.stringify(capture.name)}`, {
            code: "Z0820",
            helps: ["name a binding visible before the raw expression"],
          });
        }
        const type = String(underlyingType(stored));
        if (type === "unknown") {
          throw new DiagnosticError(fileName, capture.nameLocation, `raw operand ${JSON.stringify(capture.name)} requires an explicit type`, {
            code: "Z0821",
            helps: [`add a type annotation to the \`let ${capture.name}\` declaration`],
          });
        }
        validateRawBoundaryType({ name: type, location: capture.nameLocation }, false, state.foreignNamedTypes, state.foreignTypes, fileName);
        if (type === "cstring" && capture.mode !== "in") {
          throw new DiagnosticError(fileName, capture.nameLocation, "cstring is already a borrowed native string and only supports `in` at a raw boundary", {
            code: "Z0821",
            helps: ["use an imported writable native pointer type when native code must replace pointer storage"],
          });
        }
        if (capture.mode !== "out" && initializationState(stored) !== "initialized") {
          throw new DiagnosticError(fileName, capture.nameLocation, `${capture.mode} raw operand ${JSON.stringify(capture.name)} must be initialized before the native call`, {
            code: "Z0303",
          });
        }
        if (capture.mode !== "out" && ownershipState(stored) !== "available") {
          throw movedValueError(fileName, { name: capture.name, location: capture.nameLocation }, state, ownershipState(stored) === "maybeMoved");
        }
        if (capture.mode !== "in" && !isMutableBinding(stored)) {
          throw new DiagnosticError(fileName, capture.nameLocation, `${capture.mode} raw operand ${JSON.stringify(capture.name)} requires a mutable let binding`, {
            code: capture.mode === "inout" ? "Z0301" : "Z0302",
            helps: [`declare ${JSON.stringify(capture.name)} with \`let\``],
          });
        }
        if (
          capture.mode === "out"
          && initializationState(stored) === "initialized"
          && hasOwnershipType(type, structs, enums, state)
        ) {
          throw new DiagnosticError(fileName, capture.nameLocation, `out raw operand ${JSON.stringify(capture.name)} cannot overwrite an initialized owner`, {
            code: "Z0302",
            notes: ["raw native code cannot prove that the previous owner was destroyed before replacement"],
            helps: ["use a fresh uninitialized let binding for the output"],
          });
        }
        if (capture.mode === "inout" || capture.mode === "out") {
          rejectOwnerMutationWhileViewed(capture.name, capture.nameLocation, fileName, state);
        }
        if (capture.mode === "out") {
          locals.set(capture.name, initializedAvailableBinding(stored));
          state.moveOrigins.delete(capture.name);
        }
        state.bindingTypes.set(capture.nameLocation.offset, type);
        declared.set(capture.name, capture);
        captures.push({ mode: capture.mode, name: capture.name, type });
      }
      state.rawExpressions.set(expression.location.offset, {
        returnType: expression.returnType.name,
        expression,
        captures,
      });
      return expression.returnType.name;
    }
    case "argumentReference":
      throw new DiagnosticError(
        fileName,
        expression.location,
        `${expression.access} is only valid for a classified imported C record-pointer parameter`,
      );
    case "unary": {
      if (expression.operator === "view") {
        if (!state.localViewInitializers.has(expression.location.offset)) {
          throw new DiagnosticError(fileName, expression.location, "`view expression` must directly initialize an inferred const local", {
            code: "Z0206",
            notes: ["the first local-view tier keeps provenance visible in one named lexical binding"],
            helps: ["use `const projected = view owner.field;` or `const projected = view owner.items[index];`"],
          });
        }
        const arrayView = state.arrayViewInitializers.has(expression.location.offset);
        if (
          expression.operand.kind !== "member"
          && expression.operand.kind !== "index"
          && (!arrayView || expression.operand.kind !== "identifier")
        ) {
          throw new DiagnosticError(fileName, expression.operand.location, "`view` requires a direct field or indexed projection", {
            code: "Z0206",
            helps: arrayView
              ? ["use named contiguous storage such as `view values` or `view store.items`"]
              : ["project named owner storage such as `view tree.nodes[index]`"],
          });
        }
        const root = storageRoot(expression.operand);
        const storedRoot = root ? locals.get(root.name) : null;
        if (!root || !storedRoot) {
          throw new DiagnosticError(fileName, expression.operand.location, "`view` requires a named local owner", {
            code: "Z0206",
            helps: ["bind the owner before creating a local view"],
          });
        }
        const rootType = String(underlyingType(storedRoot));
        const rootValueType = parseViewType(rootType)?.target ?? rootType;
        if (
          structs.get(rootValueType)?.kind === "class"
          || state.foreignNamedTypes.get(rootValueType)?.kind === "object"
          || rootValueType.startsWith("__z_objc:")
        ) {
          throw new DiagnosticError(fileName, expression.operand.location, "`view` local owners must have value storage", {
            code: "Z0206",
            notes: ["class aliases could mutate the projected storage without passing through this binding"],
            helps: ["use a borrowed class method or an owned snapshot instead"],
          });
        }
        const sourceType = inferExpression(expression.operand, locals, globals, structs, enums, fileName, state);
        if (sourceType === "unknown" || sourceType === "never") return sourceType;
        const target = String(underlyingType(sourceType));
        if (parseViewType(target)) {
          throw new DiagnosticError(fileName, expression.operand.location, "nested view values are not valid", {
            code: "Z0206",
          });
        }
        if (
          structs.get(target)?.kind === "class"
          || state.foreignNamedTypes.get(target)?.kind === "object"
          || target.startsWith("__z_objc:")
        ) {
          throw new DiagnosticError(fileName, expression.operand.location, "`view` projects value storage rather than reference identity", {
            code: "Z0206",
            helps: ["borrow the class reference directly with an `in` parameter"],
          });
        }
        if (
          arrayView
          && !parseFixedArrayType(target)
          && !parseDynamicArrayType(target)
          && !parseSliceType(target)
        ) {
          throw new DiagnosticError(fileName, expression.operand.location, `array view destructuring requires contiguous collection storage, found ${displayArrayType(target)}`, {
            code: "Z0206",
            helps: ["use a fixed array, Array<T>, or Slice<T> source"],
          });
        }
        state.viewCallOrigins.set(
          expression.location.offset,
          viewOriginForRoot(root.name, expression.operand.location, state),
        );
        return viewTypeName(target);
      }
      if (expression.operator === "copy") {
        const sourceType = inferExpression(expression.operand, locals, globals, structs, enums, fileName, state);
        if (sourceType === "unknown" || sourceType === "never") return sourceType;
        const view = parseViewType(String(underlyingType(sourceType)));
        const target = view?.target ?? String(underlyingType(sourceType));
        const plan = explicitCopyPlanForType(target, structs, enums, state);
        if (!plan) {
          const onceLifetime = parseOnceLifetimeType(target);
          throw new DiagnosticError(
            fileName,
            expression.location,
            onceLifetime
              ? `cannot copy move-only ${displayAssignableType(target, state)}`
              : `type ${displayAssignableType(target, state)} cannot be explicitly copied`,
            {
            code: "Z0217",
            length: 4,
            notes: [
              "`copy value` must produce an independent owner while leaving the source available",
              "the first explicit-copy tier supports ordinary cleanup-free values, String, and native values whose declaration proves copy construction",
            ],
            helps: [
              "use a domain-specific clone or snapshot method for this type, or transfer its existing owner with `move value`",
            ],
            },
          );
        }
        state.explicitCopies.set(expression.location.offset, { ...plan, type: target, sourceIsView: Boolean(view) });
        return target;
      }
      if (expression.operator === "move") {
        const sourceType = inferExpression(expression.operand, locals, globals, structs, enums, fileName, state);
        if (sourceType === "unknown" || sourceType === "never") return sourceType;
        const actual = String(underlyingType(sourceType));
        if (parseViewType(actual)) {
          throw new DiagnosticError(fileName, expression.location, "cannot move a view because it does not own the referenced value", {
            code: "Z0218",
            length: 4,
            notes: ["a view is temporary read-only access tied to another owner"],
            helps: ["use `copy value` when the viewed type is copyable, or remove/take the value through its owning container"],
          });
        }
        const native = state.foreignNamedTypes.get(actual);
        if (native?.kind === "value" && !native.lifecycle.move) {
          throw new DiagnosticError(fileName, expression.location, `native type ${displayAssignableType(actual, state)} does not declare move construction`, {
            code: "Z0218",
            length: 4,
            helps: ["use `copy value` if its `.zd` contract declares `copy`, or borrow it with `in`"],
          });
        }
        if (native?.kind === "object" || !hasOwnershipType(actual, structs, enums, state)) {
          throw new DiagnosticError(fileName, expression.location, `type ${displayAssignableType(actual, state)} has no unique ownership to move`, {
            code: "Z0218",
            length: 4,
            notes: ["ordinary cleanup-free values already copy by value; `move` is reserved for transferring an existing owner"],
            helps: ["use the value directly, or use `copy value` when explicit duplication improves clarity"],
          });
        }
        consumeOwnedValue(expression.operand, sourceType, locals, structs, enums, fileName, state, true);
        return actual;
      }
      const operand = implicitlyLoadCopyableView(
        inferExpression(expression.operand, locals, globals, structs, enums, fileName, state),
        expression.operand,
        structs,
        enums,
        state,
      );
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
          throw new DiagnosticError(fileName, expression.location, `cannot read ${JSON.stringify(expression.name)} while a child task mutably borrows it`, {
            code: "Z0704",
            length: expression.name.length,
            labels: [{ location: asyncBorrow.location, message: "child task's mutable borrow begins here", length: expression.name.length }],
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
        if (global.declaration.executorAffinity) {
          throw new DiagnosticError(fileName, expression.location, "executor-isolated function values are deferred; call the function directly from its required executor context", {
            code: "Z0711",
            notes: ["ordinary function types do not erase or implicitly carry executor affinity"],
          });
        }
        if (global.declaration.async) {
          throw new DiagnosticError(fileName, expression.location, "async function values are deferred; call the function beneath `await` or `task`");
        }
        if (global.declaration.typeParameters?.length) {
          throw new DiagnosticError(fileName, expression.location, "generic function values require explicit specialization, which is not implemented yet");
        }
        return functionTypeName(
          global.declaration.parameters.map((parameter) => ({
            name: parameter.name,
            mode: parameter.mode,
            type: parameter.type.name,
          })),
          global.declaration.returnType.name,
          global.declaration.errorType && !isGeneratorFunction(global.declaration)
            ? global.declaration.errorType.name
            : null,
        );
      }
      if (global?.kind === "constant") {
        state.moduleConstantReferences.set(expression.location.offset, expression.name);
        return global.type;
      }
      if (global?.kind === "standardFunction") {
        const signature = standardFunctionSignature(global.name);
        if (signature.async) {
          throw new DiagnosticError(fileName, expression.location, "async function values are deferred; call the function beneath `await` or `task`");
        }
        state.standardFunctionReferences.set(expression.location.offset, global.name);
        return functionTypeName(signature.parameters, signature.returnType, signature.errorType);
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
      if (global?.kind === "testExpect") {
        throw new DiagnosticError(fileName, expression.location, "expect must be called and completed with a matcher", {
          code: "Z0901",
          helps: ["use `expect(value).toEqual(expected)`"],
        });
      }
      if (global?.kind === "testFail") {
        throw new DiagnosticError(fileName, expression.location, "fail must be called with a failure message", {
          code: "Z0901",
          helps: ['use `fail("reason")`'],
        });
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
      const left = implicitlyLoadCopyableView(
        inferExpression(expression.left, locals, globals, structs, enums, fileName, state),
        expression.left,
        structs,
        enums,
        state,
      );
      const right = implicitlyLoadCopyableView(
        inferExpression(expression.right, locals, globals, structs, enums, fileName, state),
        expression.right,
        structs,
        enums,
        state,
      );
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
        const leftUnsafePointer = Boolean(parseUnsafeNativeType(String(underlyingType(left))));
        const rightUnsafePointer = Boolean(parseUnsafeNativeType(String(underlyingType(right))));
        if (
          (canonicalLeft === "null" && rightNullableReference)
          || (canonicalRight === "null" && leftNullableReference)
          || (canonicalLeft === "null" && rightUnsafePointer)
          || (canonicalRight === "null" && leftUnsafePointer)
        ) {
          return "boolean";
        }
        const comparableNamed = left === right && state.foreignNamedTypes.get(String(left))?.kind === "enum";
        const zEnum = left === right ? enums.get(String(left)) : null;
        const comparableZEnum = zEnum !== null && zEnum !== undefined
          && zEnum.variants.every((variant) => variant.payload === null);
        const comparableString = (parseViewType(canonicalLeft)?.target ?? canonicalLeft) === "String"
          && (parseViewType(canonicalRight)?.target ?? canonicalRight) === "String";
        if ((!comparableString && canonicalLeft !== canonicalRight) || (!isNumericType(canonicalLeft) && canonicalLeft !== "boolean" && !comparableNamed && !comparableZEnum && !comparableString)) {
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
        requireAssignable("boolean", conditionType, expression.condition, fileName, structs, enums, state);
      }
      const original = new Map(locals);
      const thenLocals = narrowedConditionLocals(original, expression.condition, true, state);
      const activeFunction = state.activeFunction;
      const thenType = activeFunction?.async
        ? inferDirectValue(expression.thenExpression, activeFunction, thenLocals, globals, structs, enums, fileName, state)
        : inferExpression(expression.thenExpression, thenLocals, globals, structs, enums, fileName, state);
      consumeOwnedValue(expression.thenExpression, thenType, thenLocals, structs, enums, fileName, state);
      const elseLocals = narrowedConditionLocals(original, expression.condition, false, state);
      const elseType = activeFunction?.async
        ? inferDirectValue(expression.elseExpression, activeFunction, elseLocals, globals, structs, enums, fileName, state)
        : inferExpression(expression.elseExpression, elseLocals, globals, structs, enums, fileName, state);
      consumeOwnedValue(expression.elseExpression, elseType, elseLocals, structs, enums, fileName, state);
      mergeOwnershipStates(locals, [thenLocals, elseLocals], state);
      return commonBranchType("conditional", thenType, elseType, expression.elseExpression.location, fileName);
    }
    case "new": {
      const standardType = [...state.standardTypeBindings.entries()]
        .find(([localName]) => localName === expression.typeName)?.[1];
      if (standardType === "TaskScope") {
        if (!state.activeFunction?.async) {
          throw new DiagnosticError(fileName, expression.location, "TaskScope construction requires an enclosing async function", {
            code: "Z0703",
            notes: ["a TaskScope inherits the current task executor and must be joined before its owner exits"],
          });
        }
        rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
        if (expression.arguments.length !== 0) {
          throw new DiagnosticError(fileName, expression.location, `new TaskScope() expects no arguments, received ${expression.arguments.length}`);
        }
        state.taskScopeConstructors.add(expression.location.offset);
        return "TaskScope";
      }
      const declaration = structs.get(expression.typeName);
      if (!declaration) {
        throw new DiagnosticError(fileName, expression.location, `unknown class ${JSON.stringify(expression.typeName)}`);
      }
      if (declaration.kind !== "class") {
        throw new DiagnosticError(fileName, expression.location, `new requires a class type; construct ${expression.typeName} as ${expression.typeName}({ ... })`);
      }
      const constructorAffinity = state.aggregateExecutorAffinities.get(declaration.name) ?? null;
      requireMainExecutorContext(
        Boolean(constructorAffinity),
        expression.location,
        `construction of ${declaration.kind} ${JSON.stringify(declaration.name)}`,
        fileName,
        state,
        constructorAffinity,
      );
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
      const affinity = state.aggregateExecutorAffinities.get(declaration.name) ?? null;
      requireMainExecutorContext(
        Boolean(affinity),
        expression.location,
        `weak reference construction for ${JSON.stringify(declaration.name)}`,
        fileName,
        state,
        affinity,
      );
      state.weakClassUses.set(declaration.name, expression.location);
      return weakTypeName(declaration.name);
    }
    case "closure":
      throw new DiagnosticError(fileName, expression.location, "a closure must directly initialize a const binding in the initial non-escaping tier");
    case "structExpression": {
      const linkedDeclaration = structs.get(expression.typeName);
      const aggregateResolution = linkedDeclaration
        ? { location: expression.location, declaration: linkedDeclaration }
        : null;
      const declaration = aggregateResolution
        ? state.observer?.resolveAggregateConstruction?.(aggregateResolution) ?? linkedDeclaration
        : undefined;
      const foreignDeclaration = state.foreignNamedTypes.get(expression.typeName);
      if (!declaration && foreignDeclaration?.kind !== "record") {
        throw new DiagnosticError(fileName, expression.location, `unknown struct ${JSON.stringify(expression.typeName)}`);
      }
      if (foreignDeclaration?.kind === "record" && foreignDeclaration.layout === "union") {
        throw new DiagnosticError(fileName, expression.location, `native union ${JSON.stringify(expression.typeName)} cannot be constructed as a Z struct`, {
          code: "Z0823",
          notes: ["a C union has one active member, while a Z struct literal initializes every declared field"],
          helps: ["initialize union storage through a checked native out parameter, then inspect a scalar member inside unsafe"],
        });
      }
      if (foreignDeclaration?.kind === "record" && foreignDeclaration.resource) {
        throw new DiagnosticError(fileName, expression.location, `native value resource ${JSON.stringify(expression.typeName)} cannot be constructed with a Z struct literal`, {
          code: "Z0823",
          notes: ["only its declaring native library can establish a valid resource representation"],
          helps: ["call a contracted native producer whose result declares `owned;`"],
        });
      }
      const constructionAffinity = declaration
        ? state.aggregateExecutorAffinities.get(declaration.name) ?? null
        : null;
      requireMainExecutorContext(
        Boolean(constructionAffinity),
        expression.location,
        `construction of ${declaration?.kind ?? "struct"} ${JSON.stringify(expression.typeName)}`,
        fileName,
        state,
        constructionAffinity,
      );
      if (expression.spread) {
        if (!declaration || declaration.kind !== "struct" || foreignDeclaration) {
          throw new DiagnosticError(fileName, expression.spread.location, "struct spread is limited to Z value structs in the first tier", {
            code: "Z0221",
            notes: ["classes preserve shared identity, while foreign records require ABI-specific construction rules"],
          });
        }
        if (declaration.deinitializer) {
          throw new DiagnosticError(fileName, expression.spread.location, `cannot spread ${declaration.name} because it defines deinit`, {
            code: "Z0221",
            notes: ["field-wise reconstruction cannot preserve a custom whole-value destructor contract"],
            helps: ["provide a type-specific update, copy, or consuming method that preserves the destructor invariant"],
          });
        }
        if (containsForeignValueStorage(declaration.name, structs, enums, state.foreignNamedTypes)) {
          throw new DiagnosticError(fileName, expression.spread.location, `cannot spread ${declaration.name} while it contains native value storage`, {
            code: "Z0240",
            notes: ["the first spread tier does not partially copy or relocate native RAII fields"],
            helps: ["move the complete aggregate or provide a type-specific native-aware operation"],
          });
        }
        if (expression.spread.expression.kind !== "identifier") {
          throw new DiagnosticError(fileName, expression.spread.expression.location, "a struct spread source must be a named local in the first tier", {
            code: "Z0221",
            notes: ["named storage lets the compiler prove source availability and exact cleanup"],
            helps: ["bind the source value before spreading it"],
          });
        }
        const sourceType = inferExpression(
          expression.spread.expression,
          locals,
          globals,
          structs,
          enums,
          fileName,
          state,
        );
        const sourceValueType = String(underlyingType(sourceType));
        if (parseViewType(sourceValueType) || sourceValueType !== declaration.name) {
          throw new DiagnosticError(
            fileName,
            expression.spread.expression.location,
            `struct spread for ${JSON.stringify(declaration.name)} requires the exact same nominal struct type, found ${describeValueType(sourceType, state)}`,
            {
              code: "Z0221",
              notes: ["structural spreading between unrelated types is intentionally deferred"],
            },
          );
        }
        if (
          expression.spread.mode === "move"
          && !hasOwnershipType(declaration.name, structs, enums, state)
        ) {
          throw new DiagnosticError(fileName, expression.spread.location, `type ${displayAssignableType(declaration.name, state)} has no unique ownership to move`, {
            code: "Z0218",
            notes: ["cleanup-free value structs already copy their retained fields by value"],
            helps: ["use ordinary `...source` spread"],
          });
        }
        const overriddenNames = new Set(expression.fields.map((field) => field.name));
        const retained = declaration.fields
          .filter((field) => !overriddenNames.has(field.name))
          .map((declaredField) => {
            const field = resolveSemanticField(expression.spread!.location, declaration, declaredField, state);
            const fieldType = field.type.name;
            if (expression.spread!.mode === "move") {
              return { name: field.name, type: fieldType, action: "move" as const };
            }
            if (expression.spread!.mode === "copy") {
              const copy = explicitCopyPlanForType(fieldType, structs, enums, state);
              if (!copy) {
                throw new DiagnosticError(
                  fileName,
                  expression.spread!.location,
                  `retained field ${JSON.stringify(field.name)} of type ${displayAssignableType(fieldType, state)} cannot be explicitly copied`,
                  {
                    code: "Z0217",
                    notes: ["overridden fields are not copied; only retained spread fields must support independent copying"],
                    helps: ["override this field, provide a domain-specific snapshot, or use `move ...source`"],
                  },
                );
              }
              return { name: field.name, type: fieldType, action: "copy" as const, copy: copy.kind };
            }
            const fieldAggregate = structs.get(fieldType);
            const foreignField = state.foreignNamedTypes.get(fieldType);
            if (fieldAggregate?.kind === "class") {
              return { name: field.name, type: fieldType, action: "retain" as const };
            }
            if (foreignField?.kind === "object") {
              return { name: field.name, type: fieldType, action: "value" as const };
            }
            if (hasOwnershipType(fieldType, structs, enums, state)) {
              throw new DiagnosticError(
                fileName,
                expression.spread!.location,
                `ordinary spread cannot implicitly duplicate ownership-bearing field ${JSON.stringify(field.name)} of type ${displayAssignableType(fieldType, state)}`,
                {
                  code: "Z0221",
                  notes: ["overridden fields do not constrain ordinary spread because their source values are not retained"],
                  helps: ["use `copy ...source` for independently copyable fields, `move ...source` to consume the source, or override this field"],
                },
              );
            }
            return { name: field.name, type: fieldType, action: "value" as const };
          });
        const overridden = declaration.fields
          .filter((field) => overriddenNames.has(field.name))
          .map((declaredField) => {
            const field = resolveSemanticField(expression.spread!.location, declaration, declaredField, state);
            return { name: field.name, type: field.type.name };
          });
        state.structSpreads.set(expression.location.offset, {
          mode: expression.spread.mode,
          sourceName: expression.spread.expression.name,
          type: declaration.name,
          retained,
          overridden,
        });
        if (expression.spread.mode === "move") {
          consumeOwnedValue(
            expression.spread.expression,
            sourceType,
            locals,
            structs,
            enums,
            fileName,
            state,
            true,
          );
        }
      }
      const provided = new Set<string>();
      for (const initializer of expression.fields) {
        if (provided.has(initializer.name)) {
          throw new DiagnosticError(fileName, initializer.location, `duplicate field initializer ${JSON.stringify(initializer.name)}`);
        }
        provided.add(initializer.name);
        const declaredField = declaration?.fields.find((candidate) => candidate.name === initializer.name)
          ?? (foreignDeclaration?.kind === "record" ? foreignDeclaration.fields.find((candidate) => candidate.name === initializer.name) : null);
        if (!declaredField) {
          throw new DiagnosticError(fileName, initializer.location, `struct ${JSON.stringify(expression.typeName)} has no field ${JSON.stringify(initializer.name)}`);
        }
        const field = declaration && "type" in declaredField
          ? resolveSemanticField(initializer.location, declaration, declaredField, state)
          : declaredField;
        const fieldType = "type" in field ? field.type.name : field.typeName;
        let actual = inferExpression(initializer.expression, locals, globals, structs, enums, fileName, state);
        actual = contextualCStringLiteral(fieldType, initializer.expression, state) ?? actual;
        rejectBorrowedNativeResourceEscape(actual, initializer.expression, locals, fileName, state, "stored in a struct field");
        requireAssignable(fieldType, actual, initializer.expression, fileName, structs, enums, state);
        consumeOwnedValue(initializer.expression, fieldType, locals, structs, enums, fileName, state);
      }
      const expectedFields = declaration?.fields ?? (foreignDeclaration?.kind === "record" ? foreignDeclaration.fields : []);
      const missing = expression.spread
        ? null
        : expectedFields.find((field) => !provided.has(field.name));
      if (missing) {
        throw new DiagnosticError(fileName, expression.location, `missing field ${JSON.stringify(missing.name)} when constructing ${JSON.stringify(expression.typeName)}`);
      }
      if (aggregateResolution) state.observer?.onAggregateConstruction?.(aggregateResolution);
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
      rejectBorrowedNativeResourceEscape(elementType, expression.elements[0], locals, fileName, state, "stored in an array");
      consumeOwnedValue(expression.elements[0], elementType, locals, structs, enums, fileName, state);
      for (const element of expression.elements.slice(1)) {
        const actual = inferExpression(element, locals, globals, structs, enums, fileName, state);
        rejectBorrowedNativeResourceEscape(actual, element, locals, fileName, state, "stored in an array");
        requireAssignable(elementType, actual, element, fileName, structs, enums, state);
        consumeOwnedValue(element, elementType, locals, structs, enums, fileName, state);
      }
      return fixedArrayTypeName(String(elementType), expression.elements.length);
    }
    case "dynamicArrayExpression":
      for (const element of expression.elements) {
        const actual = inferExpression(element, locals, globals, structs, enums, fileName, state);
        rejectBorrowedNativeResourceEscape(
          actual,
          element,
          locals,
          fileName,
          state,
          "stored in an Array",
        );
        requireAssignable(
          expression.elementType,
          actual,
          element,
          fileName,
          structs,
          enums,
          state,
        );
        consumeOwnedValue(
          element,
          expression.elementType,
          locals,
          structs,
          enums,
          fileName,
          state,
        );
      }
      if (expression.elements.length > 0) {
        state.dynamicArrayPushTypes.add(dynamicArrayTypeName(expression.elementType));
      }
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
      const declaredVariant = declaration?.variants.find((candidate) => candidate.name === expression.variantName);
      if (!declaration || !declaredVariant) {
        throw new DiagnosticError(fileName, expression.location, `unknown enum variant ${expression.enumName}.${expression.variantName}`);
      }
      const variant = resolveSemanticEnumVariant(expression.location, declaration, declaredVariant, state);
      if (!variant.payload) {
        throw new DiagnosticError(fileName, expression.location, "payloadless variant does not accept a value");
      }
      const payloadView = parseViewType(variant.payload.name);
      if (payloadView) {
        validateReceiverViewProjection(expression.payload, declaration.name, payloadView.target, locals, globals, structs, enums, fileName, state);
        return declaration.name;
      }
      let actual = expression.payload.kind === "objectExpression"
        ? inferContextualObjectExpression(expression.payload, variant.payload.name, locals, globals, structs, enums, fileName, state)
        : inferExpression(expression.payload, locals, globals, structs, enums, fileName, state);
      actual = contextualCStringLiteral(variant.payload.name, expression.payload, state) ?? actual;
      rejectBorrowedNativeResourceEscape(actual, expression.payload, locals, fileName, state, "stored in an enum payload");
      requireAssignable(variant.payload.name, actual, expression.payload, fileName, structs, enums, state);
      consumeOwnedValue(expression.payload, variant.payload.name, locals, structs, enums, fileName, state);
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
        throw new DiagnosticError(fileName, expression.location, "`await task` is redundant", {
          code: "Z0701",
          notes: ["an immediately joined child creates no interval of concurrent parent work"],
          helps: ["use `await operation()` for sequential work, or bind `task operation()` and await the Task later"],
        });
      }
      const borrowed = firstLiveBorrow(
        locals,
        state.activeFunction,
        state.viewOrigins,
        state.borrowOrigins,
        state.iterationBorrowOrigins,
      );
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
      rejectLoopCarriedChildTask(expression.location, fileName, state);
      if (!state.activeFunction?.async) {
        throw new DiagnosticError(fileName, expression.location, "task requires an enclosing async function", {
          code: "Z0703",
          helps: ["add `async` before the enclosing function declaration"],
        });
      }
      if (expression.expression.kind !== "call") {
        throw new DiagnosticError(fileName, expression.location, "task requires a direct async function or method call");
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
        throw new DiagnosticError(fileName, expression.location, "task requires exactly one direct async call");
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
    case "try": {
      if (
        expression.expression.kind !== "await"
        && expression.expression.kind !== "executorPlacement"
      ) {
        throw new DiagnosticError(
          fileName,
          expression.location,
          "try must be the direct value of a binding, return, or expression statement",
        );
      }
      const owner = state.activeFunction;
      if (!owner) {
        throw new DiagnosticError(fileName, expression.location, "try requires an enclosing throwing function");
      }
      return inferTrySuccess(
        expression,
        owner,
        locals,
        globals,
        structs,
        enums,
        fileName,
        state,
      );
    }
    case "matchExpression":
      throw new DiagnosticError(fileName, expression.location, "match must be the direct value of a binding, return, or expression statement");
    case "ifExpression":
      throw new DiagnosticError(fileName, expression.location, "if must be the direct value of a binding, return, or expression statement");
    case "whileExpression":
      throw new DiagnosticError(fileName, expression.location, "while must be the direct value of a binding, return, or expression statement");
    case "forExpression":
      throw new DiagnosticError(fileName, expression.location, "for must be the direct value of a binding, return, or expression statement");
    case "member": {
      if (expression.optional) {
        return inferOptionalChain(
          expression,
          expression,
          locals,
          globals,
          structs,
          enums,
          fileName,
          state,
          allowThrowingCall,
        );
      }
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
        requireMainExecutorContext(
          foreignInterfaceRequiresMain(objcClass, state),
          expression.location,
          `Objective-C class ${JSON.stringify(objcClass.className)}`,
          fileName,
          state,
        );
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
          const declaredVariant = enumDeclaration.variants.find((candidate) => candidate.name === expression.property);
          if (!declaredVariant) throw new DiagnosticError(fileName, expression.location, `enum ${JSON.stringify(enumDeclaration.name)} has no variant ${JSON.stringify(expression.property)}`);
          const variant = resolveSemanticEnumVariant(expression.location, enumDeclaration, declaredVariant, state);
          if (variant.payload) throw new DiagnosticError(fileName, expression.location, "payload variant must be called with a value");
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
      if (
        receiverValueType === fsLockTypeName
        || receiverValueType === "fs.Lock"
      ) {
        throw new DiagnosticError(
          fileName,
          expression.location,
          `fs.Lock has no property ${JSON.stringify(expression.property)}; call unlock for explicit early release`,
        );
      }
      if (receiverValueType === objcConnectionTypeName) {
        throw new DiagnosticError(fileName, expression.location, `objc.Connection has no property ${JSON.stringify(expression.property)}`);
      }
      if (receiverValueType === "TaskControl") {
        if (expression.property === "accepted" || expression.property === "isCancellationRequested") return "boolean";
        throw new DiagnosticError(fileName, expression.location, `TaskControl has no property ${JSON.stringify(expression.property)}; call requestCancel instead`);
      }
      const map = parseMapType(receiverValueType);
      if (map) {
        if (expression.property === "length") return "usize";
        throw new DiagnosticError(fileName, expression.location, `Map has no property ${JSON.stringify(expression.property)}`);
      }
      const set = parseSetType(receiverValueType);
      if (set) {
        if (expression.property === "length") return "usize";
        throw new DiagnosticError(fileName, expression.location, `Set has no property ${JSON.stringify(expression.property)}`);
      }
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
        requireMainExecutorContext(
          foreignInterfaceRequiresMain(objcReceiverType.declaration, state)
            || property.metadata.executorAffinity === "main",
          expression.location,
          `Objective-C property ${JSON.stringify(objcReceiverType.declaration.className)}.${JSON.stringify(property.name)}`,
          fileName,
          state,
        );
        const propertyType = foreignValueType(property.type);
        if (propertyType === "unknown") throw new DiagnosticError(fileName, expression.location, `Objective-C property ${JSON.stringify(property.name)} uses an unsupported type`);
        checkForeignAvailability(property.metadata, property.name, expression.location, fileName, state);
        state.objcProperties.set(expression.location.offset, {
          getter: property.getter,
          setter: property.setter,
          ownership: property.ownership,
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
      if (foreignRecord?.metadata.executorAffinity === "main") {
        requireMainExecutorContext(
          true,
          expression.location,
          `native type ${JSON.stringify(foreignRecord.qualifiedName)}`,
          fileName,
          state,
        );
      }
      if (foreignRecord?.kind === "record") {
        if (foreignRecord.layout === "union" && state.unsafeDepth === 0) {
          throw new DiagnosticError(fileName, expression.location, `native union member ${JSON.stringify(expression.property)} requires an unsafe boundary`, {
            code: "Z0823",
            notes: ["Clang proves the member layout but not which union member the native API initialized"],
            helps: ["validate the API discriminator, then read the scalar member inside `unsafe { ... }`"],
          });
        }
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
        throw new DiagnosticError(fileName, expression.location, `type ${JSON.stringify(displayAssignableType(receiverType, state))} has no members`);
      }
      const declaredField = declaration.fields.find((candidate) => candidate.name === expression.property);
      if (declaredField) {
        const field = resolveSemanticField(expression.location, declaration, declaredField, state);
        if (field.visibility === "private" && state.activeReceiver !== declaration.name) {
          throw new DiagnosticError(fileName, expression.location, `field ${JSON.stringify(field.name)} is private to class ${JSON.stringify(displayAssignableType(declaration.name, state))}`);
        }
        const memberAffinity = declaration.executorAffinity
          ? state.aggregateExecutorAffinities.get(declaration.name) ?? null
          : state.fieldExecutorAffinities.get(`${declaration.name}.${field.name}`) ?? null;
        requireMainExecutorContext(
          Boolean(memberAffinity),
          expression.location,
          `field ${JSON.stringify(`${declaration.name}.${field.name}`)}`,
          fileName,
          state,
          memberAffinity,
        );
        return field.type.name;
      }
      const method = declaration.methods.find((candidate) => candidate.name === expression.property);
      if (method) {
        throw new DiagnosticError(fileName, expression.location, "method values are not implemented; call the method instead");
      }
      throw new DiagnosticError(fileName, expression.location, `struct ${JSON.stringify(displayAssignableType(declaration.name, state))} has no member ${JSON.stringify(expression.property)}`);
    }
    case "call": {
      if (expression.callee.kind === "member" && expression.callee.optional) {
        return inferOptionalChain(
          expression,
          expression.callee,
          locals,
          globals,
          structs,
          enums,
          fileName,
          state,
          allowThrowingCall,
        );
      }
      const testExpectation = inferTestExpectationCall(
        expression,
        locals,
        globals,
        structs,
        enums,
        fileName,
        state,
      );
      if (testExpectation) return testExpectation;
      const testFailure = inferTestFailureCall(
        expression,
        locals,
        globals,
        structs,
        enums,
        fileName,
        state,
      );
      if (testFailure) return testFailure;
      if (expression.callee.kind === "identifier") {
        if (integerTypes.has(expression.callee.name)) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.arguments.length !== 1) {
            throw new DiagnosticError(
              fileName,
              expression.location,
              `${expression.callee.name} numeric construction expects exactly one integer value, received ${expression.arguments.length}`,
              {
                code: "Z0104",
                helps: [`use ${expression.callee.name}(value)`],
              },
            );
          }
          const targetType = expression.callee.name;
          const argument = expression.arguments[0];
          if (requireContextualSignedLiteral(argument, targetType, fileName, state.numericLiteralTypes)) {
            state.integerConversions.set(expression.location.offset, {
              sourceType: targetType,
              targetType,
              checked: false,
            });
            return targetType;
          }
          if (argument.kind === "number") {
            requireNumericLiteralFits(argument, targetType, fileName, state.numericLiteralTypes);
            state.integerConversions.set(expression.location.offset, {
              sourceType: targetType,
              targetType,
              checked: false,
            });
            return targetType;
          }
          const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
          const actualType = String(underlyingType(actual));
          const nativeEnum = state.foreignNamedTypes.get(actualType);
          const sourceType = nativeEnum?.kind === "enum"
            ? nativeEnum.underlying
            : canonicalType(actual, state.foreignNamedTypes);
          if (!isIntegerType(sourceType)) {
            throw new DiagnosticError(
              fileName,
              argument.location,
              `${targetType} numeric construction requires an integer value, found ${displayAssignableType(actual, state)}`,
              {
                code: "Z0104",
                notes: ["integer-to-floating and floating-to-integer conversion require a separate rounding and precision policy"],
              },
            );
          }
          const constant = constantIntegerValue(argument);
          const bounds = integerBounds(targetType)!;
          if (constant !== null && (constant < bounds.minimum || constant > bounds.maximum)) {
            throw new DiagnosticError(
              fileName,
              argument.location,
              `constant integer value ${constant} cannot convert to ${targetType}`,
              {
                code: "Z0104",
                notes: [`${targetType} represents values from ${bounds.minimum} through ${bounds.maximum}`],
                helps: ["choose a wider target type or use a value within the target range"],
              },
            );
          }
          state.integerConversions.set(expression.location.offset, {
            sourceType,
            ...(nativeEnum?.kind === "enum" ? { sourceDisplayType: actualType } : {}),
            targetType,
            checked: !integerRangeContains(targetType, sourceType),
          });
          return targetType;
        }
        if (floatTypes.has(expression.callee.name)) {
          throw new DiagnosticError(
            fileName,
            expression.location,
            `${expression.callee.name}(value) numeric conversion is not available in the integer-only conversion tier`,
            {
              code: "Z0104",
              notes: ["floating-point conversion needs explicit rounding, precision-loss, infinity, and NaN rules"],
            },
          );
        }
        const mutex = parseMutexType(expression.callee.name);
        if (mutex) {
          if (![...state.standardTypeBindings.values()].includes("Mutex")) {
            throw new DiagnosticError(fileName, expression.callee.location, "Mutex requires an explicit standard-library import", {
              code: "Z0501",
              helps: ["add `import { Mutex } from \"std/sync\";`"],
            });
          }
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.arguments.length !== 1) {
            throw new DiagnosticError(fileName, expression.location, "Mutex<T>(value) expects exactly one value");
          }
          if (
            mutex.valueType === "void"
            || containsViewType(mutex.valueType)
            || containsSliceType(mutex.valueType)
            || parseOnceType(mutex.valueType)
            || parseOnceLifetimeType(mutex.valueType)
            || parseMutexType(mutex.valueType)
            || parseTaskType(mutex.valueType)
            || containsForeignValueStorage(
              mutex.valueType,
              structs,
              enums,
              state.foreignNamedTypes,
            )
          ) {
            throw new DiagnosticError(fileName, expression.callee.location, `Mutex cannot own ${JSON.stringify(displayArrayType(mutex.valueType))} in the first synchronization tier`, {
              code: "Z0240",
              notes: ["a Mutex payload must be independently owned storage with no borrowed lifetime"],
            });
          }
          const argument = expression.arguments[0];
          const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
          requireAssignable(mutex.valueType, actual, argument, fileName, structs, enums, state);
          if (
            hasOwnershipType(actual, structs, enums, state)
            && isNamedStorageExpression(argument)
          ) {
            throw new DiagnosticError(fileName, argument.location, "initializing Mutex from an existing owner requires an explicit move", {
              code: "Z0218",
              helps: [`write \`Mutex(move ${storageRoot(argument)?.name ?? "value"})\``],
            });
          }
          consumeOwnedValue(argument, mutex.valueType, locals, structs, enums, fileName, state);
          state.mutexConstructors.set(expression.location.offset, mutex.valueType);
          return mutexTypeName(mutex.valueType);
        }
        const once = parseOnceType(expression.callee.name);
        if (once) {
          if (![...state.standardTypeBindings.values()].includes("Once")) {
            throw new DiagnosticError(fileName, expression.callee.location, "Once requires an explicit standard-library import", {
              code: "Z0501",
              helps: ["add `import { Once } from \"std/sync\";`"],
            });
          }
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.arguments.length !== 0) {
            throw new DiagnosticError(fileName, expression.location, "Once<T>() expects no values");
          }
          if (!state.analyzingModuleConstant) {
            throw new DiagnosticError(fileName, expression.location, "Once<T>() is a static-empty module initializer", {
              code: "Z0604",
              notes: ["the cell has one canonical module identity and cannot be copied into local storage"],
              helps: ["declare `const cell = Once<T>();` at module scope"],
            });
          }
          const stored = structs.get(once.valueType);
          if (stored?.kind !== "class" || !state.aggregateExecutorAffinities.has(once.valueType)) {
            throw new DiagnosticError(fileName, expression.callee.location, `Once<T> requires a class whose lifecycle belongs to thread.main in the first tier, found ${JSON.stringify(displayArrayType(once.valueType))}`, {
              code: "Z0604",
              notes: ["one-time initialization does not by itself make mutable identity safe to share across threads"],
              helps: ["declare the stored class with `on thread.main` or give it a main-bound field"],
            });
          }
          state.onceConstructors.set(expression.location.offset, once.valueType);
          return expression.callee.name;
        }
        const map = parseMapType(expression.callee.name);
        if (map) {
          if (![...state.standardTypeBindings.values()].includes("Map")) {
            throw new DiagnosticError(fileName, expression.callee.location, "Map requires an explicit standard-library import", {
              code: "Z0501",
              helps: ["add `import { Map } from \"std/collections\";`"],
            });
          }
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.arguments.length !== 0) {
            throw new DiagnosticError(fileName, expression.location, "Map<K, V>() expects no values");
          }
          validateCollectionKeyType("Map key", map.keyType, structs, enums, state, expression.callee.location, fileName);
          if (map.valueType === "void" || containsViewType(map.valueType) || containsSliceType(map.valueType) || map.valueType === "Arena" || parseTaskType(map.valueType)) {
            throw new DiagnosticError(fileName, expression.callee.location, `Map cannot own value type ${JSON.stringify(displayArrayType(map.valueType))} in the first collections tier`);
          }
          if (
            hasMoveOnlyForeignType(map.keyType, structs, enums, state.foreignNamedTypes)
          ) {
            throw new DiagnosticError(fileName, expression.callee.location, "Map keys cannot be move-only native C++ values", {
              code: "Z0240",
              helps: ["use a stable Z-owned identifier or readonly Hashable value as the key"],
            });
          }
          return expression.callee.name;
        }
        const set = parseSetType(expression.callee.name);
        if (set) {
          if (![...state.standardTypeBindings.values()].includes("Set")) {
            throw new DiagnosticError(fileName, expression.callee.location, "Set requires an explicit standard-library import", {
              code: "Z0501",
              helps: ["add `import { Set } from \"std/collections\";`"],
            });
          }
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.arguments.length !== 0) {
            throw new DiagnosticError(fileName, expression.location, "Set<T>() expects no values");
          }
          validateCollectionKeyType("Set element", set.elementType, structs, enums, state, expression.callee.location, fileName);
          return expression.callee.name;
        }
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
          requireAssignable("usize", actual, capacity, fileName, structs, enums, state);
          return standardType.type;
        }
        const aggregate = structs.get(expression.callee.name);
        if (aggregate) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (aggregate.kind === "class") {
            throw new DiagnosticError(fileName, expression.callee.location, `class construction requires new ${displayAssignableType(aggregate.name, state)}({ ... })`);
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
            if (owner.module === "objc") {
              if (expression.callee.property === "bind") {
                rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
                if (expression.arguments.length !== 2 || expression.arguments[1].kind !== "objectExpression") {
                  throw new DiagnosticError(fileName, expression.location, "objc.bind expects an Objective-C object and a protocol-binding object literal", {
                    code: "Z0810",
                    helps: [`use \`${localModuleName}.bind(tableView, { dataSource: controller, delegate: controller })\``],
                  });
                }
                const object = expression.arguments[0];
                const objectType = inferExpression(object, locals, globals, structs, enums, fileName, state);
                rejectNullableObjCReceiver(objectType, object.location, fileName, state);
                const receiver = objcReceiver(objectType, state);
                if (!receiver?.instance) {
                  throw new DiagnosticError(fileName, object.location, "objc.bind requires a non-null Objective-C instance", {
                    code: "Z0810",
                  });
                }
                const provided = new Set<string>();
                const bindings: ObjCBindingPlan["bindings"][number][] = [];
                for (const field of expression.arguments[1].fields) {
                  if (provided.has(field.name)) {
                    throw new DiagnosticError(fileName, field.location, `duplicate Objective-C protocol binding ${JSON.stringify(field.name)}`, {
                      code: "Z0810",
                    });
                  }
                  provided.add(field.name);
                  const property = findObjCProperty(receiver, field.name, state);
                  if (!property?.setter || property.protocols.length === 0) {
                    throw new DiagnosticError(fileName, field.location, `Objective-C ${receiver.declaration.className} property ${JSON.stringify(field.name)} is not a writable protocol property`, {
                      code: "Z0810",
                    });
                  }
                  if (property.ownership !== "weak") {
                    throw new DiagnosticError(fileName, field.location, `objc.bind currently requires a zeroing weak protocol property; ${receiver.declaration.className}.${field.name} is ${property.ownership}`, {
                      code: "Z0810",
                      notes: ["releasing an adapter behind assign or unsafeUnretained storage would leave a dangling native pointer"],
                      helps: ["use a zeroing weak protocol property, or keep an explicit native adapter alive until that property is cleared"],
                    });
                  }
                  if (field.expression.kind !== "identifier") {
                    throw new DiagnosticError(fileName, field.expression.location, "objc.bind protocol owners must be stored Z class bindings", {
                      code: "Z0810",
                      notes: ["the returned objc.Binding retains the controller and generated adapter for the native object's lifetime contract"],
                      helps: ["bind the class instance to const or let before calling objc.bind"],
                    });
                  }
                  const ownerType = inferExpression(field.expression, locals, globals, structs, enums, fileName, state);
                  const ownerClass = structs.get(String(underlyingType(ownerType)));
                  const conformance = ownerClass?.kind === "class"
                    ? state.objcProtocolConformances.get(ownerClass.name)
                    : null;
                  if (!ownerClass || ownerClass.kind !== "class" || !conformance) {
                    throw new DiagnosticError(fileName, field.expression.location, `${JSON.stringify(field.name)} requires a Z class implementing ${property.protocols.join(" & ")}`, {
                      code: "Z0810",
                    });
                  }
                  const missing = property.protocols.find((protocolName) => (
                    !conformance.protocols.some((protocol) => protocol.protocolName === protocolName)
                  ));
                  if (missing) {
                    throw new DiagnosticError(fileName, field.expression.location, `${ownerClass.name} does not implement Objective-C protocol ${missing}`, {
                      code: "Z0810",
                      helps: [`add \`${receiver.declaration.typeName.slice(0, receiver.declaration.typeName.lastIndexOf("."))}.${missing}\` to the class implements list`],
                    });
                  }
                  bindings.push({ property, ownerType: ownerClass.name, ownerExpression: field.expression });
                }
                if (bindings.length === 0) {
                  throw new DiagnosticError(fileName, expression.arguments[1].location, "objc.bind requires at least one protocol property", {
                    code: "Z0810",
                  });
                }
                state.objcBindingCalls.set(expression.location.offset, {
                  objectType: String(underlyingType(objectType)),
                  bindings,
                });
                state.expressionTypes.set(expression.location.offset, objcBindingTypeName);
                return objcBindingTypeName;
              }
              if (expression.callee.property !== "connect") {
                throw new DiagnosticError(fileName, expression.callee.location, `objc has no method ${JSON.stringify(expression.callee.property)}`, {
                  helps: [`use ${localModuleName}.connect(control, move () => operation()) or ${localModuleName}.bind(object, { delegate: controller })`],
                });
              }
              rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
              if (expression.arguments.length !== 2 || expression.arguments[1].kind !== "closure") {
                throw new DiagnosticError(fileName, expression.location, "objc.connect expects an Objective-C target/action object and one synchronous closure", {
                  code: "Z0811",
                  helps: [`use \`${localModuleName}.connect(control, move () => operation())\``],
                });
              }
              const control = expression.arguments[0];
              const controlType = inferExpression(control, locals, globals, structs, enums, fileName, state);
              rejectNullableObjCReceiver(controlType, control.location, fileName, state);
              const receiver = objcReceiver(controlType, state);
              if (!receiver?.instance
                || !findObjCProperty(receiver, "target", state)?.setter
                || !findObjCProperty(receiver, "action", state)?.setter) {
                throw new DiagnosticError(fileName, control.location, "objc.connect requires a non-null Objective-C object with writable target and action properties", {
                  code: "Z0811",
                  notes: ["the returned objc.Connection owns the object and operation while callbacks are active"],
                });
              }
              const operation = expression.arguments[1];
              const expectedFunction: FunctionType = { parameters: [], returnType: "void", errorType: null };
              const expectedType = functionTypeName([], "void");
              const controlExecutionContext: ClosureExecutionContext = executorAffinityForType(
                controlType,
                structs,
                enums,
                state,
              )?.executor === "main"
                ? "main"
                : "unknown";
              inferClosureExpression(
                operation,
                locals,
                globals,
                structs,
                enums,
                fileName,
                state,
                {
                  expectedFunction,
                  executionContext: controlExecutionContext,
                },
              );
              finalizeClosureFunctionValue(
                operation,
                expectedFunction,
                expectedType,
                locals,
                structs,
                enums,
                fileName,
                state,
              );
              state.objcConnectionCalls.add(expression.location.offset);
              state.expressionTypes.set(expression.location.offset, objcConnectionTypeName);
              return objcConnectionTypeName;
            }
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
              rejectLoopCarriedChildTask(expression.location, fileName, state, "native thread");
              if (expression.arguments.length !== 1 || expression.arguments[0].kind !== "closure") {
                throw new DiagnosticError(fileName, expression.location, "thread.spawn expects one closure", {
                  code: "Z0703",
                  helps: [`use \`${localModuleName}.spawn(move () => operation())\` or \`${localModuleName}.spawn(async move () => await operation())\``],
                });
              }
              const operation = expression.arguments[0];
              inferClosureExpression(operation, locals, globals, structs, enums, fileName, state, {
                oneShotOwnedCaptures: true,
                nativeThreadBody: true,
                executionContext: "unknown",
              });
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
                const capturedClass = structs.get(String(underlyingType(capture.type)));
                const executorBound = capturedClass?.kind === "class"
                  && state.aggregateExecutorAffinities.has(capturedClass.name);
                const transfer = executorBound
                  ? "executorBound"
                  : initialThreadTransferKind(capture.type, structs, enums, state);
                if (!transfer) {
                  const shareability = capturedClass?.kind === "class"
                    ? shareableTypeIssue(capturedClass.name, structs, enums, state)
                    : null;
                  const foreignIssue = foreignThreadTransferIssue(capture.type, state);
                  const mutexIssue = mutexThreadShareIssue(capture.type, structs, enums, state);
                  const issue = shareability ?? foreignIssue ?? mutexIssue;
                  const detail = issue ? `: ${issue.reason}` : " yet";
                  throw new DiagnosticError(fileName, capture.location, `capture ${JSON.stringify(capture.name)} of type ${displayAssignableType(capture.type, state)} cannot cross a native thread boundary${detail}`, {
                    code: "Z0704",
                    notes: [issue?.reason ?? "the current tier copies plain values, shares deeply readonly ARC identity, and moves supported Array, String, TextBuffer, and containing aggregate owners"],
                    helps: [issue?.help ?? "capture a transferable owned value, or keep this work on the inherited executor with `task`"],
                  });
                }
                if (transfer === "executorBound") {
                  const invalidUse = executorBoundCaptureUseOutsideMain(
                    operation.body,
                    capture.name,
                    false,
                    !capturedClass!.executorAffinity,
                  );
                  if (invalidUse) {
                    throw new DiagnosticError(
                      fileName,
                      invalidUse,
                      `main-isolated capture ${JSON.stringify(capture.name)} is only opaque while crossing a native thread boundary`,
                      {
                        code: "Z0704",
                        notes: [
                          `${capturedClass!.name} remains owned by thread.main; the worker may carry its identity but cannot access, copy, return, or escape it`,
                        ],
                        helps: [
                          `access ${JSON.stringify(capture.name)} only inside \`await on thread.main { ... }\` or \`task on thread.main { ... }\``,
                        ],
                      },
                    );
                  }
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
                if (transfer === "share" && errorClass?.kind === "class") {
                  state.threadSharedClassUses.set(errorClass.name, operation.errorType!.location);
                }
              }
              for (const { capture, kind } of captureTransfers) {
                const capturedClass = structs.get(String(underlyingType(capture.type)));
                if (kind === "share" && capturedClass?.kind === "class") {
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
              state.threadSpawnCaptureTransfers.set(
                expression.location.offset,
                captureTransfers.map(({ kind }) => kind),
              );
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
                declaration.errorType?.name ?? null,
              ),
            );
            checkArguments(declaration, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
            registerAsyncCall(declaration, expression.location, fileName, state);
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
          const nativeText = foreignPointer(actual, state);
          if (nativeText?.stringView) {
            if (nativeText.nullable) {
              throw new DiagnosticError(fileName, expression.arguments[0].location, "nullable native text must be checked before copying it into String", {
                helps: ["compare the view with `null`; the non-null branch narrows it automatically"],
              });
            }
          } else {
            requireAssignable("cstring", actual, expression.arguments[0], fileName, structs, enums, state);
          }
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
            const staticAffinity = aggregate.executorAffinity
              ? state.aggregateExecutorAffinities.get(aggregate.name) ?? null
              : null;
            requireMainExecutorContext(
              Boolean(callable.executorAffinity) || Boolean(staticAffinity),
              expression.location,
              `static method ${JSON.stringify(aggregate.name)}.${JSON.stringify(callable.name)}`,
              fileName,
              state,
              staticAffinity,
            );
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
                const expectedDisplay = expectedPointer
                  ? state.typeDisplayNames.get(pointerTypeName(expectedPointer.identity, expectedPointer.ownership, true))
                  : null;
                const expected = expectedDisplay
                  ?? (expectedPointer ? `${expectedPointer.cName} | null` : `${option.target} | null`);
                throw new DiagnosticError(
                  fileName,
                  argument.location,
                  `Option.fromNullable requires ${expected}, found ${describeValueType(actual, state)}`,
                );
              }
              state.optionFromNullable.add(expression.location.offset);
              return enumDeclaration.name;
            }
            const declaredVariant = enumDeclaration.variants.find((candidate) => candidate.name === expression.callee.property);
            if (!declaredVariant) throw new DiagnosticError(fileName, expression.callee.location, `enum ${JSON.stringify(enumDeclaration.name)} has no variant ${JSON.stringify(expression.callee.property)}`);
            const variant = resolveSemanticEnumVariant(expression.location, enumDeclaration, declaredVariant, state);
            const expectedCount = variant.payload ? 1 : 0;
            if (expression.arguments.length !== expectedCount) throw new DiagnosticError(fileName, expression.location, `variant ${JSON.stringify(variant.name)} expects ${expectedCount} argument(s)`);
            if (variant.payload) {
              const argument = expression.arguments[0];
              const payloadView = parseViewType(variant.payload.name);
              if (payloadView) {
                validateReceiverViewProjection(argument, enumDeclaration.name, payloadView.target, locals, globals, structs, enums, fileName, state);
                return enumDeclaration.name;
              }
              const actual = argument.kind === "objectExpression"
                ? inferContextualObjectExpression(argument, variant.payload.name, locals, globals, structs, enums, fileName, state)
                : inferExpression(argument, locals, globals, structs, enums, fileName, state);
              rejectBorrowedNativeResourceEscape(
                actual,
                argument,
                locals,
                fileName,
                state,
                "stored in an enum payload",
              );
              requireAssignable(variant.payload.name, actual, expression.arguments[0], fileName, structs, enums, state);
              consumeOwnedValue(expression.arguments[0], variant.payload.name, locals, structs, enums, fileName, state);
            }
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
              allowThrowingCall,
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
        const mutex = parseMutexType(receiverValueType);
        if (mutex) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.callee.property !== "withLock") {
            throw new DiagnosticError(fileName, expression.callee.location, `Mutex has no method ${JSON.stringify(expression.callee.property)}`);
          }
          if (!isNamedStorageExpression(expression.callee.object)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "Mutex.withLock requires stable named storage", {
              code: "Z0211",
              notes: ["the blocking operation borrows one address-stable mutex for the complete callback"],
              helps: ["bind the Mutex before calling withLock"],
            });
          }
          const lockRoot = namedStoragePath(expression.callee.object);
          const existingLock = lockRoot ? state.activeMutexLockRoots.get(lockRoot) : null;
          if (lockRoot && existingLock) {
            throw new DiagnosticError(fileName, expression.location, `Mutex.withLock cannot recursively acquire ${JSON.stringify(lockRoot)}`, {
              code: "Z0211",
              labels: [{ location: existingLock, message: "the same mutex is already held here" }],
              notes: ["Mutex<T> is deliberately non-reentrant; a second acquisition on the same OS thread would deadlock"],
              helps: ["reuse the protected closure parameter, or finish the outer withLock before acquiring this mutex again"],
            });
          }
          if (expression.arguments.length !== 1 || expression.arguments[0].kind !== "closure") {
            throw new DiagnosticError(fileName, expression.location, "Mutex.withLock expects one inline closure", {
              code: "Z0215",
              helps: ["write `mutex.withLock((in value) => expression)` or `mutex.withLock((inout value): void => { ... })`"],
            });
          }
          const callback = expression.arguments[0];
          if (callback.async) {
            throw new DiagnosticError(fileName, callback.location, "Mutex.withLock requires a synchronous closure that cannot suspend", {
              code: "Z0703",
              notes: ["withLock blocks the current OS thread and releases the mutex when the callback returns or throws"],
              helps: ["finish protected access before awaiting, or use a future scheduler-aware AsyncMutex"],
            });
          }
          if (callback.parameters.length !== 1) {
            throw new DiagnosticError(fileName, callback.location, `Mutex.withLock expects one closure parameter, found ${callback.parameters.length}`);
          }
          const parameter = callback.parameters[0];
          if (parameter.mode !== "in" && parameter.mode !== "inout") {
            throw new DiagnosticError(fileName, parameter.location, "Mutex.withLock closure parameters require `in` or `inout`", {
              code: "Z0215",
              notes: ["`in` exposes read-only protected storage; `inout` permits mutation while the same exclusive mutex is held"],
              helps: [`write \`(${parameter.name === "" ? "in value" : `in ${parameter.name}`})\` or \`(${parameter.name === "" ? "inout value" : `inout ${parameter.name}`})\``],
            });
          }
          if (callback.returnType && containsViewType(callback.returnType.name)) {
            throw new DiagnosticError(fileName, callback.returnType.location, "a borrowed view cannot escape Mutex.withLock", {
              code: "Z0206",
              notes: ["the protected borrow ends before withLock returns"],
              helps: ["return an independently owned `copy` or a cleanup-free value"],
            });
          }
          const contextualParameter = parameter.type
            ? parameter
            : { ...parameter, type: { name: mutex.valueType, location: parameter.location } };
          const contextualCallback = {
            ...callback,
            parameters: [contextualParameter],
          };
          if (lockRoot) state.activeMutexLockRoots.set(lockRoot, expression.location);
          try {
            inferClosureExpression(
              contextualCallback,
              locals,
              globals,
              structs,
              enums,
              fileName,
              state,
              {
                transientBorrow: true,
                executionContext: "inherit",
              },
            );
          } finally {
            if (lockRoot) state.activeMutexLockRoots.delete(lockRoot);
          }
          const closure = state.closures.get(callback.location.offset)!;
          const functionType = closureFunctionType(closure);
          if (functionType.parameters[0]?.mode !== parameter.mode || functionType.parameters[0]?.type !== mutex.valueType) {
            throw new DiagnosticError(fileName, parameter.location, `Mutex.withLock expected ${parameter.mode} ${displayArrayType(mutex.valueType)}, found ${displayFunctionType(functionTypeName(functionType.parameters, functionType.returnType, functionType.errorType))}`);
          }
          if (containsViewType(functionType.returnType) || containsSliceType(functionType.returnType)) {
            throw new DiagnosticError(fileName, callback.returnType?.location ?? callback.location, "a borrowed value cannot escape Mutex.withLock", {
              code: "Z0206",
              notes: ["the protected borrow ends before withLock returns"],
              helps: ["return an independently owned `copy` or a cleanup-free value"],
            });
          }
          const callableType = functionTypeName(functionType.parameters, functionType.returnType, functionType.errorType);
          finalizeClosureFunctionValue(
            callback,
            functionType,
            callableType,
            locals,
            structs,
            enums,
            fileName,
            state,
            true,
          );
          if (functionType.errorType && !allowThrowingCall) {
            throw new DiagnosticError(fileName, expression.location, "throwing Mutex.withLock requires `attempt` or `try`", {
              code: "Z0301",
              notes: ["the mutex is unlocked before the typed error propagates"],
            });
          }
          state.mutexWithLockCalls.set(expression.location.offset, {
            valueType: mutex.valueType,
            access: parameter.mode,
            closureOffset: callback.location.offset,
            functionType: callableType,
            returnType: functionType.returnType,
            errorType: functionType.errorType,
          });
          return functionType.errorType
            ? resultTypeName(functionType.returnType, functionType.errorType)
            : functionType.returnType;
        }
        const once = parseOnceType(receiverValueType);
        if (once) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (!isNamedStorageExpression(expression.callee.object)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "Once methods require a named module cell");
          }
          if (expression.callee.property === "get") {
            if (expression.arguments.length !== 0) {
              throw new DiagnosticError(fileName, expression.location, `Once.get expects 0 arguments, received ${expression.arguments.length}`);
            }
            state.onceGetCalls.set(expression.location.offset, once.valueType);
            return once.valueType;
          }
          if (expression.callee.property === "initialize") {
            requireMainExecutorContext(
              true,
              expression.location,
              `Once<${displayArrayType(once.valueType)}> initialization`,
              fileName,
              state,
              {
                executor: "main",
                declared: false,
                originType: once.valueType,
                fieldPath: [],
              },
            );
            if (expression.arguments.length !== 1) {
              throw new DiagnosticError(fileName, expression.location, `Once.initialize expects 1 argument, received ${expression.arguments.length}`);
            }
            const argument = expression.arguments[0];
            const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
            requireAssignable(
              once.valueType,
              actual,
              argument,
              fileName,
              structs,
              enums,
              state,
            );
            if (isNamedStorageExpression(argument)) {
              throw new DiagnosticError(fileName, argument.location, "initializing Once from an existing owner requires an explicit move", {
                code: "Z0218",
                helps: [`write \`initialize(move ${storageRoot(argument)?.name ?? "value"})\``],
              });
            }
            if (argument.kind !== "unary" || argument.operator !== "move") {
              consumeOwnedValue(argument, actual, locals, structs, enums, fileName, state);
            }
            state.onceInitializeCalls.set(expression.location.offset, once.valueType);
            return onceLifetimeTypeName(once.valueType);
          }
          throw new DiagnosticError(fileName, expression.callee.location, `Once has no method ${JSON.stringify(expression.callee.property)}`);
        }
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
            throw new DiagnosticError(fileName, expression.location, "Task.cancel cannot be started as another task", {
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
        const asyncGenerator = parseAsyncGeneratorType(receiverValueType);
        if (asyncGenerator) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.callee.property !== "next") {
            throw new DiagnosticError(fileName, expression.callee.location, `AsyncGenerator has no method ${JSON.stringify(expression.callee.property)}`);
          }
          if (expression.arguments.length !== 0) {
            throw new DiagnosticError(fileName, expression.location, `"next" expects 0 arguments, received ${expression.arguments.length}`);
          }
          const root = storageRoot(expression.callee.object);
          if (!root || !locals.has(root.name)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "AsyncGenerator.next requires a named generator handle");
          }
          const context = state.asyncCallContexts.at(-1);
          if (!state.activeFunction?.async || !context) {
            throw new DiagnosticError(fileName, expression.location, "AsyncGenerator.next requires direct await", {
              code: "Z0702",
              helps: ["write `await generator.next()` inside an async function"],
            });
          }
          if (context.mode === "spawn") {
            throw new DiagnosticError(fileName, expression.location, "starting AsyncGenerator.next as a task is deferred until concurrent advancement is statically excluded", {
              code: "Z0703",
              helps: ["advance the stream with direct `await generator.next()`"],
            });
          }
          context.calls += 1;
          const success = asyncGenerator.returnType
            ? generatorStepTypeName(asyncGenerator.elementType, asyncGenerator.returnType)
            : optionTypeName(asyncGenerator.elementType);
          return taskTypeName(success, asyncGenerator.errorType);
        }
        if (receiverValueType === "TaskControl") {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.callee.property !== "requestCancel") {
            throw new DiagnosticError(fileName, expression.callee.location, `TaskControl has no method ${JSON.stringify(expression.callee.property)}`);
          }
          if (expression.arguments.length !== 0) {
            throw new DiagnosticError(fileName, expression.location, `TaskControl.requestCancel expects 0 arguments, received ${expression.arguments.length}`);
          }
          if (!isNamedStorageExpression(expression.callee.object)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "TaskControl.requestCancel requires a named control handle");
          }
          return "boolean";
        }
        if (
          receiverValueType === fsLockTypeName
          || receiverValueType === "fs.Lock"
        ) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.callee.property !== "unlock") {
            throw new DiagnosticError(
              fileName,
              expression.callee.location,
              `fs.Lock has no method ${JSON.stringify(expression.callee.property)}`,
            );
          }
          if (expression.arguments.length !== 0) {
            throw new DiagnosticError(
              fileName,
              expression.location,
              `fs.Lock.unlock expects 0 arguments, received ${expression.arguments.length}`,
            );
          }
          if (expression.callee.object.kind !== "identifier") {
            throw new DiagnosticError(
              fileName,
              expression.callee.object.location,
              "fs.Lock.unlock currently requires a directly named lock owner",
            );
          }
          consumeOwnedValue(
            expression.callee.object,
            receiverType,
            locals,
            structs,
            enums,
            fileName,
            state,
          );
          return "void";
        }
        if (receiverValueType === "TaskScope") {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.callee.object.kind !== "identifier") {
            throw new DiagnosticError(fileName, expression.callee.object.location, "TaskScope methods require a named scope handle");
          }
          const method = expression.callee.property;
          if (method === "schedule") {
            if (expression.arguments.length !== 2 || expression.arguments[1].kind !== "closure") {
              throw new DiagnosticError(fileName, expression.location, "TaskScope.schedule expects an executor and one closure", {
                code: "Z0710",
                helps: [
                  "use `scope.schedule(thread.main, move () => operation())`",
                  "or `scope.schedule(thread.main, async move (): void => { await operation(); })`",
                ],
              });
            }
            const executor = inferExpression(expression.arguments[0], locals, globals, structs, enums, fileName, state);
            if (executor !== "__z_executor:main") {
              throw new DiagnosticError(fileName, expression.arguments[0].location, "TaskScope.schedule currently requires thread.main", {
                code: "Z0710",
                notes: ["additional explicit executor capabilities remain a standard-library extension point"],
              });
            }
            const operation = expression.arguments[1];
            const expectedFunction: FunctionType = { parameters: [], returnType: "void", errorType: null };
            const expectedType = functionTypeName([], "void");
            if (operation.async && operation.errorType) {
              throw new DiagnosticError(fileName, operation.errorType.location, "TaskScope.schedule async operations cannot throw", {
                code: "Z0710",
                notes: ["a synchronous submitter has no task result through which to receive an unhandled error"],
                helps: ["handle fallible work locally with `attempt await`"],
              });
            }
            inferClosureExpression(
              operation,
              locals,
              globals,
              structs,
              enums,
              fileName,
              state,
              {
                expectedFunction,
                oneShotOwnedCaptures: operation.async,
                scheduledAsyncBody: operation.async,
                executionContext: "main",
              },
            );
            const closure = operation.async
              ? state.closures.get(operation.location.offset)!
              : finalizeClosureFunctionValue(
                  operation,
                  expectedFunction,
                  expectedType,
                  locals,
                  structs,
                  enums,
                  fileName,
                  state,
                );
            if (closure.captures.length > 0 && operation.captureMode !== "move") {
              throw new DiagnosticError(fileName, operation.location, "TaskScope.schedule requires `move` for a capturing closure", {
                code: "Z0704",
                notes: ["accepted work may execute after the submitting callback returns"],
                helps: ["write `move () => operation()`"],
              });
            }
            for (const capture of closure.captures) {
              const issue = shareableTypeIssue(capture.type, structs, enums, state);
              const affinity = executorAffinityForType(capture.type, structs, enums, state);
              const remainsOnMain = affinity?.executor === "main" && state.executorContext === "main";
              if (issue && !remainsOnMain) {
                throw new DiagnosticError(
                  fileName,
                  capture.location,
                  `capture ${JSON.stringify(capture.name)} of type ${JSON.stringify(capture.type)} cannot cross to the scope executor: ${issue.reason}`,
                  {
                    code: "Z0704",
                    helps: [issue.help],
                  },
                );
              }
            }
            if (operation.async) {
              for (const capture of closure.captures) {
                if (
                  capture.type === "TaskScope"
                  || capture.type === "TaskControl"
                  || structs.get(String(underlyingType(capture.type)))?.kind === "class"
                  || !hasOwnershipType(capture.type, structs, enums, state)
                ) {
                  continue;
                }
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
              state.taskScopeAsyncCalls.set(expression.location.offset, operation.location.offset);
            } else {
              state.closures.set(operation.location.offset, { ...closure, threadSafe: true });
              state.taskScopeSpawnCalls.set(expression.location.offset, operation.location.offset);
            }
            return "TaskControl";
          }
          if (method !== "close" && method !== "cancel") {
            throw new DiagnosticError(fileName, expression.callee.location, `TaskScope has no method ${JSON.stringify(method)}`);
          }
          if (expression.arguments.length !== 0) {
            throw new DiagnosticError(fileName, expression.location, `TaskScope.${method} expects 0 arguments, received ${expression.arguments.length}`);
          }
          const context = state.asyncCallContexts.at(-1);
          if (!state.activeFunction?.async || !context || context.mode !== "await") {
            throw new DiagnosticError(fileName, expression.location, `TaskScope.${method} requires direct await`, {
              code: "Z0702",
              helps: [`write \`await scope.${method}()\` inside an async function`],
            });
          }
          context.calls += 1;
          return taskTypeName("void", null);
        }
        const generator = parseGeneratorType(receiverValueType);
        if (generator) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.callee.property !== "next") {
            throw new DiagnosticError(fileName, expression.callee.location, `Generator has no method ${JSON.stringify(expression.callee.property)}`);
          }
          if (expression.arguments.length !== 0) {
            throw new DiagnosticError(fileName, expression.location, `"next" expects 0 arguments, received ${expression.arguments.length}`);
          }
          const root = storageRoot(expression.callee.object);
          if (!root || !locals.has(root.name)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "Generator.next requires a named generator handle");
          }
          const success = generator.returnType
            ? generatorStepTypeName(generator.elementType, generator.returnType)
            : optionTypeName(generator.elementType);
          if (generator.errorType) {
            if (!allowThrowingCall) {
              throw new DiagnosticError(fileName, expression.location, "advancing a throwing generator requires `attempt` or `try`", {
                helps: ["write `try generator.next()` to propagate the error, or `attempt generator.next()` to inspect it"],
              });
            }
            return resultTypeName(success, generator.errorType);
          }
          return success;
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
          state.viewCallOrigins.set(
            expression.location.offset,
            directViewOrigin(root.name, expression.callee.object.location),
          );
          return viewTypeName(actual);
        }
        if (receiverValueType === "Hasher") {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          if (expression.callee.property !== "add") {
            throw new DiagnosticError(fileName, expression.callee.location, `Hasher has no method ${JSON.stringify(expression.callee.property)}`);
          }
          const root = storageRoot(expression.callee.object);
          const stored = root ? locals.get(root.name) : null;
          if (!root || !stored || !isMutableBinding(stored)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "Hasher.add requires mutable hasher storage", {
              code: "Z0205",
              helps: ["receive the hasher as `inout hasher: Hasher`"],
            });
          }
          if (expression.arguments.length !== 1) {
            throw new DiagnosticError(fileName, expression.location, `"add" expects 1 argument, received ${expression.arguments.length}`);
          }
          const argument = expression.arguments[0];
          const actual = String(underlyingType(inferExpression(argument, locals, globals, structs, enums, fileName, state)));
          const payloadFreeEnum = enums.get(actual)?.variants.every((variant) => variant.payload === null) ?? false;
          const nativeEnum = state.foreignNamedTypes.get(actual)?.kind === "enum";
          const customHashable = structs.get(actual)?.implements.some((trait) => trait.name === "Hashable") ?? false;
          if (!integerTypes.has(actual) && actual !== "boolean" && actual !== "String" && !payloadFreeEnum && !nativeEnum && !customHashable) {
            throw new DiagnosticError(fileName, argument.location, `Hasher.add cannot hash ${JSON.stringify(displayArrayType(actual))}`, {
              code: "Z0401",
              helps: ["add a supported scalar, String, enum, or another Hashable value"],
            });
          }
          if (customHashable && !storageRoot(argument) && argument.kind !== "structExpression") {
            throw new DiagnosticError(fileName, argument.location, "Hasher.add requires addressable storage for a nested Hashable value in the first tier", {
              code: "Z0401",
              helps: ["bind the nested value before feeding it into the hasher"],
            });
          }
          state.hasherAddTypes.set(expression.location.offset, actual);
          return "void";
        }
        const map = parseMapType(receiverValueType);
        if (map) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          const root = storageRoot(expression.callee.object);
          const stored = root ? locals.get(root.name) : null;
          if (!root || !stored) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "Map methods require named storage");
          }
          const method = expression.callee.property;
          if (!["has", "get", "set", "remove", "delete", "clear"].includes(method)) {
            throw new DiagnosticError(fileName, expression.callee.location, `Map has no method ${JSON.stringify(method)}`);
          }
          const mutable = method === "set" || method === "remove" || method === "delete" || method === "clear";
          if (mutable) {
            rejectCollectionMutationWhileIterating("Map", root.name, method, expression.callee.location, fileName, state);
            const readonlyField = readonlyFieldOnPath(expression.callee.object, structs, state);
            if (readonlyField) {
              throw new DiagnosticError(fileName, expression.callee.object.location, `cannot mutate Map through readonly field ${JSON.stringify(readonlyField.name)}`, {
                code: "Z0214",
              });
            }
            if (!isMutableBinding(stored)) {
              throw new DiagnosticError(fileName, expression.callee.object.location, `Map.${method} requires addressable let storage`, {
                code: "Z0205",
                helps: ["bind the Map with `let`"],
              });
            }
            rejectOwnerMutationWhileViewed(root.name, expression.callee.object.location, fileName, state, method);
          }
          if (method === "clear") {
            if (expression.arguments.length !== 0) {
              throw new DiagnosticError(fileName, expression.location, `"clear" expects 0 arguments, received ${expression.arguments.length}`);
            }
            return "void";
          }
          const expectedArguments = method === "set" ? 2 : 1;
          if (expression.arguments.length !== expectedArguments) {
            throw new DiagnosticError(fileName, expression.location, `${JSON.stringify(method)} expects ${expectedArguments} argument(s), received ${expression.arguments.length}`);
          }
          const key = expression.arguments[0];
          const actualKey = inferExpression(key, locals, globals, structs, enums, fileName, state);
          requireAssignable(map.keyType, actualKey, key, fileName, structs, enums, state);
          if (method === "has" || method === "delete") return "boolean";
          if (method === "get") {
            if (mapValueHasReferenceIdentity(map.valueType, structs, state)) {
              return optionTypeName(map.valueType);
            }
            state.viewCallOrigins.set(
              expression.location.offset,
              viewOriginForRoot(root.name, expression.callee.object.location, state),
            );
            return optionTypeName(viewTypeName(map.valueType));
          }
          if (method === "set") {
            const value = expression.arguments[1];
            const actualValue = inferExpression(value, locals, globals, structs, enums, fileName, state);
            requireAssignable(map.valueType, actualValue, value, fileName, structs, enums, state);
            consumeOwnedValue(key, map.keyType, locals, structs, enums, fileName, state);
            consumeOwnedValue(value, map.valueType, locals, structs, enums, fileName, state);
            state.dynamicArrayPushTypes.add(dynamicArrayTypeName(mapEntryTypeName(map.keyType, map.valueType)));
            return "void";
          }
          return optionTypeName(map.valueType);
        }
        const set = parseSetType(receiverValueType);
        if (set) {
          rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
          const root = storageRoot(expression.callee.object);
          const stored = root ? locals.get(root.name) : null;
          if (!root || !stored) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "Set methods require named storage");
          }
          const method = expression.callee.property;
          if (!["has", "add", "remove", "delete", "clear"].includes(method)) {
            throw new DiagnosticError(fileName, expression.callee.location, `Set has no method ${JSON.stringify(method)}`);
          }
          const mutable = method === "add" || method === "remove" || method === "delete" || method === "clear";
          if (mutable) {
            rejectCollectionMutationWhileIterating("Set", root.name, method, expression.callee.location, fileName, state);
            const readonlyField = readonlyFieldOnPath(expression.callee.object, structs, state);
            if (readonlyField) {
              throw new DiagnosticError(fileName, expression.callee.object.location, `cannot mutate Set through readonly field ${JSON.stringify(readonlyField.name)}`, {
                code: "Z0214",
              });
            }
            if (!isMutableBinding(stored)) {
              throw new DiagnosticError(fileName, expression.callee.object.location, `Set.${method} requires addressable let storage`, {
                code: "Z0205",
                helps: ["bind the Set with `let`"],
              });
            }
          }
          if (method === "clear") {
            if (expression.arguments.length !== 0) {
              throw new DiagnosticError(fileName, expression.location, `"clear" expects 0 arguments, received ${expression.arguments.length}`);
            }
            return "void";
          }
          if (expression.arguments.length !== 1) {
            throw new DiagnosticError(fileName, expression.location, `${JSON.stringify(method)} expects 1 argument, received ${expression.arguments.length}`);
          }
          const value = expression.arguments[0];
          const actual = inferExpression(value, locals, globals, structs, enums, fileName, state);
          requireAssignable(set.elementType, actual, value, fileName, structs, enums, state);
          if (method === "add") {
            consumeOwnedValue(value, set.elementType, locals, structs, enums, fileName, state);
            state.dynamicArrayPushTypes.add(dynamicArrayTypeName(set.elementType));
            return "boolean";
          }
          if (method === "has" || method === "delete") return "boolean";
          return optionTypeName(set.elementType);
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
              structs,
              enums,
              state,
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
              structs,
              enums,
              state,
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
          requireAssignable(dynamic.elementType, actual, expression.arguments[0], fileName, structs, enums, state);
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
          const selection = findObjCMethod(
            objcReceiverType,
            expression.callee.property,
            expression.arguments.length,
            expression.argumentLabels,
            state,
            fileName,
            expression.callee.location,
          );
          const method = selection.method;
          requireMainExecutorContext(
            foreignInterfaceRequiresMain(objcReceiverType.declaration, state)
              || method.metadata.executorAffinity === "main",
            expression.location,
            `Objective-C method ${JSON.stringify(objcReceiverType.declaration.className)}.${JSON.stringify(method.selector)}`,
            fileName,
            state,
          );
          checkForeignAvailability(method.metadata, method.selector, expression.callee.location, fileName, state);
          const checkedMethod = selection.projected
            ? {
                ...method,
                parameters: method.parameters.filter((_, index) => index !== method.asyncCallbackParameter),
              }
            : method;
          checkObjCArguments(checkedMethod, expression.arguments, locals, globals, structs, enums, fileName, state);
          let asyncProjection: ObjCCallInfo["async"] = null;
          if (selection.projected) {
            const callback = method.parameters[method.asyncCallbackParameter!].type;
            if (callback.kind !== "block") {
              throw new DiagnosticError(fileName, expression.location, "invalid async Objective-C projection metadata", { code: "Z0801" });
            }
            const result = method.asyncResultParameter === null
              ? "void"
              : String(foreignValueType(callback.parameters[method.asyncResultParameter]));
            if (
              result === "unknown"
              || (result !== "void" && result !== "boolean" && !integerTypes.has(result) && !floatTypes.has(result))
            ) {
              throw new DiagnosticError(
                fileName,
                expression.location,
                `the first executable async Objective-C projection tier requires a scalar callback value, found ${displayArrayType(result)}`,
                {
                  code: "Z0700",
                  helps: ["use the raw callback overload while ownership-bearing async payload frames are implemented"],
                },
              );
            }
            const context = state.asyncCallContexts.at(-1);
            if (!state.activeFunction?.async || !context) {
              throw new DiagnosticError(fileName, expression.location, `async call to ${JSON.stringify(method.baseName)} requires \`await\` or \`task\``, {
                code: "Z0702",
                notes: ["Z never starts asynchronous work from a naked function call"],
                helps: ["use `await` for sequential work or `task` for concurrent work in an async function"],
              });
            }
            let errorType: string | null = null;
            if (method.asyncErrorParameter !== null) {
              const nativeError = callback.parameters[method.asyncErrorParameter];
              if (nativeError.kind !== "object" || !nativeError.nullable) {
                throw new DiagnosticError(fileName, expression.location, "invalid typed async Objective-C error projection metadata", { code: "Z0801" });
              }
              errorType = publicObjCTypeName(nativeError.typeName);
              if (!allowThrowingCall) {
                throw new DiagnosticError(fileName, expression.location, "throwing async native call requires `attempt` or `try`", {
                  code: "Z0701",
                  helps: ["write `try await` to propagate the error, or `attempt await` to inspect Result<T, E>"],
                });
              }
            }
            context.calls += 1;
            asyncProjection = {
              callbackParameter: method.asyncCallbackParameter!,
              resultType: result,
              errorType,
              parameterTypes: checkedMethod.parameters.map((parameter) => String(foreignValueType(parameter.type))),
              method,
            };
          }
          state.objcCalls.set(expression.location.offset, {
            selector: method.selector,
            instance: method.instance,
            className: objcReceiverType.declaration.className,
            async: asyncProjection,
          });
          if (selection.projected) {
            state.foreignCallTypes.set(expression.location.offset, asyncProjection!.resultType);
            return asyncProjection!.errorType
              ? resultTypeName(asyncProjection!.resultType, asyncProjection!.errorType)
              : asyncProjection!.resultType;
          }
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
          requireMainExecutorContext(
            foreignValue.metadata.executorAffinity === "main",
            expression.location,
            `native type ${JSON.stringify(foreignValue.qualifiedName)}`,
            fileName,
            state,
          );
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
            allowThrowingCall,
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
        const declaredField = declaration?.fields.find((candidate) => candidate.name === expression.callee.property);
        const field = declaration && declaredField
          ? resolveSemanticField(expression.callee.location, declaration, declaredField, state)
          : null;
        const fieldFunctionType = field ? parseFunctionType(field.type.name) : null;
        if (declaration && field && fieldFunctionType) {
          if (field.visibility === "private" && state.activeReceiver !== declaration.name) {
            throw new DiagnosticError(fileName, expression.callee.location, `field ${JSON.stringify(field.name)} is private to class ${JSON.stringify(declaration.name)}`);
          }
          if (hasOwnershipType(receiverType, structs, enums, state) && !isNamedStorageExpression(expression.callee.object)) {
            throw new DiagnosticError(fileName, expression.callee.object.location, "a cleanup-bearing temporary must be bound before calling one of its function fields");
          }
          const fieldAffinity = declaration.executorAffinity
            ? state.aggregateExecutorAffinities.get(declaration.name) ?? null
            : state.fieldExecutorAffinities.get(`${declaration.name}.${field.name}`) ?? null;
          requireMainExecutorContext(
            Boolean(fieldAffinity),
            expression.location,
            `function field ${JSON.stringify(`${declaration.name}.${field.name}`)}`,
            fileName,
            state,
            fieldAffinity,
          );
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
          if (fieldFunctionType.errorType) {
            if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
            return resultTypeName(fieldFunctionType.returnType, fieldFunctionType.errorType);
          }
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
        const methodAffinity = declaration.executorAffinity
          ? state.aggregateExecutorAffinities.get(declaration.name) ?? null
          : null;
        requireMainExecutorContext(
          Boolean(callable.executorAffinity) || Boolean(methodAffinity),
          expression.location,
          `method ${JSON.stringify(declaration.name)}.${JSON.stringify(callable.name)}`,
          fileName,
          state,
          methodAffinity,
        );
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
          state.viewCallOrigins.set(
            expression.location.offset,
            viewOriginForRoot(root.name, expression.callee.object.location, state),
          );
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
          if (functionType.errorType) {
            if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
            return resultTypeName(functionType.returnType, functionType.errorType);
          }
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
      if (target?.kind === "testExpect") {
        throw new DiagnosticError(fileName, expression.location, "expect must be completed with a matcher", {
          code: "Z0901",
          helps: ["use `expect(value).toEqual(expected)`"],
        });
      }
      if (target?.kind === "testFail") {
        throw new DiagnosticError(fileName, expression.location, "fail expects one String message", {
          code: "Z0901",
          helps: ['use `fail("reason")`'],
        });
      }
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
            target.declaration.errorType?.name ?? null,
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
          allowThrowingCall,
        );
      }
      if (target?.kind !== "function") {
        throw new DiagnosticError(fileName, expression.callee.location, `unknown function ${JSON.stringify(expression.callee.name)}`);
      }
      const functionResolution = { location: expression.location, declaration: target.declaration };
      const callable = state.observer?.resolveFunctionCall?.(functionResolution) ?? target.declaration;
      requireMainExecutorContext(
        Boolean(callable.executorAffinity),
        expression.location,
        `function ${JSON.stringify(callable.name)}`,
        fileName,
        state,
      );
      rejectLabeledArguments(expression.argumentLabels, expression.location, fileName);
      checkArguments(callable, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
      registerAsyncCall(callable, expression.location, fileName, state);
      state.observer?.onFunctionCall?.(functionResolution);
      if (
        callable.errorType
        && !isGeneratorFunction(callable)
        && !isAsyncGeneratorFunction(callable)
      ) {
        if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
        return resultTypeName(callable.returnType.name, callable.errorType.name);
      }
      if (parseReceiverViewReturnType(callable.returnType.name)) {
        const origin = parameterViewCallOrigin(
          callable,
          expression.arguments,
          locals,
          fileName,
          state,
        );
        if (origin) state.viewCallOrigins.set(expression.location.offset, origin);
      }
      return callable.returnType.name;
    }
  }
}

function mapValueHasReferenceIdentity(
  type: string,
  structs: ReadonlyMap<string, StructDeclaration>,
  state: AnalysisState,
): boolean {
  return structs.get(type)?.kind === "class" || state.foreignNamedTypes.get(type)?.kind === "object";
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
    {
      kind: "structExpression",
      typeName: expectedType,
      fields: expression.fields,
      spread: expression.spread,
      location: expression.location,
    },
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
    if (state.unsafeDepth > 0 && containsUnsafeUnverifiedValue(argument, state)) {
      throw new DiagnosticError(fileName, argument.location, "an unsafe native value cannot cross an ordinary Z call boundary", {
        code: "Z0822",
        notes: ["an arbitrary Z callee could return, store, or otherwise extend the locally asserted native lifetime"],
        helps: [
          "consume an opaque value through an exactly matching native call",
          "copy asserted cstring text with String.from before passing the owned String to Z code",
        ],
      });
    }
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
        structs,
        enums,
        state,
      );
      locals.set(argument.name, initializedAvailableBinding(stored));
      state.moveOrigins.delete(argument.name);
      state.nativeArgumentAccesses.set(argument.location.offset, "out");
      state.expressionTypes.set(argument.location.offset, String(underlyingType(stored)));
      state.expressionTypes.set(argument.nameLocation.offset, String(underlyingType(stored)));
      const asyncContext = state.asyncCallContexts.at(-1);
      if (target.async && asyncContext?.mode === "spawn") {
        throw new DiagnosticError(fileName, argument.location, `child-task output borrow of ${JSON.stringify(argument.name)} is not supported`, {
          code: "Z0704",
          notes: ["direct await suspends the caller until initialization finishes; a child-task output would leave caller storage concurrently observable"],
          helps: [`use \`await ${target.name}(out ${argument.name})\`, or return an owned result from the child task`],
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
          structs,
          enums,
          state,
        );
      }
      state.nativeArgumentAccesses.set(argument.location.offset, "inout");
      state.expressionTypes.set(argument.location.offset, String(storedType));
      state.expressionTypes.set(argument.nameLocation.offset, String(storedType));
      if (target.async && asyncContext?.mode === "spawn") {
        if (state.asyncScopeDepth === 0) {
          throw new DiagnosticError(fileName, argument.location, `child-task mutable borrow of ${JSON.stringify(argument.name)} requires an explicit async scope`, {
            code: "Z0704",
            notes: ["the scope join bounds exclusive child access before caller storage can be read, mutated, moved, or destroyed"],
            helps: ["place the task inside `async scope { ... }`, use direct `await`, or transfer ownership into the child task"],
          });
        }
        recordAsyncSpawnBorrow(argument.name, argument.location, "inout", asyncContext.spawnOffset!, fileName, state);
      }
      continue;
    }
    if (argument.kind === "argumentReference") {
      if (argument.access !== "in") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `${argument.access} is not valid for ${parameter.mode === "in" ? "an immutable borrow" : "an owned value parameter"}`,
        );
      }
      if (parameter.mode !== "in") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `${JSON.stringify(target.name)} expects an owned value, not an explicit in borrow`,
          {
            code: "Z0300",
            helps: [`pass \`${argument.name}\` directly to transfer ownership`],
          },
        );
      }
    }
    if (argument.kind === "closure") {
      const expectedFunction = parseFunctionType(parameter.type.name);
      if (!expectedFunction) {
        throw new DiagnosticError(fileName, argument.location, `expected ${parameter.type.name}, found a closure`);
      }
      inferClosureExpression(
        argument,
        locals,
        globals,
        structs,
        enums,
        fileName,
        state,
        {
          expectedFunction,
          transientBorrow: true,
          executionContext: parameter.mode === "in" ? "inherit" : "unknown",
        },
      );
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
      const borrowedArgument = argument.kind === "argumentReference"
        ? {
            kind: "identifier" as const,
            name: argument.name,
            location: argument.nameLocation,
          }
        : argument;
      const aggregateTemporary = argument.kind === "call"
        && argument.callee.kind === "identifier"
        && structs.has(argument.callee.name)
        && argument.arguments.length === 1
        && argument.arguments[0].kind === "objectExpression";
      if (
        !isNamedStorageExpression(borrowedArgument)
        && argument.kind !== "structExpression"
        && !aggregateTemporary
        && argument.kind !== "template"
        && argument.kind !== "string"
        && argument.kind !== "try"
      ) {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `borrowed argument to ${JSON.stringify(target.name)} must be stored or a struct literal`,
        );
      }
      const actual = inferExpression(borrowedArgument, locals, globals, structs, enums, fileName, state);
      const borrowedActual = parseViewType(String(actual))?.target ?? actual;
      if (
        hasOwnershipType(borrowedActual, structs, enums, state)
        && !isNamedStorageExpression(borrowedArgument)
        && argument.kind !== "template"
        && argument.kind !== "string"
        && argument.kind !== "try"
      ) {
        throw new DiagnosticError(fileName, argument.location, "a cleanup-bearing borrowed temporary must be bound before the call");
      }
      requireAssignable(parameter.type.name, borrowedActual, argument, fileName, structs, enums, state);
      state.nativeArgumentAccesses.set(argument.location.offset, "in");
      if (argument.kind === "argumentReference") {
        state.expressionTypes.set(argument.location.offset, String(borrowedActual));
        state.expressionTypes.set(argument.nameLocation.offset, String(borrowedActual));
      }
      const asyncContext = state.asyncCallContexts.at(-1);
      if (target.async && asyncContext?.mode === "spawn") {
        const borrowedRoot = storageRoot(argument)?.name ?? null;
        if (state.asyncScopeDepth === 0) {
          throw new DiagnosticError(fileName, argument.location, `child-task borrow of ${JSON.stringify(borrowedRoot ?? "value")} requires an explicit async scope`, {
            code: "Z0704",
            notes: ["the scope join bounds the child task before borrowed caller storage can be destroyed"],
            helps: ["place the task and its uses inside `async scope { ... }`, or pass ownership instead"],
          });
        }
        if (!borrowedRoot) {
          throw new DiagnosticError(fileName, argument.location, "an async child-task borrow requires named storage", {
            code: "Z0704",
            helps: ["bind the value before borrowing it into the child task"],
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
        requireAssignable(parameter.type.name, actual, argument, fileName, structs, enums, state);
      }
      const asyncContext = state.asyncCallContexts.at(-1);
      if (target.async && asyncContext?.mode === "spawn") {
        const borrowedRoot = storageRoot(argument)?.name ?? null;
        if (state.asyncScopeDepth === 0) {
          throw new DiagnosticError(fileName, argument.location, `child-task Slice borrow of ${JSON.stringify(borrowedRoot ?? "value")} requires an explicit async scope`, {
            code: "Z0704",
            notes: ["the scope join keeps the Slice backing storage alive and stable until the child finishes"],
            helps: ["place the task inside `async scope { ... }`, or use direct `await`"],
          });
        }
        if (!borrowedRoot) {
          throw new DiagnosticError(fileName, argument.location, "an async child-task Slice borrow requires named storage", {
            code: "Z0704",
            helps: ["bind the backing collection before borrowing it into the child task"],
          });
        }
        recordAsyncSpawnBorrow(borrowedRoot, argument.location, "in", asyncContext.spawnOffset!, fileName, state);
      }
      continue;
    }
    requireAssignable(parameter.type.name, actual, argument, fileName, structs, enums, state);
    consumeOwnedValue(argument, parameter.type.name, locals, structs, enums, fileName, state);
  }
}

function validateDeinitControlFlow(statements: Statement[], fileName: string): void {
  for (const statement of statements) {
    if (statement.kind === "return" || statement.kind === "throw" || statement.kind === "yield" || statement.kind === "select") {
      throw new DiagnosticError(fileName, statement.location, `deinit cannot contain ${JSON.stringify(statement.kind)}`);
    }
    if (statement.kind === "block") validateDeinitControlFlow(statement.statements, fileName);
    if (statement.kind === "variable" && statement.initializer) validateDeinitExpression(statement.initializer, fileName);
    if (statement.kind === "destructure") validateDeinitExpression(statement.initializer, fileName);
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
    if (expression.spread) validateDeinitExpression(expression.spread.expression, fileName);
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
  if (expression.kind === "unsafeExpression") {
    validateDeinitControlFlow(expression.body.statements, fileName);
  }
  if (expression.kind === "whileExpression") {
    validateDeinitExpression(expression.condition, fileName);
    validateDeinitControlFlow(expression.body.statements, fileName);
    validateDeinitControlFlow(expression.elseBranch.statements, fileName);
  }
  if (expression.kind === "forExpression") {
    validateDeinitExpression(expression.iterable, fileName);
    validateDeinitControlFlow(expression.body.statements, fileName);
    validateDeinitControlFlow(expression.elseBranch.statements, fileName);
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
    if (!force && (expression.kind === "identifier" || expression.kind === "member" || expression.kind === "index")) {
      state.managedCopies.add(expression.location.offset);
      return;
    }
  }
  const declaration = structs.get(actual);
  if (actual === "TaskScope" || actual === "TaskControl" || declaration?.kind === "class" || parseFunctionType(actual)) {
    if (!force && (expression.kind === "identifier" || expression.kind === "member" || expression.kind === "index")) {
      state.managedCopies.add(expression.location.offset);
      return;
    }
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
        labels: [{ location: borrow.location, message: "for...of borrows the collection element here", length: 3 }],
        notes: ["moving an element would leave a hole in collection storage that still owns its elements"],
        helps: ["use `copy` when an independent copy is supported, or remove the value after iteration ends"],
      });
    }
    if (borrow?.kind === "match" || borrow?.kind === "ownedMatch") {
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

function directViewOrigin(owner: string, location: SourceLocation): ViewOrigin {
  return { sources: [{ owner, location }] };
}

function viewOriginForRoot(
  root: string,
  location: SourceLocation,
  state: AnalysisState,
): ViewOrigin {
  return state.viewOrigins.get(root) ?? directViewOrigin(root, location);
}

function mergeViewOrigins(origins: readonly ViewOrigin[]): ViewOrigin {
  const sources: ViewOriginSource[] = [];
  for (const origin of origins) {
    for (const source of origin.sources) {
      if (sources.some((candidate) => candidate.owner === source.owner)) continue;
      sources.push(source);
    }
  }
  return { sources };
}

function viewOriginOwnerLabel(origin: ViewOrigin): string {
  return origin.sources.map((source) => source.owner).join(" | ");
}

function parameterViewSourceIndices(
  declaration: FunctionDeclaration,
): readonly number[] {
  if (!parseReceiverViewReturnType(declaration.returnType.name)) return [];
  const sources = new Set<number>();
  const record = (expression: Expression | null): void => {
    if (!expression) return;
    const root = storageRoot(expression);
    if (!root) return;
    const index = declaration.parameters.findIndex((parameter) => (
      parameter.name === root.name && parameter.mode === "in"
    ));
    if (index >= 0) sources.add(index);
  };
  const visit = (statement: Statement): void => {
    switch (statement.kind) {
      case "return":
        record(statement.expression);
        return;
      case "block":
        statement.statements.forEach(visit);
        return;
      case "unsafe":
        visit(statement.body);
        return;
      case "asyncScope":
        visit(statement.body);
        return;
      case "if":
        visit(statement.thenBranch);
        if (statement.elseBranch) visit(statement.elseBranch);
        return;
      case "while":
      case "for":
        visit(statement.body);
        return;
      case "match":
        statement.arms.forEach((arm) => visit(arm.body));
        return;
      default:
        return;
    }
  };
  declaration.body.forEach(visit);
  return [...sources];
}

function parameterViewCallOrigin(
  declaration: FunctionDeclaration,
  arguments_: readonly Expression[],
  locals: ReadonlyMap<string, ValueType>,
  fileName: string,
  state: AnalysisState,
): ViewOrigin | null {
  const origins: ViewOrigin[] = [];
  for (const sourceIndex of parameterViewSourceIndices(declaration)) {
    const argument = arguments_[sourceIndex];
    const rootName = argument?.kind === "argumentReference"
      ? argument.name
      : argument
        ? storageRoot(argument)?.name ?? null
        : null;
    if (!argument || !rootName || !locals.has(rootName)) {
      throw new DiagnosticError(
        fileName,
        argument?.location ?? declaration.location,
        `view-returning function ${JSON.stringify(declaration.name)} requires named storage for borrowed parameter ${JSON.stringify(declaration.parameters[sourceIndex].name)}`,
        {
          code: "Z0206",
          helps: ["bind the owner before requesting a view"],
        },
      );
    }
    origins.push(viewOriginForRoot(rootName, argument.location, state));
  }
  return origins.length > 0 ? mergeViewOrigins(origins) : null;
}

function bindViewOrigin(
  binding: string,
  origin: ViewOrigin,
  fileName: string,
  state: AnalysisState,
): void {
  unbindViewOrigin(binding, state);
  for (const source of origin.sources) {
    const conflict = (state.activeLoans.get(source.owner) ?? []).find((loan) => (
      accessCapabilitiesConflict(loan.capability, "in")
    ));
    if (conflict) {
      throw new DiagnosticError(fileName, source.location, `cannot create view ${JSON.stringify(binding)} while ${JSON.stringify(source.owner)} has an active ${conflict.capability} loan`, {
        code: conflict.lifetime.kind === "task" ? "Z0704" : "Z0205",
        labels: [{ location: conflict.location, message: `active ${conflict.capability} loan begins here`, length: source.owner.length }],
        notes: ["views and call- or task-lifetime access use the same exclusivity rules"],
        helps: ["finish the conflicting access before creating the view"],
      });
    }
  }
  for (const source of origin.sources) {
    registerAccessLoan(state.activeLoans, {
      root: source.owner,
      capability: "in",
      lifetime: { kind: "view", binding },
      location: source.location,
    });
  }
  state.viewOrigins.set(binding, origin);
}

function foreignConnectionOrigin(
  expression: Expression,
  state: AnalysisState,
): { readonly owner: string; readonly location: SourceLocation } | null {
  if (expression.kind === "call") return state.connectionCallOrigins.get(expression.location.offset) ?? null;
  if (expression.kind === "try" || expression.kind === "attempt") {
    return foreignConnectionOrigin(expression.expression, state);
  }
  return null;
}

function unbindConnectionOrigin(binding: string, state: AnalysisState): void {
  const origin = state.connectionOrigins.get(binding);
  if (!origin) return;
  const remaining = (state.activeLoans.get(origin.owner) ?? []).filter((loan) => (
    loan.lifetime.kind !== "connection" || loan.lifetime.binding !== binding
  ));
  if (remaining.length > 0) state.activeLoans.set(origin.owner, remaining);
  else state.activeLoans.delete(origin.owner);
  state.connectionOrigins.delete(binding);
}

function unbindViewOrigin(binding: string, state: AnalysisState): void {
  const origin = state.viewOrigins.get(binding);
  if (!origin) return;
  for (const source of origin.sources) {
    const remaining = (state.activeLoans.get(source.owner) ?? []).filter((loan) => (
      loan.lifetime.kind !== "view" || loan.lifetime.binding !== binding
    ));
    if (remaining.length > 0) state.activeLoans.set(source.owner, remaining);
    else state.activeLoans.delete(source.owner);
  }
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
            : loan.lifetime.kind === "connection"
              ? `connection:${loan.lifetime.binding}`
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

function rejectLoopCarriedChildTask(
  location: SourceLocation,
  fileName: string,
  state: AnalysisState,
  subject = "child task",
): void {
  const loopScopeFloor = state.asyncLoopScopeFloors.at(-1);
  if (loopScopeFloor === undefined || state.asyncScopeDepth > loopScopeFloor) return;
  throw new DiagnosticError(fileName, location, `${subject} cannot cross a loop back-edge in the current runtime tier`, {
    code: "Z0700",
    notes: [
      "the current task frame has one child slot per syntactic task site; repeating that site would overwrite a still-live child",
      "a scope created inside the loop iteration joins all of its children before the next iteration",
    ],
    helps: [
      "use direct await for sequential iteration",
      "or create `async scope { ... }` inside the loop body so its child tasks join before the back-edge",
    ],
  });
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
    throw new DiagnosticError(fileName, location, `cannot ${action} ${JSON.stringify(owner)} while a child task borrows it`, {
      code: "Z0704",
      labels: [{
        location: asyncBorrow.location,
        message: `child-task ${asyncBorrow.capability === "inout" ? "mutable" : "immutable"} borrow begins here`,
        length: owner.length,
      }],
      notes: [`the ${asyncBorrow.capability === "inout" ? "exclusive borrow" : "borrow"} remains live until the enclosing async scope joins its child tasks`],
      helps: ["finish the async scope before mutating or moving the borrowed value"],
    });
  }
  const connection = state.activeLoans.get(owner)?.find((loan) => loan.lifetime.kind === "connection");
  if (connection?.lifetime.kind === "connection") {
    throw new DiagnosticError(fileName, location, `cannot ${action} ${JSON.stringify(owner)} while native connection ${JSON.stringify(connection.lifetime.binding)} is live`, {
      code: "Z0205",
      labels: [{
        location: connection.location,
        message: `connection ${JSON.stringify(connection.lifetime.binding)} begins here`,
        length: owner.length,
      }],
      notes: ["the connection cleanup must unregister its callback before the native owner can move or deinitialize"],
      helps: [`place ${JSON.stringify(connection.lifetime.binding)} in a narrower block so it is cleaned up first`],
    });
  }
  const active = state.activeLoans.get(owner)?.find((loan) => loan.lifetime.kind === "view");
  if (!active || active.lifetime.kind !== "view") return;
  const viewName = active.lifetime.binding;
  throw new DiagnosticError(fileName, location, `cannot ${action} ${JSON.stringify(owner)} while view ${JSON.stringify(viewName)} is live`, {
    code: "Z0205",
    labels: [{ location: active.location, message: `view ${JSON.stringify(viewName)} begins here`, length: owner.length }],
    notes: ["an owner-tied view reads directly from its owner's storage"],
    helps: [`finish using ${JSON.stringify(viewName)} before mutating or moving ${JSON.stringify(owner)}`],
  });
}

function rejectCollectionMutationWhileIterating(
  collection: "Map" | "Set",
  owner: string,
  method: string,
  location: SourceLocation,
  fileName: string,
  state: AnalysisState,
): void {
  const iteration = state.iterationBorrowOrigins.get(owner);
  if (!iteration) return;
  throw new DiagnosticError(
    fileName,
    location,
    `cannot structurally mutate ${collection} ${JSON.stringify(owner)} while for...of is borrowing it`,
    {
      code: "Z0311",
      length: method.length,
      labels: [{ location: iteration, message: "iteration borrow begins here", length: 3 }],
      notes: [`${collection}.${method} can invalidate the entry or element currently being visited`],
      helps: ["finish the loop before mutating the collection, or iterate a separate owned snapshot"],
    },
  );
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

function namedStoragePath(expression: Expression): string | null {
  if (expression.kind === "identifier") return expression.name;
  if (expression.kind === "member" && !expression.optional) {
    const owner = namedStoragePath(expression.object);
    return owner ? `${owner}.${expression.property}` : null;
  }
  if (expression.kind === "index" && expression.index.kind === "number") {
    const owner = namedStoragePath(expression.object);
    return owner ? `${owner}[${expression.index.value}]` : null;
  }
  return null;
}

function assignmentPathContainsOptionalChain(expression: Expression): boolean {
  if (expression.kind === "member") {
    return Boolean(expression.optional)
      || assignmentPathContainsOptionalChain(expression.object);
  }
  if (expression.kind === "index") {
    return assignmentPathContainsOptionalChain(expression.object);
  }
  if (expression.kind === "call") {
    return assignmentPathContainsOptionalChain(expression.callee);
  }
  return false;
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

function isBorrowedNativeResource(type: ValueType, state: AnalysisState): boolean {
  if (!isBorrowedBinding(type)) return false;
  const foreign = state.foreignNamedTypes.get(String(underlyingType(type)));
  return foreign?.kind === "record" && Boolean(foreign.resource);
}

function rejectBorrowedNativeResourceEscape(
  type: ValueType,
  expression: Expression,
  locals: ReadonlyMap<string, ValueType>,
  fileName: string,
  state: AnalysisState,
  action: string,
): void {
  const rootName = expression.kind === "argumentReference"
    ? expression.name
    : storageRoot(expression)?.name ?? null;
  const stored = rootName ? locals.get(rootName) : null;
  if (!isBorrowedNativeResource(type, state) && !(stored && isBorrowedNativeResource(stored, state))) return;
  throw new DiagnosticError(fileName, expression.location, `a borrowed native resource cannot be ${action}`, {
    code: "Z0206",
    notes: [
      "its validity is controlled by native runtime state that Z cannot name in the first resource-lifetime tier",
      "borrowed native resources are non-escaping until `.zd` lifetime provenance is implemented",
    ],
    helps: ["inspect it through a local const binding and pass it only to contracted `in` parameters"],
  });
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
  const valueFrame = state.valueLoopStack.at(-1)?.loopOffset === statement.location.offset
    ? state.valueLoopStack.at(-1)!
    : null;
  const entry = new Map(locals);
  let header = new Map(entry);
  let finalCondition = new Map(header);
  let finalFrame: LoopAnalysisFrame = { breaks: [], continues: [] };

  for (let iteration = 0; iteration < 8; iteration += 1) {
    if (valueFrame) valueFrame.selections = [];
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
        structs,
        enums,
        state,
      );
    }

    const bodyLocals = narrowedConditionLocals(conditionLocals, statement.condition, true, state);
    const frame: LoopAnalysisFrame = {
      breaks: [],
      continues: [],
      valueProducing: Boolean(valueFrame),
    };
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

function resolveObjectBindingFields(
  bindings: readonly MatchObjectBinding[],
  declaration: StructDeclaration,
  locals: ReadonlyMap<string, ValueType>,
  fileName: string,
  activeReceiver: string | null,
): Array<{ readonly binding: MatchObjectBinding; readonly field: FieldDeclaration }> {
  if (bindings.length === 0) {
    throw new DiagnosticError(fileName, declaration.location, "object destructuring requires at least one field", { code: "Z0220" });
  }
  const fields = new Set<string>();
  const names = new Set<string>();
  return bindings.map((binding) => {
    validateUserName(binding.bindingName, binding.bindingLocation, fileName);
    if (fields.has(binding.fieldName)) {
      throw new DiagnosticError(fileName, binding.fieldLocation, `object pattern repeats field ${JSON.stringify(binding.fieldName)}`, { code: "Z0220" });
    }
    fields.add(binding.fieldName);
    if (names.has(binding.bindingName) || locals.has(binding.bindingName)) {
      throw new DiagnosticError(fileName, binding.bindingLocation, `duplicate local ${JSON.stringify(binding.bindingName)}`);
    }
    names.add(binding.bindingName);
    const field = declaration.fields.find((candidate) => candidate.name === binding.fieldName);
    if (!field) {
      throw new DiagnosticError(fileName, binding.fieldLocation, `${declaration.name} has no field ${JSON.stringify(binding.fieldName)}`, { code: "Z0220" });
    }
    if (field.visibility === "private" && activeReceiver !== declaration.name) {
      throw new DiagnosticError(fileName, binding.fieldLocation, `cannot destructure private field ${JSON.stringify(binding.fieldName)} of ${declaration.name}`, { code: "Z0220" });
    }
    return { binding, field };
  });
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
  const valueFrame = state.valueLoopStack.at(-1)?.loopOffset === statement.location.offset
    ? state.valueLoopStack.at(-1)!
    : null;
  if (statement.binding && statement.bindingLocation) {
    validateUserName(statement.binding, statement.bindingLocation, fileName);
    if (locals.has(statement.binding)) {
      throw new DiagnosticError(fileName, statement.bindingLocation, `duplicate local ${JSON.stringify(statement.binding)}`);
    }
  }
  const iterableType = inferExpression(statement.iterable, locals, globals, structs, enums, fileName, state);
  const iterableName = String(underlyingType(iterableType));
  const iterableValueName = parseViewType(iterableName)?.target ?? iterableName;
  const root = storageRoot(statement.iterable);
  const generator = parseGeneratorType(iterableName);
  const asyncGenerator = parseAsyncGeneratorType(iterableName);
  if (statement.asynchronous) {
    if (!owner.async) {
      throw new DiagnosticError(fileName, statement.location, "for await requires an enclosing async function", {
        code: "Z0702",
        helps: ["add `async` before the enclosing function"],
      });
    }
    if (statement.mode === "inout") {
      throw new DiagnosticError(fileName, statement.iterable.location, "for await advances its stream handle internally and does not accept inout", {
        code: "Z0311",
        helps: ["remove `inout` from the iterable"],
      });
    }
    if (!asyncGenerator) {
      throw new DiagnosticError(fileName, statement.iterable.location, `for await requires AsyncGenerator<T>, found ${displayArrayType(iterableName)}`, {
        code: "Z0311",
        helps: ["iterate an AsyncGenerator<T>, or remove `await` for a synchronous collection"],
      });
    }
    if (asyncGenerator.returnType) {
      throw new DiagnosticError(
        fileName,
        statement.iterable.location,
        `for await...of cannot discard the terminal ${displayArrayType(asyncGenerator.returnType)} value from ${displayArrayType(iterableName)}`,
        {
          code: "Z0311",
          helps: ["advance the async generator with `.next()` and match `yielded(value)` or `complete(result)`"],
        },
      );
    }
    if (statement.errorMode === "try") {
      if (!asyncGenerator.errorType) {
        throw new DiagnosticError(fileName, statement.location, "try for await requires a throwing async generator", {
          code: "Z0311",
          helps: ["remove `try` when iterating a nonthrowing AsyncGenerator<T>"],
        });
      }
      if (!owner.errorType) {
        throw new DiagnosticError(fileName, statement.location, "try for await requires an enclosing throwing function", {
          code: "Z0311",
          helps: [`add \`throws ${displayArrayType(asyncGenerator.errorType)}\` to the enclosing async function`],
        });
      }
      if (owner.errorType.name !== asyncGenerator.errorType) {
        throw new DiagnosticError(
          fileName,
          statement.location,
          `cannot propagate ${displayArrayType(asyncGenerator.errorType)} from a function throwing ${displayArrayType(owner.errorType.name)}`,
          { code: "Z0311" },
        );
      }
    }
    if (asyncGenerator.errorType && statement.errorMode !== "try") {
      throw new DiagnosticError(
        fileName,
        statement.iterable.location,
        `for await...of cannot implicitly propagate ${displayArrayType(asyncGenerator.errorType)} from a throwing async generator`,
        {
          code: "Z0311",
          notes: ["throwing iteration requires an explicit propagation boundary"],
          helps: ["write `try for await (const value of stream) { ... }`, or advance explicitly with `attempt await stream.next()`"],
        },
      );
    }
    analyzeIteratorForLoop(
      statement,
      asyncGenerator.elementType,
      iterableName,
      root,
      owner,
      locals,
      globals,
      structs,
      enums,
      fileName,
      state,
    );
    return;
  }
  if (statement.errorMode !== "none") {
    throw new DiagnosticError(fileName, statement.location, "try for await requires asynchronous iteration", {
      code: "Z0311",
      helps: ["write `try for await (...)`, or remove `try` from a synchronous for...of loop"],
    });
  }
  if (asyncGenerator) {
    throw new DiagnosticError(fileName, statement.iterable.location, `AsyncGenerator<T> requires asynchronous iteration`, {
      code: "Z0311",
      helps: ["write `for await (const value of stream) { ... }` inside an async function"],
    });
  }
  if (generator?.returnType) {
    throw new DiagnosticError(
      fileName,
      statement.iterable.location,
      `for...of cannot discard the terminal ${displayArrayType(generator.returnType)} value from ${displayArrayType(iterableName)}`,
      {
        code: "Z0311",
        helps: ["advance the generator with `.next()` and match `yielded(value)` or `complete(result)`"],
      },
    );
  }
  if (generator?.errorType) {
    throw new DiagnosticError(
      fileName,
      statement.iterable.location,
      `for...of cannot implicitly propagate ${displayArrayType(generator.errorType)} from a throwing generator`,
      {
        code: "Z0311",
        helps: ["advance the generator with `try generator.next()` or `attempt generator.next()`"],
      },
    );
  }
  const iteratorElement = state.iteratorElementTypes.get(iterableName);
  if (iteratorElement) {
    analyzeIteratorForLoop(
      statement,
      iteratorElement,
      iterableName,
      root,
      owner,
      locals,
      globals,
      structs,
      enums,
      fileName,
      state,
    );
    return;
  }
  if (statement.mode === "inout") {
    throw new DiagnosticError(fileName, statement.iterable.location, `for...of inout requires an Iterator<T>, found ${iterableType}`, {
      code: "Z0311",
      notes: ["arrays, Slice, Map, and Set use borrowed collection iteration without mutating iterator state"],
      helps: ["remove `inout` when iterating a built-in collection"],
    });
  }
  if (!root) {
    throw new DiagnosticError(fileName, statement.iterable.location, "for...of requires stored collection storage in the initial iteration tier", {
      code: "Z0310",
      helps: ["bind the collection to a const or let before iterating it"],
    });
  }
  const map = parseMapType(iterableValueName);
  const set = parseSetType(iterableValueName);
  const collection = parseFixedArrayType(iterableValueName)
    ?? parseDynamicArrayType(iterableValueName)
    ?? parseSliceType(iterableValueName)
    ?? (map ? { elementType: mapEntryTypeName(map.keyType, map.valueType) } : null)
    ?? (set ? { elementType: set.elementType } : null);
  if (!collection) {
    throw new DiagnosticError(fileName, statement.iterable.location, `for...of requires an array, Slice, Map, or Set, found ${iterableType}`, {
      code: "Z0310",
      helps: ["iterate a fixed array, Array<T>, Slice<T>, Map<K, V>, or Set<T> value"],
    });
  }
  const collectionBorrow = Boolean(map || set);
  const elementDeclaration = statement.objectBindings ? structs.get(collection.elementType) : null;
  if (statement.objectBindings && (!elementDeclaration || elementDeclaration.kind !== "struct")) {
    throw new DiagnosticError(fileName, statement.location, `object iteration pattern requires struct elements, found ${displayArrayType(collection.elementType)}`, {
      code: "Z0220",
    });
  }
  const objectFields = statement.objectBindings && elementDeclaration
    ? resolveObjectBindingFields(statement.objectBindings, elementDeclaration, locals, fileName, state.activeReceiver)
    : [];
  if (statement.binding && statement.bindingLocation) {
    state.bindingTypes.set(statement.bindingLocation.offset, collection.elementType);
  }
  for (const { binding, field } of objectFields) {
    state.bindingTypes.set(binding.bindingLocation.offset, field.type.name);
  }

  const entry = new Map(locals);
  let header = new Map(entry);
  let finalFrame: LoopAnalysisFrame = { breaks: [], continues: [] };
  const normalize = (candidate: Map<string, ValueType>): Map<string, ValueType> => {
    const normalized = new Map(candidate);
    if (statement.binding) normalized.delete(statement.binding);
    for (const { binding } of objectFields) normalized.delete(binding.bindingName);
    const rootType = header.get(root.name);
    if (rootType) normalized.set(root.name, rootType);
    return normalized;
  };

  for (let iteration = 0; iteration < 8; iteration += 1) {
    if (valueFrame) valueFrame.selections = [];
    const bodyLocals = new Map(header);
    const rootType = bodyLocals.get(root.name);
    if (rootType) bodyLocals.set(root.name, `${borrowedPrefix}${underlyingType(rootType)}`);
    const borrowedElement = collectionBorrow || hasOwnershipType(collection.elementType, structs, enums, state);
    if (statement.binding) {
      const elementBinding = borrowedElement
        ? `${borrowedPrefix}${collection.elementType}`
        : collection.elementType;
      bodyLocals.set(statement.binding, elementBinding);
    }
    for (const { binding, field } of objectFields) {
      const borrowedField = borrowedElement && hasOwnershipType(field.type.name, structs, enums, state);
      bodyLocals.set(binding.bindingName, borrowedField ? `${borrowedPrefix}${field.type.name}` : field.type.name);
    }

    const frame: LoopAnalysisFrame = {
      breaks: [],
      continues: [],
      valueProducing: Boolean(valueFrame),
    };
    const previousIterationBorrow = state.iterationBorrowOrigins.get(root.name);
    const previousElementBorrow = statement.binding ? state.borrowOrigins.get(statement.binding) : null;
    const previousFieldBorrows = new Map(objectFields.map(({ binding }) => [binding.bindingName, state.borrowOrigins.get(binding.bindingName)]));
    state.iterationBorrowOrigins.set(root.name, statement.location);
    if (borrowedElement && statement.binding) {
      state.borrowOrigins.set(statement.binding, { location: statement.location, kind: "iteration" });
    }
    for (const { binding, field } of objectFields) {
      if (borrowedElement && hasOwnershipType(field.type.name, structs, enums, state)) {
        state.borrowOrigins.set(binding.bindingName, { location: statement.location, kind: "iteration" });
      }
    }
    state.loopStack.push(frame);
    try {
      analyzeStatement(statement.body, owner, bodyLocals, globals, structs, enums, fileName, state);
    } finally {
      state.loopStack.pop();
      if (previousIterationBorrow) state.iterationBorrowOrigins.set(root.name, previousIterationBorrow);
      else state.iterationBorrowOrigins.delete(root.name);
      if (statement.binding) {
        if (previousElementBorrow) state.borrowOrigins.set(statement.binding, previousElementBorrow);
        else state.borrowOrigins.delete(statement.binding);
      }
      for (const { binding } of objectFields) {
        const previous = previousFieldBorrows.get(binding.bindingName);
        if (previous) state.borrowOrigins.set(binding.bindingName, previous);
        else state.borrowOrigins.delete(binding.bindingName);
      }
    }

    const backEdges = frame.continues.map(normalize);
    if (!statementStopsFlow(statement.body)) backEdges.push(normalize(bodyLocals));
    if (valueFrame) {
      valueFrame.selections = valueFrame.selections.map((selection) => ({
        ...selection,
        locals: normalize(selection.locals),
      }));
    }
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

function analyzeIteratorForLoop(
  statement: Extract<Statement, { kind: "for" }>,
  elementType: string,
  iteratorType: string,
  root: ReturnType<typeof storageRoot>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  const valueFrame = state.valueLoopStack.at(-1)?.loopOffset === statement.location.offset
    ? state.valueLoopStack.at(-1)!
    : null;
  if (root) {
    const generator = parseGeneratorType(iteratorType) ?? parseAsyncGeneratorType(iteratorType);
    if (!generator && statement.mode !== "inout") {
      throw new DiagnosticError(fileName, statement.iterable.location, `stored iterator ${JSON.stringify(root.name)} requires explicit inout iteration`, {
        code: "Z0311",
        notes: ["Iterator.next mutates the iterator's traversal state"],
        helps: [`use \`for (const value of inout ${root.name})\``],
      });
    }
    const stored = locals.get(root.name);
    const iterator = structs.get(iteratorType);
    if (!stored || (!generator && iterator?.kind !== "class" && !isMutableBinding(stored))) {
      throw new DiagnosticError(fileName, statement.iterable.location, `iterator ${JSON.stringify(root.name)} requires mutable let storage`, {
        code: "Z0311",
        helps: [`declare \`let ${root.name} = ...\` before iterating it`],
      });
    }
    rejectOwnerMutationWhileViewed(root.name, statement.iterable.location, fileName, state);
  } else if (statement.mode === "inout") {
    throw new DiagnosticError(fileName, statement.iterable.location, "inout iteration requires named iterator storage", {
      code: "Z0311",
      helps: ["bind the iterator to let first, or omit `inout` when iterating a temporary"],
    });
  }

  const elementDeclaration = statement.objectBindings ? structs.get(elementType) : null;
  if (statement.objectBindings && (!elementDeclaration || elementDeclaration.kind !== "struct")) {
    throw new DiagnosticError(fileName, statement.location, `object iteration pattern requires struct elements, found ${displayArrayType(elementType)}`, {
      code: "Z0220",
    });
  }
  if (statement.objectBindings && hasOwnershipType(elementType, structs, enums, state)) {
    const asyncIterator = Boolean(parseAsyncGeneratorType(iteratorType));
    if (!asyncIterator) {
      throw new DiagnosticError(fileName, statement.location, "destructuring ownership-bearing Iterator elements is deferred in the synchronous iterator tier", {
        code: "Z0311",
        helps: ["bind the element by name, then destructure or move its fields explicitly inside the loop"],
      });
    }
  }
  if (statement.objectBindings && parseAsyncGeneratorType(iteratorType)) {
    if (elementDeclaration!.deinitializer) {
      throw new DiagnosticError(fileName, statement.location, `cannot destructure yielded ${elementDeclaration!.name} because it defines deinit`, {
        code: "Z0220",
        notes: ["moving selected fields would leave the custom destructor with an incomplete value"],
        helps: ["bind the yielded value by name and use a type-specific extraction method"],
      });
    }
    if (containsForeignValueStorage(elementType, structs, enums, state.foreignNamedTypes)) {
      throw new DiagnosticError(fileName, statement.location, `cannot destructure yielded ${elementDeclaration!.name} while it contains native value storage`, {
        code: "Z0240",
        notes: ["partial relocation of native RAII fields requires a separate explicit contract"],
        helps: ["bind and move the complete yielded value instead"],
      });
    }
    if (containsOpaqueCleanupStorage(elementType, structs, enums, state.foreignTypes)) {
      throw new DiagnosticError(fileName, statement.location, `cannot destructure yielded ${elementDeclaration!.name} while it contains custom or foreign cleanup storage`, {
        code: "Z0220",
        notes: ["the compiler cannot suppress cleanup safely for only the transferred opaque fields"],
        helps: ["bind and move the complete yielded value instead"],
      });
    }
  }
  if (hasMoveOnlyForeignType(elementType, structs, enums, state.foreignNamedTypes)) {
    throw new DiagnosticError(fileName, statement.location, "Iterator cannot yield move-only native C++ values in the first iterator tier", {
      code: "Z0311",
      notes: ["the C++ union payload needs explicit move construction during Option<T> extraction"],
      helps: ["yield a Z-owned handle or stable identifier while native move extraction is expanded"],
    });
  }
  const objectFields = statement.objectBindings && elementDeclaration
    ? resolveObjectBindingFields(statement.objectBindings, elementDeclaration, locals, fileName, state.activeReceiver)
    : [];
  if (statement.binding && statement.bindingLocation) {
    state.bindingTypes.set(statement.bindingLocation.offset, elementType);
  }
  for (const { binding, field } of objectFields) {
    state.bindingTypes.set(binding.bindingLocation.offset, field.type.name);
  }

  const entry = new Map(locals);
  let header = new Map(entry);
  let finalFrame: LoopAnalysisFrame = { breaks: [], continues: [] };
  const normalize = (candidate: Map<string, ValueType>): Map<string, ValueType> => {
    const normalized = new Map(candidate);
    if (statement.binding) normalized.delete(statement.binding);
    for (const { binding } of objectFields) normalized.delete(binding.bindingName);
    if (root) {
      const rootType = header.get(root.name);
      if (rootType) normalized.set(root.name, rootType);
    }
    return normalized;
  };

  for (let iteration = 0; iteration < 8; iteration += 1) {
    if (valueFrame) valueFrame.selections = [];
    const bodyLocals = new Map(header);
    if (root) {
      const rootType = bodyLocals.get(root.name);
      if (rootType) bodyLocals.set(root.name, `${borrowedPrefix}${isMutableBinding(rootType) ? mutablePrefix : ""}${underlyingType(rootType)}`);
    }
    if (statement.binding) bodyLocals.set(statement.binding, elementType);
    for (const { binding, field } of objectFields) bodyLocals.set(binding.bindingName, field.type.name);
    const frame: LoopAnalysisFrame = {
      breaks: [],
      continues: [],
      valueProducing: Boolean(valueFrame),
    };
    state.loopStack.push(frame);
    try {
      analyzeStatement(statement.body, owner, bodyLocals, globals, structs, enums, fileName, state);
    } finally {
      state.loopStack.pop();
    }
    const backEdges = frame.continues.map(normalize);
    if (!statementStopsFlow(statement.body)) backEdges.push(normalize(bodyLocals));
    if (valueFrame) {
      valueFrame.selections = valueFrame.selections.map((selection) => ({
        ...selection,
        locals: normalize(selection.locals),
      }));
    }
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
  if (actual === "String" || actual === "TextBuffer" || actual === "Arena" || actual === "TaskScope" || actual === "TaskControl") return true;
  if (parseMutexType(actual)) return true;
  if (parseOnceLifetimeType(actual)) return true;
  if (actual === fsLockTypeName || actual === "fs.Lock") return true;
  if (actual === nativeConnectionTypeName) return true;
  if (parseGeneratorType(actual) || parseAsyncGeneratorType(actual)) return true;
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

function explicitCopyPlanForType(
  type: ValueType,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  state: AnalysisState,
): Omit<ExplicitCopyPlan, "type" | "sourceIsView"> | null {
  const actual = String(underlyingType(type));
  if (actual === "String") return { kind: "string" };
  if (
    actual === "TextBuffer"
    || actual === "Arena"
    || actual === "TaskScope"
    || actual === "TaskControl"
    || parseMutexType(actual)
    || parseOnceType(actual)
    || parseOnceLifetimeType(actual)
    || actual === fsLockTypeName
    || actual === "fs.Lock"
    || parseAsyncGeneratorType(actual)
    || parseWeakType(actual)
    || parseFunctionType(actual)
  ) return null;

  const native = state.foreignNamedTypes.get(actual);
  if (native?.kind === "value") return native.lifecycle.copy ? { kind: "native" } : null;
  // ARC/Objective-C references copy identity through ordinary assignment. The
  // explicit operator is reserved for creating an independent value.
  if (native?.kind === "object") return null;

  const declaration = structs.get(actual);
  if (declaration?.kind === "class") return null;
  if (
    (Boolean(parseDynamicArrayType(actual)) || Boolean(parseFixedArrayType(actual)) || declaration?.kind === "struct" || enums.has(actual))
    && explicitAggregateCopyable(actual, structs, enums, state)
  ) return { kind: "aggregate" };
  if (
    !hasOwnershipType(actual, structs, enums, state)
    && !containsForeignValueStorage(actual, structs, enums, state.foreignNamedTypes)
  ) return { kind: "trivial" };
  return null;
}

function explicitAggregateCopyable(
  type: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  state: AnalysisState,
  visiting = new Set<string>(),
): boolean {
  if (type === "String") return true;
  if (
    type === "TextBuffer"
    || type === "Arena"
    || type === "TaskControl"
    || parseMutexType(type)
    || type === fsLockTypeName
    || type === "fs.Lock"
    || parseAsyncGeneratorType(type)
    || parseWeakType(type)
    || parseFunctionType(type)
  ) return false;
  const native = state.foreignNamedTypes.get(type);
  if (native?.kind === "value") return native.lifecycle.copy;
  if (native?.kind === "object") return false;
  const dynamic = parseDynamicArrayType(type);
  if (dynamic) return explicitAggregateCopyable(dynamic.elementType, structs, enums, state, visiting);
  const fixed = parseFixedArrayType(type);
  if (fixed) return explicitAggregateCopyable(fixed.elementType, structs, enums, state, visiting);
  const declaration = structs.get(type);
  const enumeration = enums.get(type);
  if (!declaration && !enumeration) return !hasOwnershipType(type, structs, enums, state);
  if (declaration?.kind === "class" || declaration?.deinitializer || visiting.has(type)) return false;
  visiting.add(type);
  const result = declaration
    ? declaration.fields.every((field) => explicitAggregateCopyable(field.type.name, structs, enums, state, visiting))
    : enumeration!.variants.every((variant) => (
      !variant.payload || explicitAggregateCopyable(variant.payload.name, structs, enums, state, visiting)
    ));
  visiting.delete(type);
  return result;
}

function executorBoundCaptureUseOutsideMain(
  value: unknown,
  name: string,
  onMain = false,
  allowMemberRoot = false,
): SourceLocation | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const invalid = executorBoundCaptureUseOutsideMain(child, name, onMain, allowMemberRoot);
      if (invalid) return invalid;
    }
    return null;
  }
  const node = value as {
    readonly kind?: string;
    readonly name?: string;
    readonly location?: SourceLocation;
    readonly body?: unknown;
    readonly executor?: unknown;
    readonly call?: unknown;
    readonly object?: unknown;
  };
  if (node.kind === "identifier" && node.name === name) {
    return onMain ? null : node.location ?? null;
  }
  if (node.kind === "executorPlacement") {
    const executorUse = executorBoundCaptureUseOutsideMain(node.executor, name, onMain, allowMemberRoot);
    const callUse = node.call ? executorBoundCaptureUseOutsideMain(node.call, name, true, allowMemberRoot) : null;
    return executorUse ?? callUse ?? executorBoundCaptureUseOutsideMain(node.body, name, true, allowMemberRoot);
  }
  if (node.kind === "closure") {
    // A nested closure can outlive the placement that constructs it. Keep this
    // first tier structural: only the worker's direct main-placement regions
    // may borrow executor-bound identity.
    return executorBoundCaptureUseOutsideMain(node.body, name, false, false);
  }
  if (
    allowMemberRoot
    && node.kind === "member"
    && node.object
    && typeof node.object === "object"
    && (node.object as { readonly kind?: string }).kind === "identifier"
    && (node.object as { readonly name?: string }).name === name
  ) {
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "location"
      || key === "nameLocation"
      || key === "type"
      || key === "returnType"
      || key === "errorType"
      || key === "executorAffinity"
    ) continue;
    const invalid = executorBoundCaptureUseOutsideMain(child, name, onMain, allowMemberRoot);
    if (invalid) return invalid;
  }
  return null;
}

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

function mutexThreadShareIssue(
  type: ValueType,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  state: AnalysisState,
): ShareabilityIssue | null {
  const mutex = parseMutexType(String(underlyingType(type)));
  if (!mutex) return null;
  const payload = String(underlyingType(mutex.valueType));
  const affinity = state.aggregateExecutorAffinities.get(payload);
  if (affinity || foreignExecutorAffinityForTypeName(payload, state)) {
    return {
      reason: `Mutex payload ${displayAssignableType(payload, state)} is executor-bound and cannot be destroyed by an arbitrary worker`,
      help: "keep this Mutex on its owning executor, or protect an owned thread-independent snapshot instead",
    };
  }
  const aggregate = structs.get(payload);
  if (aggregate?.deinitializer) {
    return {
      reason: `Mutex payload ${displayAssignableType(payload, state)} has a custom deinit whose thread affinity is unknown`,
      help: "use a payload with thread-independent cleanup, or keep this Mutex on one thread",
    };
  }
  const foreignIssue = foreignThreadTransferIssue(payload, state);
  if (foreignIssue) return foreignIssue;
  return {
    reason: `Mutex payload ${displayAssignableType(payload, state)} is not transferable and safely destructible on an arbitrary worker`,
    help: "store an owned thread-transferable value in the Mutex, or keep this Mutex on one thread",
  };
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
  if (actual === "void" || actual === "boolean" || integerTypes.has(actual) || floatTypes.has(actual) || actual === "String" || actual === "TaskScope" || actual === "TaskControl") {
    return null;
  }
  const mutex = parseMutexType(actual);
  if (mutex) {
    return initialThreadTransferKind(actual, structs, enums, state) === "share"
      ? null
      : mutexThreadShareIssue(actual, structs, enums, state);
  }
  const executorAffinity = state.aggregateExecutorAffinities.get(actual);
  if (executorAffinity) {
    const inherited = executorAffinity.declared
      ? ""
      : ` inherited through ${executorAffinity.fieldPath.join(".")}`;
    return {
      reason: `${path} is isolated to thread.main${inherited}`,
      help: "keep the value on thread.main and transfer an owned thread-independent snapshot instead",
    };
  }
  const foreignAffinity = foreignExecutorAffinityForTypeName(actual, state);
  if (foreignAffinity) {
    return {
      reason: `${path} is isolated to thread.main by native metadata`,
      help: "keep the value on thread.main and transfer an owned thread-independent snapshot instead",
    };
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
  if (state.aggregateExecutorAffinities.has(actual)) return null;
  if (actual === "TaskScope" || actual === "TaskControl") return "share";
  if (actual === "String" || actual === "TextBuffer") return "move";
  if (parseViewType(actual) || parseSliceType(actual) || parseTaskType(actual)) return null;
  const mutex = parseMutexType(actual);
  if (mutex) {
    return initialThreadTransferKind(mutex.valueType, structs, enums, state, visiting)
      ? "share"
      : null;
  }
  const fixed = parseFixedArrayType(actual);
  if (fixed) {
    const element = initialThreadTransferKind(fixed.elementType, structs, enums, state, visiting);
    return element ? (element === "copy" ? "copy" : "move") : null;
  }
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
    if (aggregate.kind === "class") return state.shareableClasses.has(actual) ? "share" : null;
    if (aggregate.deinitializer) return null;
    visiting.add(actual);
    const fields = aggregate.fields.map((field) => (
      initialThreadTransferKind(field.type.name, structs, enums, state, visiting)
    ));
    visiting.delete(actual);
    if (fields.some((field) => field === null)) return null;
    return fields.some((field) => field === "move" || field === "share") ? "move" : "copy";
  }
  const enumeration = enums.get(actual);
  if (enumeration) {
    visiting.add(actual);
    const variants = enumeration.variants.map((variant) => (
      variant.payload ? initialThreadTransferKind(variant.payload.name, structs, enums, state, visiting) : "copy"
    ));
    visiting.delete(actual);
    if (variants.some((variant) => variant === null)) return null;
    return variants.some((variant) => variant === "move" || variant === "share") ? "move" : "copy";
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
  if (foreign?.kind === "record" && foreign.resource) return true;
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
): { readonly method: ForeignObjCMethod; readonly projected: boolean } {
  const usesLabels = argumentLabels.some((label) => label !== null);
  if (argumentLabels[0] !== null && argumentLabels.length > 0) {
    throw new DiagnosticError(fileName, location, "the first Objective-C argument is already named by the method and must not have a label");
  }
  if (usesLabels && argumentLabels.slice(1).some((label) => label === null)) {
    throw new DiagnosticError(fileName, location, "a labeled Objective-C call must label every argument after the first");
  }
  let declaration: ForeignObjCInterface | undefined = receiver.declaration;
  const matches: { readonly method: ForeignObjCMethod; readonly projected: boolean }[] = [];
  while (declaration) {
    matches.push(...declaration.methods.flatMap((method) => {
      if (method.instance !== receiver.instance || method.baseName !== baseName) return [];
      const projected = method.asyncCallbackParameter !== null
        && method.parameters.length - 1 === argumentCount;
      if (!projected && method.parameters.length !== argumentCount) return [];
      const labels = projected
        ? objectiveCLabels(method.selector).filter((_, index) => index !== method.asyncCallbackParameter)
        : objectiveCLabels(method.selector);
      if (usesLabels && !labels.every((label, index) => label === argumentLabels[index])) return [];
      return [{ method, projected }];
    }));
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
  if (type.kind === "nullPointer") return "null";
  if (type.kind === "fixedNative") return "unknown";
  if (type.kind === "selector") return objcSelectorTypeName;
  if (type.kind === "swiftString") return swiftStringTypeName;
  if (type.kind === "named") return type.type.typeName;
  if (type.kind === "reference") return type.type.kind === "scalar" ? type.type.underlying : type.type.typeName;
  if (type.kind === "pointer" || type.kind === "object") return type.typeName;
  if (type.kind === "pointerOut") return type.pointer.typeName;
  if (type.kind === "scalarPointer") return type.typeName;
  if (type.kind === "callback" || type.kind === "block") {
    const parameters = type.parameters.map((parameter, index) => ({
      name: type.kind === "callback" ? type.parameterNames?.[index] ?? `argument${index + 1}` : `argument${index + 1}`,
      mode: type.kind === "callback"
        ? (type.parameterModes?.[index] ?? "value")
        : "value",
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
    if (
      parameter.type.kind === "unsupported"
      || parameter.type.kind === "recordPointer"
      || parameter.type.kind === "scalarPointer"
    ) {
      throw new DiagnosticError(fileName, argument.location, `Objective-C selector ${JSON.stringify(target.selector)} uses unsupported parameter type ${JSON.stringify(parameter.type.cName)}`);
    }
    const contextual = contextualObjCStringType(parameter.type, argument, state);
    let actual: ValueType;
    if (parameter.type.kind === "block" && argument.kind === "closure") {
      const expectedType = foreignValueType(parameter.type);
      const expectedFunction = parseFunctionType(String(expectedType))!;
      const executionContext: ClosureExecutionContext = parameter.type.thread === "any"
        ? "unknown"
        : "inherit";
      inferClosureExpression(
        argument,
        locals,
        globals,
        structs,
        enums,
        fileName,
        state,
        {
          expectedFunction,
          transientBorrow: !parameter.type.escaping,
          executionContext,
        },
      );
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
      if (parameter.type.thread === "any") {
        validateConcurrentForeignCallbackSignature(
          parameter.type,
          argument.location,
          structs,
          enums,
          fileName,
          state,
        );
        validateConcurrentForeignCallbackClosure(
          argument,
          locals,
          structs,
          enums,
          fileName,
          state,
        );
      }
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
    requireObjCAssignable(parameter.type, actual, argument, structs, enums, fileName, state, target.selector);
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
  if (!actualObject || actualObject.nullable) return null;
  if (actualObject.className !== "NSString"
    && (!stringType || !isObjCSubclass(actualObject, stringType, state))) return null;
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
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  selector: string | null = null,
): void {
  if (expected.kind !== "object") {
    requireAssignable(foreignValueType(expected), actual, expression, fileName, structs, enums, state);
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
  allowThrowingCall = false,
  onSelected?: (overload: ForeignFunctionOverload) => void,
  subject = "foreign function",
): ValueType {
  if (target.overloads.length === 1) {
    const selected = target.overloads[0];
    requireMainExecutorContext(
      selected.metadata.executorAffinity === "main",
      location,
      `${subject} ${JSON.stringify(target.qualifiedName)}`,
      fileName,
      state,
    );
    checkForeignAvailability(selected.metadata, target.qualifiedName, location, fileName, state);
    state.foreignFunctionNames.set(calleeOffset, selected.cName);
    state.foreignFunctionDefinitions.set(calleeOffset, selected.metadata);
    onSelected?.(selected);
    const result = checkForeignCall(selected, args, locals, globals, structs, enums, fileName, location, state);
    if (selected.status && !allowThrowingCall) {
      throw new DiagnosticError(fileName, location, "throwing native call requires `attempt` or `try`", {
        code: "Z0805",
        helps: ["use `try` to propagate the native status or `attempt` to inspect Result<void, E>"],
      });
    }
    return result;
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
  requireMainExecutorContext(
    selected.metadata.executorAffinity === "main",
    location,
    `${subject} ${JSON.stringify(target.qualifiedName)}`,
    fileName,
    state,
  );
  checkForeignAvailability(selected.metadata, target.qualifiedName, location, fileName, state);
  state.foreignFunctionNames.set(calleeOffset, selected.cName);
  state.foreignFunctionDefinitions.set(calleeOffset, selected.metadata);
  onSelected?.(selected);
  const result = checkForeignCall(selected, args, locals, globals, structs, enums, fileName, location, state);
  if (selected.status && !allowThrowingCall) {
    throw new DiagnosticError(fileName, location, "throwing native call requires `attempt` or `try`", {
      code: "Z0805",
      helps: ["use `try` to propagate the native status or `attempt` to inspect Result<void, E>"],
    });
  }
  return result;
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
  requireMainExecutorContext(
    declaration.metadata.executorAffinity === "main",
    location,
    `native type ${JSON.stringify(declaration.qualifiedName)}`,
    fileName,
    state,
  );
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
    false,
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
  requireMainExecutorContext(
    declaration.metadata.executorAffinity === "main",
    location,
    `native type ${JSON.stringify(declaration.qualifiedName)}`,
    fileName,
    state,
  );
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
    false,
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
  const buffers = target.buffers ?? [];
  const projectedLengths = new Set(buffers.flatMap((buffer) => buffer.lengthParameters));
  const projectedBuffers = new Map(buffers.map((buffer) => [buffer.bufferParameter, buffer]));
  const parameters = target.parameters
    .map((parameter, nativeIndex) => ({ parameter, nativeIndex }))
    .filter(({ parameter, nativeIndex }) => (
      parameter.type.kind !== "callbackContext"
      && parameter.type.kind !== "callbackRelease"
      && parameter.type.kind !== "fixedNative"
      && !projectedLengths.has(nativeIndex)
    ));
  let score = target.variadic ? 0 : 2;
  for (let index = 0; index < args.length; index += 1) {
    const entry = parameters[index];
    if (!entry) continue;
    const { parameter, nativeIndex } = entry;
    if (parameter.literal) {
      // Exact literal projections outrank an otherwise equally shaped overload.
      score += 32;
    }
    const expected = canonicalType(
      projectedBuffers.has(nativeIndex)
        ? sliceTypeName(projectedBuffers.get(nativeIndex)!.elementType)
        : foreignValueType(parameter.type),
      state.foreignNamedTypes,
    );
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

function unsafeForeignResultType(
  cName: string,
  location: SourceLocation,
  fileName: string,
  state: AnalysisState,
): string {
  const expected = state.unsafeExpectedTypes.get(location.offset) ?? null;
  state.unsafeUnverifiedExpressions.add(location.offset);
  if (!expected) return unsafeNativeTypeName(cName);
  if (expected === "cstring" && isUnsafeCStringSpelling(cName)) return "cstring";
  const expectedOpaque = parseUnsafeNativeType(expected);
  if (
    expectedOpaque
    && normalizeUnsafeNativeSpelling(expectedOpaque) === normalizeUnsafeNativeSpelling(cName)
  ) {
    return expected;
  }
  throw new DiagnosticError(
    fileName,
    location,
    `unsafe native result ${JSON.stringify(normalizeUnsafeNativeSpelling(cName))} is not ABI-compatible with asserted Z type ${displayAssignableType(expected, state)}`,
    {
      code: "Z0823",
      notes: ["a contextual unsafe assertion changes only Z's local interpretation; it cannot change the native ABI"],
      helps: ["assert cstring only for a native character pointer, keep another pointer opaque, or write a checked .zd projection"],
    },
  );
}

function isUnsafeUnverifiedValue(expression: Expression, state: AnalysisState): boolean {
  if (state.unsafeUnverifiedExpressions.has(expression.location.offset)) return true;
  if (expression.kind === "identifier") return state.unsafeUnverifiedBindings.has(expression.name);
  if (expression.kind === "unary") return isUnsafeUnverifiedValue(expression.operand, state);
  if (expression.kind === "ternary") {
    return isUnsafeUnverifiedValue(expression.whenTrue, state)
      || isUnsafeUnverifiedValue(expression.whenFalse, state);
  }
  return false;
}

function containsUnsafeUnverifiedValue(expression: Expression, state: AnalysisState): boolean {
  if (isUnsafeUnverifiedValue(expression, state)) return true;
  if (expression.kind === "call") {
    return expression.arguments.some((argument) => containsUnsafeUnverifiedValue(argument, state));
  }
  if (expression.kind === "member") return containsUnsafeUnverifiedValue(expression.object, state);
  if (expression.kind === "index") {
    return containsUnsafeUnverifiedValue(expression.object, state)
      || containsUnsafeUnverifiedValue(expression.index, state);
  }
  return false;
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
  const buffers = target.buffers ?? [];
  const projectedBuffers = new Map(buffers.map((buffer) => [buffer.bufferParameter, buffer]));
  const projectedLengths = new Map(
    buffers.flatMap((buffer) => buffer.lengthParameters.map((parameter) => [parameter, buffer] as const)),
  );
  const unsupportedTypes = [
    target.returnType,
    ...target.parameters
      .map((parameter, nativeIndex) => ({ type: parameter.type, nativeIndex }))
      .filter(({ nativeIndex }) => !projectedBuffers.has(nativeIndex) && !projectedLengths.has(nativeIndex))
      .map(({ type }) => type),
  ]
    .filter((type): type is Extract<ForeignType, { readonly kind: "unsupported" }> => type.kind === "unsupported");
  const unsupported = unsupportedTypes[0];
  const unsupportedValueRecord = unsupportedTypes.find((type) => (
    type.reason === "byValueRecordWithPointers"
    || type.reason === "byValueRecordLayout"
  ));
  const unclassifiedValueResource = unsupportedTypes.find((type) => (
    type.reason === "unclassifiedValueResource"
  ));
  if (unsupported && state.unsafeDepth === 0) {
    if (unclassifiedValueResource) {
      throw new DiagnosticError(
        fileName,
        location,
        `C value-resource boundary ${JSON.stringify(target.name)} requires an explicit ownership capability for ${JSON.stringify(unclassifiedValueResource.cName)}`,
        {
          code: "Z0823",
          notes: [
            "a classified native resource has no default producer or parameter ownership",
            "the native ABI remains unchanged; the contract tells Z whether this call creates, borrows, or consumes ownership",
          ],
          helps: [
            "declare `owned;` or `borrowed;` on a resource result",
            "declare `in`, `inout`, or `move` on a resource parameter",
          ],
        },
      );
    }
    if (unsupportedValueRecord) {
      const pointerBearing = unsupportedValueRecord.reason === "byValueRecordWithPointers";
      throw new DiagnosticError(
        fileName,
        location,
        `C function ${JSON.stringify(target.name)} passes unsupported native record ${JSON.stringify(unsupportedValueRecord.cName)} by value${pointerBearing ? " and that record contains pointer storage" : ""}`,
        {
          code: "Z0823",
          notes: [
            pointerBearing
              ? "the current checked interop tier cannot represent a by-value record containing native pointers"
              : "the current checked interop tier cannot represent this native record layout by value",
            "an adjacent .zd file cannot make this by-value layout representable yet",
          ],
          helps: ["isolate this operation in raw c/cpp/objc source until native value-resource contracts are implemented"],
        },
      );
    }
    throw new DiagnosticError(
      fileName,
      location,
      `C function ${JSON.stringify(target.name)} uses unsupported type ${JSON.stringify(unsupported.cName)} in signature ${JSON.stringify(target.cSignature)}`,
      {
        code: "Z0823",
        helps: ["describe the reusable safety contract in an adjacent .zd file, or place a local unverified call inside `unsafe { ... }`"],
      },
    );
  }
  if (unsupported && state.unsafeDepth > 0) {
    if (unclassifiedValueResource) {
      throw new DiagnosticError(
        fileName,
        location,
        `unsafe cannot invent ownership for native value resource ${JSON.stringify(unclassifiedValueResource.cName)}`,
        {
          code: "Z0823",
          notes: ["resource ownership and cleanup must remain reusable across the safe Z boundary"],
          helps: ["classify the result or parameter in an adjacent .zd file, or isolate the entire operation in raw native source"],
        },
      );
    }
    if (unsupportedValueRecord) {
      throw new DiagnosticError(
        fileName,
        location,
        `unsafe cannot represent native record ${JSON.stringify(unsupportedValueRecord.cName)} passed by value`,
        {
          code: "Z0823",
          notes: [
            unsupportedValueRecord.reason === "byValueRecordWithPointers"
              ? "the record contains native pointer storage; unsafe supports pointer pass-through, not pointer-bearing value layouts"
              : "unsafe supports pointer pass-through, not unsupported by-value native layouts",
          ],
          helps: ["isolate this operation in raw c/cpp/objc source until native value-resource contracts are implemented"],
        },
      );
    }
    const nonPointer = unsupportedTypes.find((type) => !isUnsafeNativePointerSpelling(type.cName));
    if (nonPointer) {
      throw new DiagnosticError(
        fileName,
        location,
        `unsafe cannot represent native type ${JSON.stringify(nonPointer.cName)} in Z`,
        {
          code: "Z0823",
          notes: ["the first unsafe tier supports pointer pass-through and compatible cstring assertions only"],
          helps: ["use a checked .zd projection, or isolate this operation in raw c/cpp/objc source"],
        },
      );
    }
  }
  const visibleParameters = target.parameters
    .map((parameter, nativeIndex) => ({ parameter, nativeIndex }))
    .filter(({ parameter, nativeIndex }) => (
      parameter.type.kind !== "callbackContext"
      && parameter.type.kind !== "callbackRelease"
      && parameter.type.kind !== "fixedNative"
      && !projectedLengths.has(nativeIndex)
    ));
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
  const callbackFunctionTypes = new Map<number, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const visibleParameter = visibleParameters[index];
    const parameter = visibleParameter?.parameter;
    const bufferProjection = visibleParameter
      ? projectedBuffers.get(visibleParameter.nativeIndex)
      : undefined;
    if (parameter?.literal) {
      const constant = argument.kind === "member" ? getForeignConstant(argument, globals) : null;
      if (constant?.cName !== parameter.literal) {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C function ${JSON.stringify(target.name)} requires header constant ${parameter.literal} for parameter ${index + 1}`,
          {
            code: "Z0803",
            notes: ["this exact constant selects a safe typed projection of the native variadic function"],
          },
        );
      }
    }
    if (argument.kind === "argumentReference") {
      if (bufferProjection) {
        if (bufferProjection.access !== "inout" || argument.access !== "inout") {
          throw new DiagnosticError(
            fileName,
            argument.location,
            bufferProjection.access === "inout"
              ? `C function ${JSON.stringify(target.name)} requires inout <mutable binding> for projected parameter ${JSON.stringify(bufferProjection.name)}`
              : "a read-only projected Slice is already borrowed; pass its stored value without in, inout, out, or move",
            bufferProjection.access === "inout"
              ? { code: "Z0301", helps: [`pass mutable storage explicitly as \`inout ${argument.name}\``] }
              : { code: "Z0301" },
          );
        }
        const stored = locals.get(argument.name);
        rejectOwnerMutationWhileViewed(argument.name, argument.location, fileName, state);
        if (!stored) throw new DiagnosticError(fileName, argument.location, `unknown name ${JSON.stringify(argument.name)}`);
        if (initializationState(stored) !== "initialized") {
          throw new DiagnosticError(fileName, argument.location, `inout argument ${JSON.stringify(argument.name)} must be initialized before the call`);
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
            helps: [`declare ${JSON.stringify(argument.name)} with \`let\` before passing it as \`inout\``],
          });
        }
        const storedType = String(underlyingType(stored));
        const expectedSlice = sliceTypeName(bufferProjection.elementType);
        const storedArray = parseFixedArrayType(storedType);
        const storedDynamic = parseDynamicArrayType(storedType);
        if ((storedArray ?? storedDynamic)?.elementType === bufferProjection.elementType) {
          state.sliceConversions.set(argument.location.offset, {
            sourceType: storedType,
            targetType: expectedSlice,
          });
        } else {
          requireAssignable(expectedSlice, storedType, argument, fileName, structs, enums, state);
        }
        state.nativeArgumentAccesses.set(argument.location.offset, "inout");
        state.expressionTypes.set(argument.location.offset, storedType);
        state.expressionTypes.set(argument.nameLocation.offset, storedType);
        continue;
      }
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
          structs,
          enums,
          state,
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
          structs,
          enums,
          state,
        );
        rejectOwnerMutationWhileViewed(argument.name, argument.location, fileName, state);
        state.foreignCxxArgumentAccesses.set(argument.location.offset, "inout");
        state.expressionTypes.set(argument.location.offset, String(underlyingType(stored)));
        state.expressionTypes.set(argument.nameLocation.offset, String(underlyingType(stored)));
        continue;
      }
      if (parameter?.type.kind === "scalarPointer") {
        if (parameter.type.access !== argument.access) {
          throw new DiagnosticError(
            fileName,
            argument.location,
            `C function ${JSON.stringify(target.name)} expects ${parameter.type.access} ${argument.name}, found ${argument.access} ${argument.name}`,
          );
        }
        let stored = locals.get(argument.name);
        if (!stored) {
          throw new DiagnosticError(fileName, argument.location, `unknown name ${JSON.stringify(argument.name)}`);
        }
        if (argument.access === "out" && underlyingType(stored) === "unknown") {
          const declarationLocation = state.inferredOutBindingLocations.get(argument.name);
          if (!declarationLocation) {
            throw new DiagnosticError(fileName, argument.location, `cannot infer storage type for out argument ${JSON.stringify(argument.name)}`);
          }
          stored = `${uninitializedPrefix}${mutablePrefix}${parameter.type.typeName}`;
          locals.set(argument.name, stored);
          state.bindingTypes.set(declarationLocation.offset, parameter.type.typeName);
          state.inferredOutBindingLocations.delete(argument.name);
        }
        if (argument.access !== "out" && initializationState(stored) !== "initialized") {
          throw new DiagnosticError(
            fileName,
            argument.location,
            `${argument.access} argument ${JSON.stringify(argument.name)} must be initialized before the call`,
          );
        }
        if (argument.access !== "out" && ownershipState(stored) !== "available") {
          throw movedValueError(
            fileName,
            { name: argument.name, location: argument.location },
            state,
            ownershipState(stored) === "maybeMoved",
          );
        }
        if (argument.access !== "in" && !isMutableBinding(stored)) {
          throw new DiagnosticError(
            fileName,
            argument.location,
            `${argument.access} argument ${JSON.stringify(argument.name)} requires a mutable let binding`,
          );
        }
        requireAssignable(
          parameter.type.typeName,
          underlyingType(stored),
          argument,
          fileName,
          structs,
          enums,
          state,
        );
        state.foreignArgumentAccesses.set(argument.location.offset, argument.access);
        state.expressionTypes.set(argument.location.offset, parameter.type.typeName);
        state.expressionTypes.set(argument.nameLocation.offset, parameter.type.typeName);
        if (argument.access === "out") {
          locals.set(argument.name, initializedAvailableBinding(stored));
          state.moveOrigins.delete(argument.name);
        }
        continue;
      }
      if (parameter?.type.kind === "unsupported") {
        throw new DiagnosticError(fileName, argument.location, `${argument.access} requires a checked native capability contract`, {
          code: "Z0823",
          notes: ["unsafe pointer pass-through does not infer native mutation, initialization, or ownership facts"],
          helps: ["describe the parameter with in, inout, or out in an adjacent .zd file"],
        });
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
      let stored = locals.get(argument.name);
      if (!stored) {
        throw new DiagnosticError(fileName, argument.location, `unknown name ${JSON.stringify(argument.name)}`);
      }
      if (argument.access === "out" && underlyingType(stored) === "unknown") {
        const declarationLocation = state.inferredOutBindingLocations.get(argument.name);
        if (!declarationLocation) {
          throw new DiagnosticError(fileName, argument.location, `cannot infer storage type for out argument ${JSON.stringify(argument.name)}`);
        }
        stored = `${uninitializedPrefix}${mutablePrefix}${parameter.type.record.typeName}`;
        locals.set(argument.name, stored);
        state.bindingTypes.set(declarationLocation.offset, parameter.type.record.typeName);
        state.inferredOutBindingLocations.delete(argument.name);
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
        structs,
        enums,
        state,
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
    if (bufferProjection) {
      if (bufferProjection.access === "inout") {
        const binding = argument.kind === "identifier" ? argument.name : "value";
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C function ${JSON.stringify(target.name)} requires inout <mutable binding> for projected parameter ${JSON.stringify(bufferProjection.name)}`,
          {
            code: "Z0301",
            helps: [`pass mutable storage explicitly as \`inout ${binding}\``],
          },
        );
      }
      if (!isNamedStorageExpression(argument)) {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `borrowed byte slice passed to ${JSON.stringify(target.name)} requires named storage`,
          {
            code: "Z0206",
            notes: ["the native call borrows the projected data pointer for the duration of the call"],
            helps: ["bind the Array<u8>, fixed u8 array, or Slice<u8> before passing it"],
          },
        );
      }
      const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
      const actualName = String(underlyingType(actual));
      const expectedSlice = sliceTypeName(bufferProjection.elementType);
      const fixed = parseFixedArrayType(actualName);
      const dynamic = parseDynamicArrayType(actualName);
      const slice = parseSliceType(actualName);
      if ((fixed ?? dynamic)?.elementType === bufferProjection.elementType) {
        state.sliceConversions.set(argument.location.offset, {
          sourceType: actualName,
          targetType: expectedSlice,
        });
      } else if (slice?.elementType === bufferProjection.elementType) {
        requireAssignable(expectedSlice, actual, argument, fileName, structs, enums, state);
      } else {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C function ${JSON.stringify(target.name)} expects ${expectedSlice}, found ${describeValueType(actual, state)}`,
          {
            code: "Z0801",
            notes: ["the .zd contract projects a const native byte pointer and size_t length into one borrowed slice"],
          },
        );
      }
      continue;
    }
    if (parameter?.type.kind === "scalarPointer") {
      if (parameter.type.access !== "in") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C function ${JSON.stringify(target.name)} requires ${parameter.type.access} <mutable binding> for parameter ${index + 1}`,
        );
      }
      if (!isNamedStorageExpression(argument)) {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `in scalar argument to C function ${JSON.stringify(target.name)} must be a stored value`,
        );
      }
      const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
      requireAssignable(
        parameter.type.typeName,
        actual,
        argument,
        fileName,
        structs,
        enums,
        state,
      );
      state.foreignArgumentAccesses.set(argument.location.offset, "in");
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
        structs,
        enums,
        state,
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
      requireAssignable(expectedReference, actual, argument, fileName, structs, enums, state);
      state.foreignCxxArgumentAccesses.set(argument.location.offset, parameter.type.access);
      if (parameter.type.access === "move") {
        consumeOwnedValue(argument, actual, locals, structs, enums, fileName, state, true);
      }
      continue;
    }
    if (parameter?.type.kind === "callback" && parameter.type.thread === "any") {
      validateConcurrentForeignCallbackSignature(
        parameter.type,
        argument.location,
        structs,
        enums,
        fileName,
        state,
      );
      if (argument.kind !== "closure") {
        const global = argument.kind === "identifier" ? globals.get(argument.name) : null;
        if (global?.kind !== "function") {
          throw new DiagnosticError(
            fileName,
            argument.location,
            "thread any currently requires an inline closure or named function with no stored environment",
            {
              code: "Z0704",
              notes: ["a previously stored function value does not yet carry a compiler-proven concurrent environment contract"],
              helps: ["pass the move closure directly, or use a named function that captures no local state"],
            },
          );
        }
      }
    }
    let actual: ValueType;
    if (parameter?.type.kind === "callback" && argument.kind === "closure") {
      const expectedCallback = foreignValueType(parameter.type);
      const expectedFunction = parseFunctionType(String(expectedCallback))!;
      const executionContext: ClosureExecutionContext = parameter.type.thread === "any"
        ? "unknown"
        : parameter.type.thread === "caller" || parameter.type.lifetime === "call"
          ? "inherit"
          : "unknown";
      inferClosureExpression(
        argument,
        locals,
        globals,
        structs,
        enums,
        fileName,
        state,
        {
          expectedFunction,
          transientBorrow: true,
          executionContext,
        },
      );
      const actualFunction = closureFunctionType(state.closures.get(argument.location.offset)!);
      const actualCallback = functionTypeName(
        actualFunction.parameters,
        actualFunction.returnType,
        actualFunction.errorType,
      );
      validateForeignCallbackFunctionType(
        parameter.type,
        actualFunction,
        actualCallback,
        argument.location,
        fileName,
      );
      finalizeClosureFunctionValue(
        argument,
        actualFunction,
        actualCallback,
        locals,
        structs,
        enums,
        fileName,
        state,
        parameter.type.lifetime === "call" && parameter.type.context !== null,
      );
      if (parameter.type.thread === "any") {
        validateConcurrentForeignCallbackClosure(
          argument,
          locals,
          structs,
          enums,
          fileName,
          state,
        );
      }
      state.foreignArgumentAccesses.set(argument.location.offset, "in");
      actual = actualCallback;
    } else {
      actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
    }
    if (parameter?.type.kind === "unsupported") {
      if (actual === "null") continue;
      if (actual === "String" && isUnsafeCStringSpelling(parameter.type.cName)) {
        state.cstringConversions.add(argument.location.offset);
        actual = "cstring";
      }
      const opaque = parseUnsafeNativeType(String(underlyingType(actual)));
      if (
        (opaque && normalizeUnsafeNativeSpelling(opaque) === normalizeUnsafeNativeSpelling(parameter.type.cName))
        || (actual === "cstring" && isUnsafeCStringSpelling(parameter.type.cName))
      ) {
        continue;
      }
      throw new DiagnosticError(
        fileName,
        argument.location,
        `unsafe native parameter ${index + 1} expects ${JSON.stringify(normalizeUnsafeNativeSpelling(parameter.type.cName))}, found ${describeValueType(actual, state)}`,
        {
          code: "Z0823",
          notes: ["opaque unsafe values may pass only through an exactly matching native pointer identity"],
          helps: ["add a reusable typed projection in .zd when the native types are intentionally compatible"],
        },
      );
    }
    if (parameter?.type.kind === "nullPointer") {
      if (actual !== "null") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C function ${JSON.stringify(target.name)} restricts native parameter ${index + 1} to null`,
          { notes: [`the adjacent .zd contract does not expose non-null ${parameter.type.cName} values to safe Z`] },
        );
      }
      continue;
    }
    if (parameter?.type.kind === "callback") {
      const actualCallback = parseFunctionType(String(underlyingType(actual)));
      if (!actualCallback) {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C function ${JSON.stringify(target.name)} expects a callback function value, found ${describeValueType(actual, state)}`,
        );
      }
      const actualCallbackType = functionTypeName(
        actualCallback.parameters,
        actualCallback.returnType,
        actualCallback.errorType,
      );
      validateForeignCallbackFunctionType(
        parameter.type,
        actualCallback,
        actualCallbackType,
        argument.location,
        fileName,
      );
      callbackFunctionTypes.set(index, actualCallbackType);
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
      requireAssignable(parameter.type.name, actual, argument, fileName, structs, enums, state);
    }
    if (parameter?.type.kind === "named") {
      requireAssignable(parameter.type.type.typeName, actual, argument, fileName, structs, enums, state);
      if (parameter.type.type.kind === "record" && parameter.type.type.resource) {
        if (parameter.type.ownership === "consuming") {
          consumeOwnedValue(argument, actual, locals, structs, enums, fileName, state, true);
        } else if (parameter.type.ownership !== "borrowed") {
          throw new DiagnosticError(fileName, argument.location, `C value resource parameter ${index + 1} requires an explicit in or move contract`, {
            code: "Z0801",
          });
        }
      }
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
  if (
    contextualCallbacks.length > 0
    || buffers.length > 0
    || target.parameters.some((parameter) => parameter.type.kind === "fixedNative" || parameter.abiCast)
  ) {
    const callbacksByNativeIndex = new Map(contextualCallbacks.map((entry) => [entry.nativeIndex, entry]));
    const visibleByNativeIndex = new Map(visibleParameters.map((entry, source) => [entry.nativeIndex, source]));
    const plan: ForeignCallArgumentPlan[] = target.parameters.map((parameter, nativeIndex) => {
      const projectedBuffer = projectedBuffers.get(nativeIndex);
      if (projectedBuffer) {
        return { kind: "sliceData", source: visibleByNativeIndex.get(nativeIndex)! };
      }
      const projectedLength = projectedLengths.get(nativeIndex);
      if (projectedLength) {
        return {
          kind: "sliceLength",
          source: visibleByNativeIndex.get(projectedLength.bufferParameter)!,
        };
      }
      if (parameter.type.kind === "fixedNative") {
        return { kind: "fixed", expression: parameter.type.expression };
      }
      if (parameter.type.kind === "callbackContext") {
        const callback = callbacksByNativeIndex.get(parameter.type.callbackParameter)!;
        return {
          kind: "context",
          source: callback.source,
          callback: callback.parameter.type,
          functionType: callbackFunctionTypes.get(callback.source)
            ?? String(foreignValueType(callback.parameter.type)),
        };
      }
      if (parameter.type.kind === "callbackRelease") {
        const callback = callbacksByNativeIndex.get(parameter.type.callbackParameter)!;
        return {
          kind: "release",
          source: callback.source,
          callback: callback.parameter.type,
          functionType: callbackFunctionTypes.get(callback.source)
            ?? String(foreignValueType(callback.parameter.type)),
        };
      }
      const source = visibleByNativeIndex.get(nativeIndex)!;
      if (parameter.abiCast) {
        return { kind: "cast", source, cName: parameter.abiCast };
      }
      if (parameter.type.kind === "callback" && parameter.type.context) {
        return {
          kind: "callback",
          source,
          callback: parameter.type,
          functionType: callbackFunctionTypes.get(source)
            ?? String(foreignValueType(parameter.type)),
        };
      }
      return { kind: "argument", source };
    });
    for (let source = expected; source < args.length; source += 1) plan.push({ kind: "argument", source });
    state.foreignCallArgumentPlans.set(location.offset, plan);
  }
  if (target.returnType.kind === "pointer" && target.returnType.stringView) {
    const origins = visibleParameters
      .map(({ parameter }, source) => ({ parameter, source }))
      .filter(({ parameter }) => parameter.type.kind === "pointer" && parameter.type.ownership === "borrowed");
    if (origins.length !== 1) {
      throw new DiagnosticError(fileName, location, `borrowed text result from ${JSON.stringify(target.name)} requires exactly one borrowed pointer input`, {
        code: "Z0801",
        notes: ["the input identifies the native owner whose lifetime bounds the returned text view"],
      });
    }
    const argument = args[origins[0].source];
    const root = storageRoot(argument);
    if (!root || !locals.has(root.name)) {
      throw new DiagnosticError(fileName, argument.location, "a borrowed native text result requires a named owner binding", {
        code: "Z0206",
        helps: ["bind the native owner before requesting its text view"],
      });
    }
    state.viewCallOrigins.set(
      location.offset,
      viewOriginForRoot(root.name, argument.location, state),
    );
  }
  let result = target.returnType.kind === "z"
    ? target.returnType.name
    : target.returnType.kind === "swiftString"
      ? swiftStringTypeName
    : target.returnType.kind === "named"
      ? target.returnType.type.typeName
    : target.returnType.kind === "pointer"
      ? target.returnType.typeName
    : target.returnType.kind === "callback" || target.returnType.kind === "block"
      ? foreignValueType(target.returnType)
    : target.returnType.kind === "unsupported" && state.unsafeDepth > 0
      ? unsafeForeignResultType(target.returnType.cName, location, fileName, state)
      : "unknown";
  if (
    target.returnType.kind === "named"
    && target.returnType.type.kind === "record"
    && target.returnType.type.resource
    && target.returnType.ownership === "borrowed"
  ) {
    result = `${borrowedPrefix}${result}`;
  }
  if (target.status) {
    const errorType = target.returnType.kind === "z"
      ? target.returnType.name
      : target.returnType.kind === "named" && target.returnType.type.kind === "enum"
        ? target.returnType.type.typeName
        : null;
    if (!errorType) {
      throw new DiagnosticError(fileName, location, `native status contract for ${JSON.stringify(target.name)} has no supported error type`);
    }
    if (target.connection) {
      const ownerSource = visibleParameters.findIndex(({ nativeIndex }) => nativeIndex === target.connection!.ownerParameter);
      const callbackSource = visibleParameters.findIndex(({ nativeIndex }) => nativeIndex === target.connection!.callbackParameter);
      const callback = target.parameters[target.connection.callbackParameter]?.type;
      if (ownerSource < 0 || callbackSource < 0 || callback?.kind !== "callback") {
        throw new DiagnosticError(fileName, location, `invalid connection projection for ${JSON.stringify(target.name)}`, {
          code: "Z0801",
        });
      }
      const ownerArgument = args[ownerSource];
      const ownerRoot = storageRoot(ownerArgument);
      if (!ownerRoot || !locals.has(ownerRoot.name)) {
        throw new DiagnosticError(
          fileName,
          ownerArgument.location,
          "a native callback connection requires a named owner binding",
          {
            code: "Z0205",
            helps: ["bind the native handle before installing its callback"],
          },
        );
      }
      state.foreignConnectionCalls.set(location.offset, {
        target,
        functionType: callbackFunctionTypes.get(callbackSource)
          ?? String(foreignValueType(callback)),
        ownerSource,
        callbackSource,
      });
      state.connectionCallOrigins.set(location.offset, {
        owner: ownerRoot.name,
        location: ownerArgument.location,
      });
      result = resultTypeName(nativeConnectionTypeName, errorType);
    } else {
      state.foreignStatusCalls.set(location.offset, {
        errorType,
        success: target.status.success,
      });
      result = resultTypeName("void", errorType);
    }
  }
  state.foreignCallTypes.set(location.offset, String(result));
  return result;
}

function describePointer(type: ForeignPointerType, state?: AnalysisState): string {
  const ownership = type.ownership === "consuming" ? "owned" : type.ownership;
  const display = state?.typeDisplayNames.get(type.typeName);
  return `${ownership} ${display ?? `${type.nullable ? "nullable " : ""}${type.cName}`}`;
}

function describeValueType(type: ValueType, state: AnalysisState): string {
  const pointer = foreignPointer(type, state);
  if (pointer) return describePointer(pointer, state);
  const name = String(underlyingType(type));
  const unsafeNative = displayUnsafeNativeType(name);
  if (unsafeNative) return `${unsafeNative} (unsafe pass-through only)`;
  if (isNullableObjCTypeName(name)) return `${publicObjCTypeName(name)} | null`;
  return displayFunctionType(name, (part) => displayAssignableType(part, state))
    ?? displayAssignableType(name, state);
}

function validateCollectionKeyType(
  role: "Map key" | "Set element",
  type: string,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  state: AnalysisState,
  location: SourceLocation,
  fileName: string,
): void {
  const zEnum = enums.get(type);
  const payloadFreeEnum = zEnum?.variants.every((variant) => variant.payload === null) ?? false;
  const nativeEnum = state.foreignNamedTypes.get(type)?.kind === "enum";
  if (integerTypes.has(type) || type === "boolean" || type === "String" || payloadFreeEnum || nativeEnum) return;
  const aggregate = structs.get(type);
  if (aggregate?.kind === "struct" && aggregate.implements.some((trait) => trait.name === "Hashable")) {
    const mutableField = aggregate.fields.find((field) => !field.readonly);
    if (mutableField) {
      throw new DiagnosticError(fileName, mutableField.location, `${role} type ${JSON.stringify(displayArrayType(type))} must be readonly to preserve its stored hash`, {
        code: "Z0401",
        notes: ["a key changing after insertion would make its hashed bucket unreachable"],
        helps: [`declare \`readonly struct ${displayArrayType(type)} implements Hashable\``],
      });
    }
    return;
  }
  throw new DiagnosticError(fileName, location, `${role} type ${JSON.stringify(displayArrayType(type))} is not hashable in the first collections tier`, {
    code: "Z0401",
    notes: ["collection keys currently support integers, boolean, String, and payload-free Z or native enums"],
    helps: ["use a supported stable key; custom nominal hashing and equality contracts are planned"],
  });
}

function typeHasMainLifecycleDeclaration(
  type: string,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  visiting = new Set<string>(),
): boolean {
  const foreign = foreignNamedTypes.get(type);
  if (foreign?.metadata.executorAffinity === "main") return true;
  if (visiting.has(type)) return false;
  visiting.add(type);
  const generic = parseGenericType(type);
  const dynamic = parseDynamicArrayType(type);
  const fixed = parseFixedArrayType(type);
  const option = parseOptionType(type);
  const map = parseMapType(type);
  const set = parseSetType(type);
  const weak = parseWeakType(type);
  const children = [
    ...(generic?.arguments ?? []),
    dynamic?.elementType,
    fixed?.elementType,
    option?.target,
    map?.keyType,
    map?.valueType,
    set?.elementType,
    weak?.target,
  ].filter((child): child is string => Boolean(child));
  const aggregate = structs.get(type);
  if (aggregate?.executorAffinity || aggregate?.fields.some((field) => field.executorAffinity)) {
    visiting.delete(type);
    return true;
  }
  children.push(...(aggregate?.fields.map((field) => field.type.name) ?? []));
  children.push(...(enums.get(type)?.variants.flatMap((variant) => (
    variant.payload ? [variant.payload.name] : []
  )) ?? []));
  const result = children.some((child) => (
    typeHasMainLifecycleDeclaration(child, structs, enums, foreignNamedTypes, visiting)
  ));
  visiting.delete(type);
  return result;
}

function validateType(
  type: TypeReference,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
  allowVoid: boolean,
): void {
  const mutex = parseMutexType(type.name);
  if (mutex) {
    validateType({ name: mutex.valueType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    if (
      mutex.valueType === "void"
      || containsViewType(mutex.valueType)
      || containsSliceType(mutex.valueType)
      || parseOnceType(mutex.valueType)
      || parseOnceLifetimeType(mutex.valueType)
      || parseMutexType(mutex.valueType)
      || parseTaskType(mutex.valueType)
      || containsForeignValueStorage(
        mutex.valueType,
        structs,
        enums,
        foreignNamedTypes,
      )
    ) {
      throw new DiagnosticError(fileName, type.location, `Mutex cannot own ${JSON.stringify(displayArrayType(mutex.valueType))} in the first synchronization tier`, {
        code: "Z0240",
      });
    }
    return;
  }
  const once = parseOnceType(type.name);
  if (once) {
    validateType({ name: once.valueType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    const stored = structs.get(once.valueType);
    if (
      stored?.kind !== "class"
      || !typeHasMainLifecycleDeclaration(once.valueType, structs, enums, foreignNamedTypes)
    ) {
      throw new DiagnosticError(fileName, type.location, `Once<T> requires a class whose lifecycle belongs to thread.main, found ${JSON.stringify(displayArrayType(once.valueType))}`, {
        code: "Z0604",
      });
    }
    return;
  }
  const onceLifetime = parseOnceLifetimeType(type.name);
  if (onceLifetime) {
    validateType({ name: onceLifetime.valueType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    const stored = structs.get(onceLifetime.valueType);
    if (
      stored?.kind !== "class"
      || !typeHasMainLifecycleDeclaration(onceLifetime.valueType, structs, enums, foreignNamedTypes)
    ) {
      throw new DiagnosticError(fileName, type.location, `OnceLifetime<T> requires a class whose lifecycle belongs to thread.main, found ${JSON.stringify(displayArrayType(onceLifetime.valueType))}`, {
        code: "Z0604",
      });
    }
    return;
  }
  const generator = parseGeneratorType(type.name);
  if (generator) {
    validateType({ name: generator.elementType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    if (generator.returnType) {
      validateType({ name: generator.returnType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    }
    if (generator.errorType) {
      validateType({ name: generator.errorType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    }
    return;
  }
  const asyncGenerator = parseAsyncGeneratorType(type.name);
  if (asyncGenerator) {
    validateType({ name: asyncGenerator.elementType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    if (asyncGenerator.returnType) {
      validateType({ name: asyncGenerator.returnType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    }
    if (asyncGenerator.errorType) {
      validateType({ name: asyncGenerator.errorType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    }
    return;
  }
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
    if (
      functionType.parameters.some((parameter) => containsViewType(parameter.type))
      || containsViewType(functionType.returnType)
      || (functionType.errorType !== null && containsViewType(functionType.errorType))
    ) {
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
    if (functionType.errorType) {
      validateType({ name: functionType.errorType, location: type.location }, structs, enums, foreignNamedTypes, fileName, false);
    }
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

function resolveSemanticTypeName(
  type: TypeReference,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  state: AnalysisState,
): string {
  const resolveName = (name: string): string => {
    const generic = parseGenericType(name);
    if (generic) {
      const standard = state.standardTypeBindings.get(generic.base);
      if (standard === "Once" || standard === "OnceLifetime" || standard === "Mutex") {
        return genericTypeName(standard, generic.arguments.map(resolveName));
      }
    }
    const view = parseViewType(name);
    if (view) {
      return viewTypeName(resolveName(view.target));
    }
    const functionType = parseFunctionType(name);
    if (functionType) {
      return functionTypeName(
        functionType.parameters.map((parameter) => ({ ...parameter, type: resolveName(parameter.type) })),
        resolveName(functionType.returnType),
        functionType.errorType ? resolveName(functionType.errorType) : null,
      );
    }
    const weak = parseWeakType(name);
    if (weak) {
      return weakTypeName(resolveName(weak.target));
    }
    const task = parseTaskType(name);
    if (task) {
      return taskTypeName(
        resolveName(task.successType),
        task.errorType ? resolveName(task.errorType) : null,
      );
    }
    const asyncGenerator = parseAsyncGeneratorType(name);
    if (asyncGenerator) {
      return asyncGeneratorTypeName(
        resolveName(asyncGenerator.elementType),
        asyncGenerator.returnType ? resolveName(asyncGenerator.returnType) : null,
        asyncGenerator.errorType ? resolveName(asyncGenerator.errorType) : null,
      );
    }
    const option = parseOptionType(name);
    if (option) {
      return optionTypeName(resolveName(option.target));
    }
    const slice = parseSliceType(name);
    if (slice) return sliceTypeName(resolveName(slice.elementType));
    const dynamic = parseDynamicArrayType(name);
    if (dynamic) return dynamicArrayTypeName(resolveName(dynamic.elementType));
    const array = parseFixedArrayType(name);
    if (array) return fixedArrayTypeName(resolveName(array.elementType), array.length);
    const declaration = structs.get(name) ?? enums.get(name);
    if (!declaration) return name;
    const resolution = { location: type.location, declaration };
    const resolved = state.observer?.resolveType?.(resolution) ?? declaration;
    state.observer?.onTypeResolution?.(resolution);
    return resolved.name;
  };
  return resolveName(type.name);
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
  requireAssignable(expected, actual, expression, fileName, structs, enums, state);
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
  requireAssignable(target, actual, expression, fileName, structs, enums, state);
  state.viewReturnExpressions.add(expression.location.offset);
}

function containsViewType(name: string): boolean {
  if (parseViewType(name)) return true;
  const option = parseOptionType(name);
  if (option) return containsViewType(option.target);
  const functionType = parseFunctionType(name);
  if (functionType) {
    return functionType.parameters.some((parameter) => containsViewType(parameter.type))
      || containsViewType(functionType.returnType)
      || (functionType.errorType !== null && containsViewType(functionType.errorType));
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
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  state: AnalysisState,
): void {
  const loaded = implicitlyLoadCopyableView(actual, expression, structs, enums, state);
  if (
    loaded !== actual
    && canonicalType(expected, state.foreignNamedTypes) === canonicalType(loaded, state.foreignNamedTypes)
  ) {
    actual = loaded;
  } else if (loaded !== actual) {
    state.viewLoadExpressions.delete(expression.location.offset);
  }
  const foreignNamedTypes = state.foreignNamedTypes;
  const numericLiteralTypes = state.numericLiteralTypes;
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
  const expectedObject = state.foreignObjectTypes.get(String(underlyingType(expected)));
  const actualObject = actual === "unknown" || actual === "never"
    ? null
    : state.foreignObjectTypes.get(String(underlyingType(actual)));
  if (
    expectedObject
    && actualObject
    && (!actualObject.nullable || expectedObject.nullable)
    && isObjCSubclass(actualObject, expectedObject, state)
  ) return;
  if (
    actual !== "unknown"
    && actual !== "never"
    && expectedType !== canonicalType(actual, foreignNamedTypes)
    && !sameForeignNamedType(expected, actual, foreignNamedTypes)
  ) {
    throw new DiagnosticError(
      fileName,
      expression.location,
      `expected ${displayAssignableType(expected, state)}, found ${displayAssignableType(actual, state)}`,
    );
  }
}

function implicitlyLoadCopyableView(
  type: ValueType,
  expression: Expression,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  state: AnalysisState,
): ValueType {
  if (type === "unknown" || type === "never") return type;
  const view = parseViewType(String(underlyingType(type)));
  if (
    !view
    || hasOwnershipType(view.target, structs, enums, state)
    || containsForeignValueStorage(view.target, structs, enums, state.foreignNamedTypes)
  ) return type;
  state.viewLoadExpressions.add(expression.location.offset);
  return view.target;
}

function containsForeignValueStorage(
  type: ValueType,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  visiting = new Set<string>(),
): boolean {
  const actual = String(underlyingType(type));
  if (actual === "unknown" || actual === "never" || visiting.has(actual)) return false;
  const foreign = foreignNamedTypes.get(actual);
  if (foreign?.kind === "value" || (foreign?.kind === "record" && foreign.resource)) return true;
  const array = parseFixedArrayType(actual);
  if (array) return containsForeignValueStorage(array.elementType, structs, enums, foreignNamedTypes, visiting);
  const dynamic = parseDynamicArrayType(actual);
  if (dynamic) return containsForeignValueStorage(dynamic.elementType, structs, enums, foreignNamedTypes, visiting);
  const declaration = structs.get(actual);
  const enumDeclaration = enums.get(actual);
  if (!declaration && !enumDeclaration) return false;
  visiting.add(actual);
  const result = declaration
    ? declaration.fields.some((field) => (
      containsForeignValueStorage(field.type.name, structs, enums, foreignNamedTypes, visiting)
    ))
    : enumDeclaration!.variants.some((variant) => (
      variant.payload
      && containsForeignValueStorage(variant.payload.name, structs, enums, foreignNamedTypes, visiting)
    ));
  visiting.delete(actual);
  return Boolean(result);
}

export function runtimeRootTypeNeedsCleanup(
  type: string,
  program: Program,
  semanticInfo: SemanticInfo,
): boolean {
  return hasCleanupType(
    type,
    new Map(program.structs.map((declaration) => [declaration.name, declaration])),
    new Map(program.enums.map((declaration) => [declaration.name, declaration])),
    semanticInfo.foreignTypes,
  );
}

export function runtimeRootTypeContainsForeignValueStorage(
  type: string,
  program: Program,
  semanticInfo: SemanticInfo,
): boolean {
  return containsForeignValueStorage(
    type,
    new Map(program.structs.map((declaration) => [declaration.name, declaration])),
    new Map(program.enums.map((declaration) => [declaration.name, declaration])),
    semanticInfo.foreignNamedTypes,
  );
}

export function runtimeRootTypeRequiresMain(
  type: string,
  program: Program,
  semanticInfo: SemanticInfo,
): boolean {
  return typeHasMainLifecycleDeclaration(
    type,
    new Map(program.structs.map((declaration) => [declaration.name, declaration])),
    new Map(program.enums.map((declaration) => [declaration.name, declaration])),
    semanticInfo.foreignNamedTypes,
  );
}

function containsOpaqueCleanupStorage(
  type: ValueType,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignTypes: ReadonlyMap<string, ForeignPointerType>,
  visiting = new Set<string>(),
): boolean {
  const actual = String(underlyingType(type));
  if (actual === "unknown" || actual === "never" || visiting.has(actual)) return false;
  if (foreignTypes.get(actual)?.ownership === "owned") return true;
  const array = parseFixedArrayType(actual);
  if (array) return containsOpaqueCleanupStorage(array.elementType, structs, enums, foreignTypes, visiting);
  const dynamic = parseDynamicArrayType(actual);
  if (dynamic) return containsOpaqueCleanupStorage(dynamic.elementType, structs, enums, foreignTypes, visiting);
  const declaration = structs.get(actual);
  const enumDeclaration = enums.get(actual);
  if (declaration?.kind === "class") return false;
  if (declaration?.deinitializer) return true;
  if (!declaration && !enumDeclaration) return false;
  visiting.add(actual);
  const result = declaration
    ? declaration.fields.some((field) => (
      containsOpaqueCleanupStorage(field.type.name, structs, enums, foreignTypes, visiting)
    ))
    : enumDeclaration!.variants.some((variant) => (
      variant.payload
      && containsOpaqueCleanupStorage(variant.payload.name, structs, enums, foreignTypes, visiting)
    ));
  visiting.delete(actual);
  return Boolean(result);
}

function displayAssignableType(type: ValueType, state?: AnalysisState): string {
  const name = String(underlyingType(type));
  const unsafeNative = displayUnsafeNativeType(name);
  if (unsafeNative) return unsafeNative;
  const sourceName = state?.typeDisplayNames.get(name);
  if (sourceName) return sourceName;
  const view = parseViewType(name);
  if (view) return `view ${displayAssignableType(view.target, state)}`;
  const once = parseOnceType(name);
  if (once) return `Once<${displayAssignableType(once.valueType, state)}>`;
  const onceLifetime = parseOnceLifetimeType(name);
  if (onceLifetime) return `OnceLifetime<${displayAssignableType(onceLifetime.valueType, state)}>`;
  const mutex = parseMutexType(name);
  if (mutex) return `Mutex<${displayAssignableType(mutex.valueType, state)}>`;
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

function integerRangeContains(targetType: string, sourceType: string): boolean {
  const target = integerBounds(targetType);
  const source = integerBounds(sourceType);
  return Boolean(
    target
    && source
    && target.minimum <= source.minimum
    && target.maximum >= source.maximum
  );
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
  if (type === "fs.Lock") return fsLockTypeName;
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

function moduleConstantInitializerSupported(expression: Expression): boolean {
  if (
    expression.kind === "number"
    || expression.kind === "string"
    || expression.kind === "boolean"
  ) {
    return true;
  }
  if (
    expression.kind === "call"
    && expression.callee.kind === "identifier"
    && parseOnceType(expression.callee.name)
    && expression.arguments.length === 0
  ) {
    return true;
  }
  return expression.kind === "unary"
    && (expression.operator === "+" || expression.operator === "-")
    && expression.operand.kind === "number";
}

function moduleConstantTypeSupported(type: string): boolean {
  return type === "boolean"
    || type === "String"
    || type === "cstring"
    || isNumericType(type)
    || Boolean(parseOnceType(type));
}
