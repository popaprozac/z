import type {
  CallExpression,
  Expression,
  FunctionDeclaration,
  Program,
  SourceLocation,
  Statement,
  StructDeclaration,
  EnumDeclaration,
  MatchExpression,
  MatchStatement,
} from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { parseTaskType } from "./async-types.ts";
import { dynamicArrayTypeName, parseDynamicArrayType, parseFixedArrayType, parseSliceType } from "./array-types.ts";
import { generatorStepTypeName, parseAsyncGeneratorType } from "./generator-types.ts";
import { mapEntryTypeName, parseMapType } from "./map-types.ts";
import { optionTypeName, parseOptionType } from "./option-types.ts";
import { parsePointerTypeName } from "./foreign.ts";
import { resultTypeName } from "./results.ts";
import { parseSetType } from "./set-types.ts";
import { standardFunctionSignature } from "./standard-library.ts";
import { parseViewType } from "./view-types.ts";
import { collectPlacementCaptures } from "./placement-captures.ts";
import type { IntegerOperation, ObjCCallInfo, SemanticInfo } from "./sema.ts";
import {
  closureAdapterName,
  closureEnvironmentName,
  closureEnvironmentReleaseName,
  closureEnvironmentRetainName,
  closureFunctionType,
  functionTypeCName,
  functionValueLiteral,
  generateObjCBlockArgument,
  generateObjCMessage,
  taskScopeAsyncScheduleName,
} from "./codegen-c.ts";

type AwaitSite = {
  readonly index: number;
  readonly mode: "await" | "try" | "attempt";
  readonly intrinsic: "delay" | "yield" | "cancel" | "scopeClose" | "scopeCancel" | null;
  readonly expression: Expression;
  readonly call: CallExpression;
  readonly target: AsyncTarget;
  readonly receiver: Expression | null;
  readonly spawn: SpawnSite | null;
  readonly placement: "await" | null;
  readonly generator: {
    readonly type: string;
    readonly receiver: Expression;
  } | null;
};

type SpawnSite = {
  readonly index: number;
  readonly scope: number;
  readonly expression: Expression;
  readonly call: CallExpression;
  readonly target: AsyncTarget;
  readonly receiver: Expression | null;
  readonly binding: string | null;
  readonly nativeThread: boolean;
  readonly asyncNativeThread: boolean;
  readonly placement: "main" | null;
};

type AsyncForSite = {
  readonly index: number;
  readonly statement: Extract<Statement, { kind: "for" }>;
  readonly generator: NonNullable<ReturnType<typeof parseAsyncGeneratorType>>;
  readonly generatorType: string;
  readonly handleBinding: string | null;
  readonly resultBinding: string;
  readonly elementBinding: string;
};

type PlacementTarget = {
  readonly target: AsyncTarget;
  readonly captures: readonly {
    readonly name: string;
    readonly type: string;
    readonly mode: "copy" | "in" | "inout" | "move";
    readonly kind: "plain" | "string" | "class" | "executorBoundClass" | "objc" | "taskScope" | "taskControl" | "borrow" | "owned";
    readonly location: SourceLocation;
  }[];
};

type NestedAwaitSite = {
  readonly expression: Expression;
  readonly await: AwaitSite;
  readonly type: string;
  readonly field: string;
};

type AsyncMatchSite = {
  readonly match: MatchStatement | MatchExpression;
  readonly subjectType: string;
  readonly subjectBinding: string | null;
};

type AsyncValueMatchSite = AsyncMatchSite & {
  readonly destination: string;
  readonly destinationType: string;
  readonly terminal: boolean;
  readonly endLabel: number;
};

type AsyncValueBranchSite = {
  readonly destination: string;
  readonly destinationType: string;
  readonly terminal: boolean;
  readonly endLabel: number;
};

type AsyncOperation =
  | { readonly kind: "statement"; readonly statement: Statement }
  | { readonly kind: "scopeEnter"; readonly scope: number; readonly name: string }
  | { readonly kind: "scopeExit"; readonly scope: number; readonly name: string | null; readonly cancel: boolean }
  | { readonly kind: "localCleanup"; readonly name: string; readonly type: string }
  | { readonly kind: "branch"; readonly condition: Expression; readonly thenLabel: number; readonly elseLabel: number }
  | {
    readonly kind: "forBranch";
    readonly statement: Extract<Statement, { kind: "for" }>;
    readonly indexBinding: string;
    readonly bodyLabel: number;
    readonly elseLabel: number;
  }
  | { readonly kind: "forIncrement"; readonly indexBinding: string }
  | { readonly kind: "asyncForInitialize"; readonly site: AsyncForSite }
  | { readonly kind: "asyncForBegin"; readonly site: AsyncForSite }
  | {
    readonly kind: "asyncForComplete";
    readonly site: AsyncForSite;
    readonly bodyLabel: number;
    readonly exhaustedLabel: number;
  }
  | { readonly kind: "asyncForCleanup"; readonly site: AsyncForSite; readonly destroyHandle: boolean }
  | { readonly kind: "matchInitialize"; readonly site: AsyncMatchSite }
  | {
    readonly kind: "matchDispatch";
    readonly site: AsyncMatchSite;
    readonly armLabels: readonly number[];
  }
  | {
    readonly kind: "matchBind";
    readonly site: AsyncMatchSite;
    readonly armIndex: number;
  }
  | { readonly kind: "matchCleanup"; readonly site: AsyncMatchSite; readonly armIndex: number }
  | {
    readonly kind: "matchSelect";
    readonly site: AsyncValueMatchSite;
    readonly armIndex: number;
    readonly expression: Expression;
  }
  | {
    readonly kind: "branchSelect";
    readonly site: AsyncValueBranchSite;
    readonly expression: Expression;
  }
  | { readonly kind: "jump"; readonly label: number }
  | { readonly kind: "label"; readonly label: number };

type AsyncTarget = {
  readonly declaration: FunctionDeclaration;
  readonly owner: StructDeclaration | null;
  readonly foreign?: ForeignAsyncProjection;
  readonly nativeThreadMode?: "sync" | "async";
};

type ForeignAsyncProjection = NonNullable<ObjCCallInfo["async"]> & {
  readonly className: string;
  readonly selector: string;
};

type AsyncFunctionPlan = {
  readonly declaration: FunctionDeclaration;
  readonly owner: StructDeclaration | null;
  readonly foreign: ForeignAsyncProjection | null;
  readonly nativeThread: boolean;
  readonly asyncNativeThread: boolean;
  readonly generator: ReturnType<typeof parseAsyncGeneratorType>;
  readonly frameName: string;
  readonly pollName: string;
  readonly startName: string;
  readonly destroyName: string;
  readonly operations: readonly AsyncOperation[];
  readonly locals: ReadonlyMap<string, string>;
  readonly borrowedLocals: ReadonlySet<string>;
  readonly mutableBorrowedLocals: ReadonlySet<string>;
  readonly awaits: ReadonlyMap<number, AwaitSite>;
  readonly nestedAwaits: ReadonlyMap<number, readonly NestedAwaitSite[]>;
  readonly suspensions: ReadonlyMap<number, NestedAwaitSite>;
  readonly spawns: ReadonlyMap<number, SpawnSite>;
  readonly asyncForSites: readonly AsyncForSite[];
  readonly children: ReadonlyMap<number, AsyncTarget>;
  readonly types: AsyncTypeContext;
};

function asyncGeneratorAdvanceType(generator: NonNullable<ReturnType<typeof parseAsyncGeneratorType>>): string {
  return generator.returnType
    ? generatorStepTypeName(generator.elementType, generator.returnType)
    : optionTypeName(generator.elementType);
}

function planSuccessType(plan: Pick<AsyncFunctionPlan, "declaration" | "generator">): string {
  return plan.generator
    ? asyncGeneratorAdvanceType(plan.generator)
    : plan.declaration.returnType.name;
}

type AsyncTypeContext = {
  readonly structs: ReadonlyMap<string, StructDeclaration>;
  readonly enums: ReadonlyMap<string, EnumDeclaration>;
  readonly functions: ReadonlyMap<string, FunctionDeclaration>;
  readonly semanticInfo: SemanticInfo;
  readonly foreignTargets: ReadonlyMap<number, AsyncTarget>;
};

type FrameExpressionContext = {
  readonly locals: ReadonlyMap<string, string>;
  readonly borrowedLocals?: ReadonlySet<string>;
  readonly types: AsyncTypeContext;
  readonly bindings?: ReadonlyMap<string, string>;
  readonly expressionBindings?: ReadonlyMap<number, string>;
  readonly suspensions?: ReadonlyMap<number, NestedAwaitSite>;
};

export type AsyncCGeneration = {
  readonly synchronousProgram: Program;
  readonly source: string;
  readonly frameworks: readonly string[];
};

const scalarTypes = new Map<string, string>([
  ["i8", "int8_t"],
  ["u8", "uint8_t"],
  ["i16", "int16_t"],
  ["u16", "uint16_t"],
  ["i32", "int32_t"],
  ["u32", "uint32_t"],
  ["i64", "int64_t"],
  ["u64", "uint64_t"],
  ["isize", "intptr_t"],
  ["usize", "uintptr_t"],
  ["f32", "float"],
  ["f64", "double"],
  ["boolean", "bool"],
  ["void", "void"],
  ["cstring", "const char *"],
]);

const safeBinaryOperators = new Set([
  "==", "!=", "<", "<=", ">", ">=", "&&", "||",
]);

const finalizeStateMarker = "__Z_ASYNC_FINALIZE_STATE__";

export function generateAsyncC(
  program: Program,
  fileName: string,
  semanticInfo: SemanticInfo,
): AsyncCGeneration {
  const sourceTargets: AsyncTarget[] = [
    ...program.functions.filter((declaration) => declaration.async).map((declaration) => ({
      declaration,
      owner: null,
    })),
    ...program.structs.flatMap((owner) => owner.methods.filter((method) => method.async).map((declaration) => ({
      declaration,
      owner,
    }))),
  ];
  const threadTargets = new Map<number, AsyncTarget>();
  for (const [callOffset, closureOffset] of semanticInfo.threadSpawnCalls) {
    const closure = semanticInfo.closures.get(closureOffset)!;
    const directVoidReturn = closure.declaration.returnType.name === "void"
      && closure.declaration.errorType === null
      && closure.declaration.body.length === 1
      && closure.declaration.body[0].kind === "return"
      && closure.declaration.body[0].expression;
    const captureCount = closure.captures.length;
    threadTargets.set(callOffset, {
      owner: null,
      nativeThreadMode: closure.declaration.async ? "async" : "sync",
      declaration: {
        ...closure.declaration,
        name: `__z_thread_job_${callOffset}`,
        async: true,
        parameters: closure.declaration.parameters.map((parameter, index) => (
          index < captureCount ? { ...parameter, mode: "value" } : parameter
        )),
        body: directVoidReturn
          ? [{
              kind: "expressionStatement",
              expression: directVoidReturn,
              location: directVoidReturn.location,
            }]
          : closure.declaration.body,
      },
    });
  }
  const taskScopeTargets = new Map<number, AsyncTarget>();
  for (const [callOffset, closureOffset] of semanticInfo.taskScopeAsyncCalls) {
    const closure = semanticInfo.closures.get(closureOffset)!;
    const directVoidReturn = closure.declaration.returnType.name === "void"
      && closure.declaration.errorType === null
      && closure.declaration.body.length === 1
      && closure.declaration.body[0].kind === "return"
      && closure.declaration.body[0].expression;
    taskScopeTargets.set(callOffset, {
      owner: null,
      declaration: {
        ...closure.declaration,
        name: `__z_task_scope_job_${callOffset}`,
        async: true,
        body: directVoidReturn
          ? [{
              kind: "expressionStatement",
              expression: directVoidReturn,
              location: directVoidReturn.location,
            }]
          : closure.declaration.body,
      },
    });
  }
  const foreignTargets = new Map<number, AsyncTarget>();
  for (const [callOffset, call] of semanticInfo.objcCalls) {
    if (!call.async) continue;
    const location: SourceLocation = { offset: callOffset, line: 1, column: 1, fileName };
    const visibleParameters = call.async.method.parameters.filter((_, index) => index !== call.async!.callbackParameter);
    const foreign: ForeignAsyncProjection = {
      ...call.async,
      className: call.className,
      selector: call.selector,
    };
    foreignTargets.set(callOffset, {
      owner: null,
      foreign,
      declaration: {
        kind: "function",
        name: `__z_foreign_async_${callOffset}`,
        async: true,
        receiverMode: null,
        parameters: visibleParameters.map((parameter, index) => ({
          name: parameter.name ?? `argument${index + 1}`,
          mode: "value",
          type: { name: call.async!.parameterTypes[index], location },
          location,
        })),
        returnType: { name: call.async.resultType, location },
        errorType: call.async.errorType ? { name: call.async.errorType, location } : null,
        body: [],
        location,
      },
    });
  }
  const targets: AsyncTarget[] = [
    ...sourceTargets,
    ...threadTargets.values(),
    ...taskScopeTargets.values(),
    ...foreignTargets.values(),
  ];
  const functions = new Map(
    targets.filter((target) => !target.owner).map((target) => [target.declaration.name, target]),
  );
  const types: AsyncTypeContext = {
    structs: new Map(program.structs.map((declaration) => [declaration.name, declaration])),
    enums: new Map(program.enums.map((declaration) => [declaration.name, declaration])),
    functions: new Map(program.functions.map((declaration) => [declaration.name, declaration])),
    semanticInfo,
    foreignTargets,
  };
  const placementTargets = new Map<number, PlacementTarget>();
  const registerPlacement = (
    expression: Extract<Expression, { kind: "executorPlacement" }>,
    locals: ReadonlyMap<string, string>,
    fromNativeThread: boolean,
  ): PlacementTarget => {
    const existing = placementTargets.get(expression.location.offset);
    if (existing) return existing;
    const created = createPlacementTarget(expression, locals, types, fileName, fromNativeThread);
    placementTargets.set(expression.location.offset, created);
    targets.push(created.target);
    functions.set(created.target.declaration.name, created.target);
    return created;
  };
  const plans: AsyncFunctionPlan[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    plans.push(planFunction(
      targets[index],
      functions,
      threadTargets,
      fileName,
      semanticInfo,
      types,
      registerPlacement,
    ));
  }
  const planByKey = new Map(plans.map((plan) => [targetKey(plan), plan]));
  const main = planByKey.get("main");
  if (main) validateAsyncMain(main.declaration, fileName);

  const synchronousProgram: Program = {
    ...program,
    functions: program.functions.filter((declaration) => !declaration.async),
    structs: program.structs.map((owner) => ({
      ...owner,
      methods: owner.methods.filter((declaration) => !declaration.async),
    })),
  };

  const usesMainPlacement = plans.some((plan) => (
    [...plan.awaits.values()].some((site) => site.placement !== null)
    || [...plan.spawns.values()].some((site) => site.placement !== null)
  )) || semanticInfo.taskScopeSpawnCalls.size > 0 || semanticInfo.taskScopeAsyncCalls.size > 0;
  const usesNativeThreads = foreignTargets.size > 0
    || semanticInfo.taskScopeSpawnCalls.size > 0
    || semanticInfo.taskScopeAsyncCalls.size > 0
    || plans.some((plan) => [...plan.spawns.values()].some((site) => site.nativeThread));
  return {
    synchronousProgram,
    source: generateRuntime(plans, planByKey, main, taskScopeTargets, fileName),
    frameworks: usesMainPlacement && usesNativeThreads && process.platform === "darwin"
      ? ["CoreFoundation"]
      : [],
  };
}

function planFunction(
  target: AsyncTarget,
  functions: ReadonlyMap<string, AsyncTarget>,
  threadTargets: ReadonlyMap<number, AsyncTarget>,
  fileName: string,
  semanticInfo: SemanticInfo,
  types: AsyncTypeContext,
  registerPlacement: (
    expression: Extract<Expression, { kind: "executorPlacement" }>,
    locals: ReadonlyMap<string, string>,
    fromNativeThread: boolean,
  ) => PlacementTarget,
): AsyncFunctionPlan {
  const { declaration, owner } = target;
  const foreign = target.foreign ?? null;
  const nativeThread = target.nativeThreadMode !== undefined;
  const asyncNativeThread = target.nativeThreadMode === "async";
  const generator = parseAsyncGeneratorType(declaration.returnType.name);
  requireFrameType(
    generator ? asyncGeneratorAdvanceType(generator) : declaration.returnType.name,
    declaration.returnType.location,
    fileName,
    generator ? "async generator advancement" : "async return",
    types,
  );
  if (declaration.errorType) {
    requireFrameType(declaration.errorType.name, declaration.errorType.location, fileName, "async error", types);
  }
  const locals = new Map<string, string>();
  const borrowedLocals = new Set<string>();
  const mutableBorrowedLocals = new Set<string>();
  if (owner && !declaration.static) {
    requireFrameType(owner.name, declaration.location, fileName, "async receiver", types);
    locals.set("this", owner.name);
  }
  for (const parameter of declaration.parameters) {
    const slice = parseSliceType(parameter.type.name);
    if (
      parameter.mode !== "value"
      && parameter.mode !== "in"
      && parameter.mode !== "inout"
      && parameter.mode !== "out"
    ) {
      unsupported(fileName, parameter.location, "borrowed async parameters are not executable yet");
    }
    if (!slice && (parameter.mode === "in" || parameter.mode === "inout" || parameter.mode === "out")) {
      borrowedLocals.add(parameter.name);
    }
    if (!slice && (parameter.mode === "inout" || parameter.mode === "out")) mutableBorrowedLocals.add(parameter.name);
    requireFrameType(parameter.type.name, parameter.type.location, fileName, "async parameter", types);
    locals.set(parameter.name, parameter.type.name);
  }

  const awaits = new Map<number, AwaitSite>();
  const nestedAwaits = new Map<number, readonly NestedAwaitSite[]>();
  const suspensions = new Map<number, NestedAwaitSite>();
  const spawns = new Map<number, SpawnSite>();
  const asyncForSites: AsyncForSite[] = [];
  const spawnBindings = new Map<string, SpawnSite>();
  const children = new Map<number, AsyncTarget>();
  const joinedSpawns = new Set<number>();
  const nextChild = { value: 0 };
  const nextScope = { value: 1 };
  const nextLabel = { value: 0 };
  const operations: AsyncOperation[] = [];
  const loopTargets: {
    readonly breakLabel: number;
    readonly continueLabel: number;
    readonly matchCleanupDepth: number;
    readonly activeScopeDepth: number;
  }[] = [];
  const activeMatchCleanups: { readonly site: AsyncMatchSite; readonly armIndex: number }[] = [];
  const activeScopes: Array<{
    readonly scope: number;
    readonly name: string | null;
    readonly controlDepth: number;
    readonly cleanupLocals: { readonly name: string; readonly type: string }[];
  }> = [];
  const appendScopeExit = (
    activeScope: (typeof activeScopes)[number],
    cancel: boolean,
    cleanupLocals: boolean,
  ): void => {
    operations.push({
      kind: "scopeExit",
      scope: activeScope.scope,
      name: activeScope.name,
      cancel,
    });
    if (cleanupLocals) {
      for (const local of [...activeScope.cleanupLocals].reverse()) {
        operations.push({ kind: "localCleanup", name: local.name, type: local.type });
      }
    }
  };
  const ownedTaskScopes = new Set<string>();
  const unwindOwnedTaskScopes = (cancel: boolean): void => {
    for (const name of [...ownedTaskScopes].reverse()) {
      operations.push({ kind: "scopeExit", scope: 0, name, cancel });
    }
  };
  const recordAwait = (
    mode: AwaitSite["mode"],
    expression: Extract<Expression, { kind: "await" | "executorPlacement" }>,
  ): AwaitSite => {
    const site = awaitSite(
      mode,
      expression,
      functions,
      fileName,
      locals,
      types,
      spawnBindings,
      joinedSpawns,
      nextChild,
      registerPlacement,
      nativeThread,
    );
    awaits.set(expression.location.offset, site);
    if (!site.intrinsic && !site.generator) children.set(site.index, site.target);
    return site;
  };
  const recordNestedAwaits = (
    expression: Expression,
    group: Expression = expression,
    allowOwnedRoot = false,
  ): void => {
    const found = collectNestedAwaitOperations(expression, fileName);
    if (found.length === 0) return;
    const sites = found.map((operation) => {
      const site = recordAwait(operation.mode, operation.expression);
      const type = semanticInfo.expressionTypes.get(operation.source.location.offset)
        ?? nestedAwaitResultType(site);
      requireFrameType(type, operation.source.location, fileName, "nested await result", types);
      if (type === "void") {
        unsupported(fileName, operation.source.location, "a void await cannot be embedded in a value expression");
      }
      if (
        hasFrameCleanup(type, types)
        && !/^__z_Result_/.test(type)
        && !(allowOwnedRoot && operation.source.location.offset === group.location.offset)
      ) {
        unsupported(
          fileName,
          operation.source.location,
          "an ownership-bearing nested await result is not executable yet",
          "bind the awaited result first while hidden suspension-slot ownership transfer is implemented",
        );
      }
      const nested: NestedAwaitSite = {
        expression: operation.source,
        await: site,
        type,
        field: nestedAwaitField(operation.source.location.offset),
      };
      suspensions.set(operation.source.location.offset, nested);
      return nested;
    });
    nestedAwaits.set(group.location.offset, sites);
  };
  const matchNeedsPlanning = (expression: MatchExpression, destinationType: string): boolean => {
    if (asyncMatchExpressionNeedsPlanning(expression)) return true;
    if (hasFrameCleanup(destinationType, types)) return true;
    const subjectType = semanticInfo.expressionTypes.get(expression.expression.location.offset);
    return Boolean(
      subjectType
      && hasFrameCleanup(subjectType, types)
      && !semanticInfo.borrowedMatches.has(expression.location.offset),
    );
  };
  let planStatements: (statements: readonly Statement[], scope: number, controlDepth?: number) => void;
  const planValueMatch = (
    expression: MatchExpression,
    destination: string,
    destinationType: string,
    terminal: boolean,
    scope: number,
    controlDepth: number,
  ): void => {
    recordNestedAwaits(expression.expression);
    validateFrameExpression(expression.expression, locals, fileName, types, suspensions);
    const subjectType = semanticInfo.expressionTypes.get(expression.expression.location.offset);
    const declaration = subjectType ? types.enums.get(subjectType) : null;
    if (!subjectType || !declaration) {
      unsupported(fileName, expression.expression.location, "persistent async match requires an enum subject");
    }
    const borrowed = semanticInfo.borrowedMatches.has(expression.location.offset);
    const subjectBinding = borrowed ? null : `__z_async_match_subject_${expression.location.offset}`;
    const armLabels = expression.arms.map(() => nextLabel.value++);
    const endLabel = nextLabel.value++;
    const site: AsyncValueMatchSite = {
      match: expression,
      subjectType: subjectType!,
      subjectBinding,
      destination,
      destinationType,
      terminal,
      endLabel,
    };
    if (subjectBinding) {
      requireFrameType(subjectType!, expression.expression.location, fileName, "async match subject", types);
      locals.set(subjectBinding, subjectType!);
      operations.push({ kind: "matchInitialize", site });
    }
    operations.push({ kind: "matchDispatch", site, armLabels });
    expression.arms.forEach((arm, armIndex) => {
      operations.push({ kind: "label", label: armLabels[armIndex] });
      registerAsyncMatchBindings(
        site,
        armIndex,
        locals,
        borrowedLocals,
        types,
        semanticInfo,
        fileName,
      );
      operations.push({ kind: "matchBind", site, armIndex });
      if (!borrowed) activeMatchCleanups.push({ site, armIndex });

      const statements = arm.body.kind === "block" ? arm.body.statements : [arm.body];
      const final = statements.at(-1);
      if (!final) {
        unsupported(fileName, arm.body.location, "a value-producing async match arm cannot be empty");
      }
      const prefix = statements.slice(0, -1);
      if (prefix.length > 0) planStatements(prefix, scope, controlDepth + 1);
      if (final.kind === "expressionStatement" || final.kind === "select") {
        recordNestedAwaits(final.expression, final.expression, hasFrameCleanup(destinationType, types));
        validateFrameExpression(final.expression, locals, fileName, types, suspensions);
        operations.push({ kind: "matchSelect", site, armIndex, expression: final.expression });
      } else if (final.kind === "return" || final.kind === "throw") {
        planStatements([final], scope, controlDepth + 1);
      } else {
        unsupported(
          fileName,
          final.location,
          "a suspending async match arm must end with `select`, an expression, `return`, or `throw`",
        );
      }
      if (!borrowed) activeMatchCleanups.pop();
    });
    operations.push({ kind: "label", label: endLabel });
  };
  const needsBranchPlanning = (expression: Expression): boolean => {
    if (expression.kind === "ifExpression") return true;
    if (expression.kind === "unary") return needsBranchPlanning(expression.operand);
    return containsAwait(expression)
      && (
        expression.kind === "conditional"
        || (expression.kind === "binary" && (expression.operator === "&&" || expression.operator === "||"))
      );
  };
  let planSelectedBranchValue: (
    expression: Expression,
    site: AsyncValueBranchSite,
    scope: number,
    controlDepth: number,
  ) => void;
  const planBranchCondition = (
    expression: Expression,
    scope: number,
    controlDepth: number,
  ): Expression => {
    if (!needsBranchPlanning(expression)) {
      recordNestedAwaits(expression);
      validateFrameExpression(expression, locals, fileName, types, suspensions);
      return expression;
    }
    const binding = `__z_async_branch_condition_${expression.location.offset}`;
    if (locals.has(binding)) {
      throw new Error(`duplicate async branch condition ${expression.location.offset}`);
    }
    locals.set(binding, "boolean");
    const endLabel = nextLabel.value++;
    planSelectedBranchValue(
      expression,
      {
        destination: `frame->${frameField(binding)}`,
        destinationType: "boolean",
        terminal: false,
        endLabel,
      },
      scope,
      controlDepth,
    );
    operations.push({ kind: "label", label: endLabel });
    return {
      kind: "identifier",
      name: binding,
      location: expression.location,
    };
  };
  const planValueBranch = (
    expression: Expression,
    site: AsyncValueBranchSite,
    scope: number,
    controlDepth: number,
  ): void => {
    if (expression.kind === "unary" && needsBranchPlanning(expression.operand)) {
      const operand = planBranchCondition(expression.operand, scope, controlDepth);
      planSelectedBranchValue(
        { ...expression, operand },
        site,
        scope,
        controlDepth,
      );
      return;
    }
    if (expression.kind === "binary" && (expression.operator === "&&" || expression.operator === "||")) {
      const condition = planBranchCondition(expression.left, scope, controlDepth);
      const trueLabel = nextLabel.value++;
      const falseLabel = nextLabel.value++;
      operations.push({
        kind: "branch",
        condition,
        thenLabel: trueLabel,
        elseLabel: falseLabel,
      });
      operations.push({ kind: "label", label: trueLabel });
      planSelectedBranchValue(
        expression.operator === "&&"
          ? expression.right
          : { kind: "boolean", value: true, location: expression.location },
        site,
        scope,
        controlDepth,
      );
      operations.push({ kind: "label", label: falseLabel });
      planSelectedBranchValue(
        expression.operator === "&&"
          ? { kind: "boolean", value: false, location: expression.location }
          : expression.right,
        site,
        scope,
        controlDepth,
      );
      return;
    }
    if (expression.kind === "conditional") {
      const condition = planBranchCondition(expression.condition, scope, controlDepth);
      const thenLabel = nextLabel.value++;
      const elseLabel = nextLabel.value++;
      operations.push({
        kind: "branch",
        condition,
        thenLabel,
        elseLabel,
      });
      operations.push({ kind: "label", label: thenLabel });
      planSelectedBranchValue(expression.thenExpression, site, scope, controlDepth);
      operations.push({ kind: "label", label: elseLabel });
      planSelectedBranchValue(expression.elseExpression, site, scope, controlDepth);
      return;
    }
    if (expression.kind === "ifExpression") {
      const condition = planBranchCondition(expression.condition, scope, controlDepth);
      const thenLabel = nextLabel.value++;
      const elseLabel = nextLabel.value++;
      operations.push({
        kind: "branch",
        condition,
        thenLabel,
        elseLabel,
      });
      const planArm = (body: Extract<Statement, { kind: "block" }>): void => {
        const final = body.statements.at(-1);
        if (!final) {
          unsupported(fileName, body.location, "a value-producing async if branch cannot be empty");
        }
        const prefix = body.statements.slice(0, -1);
        if (prefix.length > 0) planStatements(prefix, scope, controlDepth + 1);
        if (final.kind === "select" || final.kind === "expressionStatement") {
          planSelectedBranchValue(final.expression, site, scope, controlDepth + 1);
        } else if (final.kind === "return" || final.kind === "throw") {
          planStatements([final], scope, controlDepth + 1);
        } else {
          unsupported(
            fileName,
            final.location,
            "a suspending value-producing if branch must end with `select`, `return`, or `throw`",
          );
        }
      };
      operations.push({ kind: "label", label: thenLabel });
      planArm(expression.thenBranch);
      operations.push({ kind: "label", label: elseLabel });
      if (expression.elseBranch.kind === "ifExpression") {
        planSelectedBranchValue(expression.elseBranch, site, scope, controlDepth + 1);
      } else {
        planArm(expression.elseBranch);
      }
      return;
    }
    unsupported(fileName, expression.location, "expected a branch-aware async value expression");
  };
  planSelectedBranchValue = (
    expression: Expression,
    site: AsyncValueBranchSite,
    scope: number,
    controlDepth: number,
  ): void => {
    if (needsBranchPlanning(expression)) {
      planValueBranch(expression, site, scope, controlDepth);
      return;
    }
    recordNestedAwaits(
      expression,
      expression,
      hasFrameCleanup(site.destinationType, types),
    );
    validateFrameExpression(expression, locals, fileName, types, suspensions);
    operations.push({ kind: "branchSelect", site, expression });
  };
  planStatements = (statements: readonly Statement[], scope: number, controlDepth = 0): void => {
    for (const statement of statements) {
      if (statement.kind === "asyncScope") {
        const childScope = nextScope.value++;
        if (statement.name) {
          requireFrameType("TaskScope", statement.nameLocation ?? statement.location, fileName, "named async scope", types);
          locals.set(statement.name, "TaskScope");
          operations.push({ kind: "scopeEnter", scope: childScope, name: statement.name });
        }
        const activeScope = {
          scope: childScope,
          name: statement.name,
          controlDepth,
          cleanupLocals: [],
        };
        activeScopes.push(activeScope);
        try {
          planStatements(statement.body.statements, childScope, controlDepth);
        } finally {
          activeScopes.pop();
        }
        appendScopeExit(activeScope, false, true);
        continue;
      }
      if (statement.kind === "if") {
        const condition = planBranchCondition(statement.condition, scope, controlDepth);
        const thenLabel = nextLabel.value++;
        const elseLabel = nextLabel.value++;
        const endLabel = nextLabel.value++;
        const incomingJoins = new Set(joinedSpawns);
        operations.push({ kind: "branch", condition, thenLabel, elseLabel });
        operations.push({ kind: "label", label: thenLabel });
        planStatements(statement.thenBranch.statements, scope, controlDepth + 1);
        const thenJoins = new Set(joinedSpawns);
        operations.push({ kind: "jump", label: endLabel });
        operations.push({ kind: "label", label: elseLabel });
        joinedSpawns.clear();
        for (const index of incomingJoins) joinedSpawns.add(index);
        if (statement.elseBranch?.kind === "block") {
          planStatements(statement.elseBranch.statements, scope, controlDepth + 1);
        } else if (statement.elseBranch?.kind === "if") {
          planStatements([statement.elseBranch], scope, controlDepth + 1);
        }
        const elseJoins = new Set(joinedSpawns);
        const continuingJoins: ReadonlySet<number>[] = [];
        if (!asyncStatementStopsFlow(statement.thenBranch)) continuingJoins.push(thenJoins);
        if (!statement.elseBranch || !asyncStatementStopsFlow(statement.elseBranch)) continuingJoins.push(elseJoins);
        joinedSpawns.clear();
        if (continuingJoins.length > 0) {
          for (const index of continuingJoins[0]) {
            if (continuingJoins.every((path) => path.has(index))) joinedSpawns.add(index);
          }
        } else {
          for (const index of incomingJoins) joinedSpawns.add(index);
        }
        operations.push({ kind: "label", label: endLabel });
        continue;
      }
      if (statement.kind === "while") {
        const conditionLabel = nextLabel.value++;
        const bodyLabel = nextLabel.value++;
        const endLabel = nextLabel.value++;
        operations.push({ kind: "label", label: conditionLabel });
        const condition = planBranchCondition(statement.condition, scope, controlDepth);
        operations.push({ kind: "branch", condition, thenLabel: bodyLabel, elseLabel: endLabel });
        operations.push({ kind: "label", label: bodyLabel });
        loopTargets.push({
          breakLabel: endLabel,
          continueLabel: conditionLabel,
          matchCleanupDepth: activeMatchCleanups.length,
          activeScopeDepth: activeScopes.length,
        });
        planStatements(statement.body.statements, scope, controlDepth + 1);
        loopTargets.pop();
        operations.push({ kind: "jump", label: conditionLabel });
        operations.push({ kind: "label", label: endLabel });
        continue;
      }
      if (statement.kind === "for") {
        if (statement.asynchronous) {
          const generatorType = semanticInfo.expressionTypes.get(statement.iterable.location.offset);
          const asyncGenerator = generatorType ? parseAsyncGeneratorType(generatorType) : null;
          if (
            !generatorType
            || !asyncGenerator
            || asyncGenerator.returnType
            || Boolean(asyncGenerator.errorType) !== (statement.errorMode === "try")
          ) {
            unsupported(
              fileName,
              statement.iterable.location,
              statement.errorMode === "try"
                ? "try for await requires a throwing AsyncGenerator<T, void, E> without a terminal return"
                : "for await requires a nonthrowing AsyncGenerator<T> without a terminal return",
            );
          }
          if (!statement.binding && !statement.objectBindings) {
            unsupported(fileName, statement.location, "for await requires an iteration binding");
          }
          requireFrameType(asyncGenerator.elementType, statement.bindingLocation ?? statement.location, fileName, "for await element", types);
          const resultType = optionTypeName(asyncGenerator.elementType);
          requireFrameType(resultType, statement.iterable.location, fileName, "for await advancement", types);
          const stored = statement.iterable.kind === "identifier"
            || statement.iterable.kind === "member"
            || statement.iterable.kind === "index";
          const handleBinding = stored ? null : `__z_async_for_handle_${statement.location.offset}`;
          const resultBinding = `__z_async_for_result_${statement.location.offset}`;
          const elementBinding = statement.binding ?? `__z_async_for_element_${statement.location.offset}`;
          if (handleBinding) locals.set(handleBinding, generatorType);
          locals.set(resultBinding, resultType);
          if (!statement.binding) {
            registerAsyncFrameBinding(
              elementBinding,
              asyncGenerator.elementType,
              false,
              statement.location,
              locals,
              borrowedLocals,
              fileName,
            );
          }
          registerAsyncForBindings(
            statement,
            asyncGenerator.elementType,
            false,
            locals,
            borrowedLocals,
            types,
            semanticInfo,
            fileName,
          );
          for (const binding of statement.objectBindings ?? []) {
            const fieldType = semanticInfo.bindingTypes.get(binding.bindingLocation.offset);
            if (!fieldType) unsupported(fileName, binding.bindingLocation, "could not determine for await field binding type");
            requireFrameType(fieldType!, binding.bindingLocation, fileName, "for await field", types);
          }
          validateFrameExpression(statement.iterable, locals, fileName, types, suspensions);
          const site: AsyncForSite = {
            index: nextChild.value++,
            statement,
            generator: asyncGenerator,
            generatorType,
            handleBinding,
            resultBinding,
            elementBinding,
          };
          asyncForSites.push(site);
          const conditionLabel = nextLabel.value++;
          const bodyLabel = nextLabel.value++;
          const continueCleanupLabel = nextLabel.value++;
          const breakCleanupLabel = nextLabel.value++;
          const endLabel = nextLabel.value++;
          if (handleBinding) operations.push({ kind: "asyncForInitialize", site });
          operations.push({ kind: "label", label: conditionLabel });
          operations.push({ kind: "asyncForBegin", site });
          operations.push({
            kind: "asyncForComplete",
            site,
            bodyLabel,
            exhaustedLabel: breakCleanupLabel,
          });
          operations.push({ kind: "label", label: bodyLabel });
          loopTargets.push({
            breakLabel: breakCleanupLabel,
            continueLabel: continueCleanupLabel,
            matchCleanupDepth: activeMatchCleanups.length,
            activeScopeDepth: activeScopes.length,
          });
          planStatements(statement.body.statements, scope, controlDepth + 1);
          loopTargets.pop();
          operations.push({ kind: "label", label: continueCleanupLabel });
          operations.push({ kind: "asyncForCleanup", site, destroyHandle: false });
          operations.push({ kind: "jump", label: conditionLabel });
          operations.push({ kind: "label", label: breakCleanupLabel });
          operations.push({ kind: "asyncForCleanup", site, destroyHandle: Boolean(handleBinding) });
          operations.push({ kind: "jump", label: endLabel });
          operations.push({ kind: "label", label: endLabel });
          continue;
        }
        if (statement.mode === "inout") {
          unsupported(fileName, statement.location, "async frame for...of does not support mutable element iteration");
        }
        const iterableType = semanticInfo.expressionTypes.get(statement.iterable.location.offset);
        const collection = iterableType ? asyncCollectionShape(iterableType, types) : null;
        if (!iterableType || !collection) {
          unsupported(
            fileName,
            statement.iterable.location,
            "persistent async for...of currently requires Array, fixed array, Slice, Map, or Set storage",
          );
        }
        if (
          statement.iterable.kind !== "identifier"
          && statement.iterable.kind !== "member"
          && statement.iterable.kind !== "index"
        ) {
          unsupported(
            fileName,
            statement.iterable.location,
            "persistent async for...of requires stored iterable storage",
            "bind the collection before entering the loop",
          );
        }
        const indexBinding = `__z_async_for_index_${statement.location.offset}`;
        locals.set(indexBinding, "usize");
        registerAsyncForBindings(
          statement,
          collection.elementType,
          collection.borrowedElement,
          locals,
          borrowedLocals,
          types,
          semanticInfo,
          fileName,
        );
        validateFrameExpression(statement.iterable, locals, fileName, types, suspensions);
        const conditionLabel = nextLabel.value++;
        const bodyLabel = nextLabel.value++;
        const incrementLabel = nextLabel.value++;
        const endLabel = nextLabel.value++;
        operations.push({
          kind: "statement",
          statement: {
            kind: "assignment",
            target: { kind: "identifier", name: indexBinding, location: statement.location },
            expression: { kind: "number", value: "0", location: statement.location },
            location: statement.location,
          },
        });
        operations.push({ kind: "label", label: conditionLabel });
        operations.push({ kind: "forBranch", statement, indexBinding, bodyLabel, elseLabel: endLabel });
        operations.push({ kind: "label", label: bodyLabel });
        loopTargets.push({
          breakLabel: endLabel,
          continueLabel: incrementLabel,
          matchCleanupDepth: activeMatchCleanups.length,
          activeScopeDepth: activeScopes.length,
        });
        planStatements(statement.body.statements, scope, controlDepth + 1);
        loopTargets.pop();
        operations.push({ kind: "label", label: incrementLabel });
        operations.push({ kind: "forIncrement", indexBinding });
        operations.push({ kind: "jump", label: conditionLabel });
        operations.push({ kind: "label", label: endLabel });
        continue;
      }
      if (statement.kind === "match") {
        recordNestedAwaits(statement.expression);
        validateFrameExpression(statement.expression, locals, fileName, types, suspensions);
        const subjectType = semanticInfo.expressionTypes.get(statement.expression.location.offset);
        const declaration = subjectType ? types.enums.get(subjectType) : null;
        if (!subjectType || !declaration) {
          unsupported(fileName, statement.expression.location, "persistent async match requires an enum subject");
        }
        const borrowed = semanticInfo.borrowedMatches.has(statement.location.offset);
        const subjectBinding = borrowed ? null : `__z_async_match_subject_${statement.location.offset}`;
        const site: AsyncMatchSite = { match: statement, subjectType: subjectType!, subjectBinding };
        if (subjectBinding) {
          requireFrameType(subjectType!, statement.expression.location, fileName, "async match subject", types);
          locals.set(subjectBinding, subjectType!);
          operations.push({ kind: "matchInitialize", site });
        }
        const armLabels = statement.arms.map(() => nextLabel.value++);
        const endLabel = nextLabel.value++;
        operations.push({ kind: "matchDispatch", site, armLabels });
        statement.arms.forEach((arm, armIndex) => {
          operations.push({ kind: "label", label: armLabels[armIndex] });
          registerAsyncMatchBindings(
            site,
            armIndex,
            locals,
            borrowedLocals,
            types,
            semanticInfo,
            fileName,
          );
          operations.push({ kind: "matchBind", site, armIndex });
          if (!borrowed) activeMatchCleanups.push({ site, armIndex });
          planStatements(
            arm.body.kind === "block" ? arm.body.statements : [arm.body],
            scope,
            controlDepth + 1,
          );
          if (!borrowed) activeMatchCleanups.pop();
          if (!asyncStatementStopsFlow(arm.body)) {
            if (!borrowed) operations.push({ kind: "matchCleanup", site, armIndex });
            operations.push({ kind: "jump", label: endLabel });
          }
        });
        operations.push({ kind: "label", label: endLabel });
        continue;
      }
      if (statement.kind === "break" || statement.kind === "continue") {
        const loop = loopTargets.at(-1);
        if (!loop) unsupported(fileName, statement.location, `${statement.kind} requires an enclosing async loop`);
        for (const cleanup of activeMatchCleanups.slice(loop.matchCleanupDepth).reverse()) {
          operations.push({ kind: "matchCleanup", site: cleanup.site, armIndex: cleanup.armIndex });
        }
        for (const activeScope of activeScopes.slice(loop.activeScopeDepth).reverse()) {
          appendScopeExit(activeScope, false, true);
        }
        operations.push({
          kind: "jump",
          label: statement.kind === "break" ? loop.breakLabel : loop.continueLabel,
        });
        continue;
      }
      if ((statement.kind === "return" || statement.kind === "throw") && activeScopes.length > 0) {
        for (const activeScope of [...activeScopes].reverse()) {
          // The final frame destroy cleans scope locals after the return/throw
          // expression has transferred its value. Eager cleanup here would make
          // returning a scope-local owner observe destroyed storage.
          appendScopeExit(activeScope, statement.kind === "throw", false);
        }
      }
      if (statement.kind === "return" || statement.kind === "throw") {
        unwindOwnedTaskScopes(statement.kind === "throw");
      }
      operations.push({ kind: "statement", statement });
      if (statement.kind === "variable") {
        const threadSpawn = statement.initializer?.kind === "call"
          && semanticInfo.threadSpawnCalls.has(statement.initializer.location.offset);
        if (scope !== 0 && locals.has(statement.name)) {
          unsupported(
            fileName,
            statement.nameLocation,
            "shadowing an async frame binding inside `async scope` is not executable yet",
          );
        }
        const type = statement.type?.name ?? semanticInfo.bindingTypes.get(statement.nameLocation.offset);
        if (!type) unsupported(fileName, statement.location, `could not determine async frame type for ${JSON.stringify(statement.name)}`);
        requireFrameType(type, statement.type?.location ?? statement.nameLocation, fileName, "async local", types);
        if (!statement.initializer && hasFrameCleanup(type, types)) {
          unsupported(
            fileName,
            statement.location,
            "an uninitialized ownership-bearing async local needs live-storage transition lowering",
            "initialize the binding immediately, or use a cleanup-free out destination in this tier",
          );
        }
        if (controlDepth > 0 && locals.has(statement.name)) {
          unsupported(
            fileName,
            statement.nameLocation,
            "shadowing or reusing an async frame binding inside conditional control flow is not executable yet",
          );
        }
        const owningAsyncScope = scope === 0
          ? null
          : [...activeScopes].reverse().find((candidate) => candidate.scope === scope) ?? null;
        if (
          controlDepth > 0
          && hasFrameCleanup(type, types)
          && (!owningAsyncScope || controlDepth > owningAsyncScope.controlDepth)
        ) {
          unsupported(
            fileName,
            statement.nameLocation,
            "a cleanup-bearing conditional-local binding needs lexical frame cleanup states",
          );
        }
        locals.set(statement.name, type);
        if (scope !== 0 && hasFrameCleanup(type, types)) {
          const activeScope = [...activeScopes].reverse().find((candidate) => candidate.scope === scope);
          if (!activeScope) {
            throw new Error(`missing active async scope ${scope} for local ${JSON.stringify(statement.name)}`);
          }
          activeScope.cleanupLocals.push({ name: statement.name, type });
        }
        if (
          statement.initializer?.kind === "new"
          && semanticInfo.taskScopeConstructors.has(statement.initializer.location.offset)
        ) {
          ownedTaskScopes.add(statement.name);
        }
        if (!statement.initializer) continue;
        if (needsBranchPlanning(statement.initializer)) {
          operations.pop();
          const endLabel = nextLabel.value++;
          const site: AsyncValueBranchSite = {
            destination: `frame->${frameField(statement.name)}`,
            destinationType: type,
            terminal: false,
            endLabel,
          };
          planSelectedBranchValue(statement.initializer, site, scope, controlDepth);
          operations.push({ kind: "label", label: endLabel });
          continue;
        }
        if (
          statement.initializer.kind === "matchExpression"
          && matchNeedsPlanning(statement.initializer, type)
        ) {
          operations.pop();
          planValueMatch(
            statement.initializer,
            `frame->${frameField(statement.name)}`,
            type,
            false,
            scope,
            controlDepth,
          );
          continue;
        }
        if (
          statement.initializer.kind === "spawn"
          || (statement.initializer.kind === "executorPlacement" && statement.initializer.mode === "spawn")
        ) {
          if (statement.initializer.kind === "spawn") {
            recordNestedAwaits(statement.initializer.expression, statement.initializer);
          }
          const site = statement.initializer.kind === "spawn"
            ? spawnSite(
                nextChild.value++,
                scope,
                statement.initializer,
                statement.name,
                functions,
                fileName,
                locals,
                types,
              )
            : placementSpawnSite(
                nextChild.value++,
                scope,
                statement.initializer,
                statement.name,
                functions,
                locals,
                types,
                registerPlacement,
                nativeThread,
              );
          spawns.set(statement.initializer.location.offset, site);
          spawnBindings.set(statement.name, site);
          children.set(site.index, site.target);
          continue;
        }
        if (threadSpawn && statement.initializer.kind === "call") {
          const site = threadSpawnSite(
            nextChild.value++,
            scope,
            statement.initializer,
            statement.name,
            threadTargets,
            semanticInfo,
            fileName,
          );
          spawns.set(statement.initializer.location.offset, site);
          spawnBindings.set(statement.name, site);
          children.set(site.index, site.target);
          continue;
        }
        const operation = awaitOperation(statement.initializer);
        if (operation) {
          if (operation.expression.kind === "await") {
            recordNestedAwaits(operation.expression.expression, operation.source);
          }
          recordAwait(operation.mode, operation.expression);
        } else if (nativeThread && statement.initializer.kind === "try") {
          validateThreadTryCall(statement.initializer.expression, fileName, types);
          validateFrameExpression(statement.initializer.expression, locals, fileName, types, suspensions);
        } else if (statement.initializer.kind === "matchExpression") {
          recordNestedAwaits(statement.initializer);
          validateAsyncMatchExpression(statement.initializer, locals, fileName, types, suspensions);
        } else {
          recordNestedAwaits(statement.initializer);
          validateFrameExpression(statement.initializer, locals, fileName, types, suspensions);
        }
        continue;
      }
      if (statement.kind === "assignment") {
        recordNestedAwaits(statement.target);
        recordNestedAwaits(statement.expression);
        validateFrameExpression(statement.target, locals, fileName, types, suspensions);
        validateFrameExpression(statement.expression, locals, fileName, types, suspensions);
        continue;
      }
      if (statement.kind === "return") {
        if (statement.expression && needsBranchPlanning(statement.expression)) {
          operations.pop();
          const site: AsyncValueBranchSite = {
            destination: "frame->result",
            destinationType: declaration.returnType.name,
            terminal: true,
            endLabel: nextLabel.value++,
          };
          planSelectedBranchValue(statement.expression, site, scope, controlDepth);
          continue;
        }
        if (
          statement.expression?.kind === "matchExpression"
          && matchNeedsPlanning(statement.expression, declaration.returnType.name)
        ) {
          operations.pop();
          planValueMatch(
            statement.expression,
            "frame->result",
            declaration.returnType.name,
            true,
            scope,
            controlDepth,
          );
          continue;
        }
        const operation = statement.expression ? awaitOperation(statement.expression) : null;
        if (operation) {
          if (operation.expression.kind === "await") {
            recordNestedAwaits(operation.expression.expression, operation.source);
          }
          recordAwait(operation.mode, operation.expression);
        } else if (statement.expression?.kind === "matchExpression") {
          recordNestedAwaits(statement.expression);
          validateAsyncMatchExpression(statement.expression, locals, fileName, types, suspensions);
        } else if (nativeThread && statement.expression?.kind === "try") {
          validateThreadTryCall(statement.expression.expression, fileName, types);
          validateFrameExpression(statement.expression.expression, locals, fileName, types, suspensions);
        } else if (statement.expression) {
          recordNestedAwaits(statement.expression);
          validateFrameExpression(statement.expression, locals, fileName, types, suspensions);
        }
        continue;
      }
      if (statement.kind === "throw") {
        recordNestedAwaits(statement.expression);
        validateFrameExpression(statement.expression, locals, fileName, types, suspensions);
        continue;
      }
      if (statement.kind === "yield") {
        if (!generator) {
          unsupported(fileName, statement.location, "`yield` requires an AsyncGenerator return type in an async frame");
        }
        recordNestedAwaits(statement.expression);
        validateFrameExpression(statement.expression, locals, fileName, types, suspensions);
        continue;
      }
      if (statement.kind === "expressionStatement") {
        if (
          statement.expression.kind === "spawn"
          || (statement.expression.kind === "executorPlacement" && statement.expression.mode === "spawn")
        ) {
          if (statement.expression.kind === "spawn") {
            recordNestedAwaits(statement.expression.expression, statement.expression);
          }
          const site = statement.expression.kind === "spawn"
            ? spawnSite(
                nextChild.value++,
                scope,
                statement.expression,
                null,
                functions,
                fileName,
                locals,
                types,
              )
            : placementSpawnSite(
                nextChild.value++,
                scope,
                statement.expression,
                null,
                functions,
                locals,
                types,
                registerPlacement,
                nativeThread,
              );
          spawns.set(statement.expression.location.offset, site);
          children.set(site.index, site.target);
          continue;
        }
        if (
          statement.expression.kind === "call"
          && semanticInfo.consoleCalls.has(statement.expression.location.offset)
        ) {
          recordNestedAwaits(statement.expression);
          validateAsyncConsoleCall(statement.expression, locals, fileName, types, suspensions);
          continue;
        }
        const operation = awaitOperation(statement.expression);
        if (operation) {
          if (operation.expression.kind === "await") {
            recordNestedAwaits(operation.expression.expression, operation.source);
          }
          recordAwait(operation.mode, operation.expression);
          continue;
        }
        if (statement.expression.kind === "call") {
          recordNestedAwaits(statement.expression);
          validateFrameExpression(statement.expression, locals, fileName, types, suspensions);
          continue;
        }
        unsupported(fileName, statement.location, "this synchronous async expression statement is not executable yet");
      }
      unsupported(
        fileName,
        statement.location,
        `statement ${JSON.stringify(statement.kind)} is not executable in the first Phase 1 async slice`,
        "the current state-machine lowering supports owned bindings, direct await, task, throw, and return",
      );
    }
  };
  planStatements(declaration.body, 0);
  unwindOwnedTaskScopes(false);

  const unjoinedThrowing = [...spawns.values()].find((site) => (
    !joinedSpawns.has(site.index) && site.target.declaration.errorType
  ));
  if (unjoinedThrowing) {
    unsupported(
      fileName,
      unjoinedThrowing.expression.location,
      "a throwing child task must be joined explicitly",
      "bind the child task and acknowledge its error with `try await` or `attempt await`",
    );
  }

  const part = nativePart(owner ? `${owner.name}_${declaration.name}` : declaration.name);
  return {
    declaration,
    owner,
    foreign,
    nativeThread,
    asyncNativeThread,
    generator,
    frameName: `Z_AsyncFrame_${part}`,
    pollName: `z_async_poll_${part}`,
    startName: `z_async_start_${part}`,
    destroyName: `z_async_destroy_${part}`,
    operations,
    locals,
    borrowedLocals,
    mutableBorrowedLocals,
    awaits,
    nestedAwaits,
    suspensions,
    spawns,
    asyncForSites,
    children,
    types,
  };
}

function asyncCollectionShape(
  type: string,
  types: AsyncTypeContext,
): {
  readonly elementType: string;
  readonly fixedLength: number | null;
  readonly storageMember: "entries" | "values" | null;
  readonly borrowedElement: boolean;
} | null {
  const fixed = parseFixedArrayType(type);
  if (fixed) {
    return {
      elementType: fixed.elementType,
      fixedLength: fixed.length,
      storageMember: null,
      borrowedElement: hasFrameCleanup(fixed.elementType, types),
    };
  }
  const dynamic = parseDynamicArrayType(type);
  if (dynamic) {
    return {
      elementType: dynamic.elementType,
      fixedLength: null,
      storageMember: null,
      borrowedElement: hasFrameCleanup(dynamic.elementType, types),
    };
  }
  const slice = parseSliceType(type);
  if (slice) {
    return {
      elementType: slice.elementType,
      fixedLength: null,
      storageMember: null,
      borrowedElement: hasFrameCleanup(slice.elementType, types),
    };
  }
  const map = parseMapType(type);
  if (map) {
    return {
      elementType: mapEntryTypeName(map.keyType, map.valueType),
      fixedLength: null,
      storageMember: "entries",
      borrowedElement: true,
    };
  }
  const set = parseSetType(type);
  if (set) {
    return {
      elementType: set.elementType,
      fixedLength: null,
      storageMember: "values",
      borrowedElement: true,
    };
  }
  return null;
}

function registerAsyncFrameBinding(
  name: string,
  type: string,
  borrowed: boolean,
  location: SourceLocation,
  locals: Map<string, string>,
  borrowedLocals: Set<string>,
  fileName: string,
): void {
  const existing = locals.get(name);
  if (existing && existing !== type) {
    unsupported(
      fileName,
      location,
      `persistent async control flow cannot reuse binding ${JSON.stringify(name)} with both ${JSON.stringify(existing)} and ${JSON.stringify(type)}`,
      "use distinct binding names in suspending branches",
    );
  }
  locals.set(name, type);
  if (borrowed) borrowedLocals.add(name);
}

function registerAsyncForBindings(
  statement: Extract<Statement, { kind: "for" }>,
  elementType: string,
  borrowedElement: boolean,
  locals: Map<string, string>,
  borrowedLocals: Set<string>,
  types: AsyncTypeContext,
  semanticInfo: SemanticInfo,
  fileName: string,
): void {
  if (statement.binding && statement.bindingLocation) {
    registerAsyncFrameBinding(
      statement.binding,
      elementType,
      borrowedElement,
      statement.bindingLocation,
      locals,
      borrowedLocals,
      fileName,
    );
  }
  const aggregate = types.structs.get(elementType);
  for (const binding of statement.objectBindings ?? []) {
    const type = semanticInfo.bindingTypes.get(binding.bindingLocation.offset)
      ?? aggregate?.fields.find((field) => field.name === binding.fieldName)?.type.name;
    if (!type) unsupported(fileName, binding.bindingLocation, "could not determine persistent for...of binding type");
    registerAsyncFrameBinding(
      binding.bindingName,
      type!,
      borrowedElement && hasFrameCleanup(type!, types),
      binding.bindingLocation,
      locals,
      borrowedLocals,
      fileName,
    );
  }
}

function registerAsyncMatchBindings(
  site: AsyncMatchSite,
  armIndex: number,
  locals: Map<string, string>,
  borrowedLocals: Set<string>,
  types: AsyncTypeContext,
  semanticInfo: SemanticInfo,
  fileName: string,
): void {
  const { match: statement, subjectType } = site;
  const declaration = types.enums.get(subjectType);
  const arm = statement.arms[armIndex];
  const variant = declaration?.variants.find((candidate) => candidate.name === arm.variantName);
  if (!declaration || !variant) {
    unsupported(fileName, statement.location, "persistent async match requires a materialized enum subject");
  }
  if (arm.binding && arm.bindingLocation && variant!.payload) {
    requireFrameType(variant!.payload.name, arm.bindingLocation, fileName, "async match payload", types);
    const borrowed = site.subjectBinding === null;
    if (
      locals.has(arm.binding)
      && borrowedLocals.has(arm.binding) !== borrowed
      && hasFrameCleanup(variant!.payload.name, types)
    ) {
      unsupported(
        fileName,
        arm.bindingLocation,
        `persistent async control flow cannot reuse cleanup-bearing binding ${JSON.stringify(arm.binding)} as both borrowed and owned storage`,
        "use distinct binding names for borrowed and consuming match arms",
      );
    }
    registerAsyncFrameBinding(
      arm.binding,
      variant!.payload.name,
      borrowed,
      arm.bindingLocation,
      locals,
      borrowedLocals,
      fileName,
    );
  }
  const payload = variant!.payload ? types.structs.get(variant!.payload.name) : null;
  for (const binding of arm.objectBindings ?? []) {
    const type = semanticInfo.bindingTypes.get(binding.bindingLocation.offset)
      ?? payload?.fields.find((field) => field.name === binding.fieldName)?.type.name;
    if (!type) unsupported(fileName, binding.bindingLocation, "could not determine persistent match binding type");
    requireFrameType(type!, binding.bindingLocation, fileName, "async match field", types);
    registerAsyncFrameBinding(
      binding.bindingName,
      type!,
      true,
      binding.bindingLocation,
      locals,
      borrowedLocals,
      fileName,
    );
  }
}

function awaitSite(
  mode: AwaitSite["mode"],
  expression: Extract<Expression, { kind: "await" | "executorPlacement" }>,
  functions: ReadonlyMap<string, AsyncTarget>,
  fileName: string,
  locals: ReadonlyMap<string, string>,
  types: AsyncTypeContext,
  spawnBindings: ReadonlyMap<string, SpawnSite>,
  joinedSpawns: Set<number>,
  nextChild: { value: number },
  registerPlacement: (
    expression: Extract<Expression, { kind: "executorPlacement" }>,
    locals: ReadonlyMap<string, string>,
    fromNativeThread: boolean,
  ) => PlacementTarget,
  fromNativeThread: boolean,
): AwaitSite {
  if (expression.kind === "executorPlacement") {
    if (expression.call) {
      const resolved = tryResolveAsyncCall(expression.call, functions, locals, types);
      if (resolved) {
        return {
          index: nextChild.value++,
          mode,
          intrinsic: null,
          expression,
          call: expression.call,
          target: resolved.target,
          receiver: resolved.receiver,
          spawn: null,
          placement: expression.mode,
          generator: null,
        };
      }
    }
    const placement = registerPlacement(expression, locals, fromNativeThread);
    return {
      index: nextChild.value++,
      mode,
      intrinsic: null,
      expression,
      call: placementCall(expression, placement),
      target: placement.target,
      receiver: null,
      spawn: null,
      placement: expression.mode,
      generator: null,
    };
  }
  if (expression.expression.kind === "identifier" && parseTaskType(locals.get(expression.expression.name) ?? "")) {
    const spawn = spawnBindings.get(expression.expression.name);
    if (!spawn) {
      unsupported(fileName, expression.location, "awaiting task parameters or aliases is not executable yet");
    }
    if (joinedSpawns.has(spawn.index)) {
      unsupported(fileName, expression.location, "a child task handle can only be joined once");
    }
    joinedSpawns.add(spawn.index);
    return {
      index: spawn.index,
      mode,
      intrinsic: null,
      expression,
      call: spawn.call,
      target: spawn.target,
      receiver: null,
      spawn,
      placement: null,
      generator: null,
    };
  }
  if (expression.expression.kind !== "call") {
    unsupported(
      fileName,
      expression.location,
      "the current Phase 1 slice awaits direct async calls only",
    );
  }
  const call = expression.expression;
  if (
    call.callee.kind === "member"
    && (call.callee.property === "close" || call.callee.property === "cancel")
  ) {
    const receiverType = types.semanticInfo.expressionTypes.get(call.callee.object.location.offset)
      ?? (call.callee.object.kind === "identifier" ? locals.get(call.callee.object.name) : null);
    if (receiverType === "TaskScope") {
      return {
        index: nextChild.value++,
        mode,
        intrinsic: call.callee.property === "close" ? "scopeClose" : "scopeCancel",
        expression,
        call,
        target: intrinsicTaskScopeTarget(call.location),
        receiver: call.callee.object,
        spawn: null,
        placement: null,
        generator: null,
      };
    }
  }
  if (
    call.callee.kind === "member"
    && call.callee.property === "cancel"
    && call.callee.object.kind === "identifier"
    && parseTaskType(locals.get(call.callee.object.name) ?? "")
  ) {
    const spawn = spawnBindings.get(call.callee.object.name);
    if (!spawn) {
      unsupported(fileName, expression.location, "cancelling task parameters or aliases is not executable yet");
    }
    if (joinedSpawns.has(spawn.index)) {
      unsupported(fileName, expression.location, "a child task handle can only be joined or cancelled once");
    }
    joinedSpawns.add(spawn.index);
    return {
      index: spawn.index,
      mode,
      intrinsic: "cancel",
      expression,
      call: spawn.call,
      target: spawn.target,
      receiver: null,
      spawn,
      placement: null,
      generator: null,
    };
  }
  if (types.semanticInfo.standardFunctionReferences.get(call.callee.location.offset) === "delay") {
    return {
      index: nextChild.value++,
      mode,
      intrinsic: "delay",
      expression,
      call,
      target: intrinsicDelayTarget(call.location),
      receiver: null,
      spawn: null,
      placement: null,
      generator: null,
    };
  }
  if (types.semanticInfo.standardFunctionReferences.get(call.callee.location.offset) === "scheduler.yield") {
    return {
      index: nextChild.value++,
      mode,
      intrinsic: "yield",
      expression,
      call,
      target: intrinsicSchedulerYieldTarget(call.location),
      receiver: null,
      spawn: null,
      placement: null,
      generator: null,
    };
  }
  if (call.callee.kind === "member" && call.callee.property === "next") {
    const receiverType = types.semanticInfo.expressionTypes.get(call.callee.object.location.offset)
      ?? (call.callee.object.kind === "identifier" ? locals.get(call.callee.object.name) : null);
    const generator = receiverType ? parseAsyncGeneratorType(receiverType) : null;
    if (generator) {
      const target = asyncGeneratorNextTarget(generator, call.location);
      return {
        index: nextChild.value++,
        mode,
        intrinsic: null,
        expression,
        call,
        target,
        receiver: call.callee.object,
        spawn: null,
        placement: null,
        generator: { type: receiverType!, receiver: call.callee.object },
      };
    }
  }
  const resolved = resolveAsyncCall(call, functions, fileName, locals, types);
  return {
    index: nextChild.value++,
    mode,
    intrinsic: null,
    expression,
    call,
    target: resolved.target,
    receiver: resolved.receiver,
    spawn: null,
    placement: null,
    generator: null,
  };
}

function asyncGeneratorNextTarget(
  generator: NonNullable<ReturnType<typeof parseAsyncGeneratorType>>,
  location: SourceLocation,
): AsyncTarget {
  return {
    owner: null,
    declaration: {
      kind: "function",
      name: "__z_async_generator_next",
      async: true,
      receiverMode: null,
      parameters: [],
      returnType: { name: asyncGeneratorAdvanceType(generator), location },
      errorType: generator.errorType ? { name: generator.errorType, location } : null,
      body: [],
      location,
    },
  };
}

function intrinsicDelayTarget(location: SourceLocation): AsyncTarget {
  return {
    owner: null,
    declaration: {
      kind: "function",
      name: "delay",
      async: true,
      receiverMode: null,
      parameters: [{
        name: "milliseconds",
        mode: "value",
        type: { name: "u64", location },
        location,
      }],
      returnType: { name: "void", location },
      errorType: null,
      body: [],
      location,
    },
  };
}

function intrinsicSchedulerYieldTarget(location: SourceLocation): AsyncTarget {
  return {
    owner: null,
    declaration: {
      kind: "function",
      name: "__z_scheduler_yield",
      async: true,
      receiverMode: null,
      parameters: [],
      returnType: { name: "void", location },
      errorType: null,
      body: [],
      location,
    },
  };
}

function intrinsicTaskScopeTarget(location: SourceLocation): AsyncTarget {
  return {
    owner: null,
    declaration: {
      kind: "function",
      name: "__z_task_scope_join",
      async: true,
      receiverMode: null,
      parameters: [],
      returnType: { name: "void", location },
      errorType: null,
      body: [],
      location,
    },
  };
}

function createPlacementTarget(
  expression: Extract<Expression, { kind: "executorPlacement" }>,
  locals: ReadonlyMap<string, string>,
  types: AsyncTypeContext,
  fileName: string,
  fromNativeThread: boolean,
): PlacementTarget {
  const directBody = expression.call
    ? {
        kind: "block" as const,
        statements: [{
          kind: "return" as const,
          expression: expression.call,
          location: expression.call.location,
        }],
        location: expression.call.location,
      }
    : expression.body;
  const captures = collectPlacementCaptures(directBody, new Set(locals.keys()));
  const declaredCaptures = new Map(expression.captures.map((capture) => [capture.name, capture]));
  const mutated = captures.find((capture) => capture.mutated);
  if (mutated && (expression.call || declaredCaptures.get(mutated.name)?.mode !== "inout")) {
    unsupported(
      fileName,
      mutated.location,
      expression.call
        ? `a synchronous placed call cannot carry mutable binding ${JSON.stringify(mutated.name)} across executors yet`
        : `executor placement cannot mutate captured binding ${JSON.stringify(mutated.name)} in the first runtime tier`,
      expression.call
        ? "use an async function with an inout/out parameter, whose suspension loan is tracked until await completes"
        : "return a selected value from the placement block and apply mutation after awaiting it",
    );
  }
  const captureKinds = new Map<string, PlacementTarget["captures"][number]["kind"]>();
  const captureModes = new Map<string, PlacementTarget["captures"][number]["mode"]>();
  for (const capture of captures) {
    const type = locals.get(capture.name)!;
    const mode = expression.call
      ? "copy"
      : declaredCaptures.get(capture.name)?.mode ?? "copy";
    const kind = placementCaptureKind(type, mode, types, fromNativeThread);
    if (!kind) {
      unsupported(
        fileName,
        capture.location,
        `executor placement capture ${JSON.stringify(capture.name)} of type ${JSON.stringify(type)} is not transferable yet`,
        "capture a plain value, String, Z class, or Objective-C identity; native resources, mutable borrows, and affinity transfer require explicit contracts",
      );
    }
    captureKinds.set(capture.name, kind);
    captureModes.set(capture.name, mode);
  }
  if (!expression.call && placementContainsFunctionReturn(expression.body)) {
    unsupported(
      fileName,
      expression.location,
      "return from an executor-placement block is not executable yet",
      "use `select` to produce the block value; enclosing-function return lowering follows after placed-frame unwinding",
    );
  }
  const final = expression.body.statements.at(-1);
  const selected = final?.kind === "select" ? final : null;
  const directType = expression.call
    ? types.semanticInfo.expressionTypes.get(expression.call.location.offset) ?? "void"
    : null;
  const successType = directType
    ?? expression.returnType?.name
    ?? (selected ? types.semanticInfo.expressionTypes.get(selected.expression.location.offset) : null)
    ?? "void";
  requireFrameType(successType, expression.returnType?.location ?? expression.location, fileName, "executor placement result", types);
  const body = expression.call
    ? [{
        kind: "return" as const,
        expression: expression.call,
        location: expression.call.location,
      }]
    : selected
      ? [
        ...expression.body.statements.slice(0, -1),
        { kind: "return" as const, expression: selected.expression, location: selected.location },
      ]
      : [...expression.body.statements];
  const declaration: FunctionDeclaration = {
    kind: "function",
    name: `__z_executor_main_${expression.location.offset}`,
    async: true,
    receiverMode: null,
    parameters: captures.map((capture) => ({
      name: capture.name,
      mode: captureModes.get(capture.name) === "in"
        || captureKinds.get(capture.name) === "executorBoundClass"
        ? "in" as const
        : captureModes.get(capture.name) === "inout"
          ? "inout" as const
          : "value" as const,
      type: { name: locals.get(capture.name)!, location: capture.location },
      location: capture.location,
    })),
    returnType: { name: successType, location: expression.returnType?.location ?? expression.location },
    errorType: expression.errorType,
    body,
    location: expression.location,
  };
  return {
    target: { declaration, owner: null },
    captures: captures.map((capture) => ({
      name: capture.name,
      type: locals.get(capture.name)!,
      mode: captureModes.get(capture.name)!,
      kind: captureKinds.get(capture.name)!,
      location: declaredCaptures.get(capture.name)?.nameLocation ?? capture.location,
    })),
  };
}

function placementCall(
  expression: Extract<Expression, { kind: "executorPlacement" }>,
  placement: PlacementTarget,
): CallExpression {
  return {
    kind: "call",
    callee: {
      kind: "identifier",
      name: placement.target.declaration.name,
      location: expression.onLocation,
    },
    arguments: placement.captures.map((capture): Expression => {
      const identifier = {
        kind: "identifier" as const,
        name: capture.name,
        location: capture.location,
      };
      if (capture.mode === "move") {
        return {
          kind: "unary",
          operator: "move",
          operand: identifier,
          location: capture.location,
        };
      }
      if (capture.mode === "inout") {
        return {
          kind: "argumentReference",
          access: "inout",
          name: capture.name,
          nameLocation: capture.location,
          location: capture.location,
        };
      }
      return identifier;
    }),
    argumentLabels: placement.captures.map(() => null),
    location: expression.location,
  };
}

function isPlacementCopyType(
  type: string,
  types: AsyncTypeContext,
  visiting = new Set<string>(),
): boolean {
  if (type === "void" || type === "cstring" || type === "String" || type === "TextBuffer") return false;
  if (scalarTypes.has(type)) return true;
  const fixed = parseFixedArrayType(type);
  if (fixed) return isPlacementCopyType(fixed.elementType, types, visiting);
  if (parseSliceType(type) || parseDynamicArrayType(type)) return false;
  if (visiting.has(type)) return true;
  const aggregate = types.structs.get(type);
  if (aggregate) {
    if (aggregate.kind === "class" || aggregate.deinitializer) return false;
    visiting.add(type);
    const result = aggregate.fields.every((field) => isPlacementCopyType(field.type.name, types, visiting));
    visiting.delete(type);
    return result;
  }
  const enumeration = types.enums.get(type);
  if (enumeration) {
    visiting.add(type);
    const result = enumeration.variants.every((variant) => (
      !variant.payload || isPlacementCopyType(variant.payload.name, types, visiting)
    ));
    visiting.delete(type);
    return result;
  }
  return false;
}

function placementCaptureKind(
  type: string,
  mode: PlacementTarget["captures"][number]["mode"],
  types: AsyncTypeContext,
  fromNativeThread: boolean,
): PlacementTarget["captures"][number]["kind"] | null {
  if (mode === "in" || mode === "inout") return "borrow";
  if (type === "String") return "string";
  if (type === "TaskScope") return "taskScope";
  if (type === "TaskControl") return "taskControl";
  const aggregate = types.structs.get(type);
  if (aggregate?.kind === "class") {
    if (!fromNativeThread || types.semanticInfo.shareableClasses.has(type)) return "class";
    return types.semanticInfo.aggregateExecutorAffinities.has(type) ? "executorBoundClass" : null;
  }
  if (
    types.semanticInfo.foreignObjectTypes.has(type)
    || types.semanticInfo.foreignNamedTypes.get(type)?.kind === "object"
  ) {
    return fromNativeThread ? null : "objc";
  }
  if (
    mode === "move"
    && (
      type === "TextBuffer"
      || parseDynamicArrayType(type)
      || types.semanticInfo.foreignNamedTypes.has(type)
      || parsePointerTypeName(type)
      || types.structs.has(type)
      || types.enums.has(type)
    )
  ) return "owned";
  return isPlacementCopyType(type, types) ? "plain" : null;
}

function isExecutorBoundClassType(type: string, types: AsyncTypeContext): boolean {
  return types.structs.get(type)?.kind === "class"
    && types.semanticInfo.aggregateExecutorAffinities.has(type);
}

function executorBoundReleaseAdapter(type: string): string {
  return `z_async_release_${asyncNativeSymbolPart(type)}_on_executor`;
}

function placementContainsFunctionReturn(statement: Statement): boolean {
  switch (statement.kind) {
    case "return": return true;
    case "block": return statement.statements.some(placementContainsFunctionReturn);
    case "if": return placementContainsFunctionReturn(statement.thenBranch)
      || Boolean(statement.elseBranch && placementContainsFunctionReturn(statement.elseBranch));
    case "while": case "for": case "asyncScope": return placementContainsFunctionReturn(statement.body);
    case "match": return statement.arms.some((arm) => placementContainsFunctionReturn(arm.body));
    default: return false;
  }
}

function spawnSite(
  index: number,
  scope: number,
  expression: Extract<Expression, { kind: "spawn" }>,
  binding: string | null,
  functions: ReadonlyMap<string, AsyncTarget>,
  fileName: string,
  locals: ReadonlyMap<string, string>,
  types: AsyncTypeContext,
): SpawnSite {
  if (expression.expression.kind !== "call") {
    unsupported(fileName, expression.location, "task lowering requires a direct async call");
  }
  if (types.semanticInfo.standardFunctionReferences.get(expression.expression.callee.location.offset) === "delay") {
    unsupported(
      fileName,
      expression.location,
      "starting the delay intrinsic as a task is not executable yet",
      "await `delay(...)` directly, or start an async function as a task that awaits it",
    );
  }
  if (types.semanticInfo.standardFunctionReferences.get(expression.expression.callee.location.offset) === "scheduler.yield") {
    unsupported(
      fileName,
      expression.location,
      "scheduler.yield() cooperates with the current task and cannot start a child task",
      "write `await scheduler.yield()` inside the task that should yield",
    );
  }
  const resolved = resolveAsyncCall(expression.expression, functions, fileName, locals, types);
  return {
    index,
    scope,
    expression,
    call: expression.expression,
    target: resolved.target,
    receiver: resolved.receiver,
    binding,
    nativeThread: false,
    asyncNativeThread: false,
    placement: null,
  };
}

function placementSpawnSite(
  index: number,
  scope: number,
  expression: Extract<Expression, { kind: "executorPlacement" }>,
  binding: string | null,
  functions: ReadonlyMap<string, AsyncTarget>,
  locals: ReadonlyMap<string, string>,
  types: AsyncTypeContext,
  registerPlacement: (
    expression: Extract<Expression, { kind: "executorPlacement" }>,
    locals: ReadonlyMap<string, string>,
    fromNativeThread: boolean,
  ) => PlacementTarget,
  fromNativeThread: boolean,
): SpawnSite {
  if (expression.call) {
    const resolved = tryResolveAsyncCall(expression.call, functions, locals, types);
    if (resolved) {
      return {
        index,
        scope,
        expression,
        call: expression.call,
        target: resolved.target,
        receiver: resolved.receiver,
        binding,
        nativeThread: false,
        asyncNativeThread: false,
        placement: "main",
      };
    }
  }
  const placement = registerPlacement(expression, locals, fromNativeThread);
  return {
    index,
    scope,
    expression,
    call: placementCall(expression, placement),
    target: placement.target,
    receiver: null,
    binding,
    nativeThread: false,
    asyncNativeThread: false,
    placement: "main",
  };
}

function threadSpawnSite(
  index: number,
  scope: number,
  call: CallExpression,
  binding: string,
  threadTargets: ReadonlyMap<number, AsyncTarget>,
  semanticInfo: SemanticInfo,
  fileName: string,
): SpawnSite {
  const target = threadTargets.get(call.location.offset);
  const closureOffset = semanticInfo.threadSpawnCalls.get(call.location.offset);
  const closure = closureOffset === undefined ? null : semanticInfo.closures.get(closureOffset);
  if (!target || !closure) {
    unsupported(fileName, call.location, "thread.spawn lowering lost its analyzed closure target");
  }
  const arguments_ = closure.captures.map((capture) => ({
    kind: "identifier" as const,
    name: capture.name,
    location: capture.location,
  }));
  return {
    index,
    scope,
    expression: call,
    call: { ...call, arguments: arguments_ },
    target,
    receiver: null,
    binding,
    nativeThread: true,
    asyncNativeThread: target.nativeThreadMode === "async",
    placement: null,
  };
}

function resolveAsyncCall(
  call: CallExpression,
  functions: ReadonlyMap<string, AsyncTarget>,
  fileName: string,
  locals: ReadonlyMap<string, string>,
  types: AsyncTypeContext,
): { readonly target: AsyncTarget; readonly receiver: Expression | null } {
  const resolved = tryResolveAsyncCall(call, functions, locals, types);
  if (resolved) return resolved;
  unsupported(fileName, call.location, "async lowering could not resolve the async call");
}

function tryResolveAsyncCall(
  call: CallExpression,
  functions: ReadonlyMap<string, AsyncTarget>,
  locals: ReadonlyMap<string, string>,
  types: AsyncTypeContext,
): { readonly target: AsyncTarget; readonly receiver: Expression | null } | null {
  const foreign = types.foreignTargets.get(call.location.offset);
  if (foreign) return { target: foreign, receiver: null };
  if (call.callee.kind === "identifier") {
    const target = functions.get(call.callee.name);
    if (target?.declaration.async) return { target, receiver: null };
  }
  if (call.callee.kind === "member") {
    const object = call.callee.object;
    if (object.kind === "identifier") {
      const staticOwner = types.structs.get(object.name);
      const staticMethod = staticOwner?.methods.find((candidate) => (
        candidate.static && candidate.async && candidate.name === call.callee.property
      ));
      if (staticOwner && staticMethod) {
        return { target: { declaration: staticMethod, owner: staticOwner }, receiver: null };
      }
    }
    const ownerType = frameExpressionType(object, { locals, types });
    const owner = types.structs.get(ownerType);
    const method = owner?.methods.find((candidate) => (
      !candidate.static && candidate.async && candidate.name === call.callee.property
    ));
    if (owner && method) {
      return { target: { declaration: method, owner }, receiver: object };
    }
  }
  return null;
}

function awaitOperation(expression: Expression): {
  readonly mode: AwaitSite["mode"];
  readonly expression: Extract<Expression, { kind: "await" | "executorPlacement" }>;
  readonly source: Expression;
} | null {
  if (expression.kind === "await") return { mode: "await", expression, source: expression };
  if (expression.kind === "executorPlacement" && expression.mode !== "spawn") {
    return { mode: "await", expression, source: expression };
  }
  if ((expression.kind === "try" || expression.kind === "attempt") && expression.expression.kind === "await") {
    return { mode: expression.kind, expression: expression.expression, source: expression };
  }
  if (
    (expression.kind === "try" || expression.kind === "attempt")
    && expression.expression.kind === "executorPlacement"
    && expression.expression.mode !== "spawn"
  ) {
    return { mode: expression.kind, expression: expression.expression, source: expression };
  }
  return null;
}

function nestedAwaitResultType(site: AwaitSite): string {
  if (site.intrinsic === "cancel" || site.intrinsic === "scopeClose" || site.intrinsic === "scopeCancel") return "void";
  if (site.mode === "attempt") {
    return resultTypeName(
      site.target.declaration.returnType.name,
      site.target.declaration.errorType!.name,
    );
  }
  return site.target.declaration.returnType.name;
}

function collectNestedAwaitOperations(
  expression: Expression,
  fileName: string,
): readonly NonNullable<ReturnType<typeof awaitOperation>>[] {
  const operations: NonNullable<ReturnType<typeof awaitOperation>>[] = [];
  const walk = (candidate: Expression): void => {
    const operation = awaitOperation(candidate);
    if (operation) {
      if (operation.expression.kind === "await") walk(operation.expression.expression);
      operations.push(operation);
      return;
    }
    switch (candidate.kind) {
      case "number":
      case "string":
      case "boolean":
      case "null":
      case "identifier":
      case "argumentReference":
      case "dynamicArrayExpression":
      case "closure":
        return;
      case "template":
        for (const part of candidate.parts) {
          if (part.kind === "value") walk(part.expression);
        }
        return;
      case "unary":
      case "weak":
        walk(candidate.kind === "unary" ? candidate.operand : candidate.expression);
        return;
      case "binary":
        if ((candidate.operator === "&&" || candidate.operator === "||")
          && (containsAwait(candidate.left) || containsAwait(candidate.right))) {
          unsupported(
            fileName,
            candidate.location,
            "await inside embedded short-circuit logic needs hidden branch-result lowering",
            "bind the lazy `&&` or `||` result first; direct bindings, returns, and control conditions already preserve selected-branch suspension",
          );
        }
        walk(candidate.left);
        walk(candidate.right);
        return;
      case "conditional":
      case "ifExpression":
        if (containsAwait(candidate)) {
          unsupported(
            fileName,
            candidate.location,
            "await inside an embedded conditional expression needs hidden branch-result lowering",
            "bind the ternary or value-producing `if` first; direct bindings and returns already preserve selected-branch suspension",
          );
        }
        return;
      case "new":
        for (const argument of candidate.arguments) walk(argument);
        return;
      case "call":
        walk(candidate.callee);
        for (const argument of candidate.arguments) walk(argument);
        return;
      case "member":
        walk(candidate.object);
        return;
      case "index":
        walk(candidate.object);
        walk(candidate.index);
        return;
      case "arrayExpression":
        for (const element of candidate.elements) walk(element);
        return;
      case "structExpression":
      case "objectExpression":
        for (const field of candidate.fields) walk(field.expression);
        return;
      case "variantExpression":
        walk(candidate.payload);
        return;
      case "attempt":
      case "try":
      case "await":
      case "spawn":
        walk(candidate.expression);
        return;
      case "executorPlacement":
        unsupported(
          fileName,
          candidate.location,
          "nested executor placement is not executable in an async expression yet",
          "bind the placed value first, then use that binding in the surrounding expression",
        );
      case "matchExpression":
        walk(candidate.expression);
        for (const arm of candidate.arms) {
          if (statementContainsAwait(arm.body)) {
            unsupported(
              fileName,
              arm.body.location,
              "await inside a match arm needs selected-arm suspension lowering",
              "await before the match for now; suspending arms will preserve single-arm evaluation in a following tier",
            );
          }
        }
        return;
    }
  };
  walk(expression);
  return operations;
}

function containsAwait(expression: Expression): boolean {
  let found = false;
  const visit = (candidate: Expression): void => {
    if (found) return;
    if (candidate.kind === "await") {
      found = true;
      return;
    }
    switch (candidate.kind) {
      case "template":
        for (const part of candidate.parts) if (part.kind === "value") visit(part.expression);
        return;
      case "unary": visit(candidate.operand); return;
      case "binary": visit(candidate.left); visit(candidate.right); return;
      case "conditional": visit(candidate.condition); visit(candidate.thenExpression); visit(candidate.elseExpression); return;
      case "new": for (const value of candidate.arguments) visit(value); return;
      case "weak":
      case "attempt":
      case "try":
      case "spawn": visit(candidate.expression); return;
      case "executorPlacement":
        if (candidate.mode === "await") found = true;
        visit(candidate.executor);
        if (candidate.call) visit(candidate.call);
        if (statementContainsAwait(candidate.body)) found = true;
        return;
      case "call": visit(candidate.callee); for (const value of candidate.arguments) visit(value); return;
      case "member": visit(candidate.object); return;
      case "index": visit(candidate.object); visit(candidate.index); return;
      case "arrayExpression": for (const value of candidate.elements) visit(value); return;
      case "structExpression":
      case "objectExpression": for (const field of candidate.fields) visit(field.expression); return;
      case "variantExpression": visit(candidate.payload); return;
      case "matchExpression":
        visit(candidate.expression);
        for (const arm of candidate.arms) if (statementContainsAwait(arm.body)) found = true;
        return;
      case "ifExpression":
        visit(candidate.condition);
        if (statementContainsAwait(candidate.thenBranch)) found = true;
        if (candidate.elseBranch.kind === "ifExpression") visit(candidate.elseBranch);
        else if (statementContainsAwait(candidate.elseBranch)) found = true;
        return;
      default:
        return;
    }
  };
  visit(expression);
  return found;
}

function statementContainsAwait(statement: Statement): boolean {
  switch (statement.kind) {
    case "variable": return Boolean(statement.initializer && containsAwait(statement.initializer));
    case "assignment": return containsAwait(statement.target) || containsAwait(statement.expression);
    case "return": return Boolean(statement.expression && containsAwait(statement.expression));
    case "throw":
    case "yield":
    case "select":
    case "expressionStatement": return containsAwait(statement.expression);
    case "block": return statement.statements.some(statementContainsAwait);
    case "if": return containsAwait(statement.condition)
      || statementContainsAwait(statement.thenBranch)
      || Boolean(statement.elseBranch && statementContainsAwait(statement.elseBranch));
    case "while": return containsAwait(statement.condition) || statementContainsAwait(statement.body);
    case "for": return containsAwait(statement.iterable) || statementContainsAwait(statement.body);
    case "match": return containsAwait(statement.expression) || statement.arms.some((arm) => statementContainsAwait(arm.body));
    case "asyncScope": return statementContainsAwait(statement.body);
    case "break":
    case "continue": return false;
  }
}

function asyncStatementStopsFlow(statement: Statement | undefined): boolean {
  if (!statement) return false;
  if (
    statement.kind === "return"
    || statement.kind === "throw"
    || statement.kind === "break"
    || statement.kind === "continue"
  ) {
    return true;
  }
  if (statement.kind === "asyncScope") return asyncStatementStopsFlow(statement.body);
  if (statement.kind === "block") return asyncStatementStopsFlow(statement.statements.at(-1));
  if (statement.kind === "if") {
    return Boolean(statement.elseBranch)
      && asyncStatementStopsFlow(statement.thenBranch)
      && asyncStatementStopsFlow(statement.elseBranch);
  }
  return statement.kind === "match" && statement.arms.length > 0
    && statement.arms.every((arm) => asyncStatementStopsFlow(arm.body));
}

function asyncMatchExpressionNeedsPlanning(expression: MatchExpression): boolean {
  return expression.arms.some((arm) => (
    (arm.body.kind !== "expressionStatement" && arm.body.kind !== "select")
    || statementContainsAwait(arm.body)
  ));
}

function validateAsyncMain(declaration: FunctionDeclaration, fileName: string): void {
  if (declaration.parameters.length > 0 || declaration.returnType.name !== "i32") {
    unsupported(
      fileName,
      declaration.location,
      "executable async main must have signature `async function main(): i32` with an optional scalar `throws E`",
    );
  }
}

function generateRuntime(
  plans: readonly AsyncFunctionPlan[],
  planByKey: ReadonlyMap<string, AsyncFunctionPlan>,
  main: AsyncFunctionPlan | undefined,
  taskScopeTargets: ReadonlyMap<number, AsyncTarget>,
  fileName: string,
): string {
  const usesDelay = plans.some((plan) => [...plan.awaits.values()].some((site) => site.intrinsic === "delay"));
  const usesTaskScopes = plans.some((plan) => (
    [...plan.locals.values()].includes("TaskScope")
    || plan.types.semanticInfo.taskScopeConstructors.size > 0
    || plan.types.semanticInfo.taskScopeSpawnCalls.size > 0
    || plan.types.semanticInfo.taskScopeAsyncCalls.size > 0
  ));
  const usesThreads = usesTaskScopes
    || plans.some((plan) => plan.foreign !== null)
    || plans.some((plan) => [...plan.spawns.values()].some((site) => site.nativeThread));
  const usesMainPlacement = plans.some((plan) => (
    [...plan.awaits.values()].some((site) => site.placement !== null)
    || [...plan.spawns.values()].some((site) => site.placement !== null)
  )) || plans.some((plan) => (
    plan.types.semanticInfo.taskScopeSpawnCalls.size > 0
    || plan.types.semanticInfo.taskScopeAsyncCalls.size > 0
  ));
  const usesDarwinMainLoop = usesThreads && usesMainPlacement;
  const usesNativeFrameStorage = plans.some((plan) => (
    requiresNativeFramePlacement(planSuccessType(plan), plan.types)
    || Boolean(plan.declaration.errorType && requiresNativeFramePlacement(plan.declaration.errorType.name, plan.types))
    || [...plan.locals].some(([name, type]) => (
      !plan.borrowedLocals.has(name) && requiresNativeFramePlacement(type, plan.types)
    ))
    || [...plan.suspensions.values()].some((site) => requiresNativeFramePlacement(site.type, plan.types))
  ));
  const executorBoundClasses = new Set(plans.flatMap((plan) => (
    plan.nativeThread
      ? [...plan.locals.values()].filter((type) => isExecutorBoundClassType(type, plan.types))
      : []
  )));
  const usesExecutorBoundReleases = executorBoundClasses.size > 0;
  const lines = [
    ...(usesThreads ? [
      "#if defined(_WIN32)",
      "#include <windows.h>",
      "typedef HANDLE Z_NativeThreadHandle;",
      "#else",
      "#include <errno.h>",
      "#include <pthread.h>",
      "#include <time.h>",
      "typedef pthread_t Z_NativeThreadHandle;",
      "#endif",
      "",
    ] : []),
    ...(usesDarwinMainLoop ? [
      "#if defined(__APPLE__)",
      "#include <CoreFoundation/CoreFoundation.h>",
      "#endif",
      "",
    ] : []),
    ...(usesNativeFrameStorage ? ["#include <memory>", "#include <new>", ""] : []),
    ...[...executorBoundClasses].flatMap((type) => [
      `static void ${executorBoundReleaseAdapter(type)}(void *value) {`,
      `  Z_${type}_release((Z_${type} *)value);`,
      "}",
      "",
    ]),
    ...(usesNativeFrameStorage ? [
      "template <typename T>",
      "static __attribute__((unused)) T z_async_take(T *value, bool *live) {",
      "  if (!*live) abort();",
      "  T result(std::move(*value));",
      "  std::destroy_at(value);",
      "  *live = false;",
      "  return result;",
      "}",
      "",
    ] : []),
    "/* Z async Phase 1: FIFO-scheduled ownership-aware task frames. */",
    "static __attribute__((unused)) inline uintptr_t z_async_bounds_index(uintptr_t index, uintptr_t length) {",
    "  if (index >= length) abort();",
    "  return index;",
    "}",
    "",
    "typedef struct Z_AsyncTask Z_AsyncTask;",
    "typedef struct Z_AsyncExecutor Z_AsyncExecutor;",
    ...(usesThreads ? ["typedef struct Z_AsyncCancellation Z_AsyncCancellation;"] : []),
    ...(usesExecutorBoundReleases ? ["typedef struct Z_AsyncRelease Z_AsyncRelease;"] : []),
    "struct Z_AsyncTask {",
    "  void (*poll)(Z_AsyncTask *task);",
    "  bool completed;",
    "  bool queued;",
    "  bool suspended;",
    "  bool cancellation_requested;",
    "  bool cancellation_delivered;",
    "  bool cancelled;",
    "  bool timer_scheduled;",
    "  bool native_thread;",
    "  bool native_async;",
    "  bool external_completion;",
    "  bool thread_joined;",
    "  bool native_body_completed;",
    "  bool native_thread_finished;",
    "  uint64_t wake_at_ms;",
    "  Z_AsyncTask *waiter;",
    "  Z_AsyncTask *next;",
    "  Z_AsyncTask *timer_next;",
    "  Z_AsyncExecutor *executor;",
    "  Z_AsyncExecutor *completion_executor;",
    "  Z_AsyncExecutor *native_executor;",
    ...(usesThreads ? [
      "  Z_NativeThreadHandle native_handle;",
      "  bool completion_queued;",
      "  bool thread_queued;",
      "  Z_AsyncTask *completion_next;",
      "  Z_AsyncTask *thread_next;",
    ] : []),
    "};",
    "",
    "struct Z_AsyncExecutor {",
    "  bool main_executor;",
    "  Z_AsyncTask *head;",
    "  Z_AsyncTask *tail;",
    "  Z_AsyncTask *timers;",
    ...(usesThreads ? [
      "  Z_AsyncTask *thread_completions;",
      "  Z_AsyncTask *thread_enqueued_head;",
      "  Z_AsyncTask *thread_enqueued_tail;",
      "  Z_AsyncCancellation *thread_cancellations_head;",
      "  Z_AsyncCancellation *thread_cancellations_tail;",
      ...(usesExecutorBoundReleases ? [
        "  Z_AsyncRelease *thread_releases_head;",
        "  Z_AsyncRelease *thread_releases_tail;",
      ] : []),
      "  size_t active_native_threads;",
      "  size_t active_external_callbacks;",
      "#if defined(_WIN32)",
      "  CRITICAL_SECTION thread_mutex;",
      "  CONDITION_VARIABLE thread_condition;",
      "#else",
      "  pthread_mutex_t thread_mutex;",
      "  pthread_cond_t thread_condition;",
      "#endif",
      ...(usesDarwinMainLoop ? [
        "#if defined(__APPLE__)",
        "  CFRunLoopRef main_run_loop;",
        "  CFRunLoopSourceRef main_source;",
        "#endif",
      ] : []),
    ] : []),
    "};",
    "",
    ...(usesThreads ? [
      "struct Z_AsyncCancellation {",
      "  Z_AsyncTask *task;",
      "  Z_AsyncCancellation *next;",
      "};",
      "",
    ] : []),
    ...(usesExecutorBoundReleases ? [
      "struct Z_AsyncRelease {",
      "  void *value;",
      "  void (*release)(void *value);",
      "  Z_AsyncRelease *next;",
      "};",
      "",
    ] : []),
    ...(usesTaskScopes ? [
      "typedef struct Z_TaskScopeJob Z_TaskScopeJob;",
      "typedef struct Z_TaskControl Z_TaskControl;",
      "struct Z_TaskScope {",
      "  size_t refcount;",
      "  Z_AsyncExecutor *executor;",
      "  size_t pending;",
      "  bool closing;",
      "  bool cancelled;",
      "  Z_AsyncTask *waiter;",
      "  Z_TaskScopeJob *jobs;",
      "};",
      "",
      "struct Z_TaskControl {",
      "  size_t refcount;",
      "  Z_TaskScope *scope;",
      "  Z_TaskScopeJob *job;",
      "  bool accepted;",
      "  bool cancellation_requested;",
      "};",
      "",
      "struct Z_TaskScopeJob {",
      "  Z_AsyncTask task;",
      "  Z_TaskScope *scope;",
      "  void (*call)(void *);",
      "  void *context;",
      "  void (*release)(void *);",
      "  Z_AsyncTask *child;",
      "  void (*destroy_child)(Z_AsyncTask *);",
      "  Z_TaskControl *control;",
      "  Z_TaskScopeJob *scope_next;",
      "};",
      "",
    ] : []),
    ...(usesThreads ? [
      "static void z_async_thread_lock(Z_AsyncExecutor *executor);",
      "static void z_async_thread_unlock(Z_AsyncExecutor *executor);",
      "",
    ] : []),
    "static __attribute__((unused)) bool z_async_is_completed(Z_AsyncTask *task) {",
    ...(usesThreads ? [
      "  return __atomic_load_n(&task->completed, __ATOMIC_ACQUIRE);",
    ] : [
      "  return task->completed;",
    ]),
    "}",
    "",
    "static __attribute__((unused)) bool z_async_is_cancellation_requested(Z_AsyncTask *task) {",
    ...(usesThreads ? [
      "  return __atomic_load_n(&task->cancellation_requested, __ATOMIC_ACQUIRE);",
    ] : [
      "  return task->cancellation_requested;",
    ]),
    "}",
    "",
    "static __attribute__((unused)) void z_async_complete_task(Z_AsyncTask *task) {",
    ...(usesThreads ? [
      "  if (task->native_thread) {",
      "    task->native_body_completed = true;",
      "    task->suspended = true;",
      "    if (task->native_thread_finished) __atomic_store_n(&task->completed, true, __ATOMIC_RELEASE);",
      "    return;",
      "  }",
      "  z_async_thread_lock(task->executor);",
      "  __atomic_store_n(&task->completed, true, __ATOMIC_RELEASE);",
      "  z_async_thread_unlock(task->executor);",
    ] : [
      "  task->completed = true;",
    ]),
    "}",
    "",
    ...(usesThreads ? [
      ...(usesDarwinMainLoop ? [
        "#if defined(__APPLE__)",
        "static void z_async_main_source_perform(void *context);",
        "#endif",
        "",
      ] : []),
      "static void z_async_thread_lock(Z_AsyncExecutor *executor) {",
      "#if defined(_WIN32)",
      "  EnterCriticalSection(&executor->thread_mutex);",
      "#else",
      "  if (pthread_mutex_lock(&executor->thread_mutex) != 0) abort();",
      "#endif",
      "}",
      "",
      "static void z_async_thread_unlock(Z_AsyncExecutor *executor) {",
      "#if defined(_WIN32)",
      "  LeaveCriticalSection(&executor->thread_mutex);",
      "#else",
      "  if (pthread_mutex_unlock(&executor->thread_mutex) != 0) abort();",
      "#endif",
      "}",
      "",
      "static void z_async_executor_init(Z_AsyncExecutor *executor, bool main_executor) {",
      "  executor->main_executor = main_executor;",
      "  executor->head = NULL;",
      "  executor->tail = NULL;",
      "  executor->timers = NULL;",
      "  executor->thread_completions = NULL;",
      "  executor->thread_enqueued_head = NULL;",
      "  executor->thread_enqueued_tail = NULL;",
      "  executor->thread_cancellations_head = NULL;",
      "  executor->thread_cancellations_tail = NULL;",
      ...(usesExecutorBoundReleases ? [
        "  executor->thread_releases_head = NULL;",
        "  executor->thread_releases_tail = NULL;",
      ] : []),
      "  executor->active_native_threads = 0;",
      "  executor->active_external_callbacks = 0;",
      "#if defined(_WIN32)",
      "  InitializeCriticalSection(&executor->thread_mutex);",
      "  InitializeConditionVariable(&executor->thread_condition);",
      "#else",
      "  if (pthread_mutex_init(&executor->thread_mutex, NULL) != 0) abort();",
      "  if (pthread_cond_init(&executor->thread_condition, NULL) != 0) abort();",
      "#endif",
      ...(usesDarwinMainLoop ? [
        "#if defined(__APPLE__)",
        "  executor->main_run_loop = NULL;",
        "  executor->main_source = NULL;",
        "  if (main_executor) {",
        "    executor->main_run_loop = CFRunLoopGetMain();",
        "    CFRetain(executor->main_run_loop);",
        "    CFRunLoopSourceContext source_context = { 0 };",
        "    source_context.info = executor;",
        "    source_context.perform = z_async_main_source_perform;",
        "    executor->main_source = CFRunLoopSourceCreate(NULL, 0, &source_context);",
        "    if (executor->main_source == NULL) abort();",
        "    CFRunLoopAddSource(executor->main_run_loop, executor->main_source, kCFRunLoopCommonModes);",
        "  }",
        "#endif",
      ] : []),
      "}",
      "",
      "static void z_async_executor_destroy(Z_AsyncExecutor *executor) {",
      "  if (executor->thread_completions != NULL",
      "      || executor->thread_enqueued_head != NULL",
      "      || executor->thread_cancellations_head != NULL",
      ...(usesExecutorBoundReleases
        ? ["      || executor->thread_releases_head != NULL"]
        : []),
      "  ) abort();",
      "  if (executor->active_native_threads != 0 || executor->active_external_callbacks != 0) abort();",
      ...(usesDarwinMainLoop ? [
        "#if defined(__APPLE__)",
        "  if (executor->main_executor) {",
        "    CFRunLoopRemoveSource(executor->main_run_loop, executor->main_source, kCFRunLoopCommonModes);",
        "    CFRelease(executor->main_source);",
        "    CFRelease(executor->main_run_loop);",
        "  }",
        "#endif",
      ] : []),
      "#if defined(_WIN32)",
      "  DeleteCriticalSection(&executor->thread_mutex);",
      "#else",
      "  if (pthread_cond_destroy(&executor->thread_condition) != 0) abort();",
      "  if (pthread_mutex_destroy(&executor->thread_mutex) != 0) abort();",
      "#endif",
      "}",
      "",
      "static void z_async_report_native_completion(Z_AsyncTask *task) {",
      "  Z_AsyncExecutor *executor = task->completion_executor;",
      "  z_async_thread_lock(executor);",
      "  if (executor->active_native_threads == 0) abort();",
      "  executor->active_native_threads -= 1;",
      "  task->native_thread_finished = true;",
      "  if (task->native_body_completed) {",
      "    task->cancelled = __atomic_load_n(&task->cancellation_requested, __ATOMIC_ACQUIRE);",
      "    __atomic_store_n(&task->completed, true, __ATOMIC_RELEASE);",
      "  }",
      "  task->completion_queued = true;",
      "  task->completion_next = executor->thread_completions;",
      "  executor->thread_completions = task;",
      "#if defined(_WIN32)",
      "  WakeConditionVariable(&executor->thread_condition);",
      "#else",
      "  if (pthread_cond_signal(&executor->thread_condition) != 0) abort();",
      "#endif",
      "  z_async_thread_unlock(executor);",
      "}",
      "",
      "static __attribute__((unused)) void z_async_begin_external_completion(Z_AsyncTask *task) {",
      "  Z_AsyncExecutor *executor = task->executor;",
      "  task->external_completion = true;",
      "  task->completion_queued = false;",
      "  task->completion_next = NULL;",
      "  task->suspended = true;",
      "  z_async_thread_lock(executor);",
      "  executor->active_external_callbacks += 1;",
      "  z_async_thread_unlock(executor);",
      "}",
      "",
      "static __attribute__((unused)) void z_async_report_external_completion(Z_AsyncTask *task) {",
      "  Z_AsyncExecutor *executor = task->executor;",
      "  z_async_thread_lock(executor);",
      "  if (!task->external_completion || executor->active_external_callbacks == 0) abort();",
      "  if (__atomic_load_n(&task->completed, __ATOMIC_ACQUIRE)) abort();",
      "  executor->active_external_callbacks -= 1;",
      "  task->cancelled = __atomic_load_n(&task->cancellation_requested, __ATOMIC_ACQUIRE);",
      "  __atomic_store_n(&task->completed, true, __ATOMIC_RELEASE);",
      "  task->completion_queued = true;",
      "  task->completion_next = executor->thread_completions;",
      "  executor->thread_completions = task;",
      "#if defined(_WIN32)",
      "  WakeConditionVariable(&executor->thread_condition);",
      "#else",
      "  if (pthread_cond_signal(&executor->thread_condition) != 0) abort();",
      "#endif",
      "  z_async_thread_unlock(executor);",
      "}",
      "",
      "static __attribute__((unused)) void z_async_enqueue(Z_AsyncExecutor *executor, Z_AsyncTask *task);",
      "static void z_async_cancel(Z_AsyncTask *task);",
      "static bool z_async_run_one(Z_AsyncExecutor *executor);",
      "static bool z_async_wait_for_work(Z_AsyncExecutor *executor, bool keep_alive);",
      "static void z_async_drain_native_completions(Z_AsyncExecutor *executor);",
      ...(usesDelay
        ? ["static __attribute__((unused)) void z_async_release_timers(Z_AsyncExecutor *executor);"]
        : []),
      "",
      "#if defined(_WIN32)",
      "static DWORD WINAPI z_async_native_thread_entry(LPVOID context) {",
      "  Z_AsyncTask *task = (Z_AsyncTask *)context;",
      "  if (task->native_async) {",
      "    Z_AsyncExecutor *executor = task->native_executor;",
      "    z_async_enqueue(executor, task);",
      "    while (!task->native_body_completed) {",
      ...(usesDelay ? ["      z_async_release_timers(executor);"] : []),
      "      z_async_drain_native_completions(executor);",
      "      if (z_async_is_cancellation_requested(task) && !task->cancellation_delivered) {",
      "        task->cancellation_delivered = true;",
      "        if (task->suspended) {",
      "          task->suspended = false;",
      "          z_async_enqueue(executor, task);",
      "        }",
      "      }",
      "      if (executor->head == NULL && !z_async_wait_for_work(executor, true)) abort();",
      "      if (executor->head == NULL) continue;",
      "      if (!z_async_run_one(executor)) abort();",
      "    }",
      "  } else {",
      "    task->poll(task);",
      "  }",
      "  z_async_report_native_completion(task);",
      "  if (task->native_async) z_async_executor_destroy(task->native_executor);",
      "  return 0;",
      "}",
      "#else",
      "static void *z_async_native_thread_entry(void *context) {",
      "  Z_AsyncTask *task = (Z_AsyncTask *)context;",
      "  if (task->native_async) {",
      "    Z_AsyncExecutor *executor = task->native_executor;",
      "    z_async_enqueue(executor, task);",
      "    while (!task->native_body_completed) {",
      ...(usesDelay ? ["      z_async_release_timers(executor);"] : []),
      "      z_async_drain_native_completions(executor);",
      "      if (z_async_is_cancellation_requested(task) && !task->cancellation_delivered) {",
      "        task->cancellation_delivered = true;",
      "        if (task->suspended) {",
      "          task->suspended = false;",
      "          z_async_enqueue(executor, task);",
      "        }",
      "      }",
      "      if (executor->head == NULL && !z_async_wait_for_work(executor, true)) abort();",
      "      if (executor->head == NULL) continue;",
      "      if (!z_async_run_one(executor)) abort();",
      "    }",
      "  } else {",
      "    task->poll(task);",
      "  }",
      "  z_async_report_native_completion(task);",
      "  if (task->native_async) z_async_executor_destroy(task->native_executor);",
      "  return NULL;",
      "}",
      "#endif",
      "",
      "static __attribute__((unused)) void z_async_start_native_thread(Z_AsyncTask *task, bool async_worker) {",
      "  task->native_thread = true;",
      "  task->native_async = async_worker;",
      "  task->completion_executor = task->executor;",
      "  task->native_executor = NULL;",
      "  if (async_worker) {",
      "    task->native_executor = (Z_AsyncExecutor *)calloc(1, sizeof(Z_AsyncExecutor));",
      "    if (task->native_executor == NULL) abort();",
      "    z_async_executor_init(task->native_executor, false);",
      "    task->executor = task->native_executor;",
      "  }",
      "  task->thread_joined = false;",
      "  task->completion_queued = false;",
      "  task->thread_queued = false;",
      "  task->completion_next = NULL;",
      "  task->thread_next = NULL;",
      "  z_async_thread_lock(task->completion_executor);",
      "  task->completion_executor->active_native_threads += 1;",
      "  z_async_thread_unlock(task->completion_executor);",
      "#if defined(_WIN32)",
      "  task->native_handle = CreateThread(NULL, 0, z_async_native_thread_entry, task, 0, NULL);",
      "  if (task->native_handle == NULL) abort();",
      "#else",
      "  if (pthread_create(&task->native_handle, NULL, z_async_native_thread_entry, task) != 0) abort();",
      "#endif",
      "}",
      "",
      "static void z_async_join_native_thread(Z_AsyncTask *task) {",
      "  if (!task->native_thread || task->thread_joined) return;",
      "#if defined(_WIN32)",
      "  if (WaitForSingleObject(task->native_handle, INFINITE) != WAIT_OBJECT_0) abort();",
      "  if (!CloseHandle(task->native_handle)) abort();",
      "#else",
      "  if (pthread_join(task->native_handle, NULL) != 0) abort();",
      "#endif",
      "  task->thread_joined = true;",
      "  if (task->native_executor != NULL) {",
      "    free(task->native_executor);",
      "    task->native_executor = NULL;",
      "  }",
      "}",
      "",
    ] : []),
    "static __attribute__((unused)) void z_async_enqueue(Z_AsyncExecutor *executor, Z_AsyncTask *task) {",
    "  if (z_async_is_completed(task) || task->queued || task->suspended) return;",
    "  task->queued = true;",
    "  task->next = NULL;",
    "  if (executor->tail != NULL) executor->tail->next = task;",
    "  else executor->head = task;",
    "  executor->tail = task;",
    "}",
    "",
    ...(usesThreads ? [
      "static __attribute__((unused)) void z_async_enqueue_from_thread(Z_AsyncExecutor *executor, Z_AsyncTask *task) {",
      "  z_async_thread_lock(executor);",
      "  if (z_async_is_completed(task) || task->queued || task->suspended) abort();",
      "  task->thread_queued = true;",
      "  task->thread_next = NULL;",
      "  if (executor->thread_enqueued_tail != NULL) executor->thread_enqueued_tail->thread_next = task;",
      "  else executor->thread_enqueued_head = task;",
      "  executor->thread_enqueued_tail = task;",
      ...(usesDarwinMainLoop ? [
        "#if defined(__APPLE__)",
        "  if (executor->main_executor) {",
        "    CFRunLoopSourceSignal(executor->main_source);",
        "    CFRunLoopWakeUp(executor->main_run_loop);",
        "  }",
        "#endif",
      ] : []),
      "#if defined(_WIN32)",
      "  WakeConditionVariable(&executor->thread_condition);",
      "#else",
      "  if (pthread_cond_signal(&executor->thread_condition) != 0) abort();",
      "#endif",
      "  z_async_thread_unlock(executor);",
      "}",
      "",
      "static __attribute__((unused)) void z_async_cancel_from_thread(Z_AsyncExecutor *executor, Z_AsyncTask *task) {",
      "  Z_AsyncCancellation *cancellation = (Z_AsyncCancellation *)calloc(1, sizeof(Z_AsyncCancellation));",
      "  if (cancellation == NULL) abort();",
      "  cancellation->task = task;",
      "  z_async_thread_lock(executor);",
      "  if (z_async_is_completed(task)",
      "      || __atomic_exchange_n(&task->cancellation_requested, true, __ATOMIC_ACQ_REL)) {",
      "    z_async_thread_unlock(executor);",
      "    free(cancellation);",
      "    return;",
      "  }",
      "  if (executor->thread_cancellations_tail != NULL) {",
      "    executor->thread_cancellations_tail->next = cancellation;",
      "  } else {",
      "    executor->thread_cancellations_head = cancellation;",
      "  }",
      "  executor->thread_cancellations_tail = cancellation;",
      ...(usesDarwinMainLoop ? [
        "#if defined(__APPLE__)",
        "  if (executor->main_executor) {",
        "    CFRunLoopSourceSignal(executor->main_source);",
        "    CFRunLoopWakeUp(executor->main_run_loop);",
        "  }",
        "#endif",
      ] : []),
      "#if defined(_WIN32)",
      "  WakeConditionVariable(&executor->thread_condition);",
      "#else",
      "  if (pthread_cond_signal(&executor->thread_condition) != 0) abort();",
      "#endif",
      "  z_async_thread_unlock(executor);",
      "}",
      "",
      ...(usesExecutorBoundReleases ? [
        "static __attribute__((unused)) void z_async_release_from_thread(",
        "  Z_AsyncExecutor *executor,",
        "  void *value,",
        "  void (*release)(void *value)",
        ") {",
        "  if (value == NULL || release == NULL) return;",
        "  Z_AsyncRelease *pending = (Z_AsyncRelease *)calloc(1, sizeof(Z_AsyncRelease));",
        "  if (pending == NULL) abort();",
        "  pending->value = value;",
        "  pending->release = release;",
        "  z_async_thread_lock(executor);",
        "  if (executor->thread_releases_tail != NULL) {",
        "    executor->thread_releases_tail->next = pending;",
        "  } else {",
        "    executor->thread_releases_head = pending;",
        "  }",
        "  executor->thread_releases_tail = pending;",
        ...(usesDarwinMainLoop ? [
          "#if defined(__APPLE__)",
          "  if (executor->main_executor) {",
          "    CFRunLoopSourceSignal(executor->main_source);",
          "    CFRunLoopWakeUp(executor->main_run_loop);",
          "  }",
          "#endif",
        ] : []),
        "#if defined(_WIN32)",
        "  WakeConditionVariable(&executor->thread_condition);",
        "#else",
        "  if (pthread_cond_signal(&executor->thread_condition) != 0) abort();",
        "#endif",
        "  z_async_thread_unlock(executor);",
        "}",
        "",
      ] : []),
      "static void z_async_drain_native_completions(Z_AsyncExecutor *executor) {",
      "  z_async_thread_lock(executor);",
      "  Z_AsyncTask *completed = executor->thread_completions;",
      "  executor->thread_completions = NULL;",
      "  Z_AsyncTask *enqueued = executor->thread_enqueued_head;",
      "  executor->thread_enqueued_head = NULL;",
      "  executor->thread_enqueued_tail = NULL;",
      "  Z_AsyncCancellation *cancellations = executor->thread_cancellations_head;",
      "  executor->thread_cancellations_head = NULL;",
      "  executor->thread_cancellations_tail = NULL;",
      ...(usesExecutorBoundReleases ? [
        "  Z_AsyncRelease *releases = executor->thread_releases_head;",
        "  executor->thread_releases_head = NULL;",
        "  executor->thread_releases_tail = NULL;",
      ] : []),
      "  for (Z_AsyncTask *task = completed; task != NULL; task = task->completion_next) {",
      "    task->completion_queued = false;",
      "  }",
      "  z_async_thread_unlock(executor);",
      ...(usesExecutorBoundReleases ? [
        "  while (releases != NULL) {",
        "    Z_AsyncRelease *pending = releases;",
        "    releases = pending->next;",
        "    pending->release(pending->value);",
        "    free(pending);",
        "  }",
      ] : []),
      "  while (cancellations != NULL) {",
      "    Z_AsyncCancellation *cancellation = cancellations;",
      "    cancellations = cancellation->next;",
      "    z_async_cancel(cancellation->task);",
      "    free(cancellation);",
      "  }",
      "  while (enqueued != NULL) {",
      "    Z_AsyncTask *task = enqueued;",
      "    enqueued = task->thread_next;",
      "    task->thread_queued = false;",
      "    task->thread_next = NULL;",
      "    z_async_enqueue(executor, task);",
      "  }",
      "  while (completed != NULL) {",
      "    Z_AsyncTask *task = completed;",
      "    completed = task->completion_next;",
      "    task->completion_next = NULL;",
      "    if (z_async_is_completed(task) && task->waiter != NULL) {",
      "      Z_AsyncTask *waiter = task->waiter;",
      "      task->waiter = NULL;",
      "      waiter->suspended = false;",
      "      z_async_enqueue(executor, waiter);",
      "    }",
      "  }",
      "}",
      "",
    ] : []),
    ...(usesTaskScopes ? [
      "static void z_async_cancel(Z_AsyncTask *task);",
      "",
      "static Z_TaskScope *z_task_scope_retain(Z_TaskScope *scope) {",
      "  if (scope != NULL) __atomic_add_fetch(&scope->refcount, 1, __ATOMIC_RELAXED);",
      "  return scope;",
      "}",
      "",
      "static void z_task_scope_discard_jobs(Z_TaskScope *scope) {",
      "  Z_TaskScopeJob *job = scope->jobs;",
      "  scope->jobs = NULL;",
      "  while (job != NULL) {",
      "    Z_TaskScopeJob *next = job->scope_next;",
      "    if (job->control != NULL) abort();",
      "    free(job);",
      "    job = next;",
      "  }",
      "}",
      "",
      "static void z_task_scope_release(Z_TaskScope *scope) {",
      "  if (scope == NULL) return;",
      "  if (__atomic_sub_fetch(&scope->refcount, 1, __ATOMIC_ACQ_REL) != 0) return;",
      "  if (scope->pending != 0) abort();",
      "  z_task_scope_discard_jobs(scope);",
      "  free(scope);",
      "}",
      "",
      "static Z_TaskControl *z_task_control_new(bool accepted) {",
      "  Z_TaskControl *control = (Z_TaskControl *)calloc(1, sizeof(Z_TaskControl));",
      "  if (control == NULL) abort();",
      "  control->refcount = 1;",
      "  control->accepted = accepted;",
      "  return control;",
      "}",
      "",
      "static __attribute__((unused)) Z_TaskControl *z_task_control_retain(Z_TaskControl *control) {",
      "  if (control != NULL) __atomic_add_fetch(&control->refcount, 1, __ATOMIC_RELAXED);",
      "  return control;",
      "}",
      "",
      "static void z_task_control_release(Z_TaskControl *control) {",
      "  if (control == NULL) return;",
      "  if (__atomic_sub_fetch(&control->refcount, 1, __ATOMIC_ACQ_REL) != 0) return;",
      "  if (control->job != NULL) abort();",
      "  z_task_scope_release(control->scope);",
      "  free(control);",
      "}",
      "",
      "static __attribute__((unused)) bool z_task_control_is_accepted(Z_TaskControl *control) {",
      "  return control != NULL && control->accepted;",
      "}",
      "",
      "static __attribute__((unused)) bool z_task_control_is_cancellation_requested(Z_TaskControl *control) {",
      "  return control != NULL && __atomic_load_n(&control->cancellation_requested, __ATOMIC_ACQUIRE);",
      "}",
      "",
      "static __attribute__((unused)) bool z_task_control_request_cancel(Z_TaskControl *control) {",
      "  if (control == NULL || !control->accepted || control->scope == NULL) return false;",
      "  Z_TaskScope *scope = control->scope;",
      "  z_async_thread_lock(scope->executor);",
      "  Z_TaskScopeJob *job = control->job;",
      "  if (job == NULL || __atomic_load_n(&control->cancellation_requested, __ATOMIC_RELAXED)) {",
      "    z_async_thread_unlock(scope->executor);",
      "    return false;",
      "  }",
      "  __atomic_store_n(&control->cancellation_requested, true, __ATOMIC_RELEASE);",
      "  z_async_thread_unlock(scope->executor);",
      "  z_async_cancel_from_thread(scope->executor, &job->task);",
      "  return true;",
      "}",
      "",
      "static Z_TaskScope *z_task_scope_new(Z_AsyncExecutor *executor) {",
      "  Z_TaskScope *scope = (Z_TaskScope *)calloc(1, sizeof(Z_TaskScope));",
      "  if (scope == NULL) abort();",
      "  scope->refcount = 1;",
      "  scope->executor = executor;",
      "  return scope;",
      "}",
      "",
      "static void z_task_scope_finish_job(Z_TaskScopeJob *job) {",
      "  Z_TaskScope *scope = job->scope;",
      "  z_async_thread_lock(scope->executor);",
      "  if (scope->pending == 0) abort();",
      "  Z_TaskControl *control = job->control;",
      "  if (control != NULL) control->job = NULL;",
      "  job->control = NULL;",
      "  scope->pending -= 1;",
      "  Z_AsyncTask *waiter = scope->pending == 0 ? scope->waiter : NULL;",
      "  if (waiter != NULL) scope->waiter = NULL;",
      "  z_async_thread_unlock(scope->executor);",
      "  z_async_complete_task(&job->task);",
      "  if (waiter != NULL) {",
      "    waiter->suspended = false;",
      "    z_async_enqueue(scope->executor, waiter);",
      "  }",
      "  z_task_control_release(control);",
      "  z_task_scope_release(scope);",
      "}",
      "",
      "static void z_task_scope_job_poll(Z_AsyncTask *task) {",
      "  Z_TaskScopeJob *job = (Z_TaskScopeJob *)task;",
      "  Z_TaskScope *scope = job->scope;",
      "  z_async_thread_lock(scope->executor);",
      "  const bool cancelled = scope->cancelled",
      "    || z_async_is_cancellation_requested(task)",
      "    || z_task_control_is_cancellation_requested(job->control);",
      "  z_async_thread_unlock(scope->executor);",
      "  if (job->child != NULL) {",
      "    if (cancelled) z_async_cancel(job->child);",
      "    if (!z_async_is_completed(job->child)) {",
      "      if (job->child->waiter != NULL && job->child->waiter != task) abort();",
      "      job->child->waiter = task;",
      "      task->suspended = true;",
      "      z_async_enqueue(scope->executor, job->child);",
      "      return;",
      "    }",
      "    job->destroy_child(job->child);",
      "    job->child = NULL;",
      "    job->destroy_child = NULL;",
      "  } else {",
      "    if (!cancelled) job->call(job->context);",
      "    if (job->release != NULL) job->release(job->context);",
      "    job->context = NULL;",
      "    job->release = NULL;",
      "  }",
      "  z_task_scope_finish_job(job);",
      "}",
      "",
      "static __attribute__((unused)) Z_TaskControl *z_task_scope_spawn(Z_TaskScope *scope, void (*call)(void *), void *context, void (*retain)(void *), void (*release)(void *)) {",
      "  if (scope == NULL || call == NULL) abort();",
      "  Z_TaskScopeJob *job = (Z_TaskScopeJob *)calloc(1, sizeof(Z_TaskScopeJob));",
      "  if (job == NULL) abort();",
      "  z_async_thread_lock(scope->executor);",
      "  if (scope->closing) {",
      "    z_async_thread_unlock(scope->executor);",
      "    free(job);",
      "    return z_task_control_new(false);",
      "  }",
      "  Z_TaskControl *control = z_task_control_new(true);",
      "  if (retain != NULL) retain(context);",
      "  job->task.poll = z_task_scope_job_poll;",
      "  job->task.executor = scope->executor;",
      "  job->scope = z_task_scope_retain(scope);",
      "  job->call = call;",
      "  job->context = context;",
      "  job->release = release;",
      "  job->control = z_task_control_retain(control);",
      "  control->scope = z_task_scope_retain(scope);",
      "  control->job = job;",
      "  job->scope_next = scope->jobs;",
      "  scope->jobs = job;",
      "  scope->pending += 1;",
      "  z_async_thread_unlock(scope->executor);",
      "  z_async_enqueue_from_thread(scope->executor, &job->task);",
      "  return control;",
      "}",
      "",
      "static __attribute__((unused)) Z_TaskControl *z_task_scope_spawn_async(Z_TaskScope *scope, Z_AsyncTask *child, void (*destroy_child)(Z_AsyncTask *)) {",
      "  if (scope == NULL || child == NULL || destroy_child == NULL) abort();",
      "  Z_TaskScopeJob *job = (Z_TaskScopeJob *)calloc(1, sizeof(Z_TaskScopeJob));",
      "  if (job == NULL) abort();",
      "  z_async_thread_lock(scope->executor);",
      "  if (scope->closing) {",
      "    z_async_thread_unlock(scope->executor);",
      "    destroy_child(child);",
      "    free(job);",
      "    return z_task_control_new(false);",
      "  }",
      "  Z_TaskControl *control = z_task_control_new(true);",
      "  job->task.poll = z_task_scope_job_poll;",
      "  job->task.executor = scope->executor;",
      "  job->scope = z_task_scope_retain(scope);",
      "  job->child = child;",
      "  job->destroy_child = destroy_child;",
      "  job->control = z_task_control_retain(control);",
      "  control->scope = z_task_scope_retain(scope);",
      "  control->job = job;",
      "  job->scope_next = scope->jobs;",
      "  scope->jobs = job;",
      "  scope->pending += 1;",
      "  z_async_thread_unlock(scope->executor);",
      "  z_async_enqueue_from_thread(scope->executor, &job->task);",
      "  return control;",
      "}",
      "",
      "static bool z_task_scope_join(Z_TaskScope *scope, Z_AsyncTask *parent, bool cancel) {",
      "  if (scope == NULL) return true;",
      "  z_async_thread_lock(scope->executor);",
      "  scope->closing = true;",
      "  if (cancel) scope->cancelled = true;",
      "  if (cancel) {",
      "    for (Z_TaskScopeJob *job = scope->jobs; job != NULL; job = job->scope_next) {",
      "      if (job->child != NULL) z_async_cancel(job->child);",
      "    }",
      "  }",
      "  if (scope->pending == 0) {",
      "    z_async_thread_unlock(scope->executor);",
      "    z_task_scope_discard_jobs(scope);",
      "    return true;",
      "  }",
      "  if (scope->waiter != NULL && scope->waiter != parent) abort();",
      "  scope->waiter = parent;",
      "  parent->suspended = true;",
      "  z_async_thread_unlock(scope->executor);",
      "  return false;",
      "}",
      "",
    ] : []),
    "static bool z_async_run_one(Z_AsyncExecutor *executor) {",
    "  Z_AsyncTask *task = executor->head;",
    "  if (task == NULL) return false;",
    "  executor->head = task->next;",
    "  if (executor->head == NULL) executor->tail = NULL;",
    "  task->queued = false;",
    "  task->next = NULL;",
    "  if (!z_async_is_completed(task)) task->poll(task);",
    "  if (z_async_is_completed(task)) {",
    ...(usesThreads ? ["    z_async_drain_native_completions(executor);"] : []),
    "    if (task->waiter != NULL) {",
    "      Z_AsyncTask *waiter = task->waiter;",
    "      task->waiter = NULL;",
    "      waiter->suspended = false;",
    ...(usesThreads ? [
      "      if (waiter->executor == executor) z_async_enqueue(executor, waiter);",
      "      else z_async_enqueue_from_thread(waiter->executor, waiter);",
    ] : [
      "      z_async_enqueue(executor, waiter);",
    ]),
    "    }",
    "  } else if (!task->suspended) {",
    "    z_async_enqueue(executor, task);",
    "  }",
    "  return true;",
    "}",
    "",
    ...(usesDarwinMainLoop ? [
      "#if defined(__APPLE__)",
      "static void z_async_main_source_perform(void *context) {",
      "  if (!pthread_main_np()) abort();",
      "  Z_AsyncExecutor *executor = (Z_AsyncExecutor *)context;",
      "  z_async_drain_native_completions(executor);",
      "  while (z_async_run_one(executor)) {}",
      "}",
      "#endif",
      "",
    ] : []),
    ...(usesDelay ? [
    "static __attribute__((unused)) uint64_t z_async_now_ms(void) {",
    "#if defined(_WIN32)",
    "  return (uint64_t)GetTickCount64();",
    "#else",
    "  struct timespec now;",
    "  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) abort();",
    "  return (uint64_t)now.tv_sec * UINT64_C(1000) + (uint64_t)now.tv_nsec / UINT64_C(1000000);",
    "#endif",
    "}",
    "",
    "static __attribute__((unused)) void z_async_os_sleep_ms(uint64_t milliseconds) {",
    "#if defined(_WIN32)",
    "  while (milliseconds > UINT32_MAX) {",
    "    Sleep(UINT32_MAX);",
    "    milliseconds -= UINT32_MAX;",
    "  }",
    "  Sleep((DWORD)milliseconds);",
    "#else",
    "  while (milliseconds > 0) {",
    "    const uint64_t chunk = milliseconds > UINT64_C(86400000) ? UINT64_C(86400000) : milliseconds;",
    "    struct timespec remaining = {",
    "      .tv_sec = (time_t)(chunk / UINT64_C(1000)),",
    "      .tv_nsec = (long)((chunk % UINT64_C(1000)) * UINT64_C(1000000)),",
    "    };",
    "    while (nanosleep(&remaining, &remaining) == -1) {",
    "      if (errno != EINTR) abort();",
    "    }",
    "    milliseconds -= chunk;",
    "  }",
    "#endif",
    "}",
    "",
    "static __attribute__((unused)) void z_async_remove_timer(Z_AsyncTask *task) {",
    "  if (!task->timer_scheduled) return;",
    "  Z_AsyncTask **link = &task->executor->timers;",
    "  while (*link != NULL && *link != task) link = &(*link)->timer_next;",
    "  if (*link == NULL) abort();",
    "  *link = task->timer_next;",
    "  task->timer_scheduled = false;",
    "  task->timer_next = NULL;",
    "}",
    "",
    "static __attribute__((unused)) void z_async_schedule_delay(Z_AsyncTask *task, uint64_t milliseconds) {",
    "  z_async_remove_timer(task);",
    "  const uint64_t now = z_async_now_ms();",
    "  task->wake_at_ms = milliseconds > UINT64_MAX - now ? UINT64_MAX : now + milliseconds;",
    "  task->timer_scheduled = true;",
    "  task->suspended = true;",
    "  Z_AsyncTask **link = &task->executor->timers;",
    "  while (*link != NULL && (*link)->wake_at_ms <= task->wake_at_ms) link = &(*link)->timer_next;",
    "  task->timer_next = *link;",
    "  *link = task;",
    "}",
    "",
    "static __attribute__((unused)) void z_async_release_timers(Z_AsyncExecutor *executor) {",
    "  const uint64_t now = z_async_now_ms();",
    "  while (executor->timers != NULL && executor->timers->wake_at_ms <= now) {",
    "    Z_AsyncTask *task = executor->timers;",
    "    executor->timers = task->timer_next;",
    "    task->timer_scheduled = false;",
    "    task->timer_next = NULL;",
    "    task->suspended = false;",
    "    z_async_enqueue(executor, task);",
    "  }",
    "}",
    "",
    "static __attribute__((unused)) void z_async_wait_for_timer(Z_AsyncExecutor *executor) {",
    "  if (executor->timers == NULL) abort();",
    "  const uint64_t now = z_async_now_ms();",
    "  if (executor->timers->wake_at_ms > now) {",
    "    z_async_os_sleep_ms(executor->timers->wake_at_ms - now);",
    "  }",
    "  z_async_release_timers(executor);",
    "}",
    "",
    ] : []),
    ...(usesThreads ? [
      "static bool z_async_wait_for_work(Z_AsyncExecutor *executor, bool keep_alive) {",
      "  z_async_thread_lock(executor);",
      "  if (executor->thread_completions == NULL",
      "      && executor->thread_enqueued_head == NULL",
      ...(usesExecutorBoundReleases ? ["      && executor->thread_releases_head == NULL"] : []),
      "      && executor->active_native_threads == 0",
      "      && executor->active_external_callbacks == 0",
      "      && executor->timers == NULL",
      "      && !keep_alive) {",
      "    z_async_thread_unlock(executor);",
      "    return false;",
      "  }",
      "  if (executor->thread_completions == NULL",
      "      && executor->thread_enqueued_head == NULL",
      ...(usesExecutorBoundReleases ? ["      && executor->thread_releases_head == NULL"] : []),
      "  ) {",
      "#if defined(_WIN32)",
      "    DWORD timeout = INFINITE;",
      ...(usesDelay ? [
        "    if (executor->timers != NULL) {",
        "      const uint64_t now = z_async_now_ms();",
        "      const uint64_t remaining = executor->timers->wake_at_ms > now",
        "        ? executor->timers->wake_at_ms - now",
        "        : 0;",
        "      timeout = remaining >= (uint64_t)INFINITE ? INFINITE - 1 : (DWORD)remaining;",
        "    }",
      ] : []),
      "    const BOOL waited = SleepConditionVariableCS(",
      "      &executor->thread_condition, &executor->thread_mutex, timeout",
      "    );",
      "    if (!waited && GetLastError() != ERROR_TIMEOUT) abort();",
      "#else",
      ...(usesDelay ? [
        "    if (executor->timers != NULL) {",
        "      const uint64_t now = z_async_now_ms();",
        "      const uint64_t remaining = executor->timers->wake_at_ms > now",
        "        ? executor->timers->wake_at_ms - now",
        "        : 0;",
        "      struct timespec deadline;",
        "      if (timespec_get(&deadline, TIME_UTC) != TIME_UTC) abort();",
        "      deadline.tv_sec += (time_t)(remaining / UINT64_C(1000));",
        "      deadline.tv_nsec += (long)((remaining % UINT64_C(1000)) * UINT64_C(1000000));",
        "      if (deadline.tv_nsec >= 1000000000L) {",
        "        deadline.tv_sec += 1;",
        "        deadline.tv_nsec -= 1000000000L;",
        "      }",
        "      const int waited = pthread_cond_timedwait(",
        "        &executor->thread_condition, &executor->thread_mutex, &deadline",
        "      );",
        "      if (waited != 0 && waited != ETIMEDOUT) abort();",
        "    } else {",
        "      if (pthread_cond_wait(&executor->thread_condition, &executor->thread_mutex) != 0) abort();",
        "    }",
      ] : [
        "    if (pthread_cond_wait(&executor->thread_condition, &executor->thread_mutex) != 0) abort();",
      ]),
      "#endif",
      "  }",
      "  z_async_thread_unlock(executor);",
      "  z_async_drain_native_completions(executor);",
      ...(usesDelay ? ["  z_async_release_timers(executor);"] : []),
      "  return true;",
      "}",
      "",
    ] : []),
    "static __attribute__((unused)) void z_async_cancel(Z_AsyncTask *task) {",
    ...(usesThreads ? [
      "  if (task->native_thread || task->external_completion) {",
      "    Z_AsyncExecutor *completion_executor = task->native_thread",
      "      ? task->completion_executor",
      "      : task->executor;",
      "    z_async_thread_lock(completion_executor);",
      "    if (!__atomic_load_n(&task->completed, __ATOMIC_ACQUIRE)) {",
      "      __atomic_store_n(&task->cancellation_requested, true, __ATOMIC_RELEASE);",
      "      if (task->native_async && task->native_executor != NULL) {",
      "        z_async_thread_lock(task->native_executor);",
      "#if defined(_WIN32)",
      "        WakeConditionVariable(&task->native_executor->thread_condition);",
      "#else",
      "        if (pthread_cond_signal(&task->native_executor->thread_condition) != 0) abort();",
      "#endif",
      "        z_async_thread_unlock(task->native_executor);",
      "      }",
      "    }",
      "    z_async_thread_unlock(completion_executor);",
      "    return;",
      "  }",
    ] : []),
    "  if (z_async_is_completed(task)) return;",
    ...(usesThreads
      ? ["  __atomic_store_n(&task->cancellation_requested, true, __ATOMIC_RELEASE);"]
      : ["  task->cancellation_requested = true;"]),
    ...(usesDelay ? ["  z_async_remove_timer(task);"] : []),
    "  task->suspended = false;",
    "  z_async_enqueue(task->executor, task);",
    "}",
    "",
    "static __attribute__((unused)) bool z_async_wait(Z_AsyncTask *parent, Z_AsyncTask *child) {",
    ...(usesThreads ? [
      "  if (child->native_thread || child->external_completion) {",
      "    Z_AsyncExecutor *executor = child->native_thread",
      "      ? child->completion_executor",
      "      : child->executor;",
      "    z_async_thread_lock(executor);",
      "    const bool completed = __atomic_load_n(&child->completed, __ATOMIC_ACQUIRE);",
      "    if (completed) {",
      "      if (child->completion_queued) {",
      "        Z_AsyncTask **link = &executor->thread_completions;",
      "        while (*link != NULL && *link != child) link = &(*link)->completion_next;",
      "        if (*link == NULL) abort();",
      "        *link = child->completion_next;",
      "        child->completion_queued = false;",
      "        child->completion_next = NULL;",
      "      }",
      "    } else {",
      "      if (child->waiter != NULL && child->waiter != parent) abort();",
      "      child->waiter = parent;",
      "      parent->suspended = true;",
      "    }",
      "    z_async_thread_unlock(executor);",
      "    if (completed && child->native_thread) z_async_join_native_thread(child);",
      "    return completed;",
      "  }",
    ] : []),
    "  if (z_async_is_completed(child)) return true;",
    "  if (child->waiter != NULL && child->waiter != parent) abort();",
    "  child->waiter = parent;",
    "  parent->suspended = true;",
    "  return false;",
    "}",
    "",
    "static __attribute__((unused)) void z_async_run(Z_AsyncTask *root) {",
    "  Z_AsyncExecutor *executor = root->executor;",
    "  z_async_enqueue(executor, root);",
    "  while (!z_async_is_completed(root)) {",
    ...(usesDelay ? [
      "    z_async_release_timers(executor);",
    ] : []),
    ...(usesThreads ? [
      "    z_async_drain_native_completions(executor);",
      "    if (executor->head == NULL && !z_async_wait_for_work(executor, false)) abort();",
      "    if (executor->head == NULL) continue;",
    ] : usesDelay ? [
      "    if (executor->head == NULL) z_async_wait_for_timer(executor);",
    ] : []),
    "    if (!z_async_run_one(executor)) abort();",
    "  }",
    "}",
    "",
  ];

  const asyncGeneratorTypes = new Set<string>();
  for (const plan of plans) {
    if (plan.generator) asyncGeneratorTypes.add(plan.declaration.returnType.name);
    for (const type of plan.locals.values()) {
      if (parseAsyncGeneratorType(type)) asyncGeneratorTypes.add(type);
    }
  }
  for (const type of asyncGeneratorTypes) {
    lines.push(
      `typedef struct ${asyncGeneratorCName(type)} {`,
      "  void *context;",
      "  Z_AsyncTask *(*next)(void *context, Z_AsyncExecutor *executor);",
      "  void (*destroy)(void *context);",
      "  bool (*failed)(void *context);",
      "  void (*take_result)(void *context, void *destination);",
      "  void (*take_error)(void *context, void *destination);",
      `} ${asyncGeneratorCName(type)};`,
      "",
    );
  }

  for (const plan of plans) lines.push(`typedef struct ${plan.frameName} ${plan.frameName};`);
  if (plans.length > 0) lines.push("");
  for (const plan of plans) lines.push(generateFrame(plan, planByKey), "");
  for (const plan of plans) lines.push(`static void ${plan.pollName}(Z_AsyncTask *task);`);
  for (const plan of plans) lines.push(`static void ${plan.destroyName}(${plan.frameName} *frame);`);
  for (const plan of plans) lines.push(`${generateStartSignature(plan)};`);
  for (const plan of plans) {
    if (plan.generator) lines.push(`${generateAsyncGeneratorFactorySignature(plan)};`);
  }
  if (plans.length > 0) lines.push("");
  for (const plan of plans) lines.push(generateDestroy(plan, planByKey), "");
  for (const plan of plans) lines.push(generateStart(plan), "");
  for (const [callOffset, target] of taskScopeTargets) {
    const plan = planByKey.get(targetKey(target))!;
    lines.push(generateTaskScopeAsyncSchedule(callOffset, plan), "");
  }
  for (const plan of plans) {
    if (plan.generator) lines.push(generateAsyncGeneratorAdapters(plan), "");
  }
  for (const plan of plans) lines.push(generatePoll(plan, planByKey, fileName), "");

  if (main) {
    const usesProcess = [...main.types.semanticInfo.standardFunctionReferences.values()]
      .some((name) => name.startsWith("process."));
    lines.push(
      "int32_t main(int argc, char **argv) {",
      "  (void)argc;",
      "  (void)argv;",
      ...(usesProcess ? ["  z_process_set_arguments(argc, argv);"] : []),
      ...(usesThreads
        ? ["  Z_AsyncExecutor executor;", "  z_async_executor_init(&executor, true);"]
        : ["  Z_AsyncExecutor executor = { .main_executor = true, .head = NULL, .tail = NULL, .timers = NULL };"]),
      `  ${main.frameName} *root = ${main.startName}(&executor);`,
      "  z_async_run(&root->task);",
      ...(main.declaration.errorType
        ? [
            "  if (root->failed) {",
            `    ${main.destroyName}(root);`,
            "    free(root);",
            ...(usesThreads ? ["    z_async_executor_destroy(&executor);"] : []),
            "    return 1;",
            "  }",
          ]
        : []),
      "  int32_t result = root->result;",
      `  ${main.destroyName}(root);`,
      "  free(root);",
      ...(usesThreads ? ["  z_async_executor_destroy(&executor);"] : []),
      "  return result;",
      "}",
    );
  }
  return lines.join("\n");
}

function generateFrame(
  plan: AsyncFunctionPlan,
  planByKey: ReadonlyMap<string, AsyncFunctionPlan>,
): string {
  const lines = [
    `struct ${plan.frameName} {`,
    "  Z_AsyncTask task;",
    "  uint32_t state;",
    "  bool cancel_children;",
  ];
  if (plan.generator) {
    lines.push("  bool generator_active;", "  bool generator_finished;");
  }
  const successType = planSuccessType(plan);
  if (successType !== "void") {
    const type = cFrameType(successType, plan.types);
    if (requiresNativeFramePlacement(successType, plan.types)) {
      lines.push(`  alignas(${type}) unsigned char result[sizeof(${type})];`);
    } else {
      lines.push(`  ${cFrameType(successType, plan.types)} result;`);
    }
    if (hasFrameCleanup(successType, plan.types)) {
      lines.push("  bool live_result;");
    }
  }
  if (plan.declaration.errorType) {
    const type = cFrameType(plan.declaration.errorType.name, plan.types);
    lines.push("  bool failed;");
    if (requiresNativeFramePlacement(plan.declaration.errorType.name, plan.types)) {
      lines.push(`  alignas(${type}) unsigned char error[sizeof(${type})];`);
    } else {
      lines.push(`  ${type} error;`);
    }
    if (hasFrameCleanup(plan.declaration.errorType.name, plan.types)) {
      lines.push("  bool live_error;");
    }
  }
  for (const [name, type] of plan.locals) {
    const cType = cFrameType(type, plan.types);
    if (plan.borrowedLocals.has(name)) {
      lines.push(`  ${borrowedFrameType(type, plan.types, plan.mutableBorrowedLocals.has(name))} ${frameField(name)};`);
    } else if (requiresNativeFramePlacement(type, plan.types)) {
      lines.push(`  alignas(${cType}) unsigned char ${frameField(name)}[sizeof(${cType})];`);
    } else {
      lines.push(`  ${cFrameType(type, plan.types)} ${frameField(name)};`);
    }
    if (!plan.borrowedLocals.has(name) && hasFrameCleanup(type, plan.types)) {
      lines.push(`  bool ${frameLiveField(name)};`);
    }
  }
  for (const site of plan.suspensions.values()) {
    const cType = cFrameType(site.type, plan.types);
    if (requiresNativeFramePlacement(site.type, plan.types)) {
      lines.push(`  alignas(${cType}) unsigned char ${site.field}[sizeof(${cType})];`);
    } else {
      lines.push(`  ${cType} ${site.field};`);
    }
    if (hasFrameCleanup(site.type, plan.types)) lines.push(`  bool ${site.field}_live;`);
  }
  for (const [index, target] of plan.children) {
    lines.push(`  ${planByKey.get(targetKey(target))!.frameName} *child_${index};`);
  }
  for (const site of plan.awaits.values()) {
    if (site.generator) lines.push(`  Z_AsyncTask *child_${site.index};`);
  }
  for (const site of plan.asyncForSites) {
    lines.push(`  Z_AsyncTask *child_${site.index};`);
  }
  lines.push("};");
  return lines.join("\n");
}

function generateDestroy(
  plan: AsyncFunctionPlan,
  planByKey: ReadonlyMap<string, AsyncFunctionPlan>,
): string {
  const lines = [
    `static void ${plan.destroyName}(${plan.frameName} *frame) {`,
    "  if (frame == NULL) return;",
  ];
  for (const [index, target] of [...plan.children].reverse()) {
    const child = planByKey.get(targetKey(target))!;
    lines.push(
      `  if (frame->child_${index} != NULL) {`,
      `    ${child.destroyName}(frame->child_${index});`,
      `    free(frame->child_${index});`,
      `    frame->child_${index} = NULL;`,
      "  }",
    );
  }
  const successType = planSuccessType(plan);
  if (successType !== "void" && hasFrameCleanup(successType, plan.types)) {
    lines.push(
      "  if (frame->live_result) {",
      `    ${frameCleanup(frameResultValue("frame", successType, plan.types), successType, plan.types)}`,
      "    frame->live_result = false;",
      "  }",
    );
  }
  if (plan.declaration.errorType && hasFrameCleanup(plan.declaration.errorType.name, plan.types)) {
    lines.push(
      "  if (frame->live_error) {",
      `    ${frameCleanup(frameErrorValue("frame", plan.declaration.errorType.name, plan.types), plan.declaration.errorType.name, plan.types)}`,
      "    frame->live_error = false;",
      "  }",
    );
  }
  for (const [name, type] of [...plan.locals].reverse()) {
    if (plan.borrowedLocals.has(name) || !hasFrameCleanup(type, plan.types)) continue;
    lines.push(
      `  if (frame->${frameLiveField(name)}) {`,
      `    ${frameCleanup(frameStoredValue(name, type, plan.types), type, plan.types)}`,
      `    frame->${frameLiveField(name)} = false;`,
      "  }",
    );
  }
  for (const site of [...plan.suspensions.values()].reverse()) {
    if (!hasFrameCleanup(site.type, plan.types)) continue;
    lines.push(
      `  if (frame->${site.field}_live) {`,
      `    ${frameCleanup(frameSuspensionValue(site, plan.types), site.type, plan.types)}`,
      `    frame->${site.field}_live = false;`,
      "  }",
    );
  }
  lines.push("}");
  return lines.join("\n");
}

function generateStartSignature(plan: AsyncFunctionPlan): string {
  const parameters = ["Z_AsyncExecutor *executor", ...frameInputs(plan).map((input) => {
    if (input.mode === "in" || input.mode === "inout" || input.mode === "out") {
      return `${borrowedFrameType(input.type, plan.types, input.mode !== "in")} ${frameField(input.name)}`;
    }
    const separator = requiresNativeFramePlacement(input.type, plan.types) ? " &&" : " ";
    return `${cFrameType(input.type, plan.types)}${separator}${frameField(input.name)}`;
  })];
  return `static __attribute__((unused)) ${plan.frameName} *${plan.startName}(${parameters.join(", ")})`;
}

function generateStart(plan: AsyncFunctionPlan): string {
  const lines = [
    `${generateStartSignature(plan)} {`,
    `  ${plan.frameName} *frame = (${plan.frameName} *)calloc(1, sizeof(${plan.frameName}));`,
    "  if (frame == NULL) abort();",
    `  frame->task.poll = ${plan.pollName};`,
    "  frame->task.completed = false;",
    "  frame->task.cancellation_requested = false;",
    "  frame->task.cancellation_delivered = false;",
    "  frame->task.cancelled = false;",
    "  frame->task.timer_scheduled = false;",
    "  frame->task.native_thread = false;",
    "  frame->task.native_async = false;",
    "  frame->task.external_completion = false;",
    "  frame->task.thread_joined = false;",
    "  frame->task.native_body_completed = false;",
    "  frame->task.native_thread_finished = false;",
    "  frame->task.wake_at_ms = 0;",
    "  frame->state = 0;",
    "  frame->cancel_children = false;",
  ];
  lines.push("  frame->task.queued = false;");
  lines.push("  frame->task.suspended = false;");
  lines.push("  frame->task.waiter = NULL;");
  lines.push("  frame->task.next = NULL;");
  lines.push("  frame->task.timer_next = NULL;");
  lines.push("  frame->task.executor = executor;");
  lines.push("  frame->task.completion_executor = executor;");
  lines.push("  frame->task.native_executor = NULL;");
  if (plan.declaration.errorType) {
    lines.push("  frame->failed = false;");
    if (hasFrameCleanup(plan.declaration.errorType.name, plan.types)) lines.push("  frame->live_error = false;");
  }
  const successType = planSuccessType(plan);
  if (successType !== "void" && hasFrameCleanup(successType, plan.types)) lines.push("  frame->live_result = false;");
  if (plan.generator) {
    lines.push("  frame->generator_active = false;");
    lines.push("  frame->generator_finished = false;");
  }
  const parameters = new Set(
    frameInputs(plan).filter((input) => input.mode === "value").map((input) => input.name),
  );
  for (const [name, type] of plan.locals) {
    if (!plan.borrowedLocals.has(name) && hasFrameCleanup(type, plan.types)) {
      lines.push(`  frame->${frameLiveField(name)} = ${parameters.has(name) ? "true" : "false"};`);
    }
  }
  for (const site of plan.suspensions.values()) {
    if (hasFrameCleanup(site.type, plan.types)) lines.push(`  frame->${site.field}_live = false;`);
  }
  for (const input of frameInputs(plan)) {
    const name = frameField(input.name);
    if (input.mode === "in" || input.mode === "inout" || input.mode === "out") {
      lines.push(`  frame->${name} = ${name};`);
    } else if (requiresNativeFramePlacement(input.type, plan.types)) {
      lines.push(`  new (frame->${name}) ${cFrameType(input.type, plan.types)}(std::move(${name}));`);
    } else {
      lines.push(`  frame->${name} = ${name};`);
    }
  }
  for (const index of plan.children.keys()) lines.push(`  frame->child_${index} = NULL;`);
  for (const site of plan.awaits.values()) {
    if (site.generator) lines.push(`  frame->child_${site.index} = NULL;`);
  }
  lines.push("  return frame;", "}");
  return lines.join("\n");
}

function generateTaskScopeAsyncSchedule(
  callOffset: number,
  plan: AsyncFunctionPlan,
): string {
  const inputs = frameInputs(plan);
  const parameters = inputs.map((input, index) => (
    `${cFrameType(input.type, plan.types)} _z_capture_${index}`
  ));
  const arguments_ = inputs.map((input, index) => (
    requiresNativeFramePlacement(input.type, plan.types)
      ? `std::move(_z_capture_${index})`
      : `_z_capture_${index}`
  ));
  const destroyName = `z_task_scope_destroy_async_${callOffset}`;
  return [
    `static void ${destroyName}(Z_AsyncTask *task) {`,
    `  ${plan.frameName} *frame = (${plan.frameName} *)task;`,
    `  ${plan.destroyName}(frame);`,
    "  free(frame);",
    "}",
    "",
    `static Z_TaskControl *${taskScopeAsyncScheduleName(callOffset)}(Z_TaskScope *scope${parameters.length ? `, ${parameters.join(", ")}` : ""}) {`,
    `  ${plan.frameName} *child = ${plan.startName}(scope->executor${arguments_.length ? `, ${arguments_.join(", ")}` : ""});`,
    `  return z_task_scope_spawn_async(scope, &child->task, ${destroyName});`,
    "}",
  ].join("\n");
}

function asyncGeneratorFactoryName(plan: Pick<AsyncFunctionPlan, "declaration" | "owner">): string {
  return `z_async_generator_make_${targetPart(plan)}`;
}

function asyncGeneratorFactoryParameters(plan: AsyncFunctionPlan): string[] {
  return frameInputs(plan).map((input) => {
    if (input.mode !== "value") {
      return `${borrowedFrameType(input.type, plan.types, input.mode !== "in")} ${frameField(input.name)}`;
    }
    return `${cFrameType(input.type, plan.types)} ${frameField(input.name)}`;
  });
}

function generateAsyncGeneratorFactorySignature(plan: AsyncFunctionPlan): string {
  return `static __attribute__((unused)) ${cFrameType(plan.declaration.returnType.name, plan.types)} ${asyncGeneratorFactoryName(plan)}(${asyncGeneratorFactoryParameters(plan).join(", ")})`;
}

function generateAsyncGeneratorAdapters(plan: AsyncFunctionPlan): string {
  const generator = plan.generator!;
  const successType = asyncGeneratorAdvanceType(generator);
  const handleType = cFrameType(plan.declaration.returnType.name, plan.types);
  const adapterPart = targetPart(plan);
  const nextName = `z_async_generator_next_${adapterPart}`;
  const destroyName = `z_async_generator_drop_${adapterPart}`;
  const failedName = `z_async_generator_failed_${adapterPart}`;
  const takeResultName = `z_async_generator_take_result_${adapterPart}`;
  const takeErrorName = `z_async_generator_take_error_${adapterPart}`;
  const resultType = cFrameType(successType, plan.types);
  const lines = [
    `static Z_AsyncTask *${nextName}(void *context, Z_AsyncExecutor *executor) {`,
    `  ${plan.frameName} *frame = (${plan.frameName} *)context;`,
    "  if (frame == NULL || frame->generator_active || frame->generator_finished) abort();",
    ...(hasFrameCleanup(successType, plan.types)
      ? ["  if (frame->live_result) abort();"]
      : []),
    "  frame->generator_active = true;",
    "  frame->task.completed = false;",
    "  frame->task.queued = false;",
    "  frame->task.suspended = false;",
    "  frame->task.cancellation_requested = false;",
    "  frame->task.cancellation_delivered = false;",
    "  frame->task.cancelled = false;",
    "  frame->task.timer_scheduled = false;",
    "  frame->task.waiter = NULL;",
    "  frame->task.next = NULL;",
    "  frame->task.timer_next = NULL;",
    "  frame->task.executor = executor;",
    ...(plan.declaration.errorType
      ? [
          "  frame->failed = false;",
          ...(hasFrameCleanup(plan.declaration.errorType.name, plan.types)
            ? ["  if (frame->live_error) abort();"]
            : []),
        ]
      : []),
    "  return &frame->task;",
    "}",
    "",
    `static void ${destroyName}(void *context) {`,
    `  ${plan.frameName} *frame = (${plan.frameName} *)context;`,
    "  if (frame == NULL) return;",
    "  if (frame->generator_active) abort();",
    `  ${plan.destroyName}(frame);`,
    "  free(frame);",
    "}",
    "",
    `static bool ${failedName}(void *context) {`,
    `  ${plan.frameName} *frame = (${plan.frameName} *)context;`,
    ...(plan.declaration.errorType ? ["  return frame->failed;"] : ["  (void)frame;", "  return false;"]),
    "}",
    "",
    `static void ${takeResultName}(void *context, void *destination) {`,
    `  ${plan.frameName} *frame = (${plan.frameName} *)context;`,
    "  if (frame->generator_active || !frame->task.completed) abort();",
    ...(requiresNativeFramePlacement(successType, plan.types)
      ? [`  new (destination) ${resultType}(${frameTakeExpression(frameResultValue("frame", successType, plan.types), "frame->live_result")});`]
      : [
          `  *(((${resultType} *)destination)) = ${frameResultValue("frame", successType, plan.types)};`,
          ...(hasFrameCleanup(successType, plan.types) ? ["  frame->live_result = false;"] : []),
        ]),
    "}",
    "",
    `static void ${takeErrorName}(void *context, void *destination) {`,
    `  ${plan.frameName} *frame = (${plan.frameName} *)context;`,
    ...(plan.declaration.errorType
      ? (() => {
          const errorType = plan.declaration.errorType.name;
          const cErrorType = cFrameType(errorType, plan.types);
          return [
            "  if (frame->generator_active || !frame->task.completed || !frame->failed) abort();",
            ...(requiresNativeFramePlacement(errorType, plan.types)
              ? [`  new (destination) ${cErrorType}(${frameTakeExpression(frameErrorValue("frame", errorType, plan.types), "frame->live_error")});`]
              : [
                  `  *(((${cErrorType} *)destination)) = ${frameErrorValue("frame", errorType, plan.types)};`,
                  ...(hasFrameCleanup(errorType, plan.types) ? ["  frame->live_error = false;"] : []),
                ]),
          ];
        })()
      : ["  (void)frame;", "  (void)destination;", "  abort();"]),
    "}",
    "",
    `${generateAsyncGeneratorFactorySignature(plan)} {`,
    `  ${plan.frameName} *frame = ${plan.startName}(${[
      "NULL",
      ...frameInputs(plan).map((input) => (
        input.mode === "value" && requiresNativeFramePlacement(input.type, plan.types)
          ? `std::move(${frameField(input.name)})`
          : frameField(input.name)
      )),
    ].join(", ")});`,
    `  return (${handleType}){`,
    "    .context = frame,",
    `    .next = ${nextName},`,
    `    .destroy = ${destroyName},`,
    `    .failed = ${failedName},`,
    `    .take_result = ${takeResultName},`,
    `    .take_error = ${takeErrorName},`,
    "  };",
    "}",
  ];
  return lines.join("\n");
}

function frameInputs(plan: AsyncFunctionPlan): readonly {
  readonly name: string;
  readonly type: string;
  readonly mode: "value" | "in" | "inout" | "out";
}[] {
  return [
    ...(plan.owner && !plan.declaration.static
      ? [{ name: "this", type: plan.owner.name, mode: "value" as const }]
      : []),
    ...plan.declaration.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type.name,
      mode: parseSliceType(parameter.type.name)
        ? "value" as const
        : parameter.mode === "in"
        ? "in" as const
        : parameter.mode === "inout"
          ? "inout" as const
          : parameter.mode === "out" ? "out" as const : "value" as const,
    })),
  ];
}

function emitAwaitArguments(
  site: Pick<AwaitSite, "receiver" | "target" | "call"> & {
    readonly nativeThread?: boolean;
    readonly placement?: AwaitSite["placement"] | SpawnSite["placement"];
  },
  parent: AsyncFunctionPlan,
  fileName: string,
): string[] {
  const arguments_: string[] = [];
  if (site.receiver) {
    let receiver = emitFrameExpression(site.receiver, parent, fileName);
    if (site.target.owner?.kind === "class") {
      receiver = `Z_${site.target.owner.name}_retain(${receiver})`;
    }
    arguments_.push(receiver);
  }
  arguments_.push(...site.call.arguments.map((argument, index) => {
    const parameter = site.target.declaration.parameters[index];
    const argumentType = argument.kind === "identifier"
      ? parent.locals.get(argument.name)
      : undefined;
    const executorBoundThreadCapture = Boolean(
      site.nativeThread
      && argument.kind === "identifier"
      && argumentType
      && isExecutorBoundClassType(argumentType, parent.types),
    );
    let value = executorBoundThreadCapture && argument.kind === "identifier" && argumentType
      ? parent.borrowedLocals.has(argument.name)
        ? borrowedFrameValue(argument.name, argumentType, parent.types)
        : frameStoredValue(argument.name, argumentType, parent.types)
      : emitFrameExpression(argument, parent, fileName);
    if (executorBoundThreadCapture && argumentType) {
      return `Z_${argumentType}_retain(${value})`;
    }
    if (site.placement && argument.kind === "identifier" && parameter?.mode === "value") {
      const type = argumentType;
      if (type === "String") {
        value = `z_string_copy_bytes(${value}, 0, (${value}).length)`;
      } else if (type === "TaskScope") {
        value = `z_task_scope_retain(${value})`;
      } else if (type === "TaskControl") {
        value = `z_task_control_retain(${value})`;
      } else if (type && parent.types.structs.get(type)?.kind === "class") {
        value = `Z_${type}_retain(${value})`;
      }
    }
    if (parameter && parseSliceType(parameter.type.name)) {
      return emitFrameSliceConversion(argument, value, parent, fileName) ?? value;
    }
    if (site.nativeThread && argument.kind === "identifier" && parameter?.mode === "value") {
      const type = argumentType;
      if (type && hasFrameCleanup(type, parent.types)) {
        const liveFlag = `frame->${frameLiveField(argument.name)}`;
        return requiresNativeFramePlacement(type, parent.types)
          ? frameTakeExpression(value, liveFlag)
          : `(${liveFlag} = false, ${value})`;
      }
    }
    if (parameter?.mode !== "in" && parameter?.mode !== "inout" && parameter?.mode !== "out") return value;
    return (parameter.mode === "in" || parameter.mode === "inout")
      && isFrameReferenceIdentityType(parameter.type.name, parent.types)
      ? value
      : `&(${value})`;
  }));
  return arguments_;
}

function emitFrameSliceConversion(
  argument: Expression,
  value: string,
  plan: Pick<AsyncFunctionPlan, "locals" | "types">,
  fileName: string,
): string | null {
  const conversion = plan.types.semanticInfo.sliceConversions.get(argument.location.offset);
  if (!conversion) return null;
  const fixed = parseFixedArrayType(conversion.sourceType);
  const dynamic = parseDynamicArrayType(conversion.sourceType);
  if (!fixed && !dynamic) {
    unsupported(fileName, argument.location, "async Slice conversion requires fixed or growable array storage");
  }
  const length = fixed ? String(fixed.length) : `((${value}).length)`;
  return `(${cFrameType(conversion.targetType, plan.types)}){ .data = (${value}).data, .length = ${length} }`;
}

function schedulePlacedChild(
  site: Pick<AwaitSite, "placement"> | Pick<SpawnSite, "placement">,
  parent: Pick<AsyncFunctionPlan, "nativeThread">,
  child: string,
): string[] {
  if ("placement" in site && site.placement && parent.nativeThread) {
    return [`z_async_enqueue_from_thread(frame->task.completion_executor, &${child}->task);`];
  }
  return [`z_async_enqueue(frame->task.executor, &${child}->task);`];
}

function childExecutor(
  site: Pick<AwaitSite, "placement"> | Pick<SpawnSite, "placement">,
  parent: Pick<AsyncFunctionPlan, "nativeThread">,
): string {
  return "placement" in site && site.placement && parent.nativeThread
    ? "frame->task.completion_executor"
    : "frame->task.executor";
}

function cancelChild(
  site: Pick<AwaitSite, "placement"> | Pick<SpawnSite, "placement"> | undefined,
  parent: Pick<AsyncFunctionPlan, "nativeThread">,
  child: string,
): string {
  return site?.placement && parent.nativeThread
    ? `z_async_cancel_from_thread(frame->task.completion_executor, ${child});`
    : `z_async_cancel(${child});`;
}

function beginAwait(
  site: AwaitSite,
  parent: AsyncFunctionPlan,
  planByKey: ReadonlyMap<string, AsyncFunctionPlan>,
  fileName: string,
  nextState: number,
): string[] {
  if (site.generator) {
    const handle = emitFrameExpression(site.generator.receiver, parent, fileName);
    return [
      `frame->child_${site.index} = (${handle}).next((${handle}).context, frame->task.executor);`,
      `z_async_enqueue(frame->task.executor, frame->child_${site.index});`,
      `frame->state = ${nextState};`,
      "continue;",
    ];
  }
  const target = planByKey.get(targetKey(site.target))!;
  const arguments_ = emitAwaitArguments(site, parent, fileName);
  return [
    `frame->child_${site.index} = ${target.startName}(${[childExecutor(site, parent), ...arguments_].join(", ")});`,
    ...schedulePlacedChild(site, parent, `frame->child_${site.index}`),
    `frame->state = ${nextState};`,
    "continue;",
  ];
}

function assignPersistentBorrowedBinding(
  name: string,
  type: string,
  value: string,
  plan: AsyncFunctionPlan,
): string {
  return plan.borrowedLocals.has(name)
    ? plan.types.structs.get(type)?.kind === "class"
      ? `frame->${frameField(name)} = ${value};`
      : `frame->${frameField(name)} = &(${value});`
    : `frame->${frameField(name)} = ${value};`;
}

function emitAsyncForBranch(
  operation: Extract<AsyncOperation, { kind: "forBranch" }>,
  plan: AsyncFunctionPlan,
  fileName: string,
): string[] {
  const iterableType = frameExpressionType(operation.statement.iterable, plan);
  const collection = asyncCollectionShape(iterableType, plan.types);
  if (!collection) unsupported(fileName, operation.statement.location, "missing persistent async collection shape");
  const iterable = emitFrameExpression(operation.statement.iterable, plan, fileName);
  const storage = collection!.storageMember ? `((${iterable}).${collection!.storageMember})` : `(${iterable})`;
  const index = frameStoredValue(operation.indexBinding, "usize", plan.types);
  const length = collection!.fixedLength === null
    ? `((${storage}).length)`
    : String(collection!.fixedLength);
  const item = `((${storage}).data[${index}])`;
  const lines = [
    `if (${index} >= ${length}) {`,
    `  frame->state = ${asyncLabelMarker(operation.elseLabel)};`,
    "  continue;",
    "}",
  ];
  if (operation.statement.binding) {
    const type = plan.locals.get(operation.statement.binding)!;
    lines.push(assignPersistentBorrowedBinding(operation.statement.binding, type, item, plan));
  }
  const aggregate = plan.types.structs.get(collection!.elementType);
  for (const binding of operation.statement.objectBindings ?? []) {
    const field = aggregate!.fields.find((candidate) => candidate.name === binding.fieldName)!;
    lines.push(assignPersistentBorrowedBinding(
      binding.bindingName,
      field.type.name,
      `((${item}).${field.name})`,
      plan,
    ));
  }
  lines.push(`frame->state = ${asyncLabelMarker(operation.bodyLabel)};`, "continue;");
  return lines;
}

function asyncForHandle(
  site: AsyncForSite,
  plan: AsyncFunctionPlan,
  fileName: string,
): string {
  return site.handleBinding
    ? frameStoredValue(site.handleBinding, site.generatorType, plan.types)
    : emitFrameExpression(site.statement.iterable, plan, fileName);
}

function asyncOptionNichePayload(
  optionType: string,
  types: AsyncTypeContext,
): string | null {
  const option = parseOptionType(optionType);
  if (!option) return null;
  if (types.semanticInfo.foreignNamedTypes.get(option.target)?.kind === "object") return option.target;
  const pointer = parsePointerTypeName(option.target);
  return pointer && !pointer.nullable ? option.target : null;
}

function asyncOptionNicheNull(payloadType: string, types: AsyncTypeContext): "nil" | "NULL" {
  return types.semanticInfo.foreignNamedTypes.get(payloadType)?.kind === "object" ? "nil" : "NULL";
}

function asyncFrameZeroValue(type: string, types: AsyncTypeContext): string {
  if (
    types.structs.get(type)?.kind === "class"
    || types.semanticInfo.foreignTypes.has(type)
    || parseTaskType(type)
  ) return "NULL";
  if (
    types.semanticInfo.foreignObjectTypes.has(type)
    || types.semanticInfo.foreignNamedTypes.get(type)?.kind === "object"
  ) return "nil";
  if (scalarTypes.has(type)) return type === "boolean" ? "false" : "0";
  return `(${cFrameType(type, types)}){ 0 }`;
}

function emitAsyncForInitialize(
  site: AsyncForSite,
  plan: AsyncFunctionPlan,
  fileName: string,
  nextState: number,
): string[] {
  const value = emitFrameExpression(site.statement.iterable, plan, fileName);
  const destination = frameStoredValue(site.handleBinding!, site.generatorType, plan.types);
  return [
    `${destination} = ${value};`,
    `frame->${frameLiveField(site.handleBinding!)} = true;`,
    `frame->state = ${nextState};`,
    "continue;",
  ];
}

function emitAsyncForBegin(
  site: AsyncForSite,
  plan: AsyncFunctionPlan,
  fileName: string,
  nextState: number,
): string[] {
  const handle = asyncForHandle(site, plan, fileName);
  return [
    `frame->child_${site.index} = (${handle}).next((${handle}).context, frame->task.executor);`,
    `z_async_enqueue(frame->task.executor, frame->child_${site.index});`,
    `frame->state = ${nextState};`,
    "continue;",
  ];
}

function emitAsyncForComplete(
  operation: Extract<AsyncOperation, { kind: "asyncForComplete" }>,
  plan: AsyncFunctionPlan,
  fileName: string,
): string[] {
  const { site } = operation;
  const handle = asyncForHandle(site, plan, fileName);
  const resultType = optionTypeName(site.generator.elementType);
  const result = frameStoredValue(site.resultBinding, resultType, plan.types);
  const resultPointer = requiresNativeFramePlacement(resultType, plan.types)
    ? `frame->${frameField(site.resultBinding)}`
    : `&(${result})`;
  const element = frameStoredValue(site.elementBinding, site.generator.elementType, plan.types);
  const niche = asyncOptionNichePayload(resultType, plan.types);
  const present = niche
    ? `${result} != ${asyncOptionNicheNull(niche, plan.types)}`
    : `(${result}).tag == ${resultTag(resultType, "some")}`;
  const payload = niche ? result : `((${result}).data.some)`;
  const lines = [
    `if (!z_async_wait(&frame->task, frame->child_${site.index})) return;`,
  ];
  if (site.generator.errorType) {
    const errorType = site.generator.errorType;
    const errorPointer = requiresNativeFramePlacement(errorType, plan.types)
      ? "frame->error"
      : "&frame->error";
    lines.push(
      `if ((${handle}).failed((${handle}).context)) {`,
      `  (${handle}).take_error((${handle}).context, ${errorPointer});`,
      ...(hasFrameCleanup(errorType, plan.types) ? ["  frame->live_error = true;"] : []),
      `  frame->child_${site.index} = NULL;`,
      "  frame->failed = true;",
      "  frame->cancel_children = true;",
      `  frame->state = ${finalizeStateMarker};`,
      "  continue;",
      "}",
    );
  }
  lines.push(
    `(${handle}).take_result((${handle}).context, ${resultPointer});`,
    `frame->child_${site.index} = NULL;`,
    ...(hasFrameCleanup(resultType, plan.types)
      ? [`frame->${frameLiveField(site.resultBinding)} = true;`]
      : []),
    `if (!(${present})) {`,
  );
  if (hasFrameCleanup(resultType, plan.types)) {
    lines.push(
      `  ${frameCleanup(result, resultType, plan.types)}`,
      `  frame->${frameLiveField(site.resultBinding)} = false;`,
    );
  }
  lines.push(
    `  frame->state = ${asyncLabelMarker(operation.exhaustedLabel)};`,
    "  continue;",
    "}",
  );
  if (requiresNativeFramePlacement(site.generator.elementType, plan.types)) {
    lines.push(`new (frame->${frameField(site.elementBinding)}) ${cFrameType(site.generator.elementType, plan.types)}(std::move(${payload}));`);
    if (hasFrameCleanup(resultType, plan.types)) {
      lines.push(
        frameCleanup(result, resultType, plan.types),
        `frame->${frameLiveField(site.resultBinding)} = false;`,
      );
    }
  } else {
    lines.push(`${element} = ${payload};`);
    if (hasFrameCleanup(site.generator.elementType, plan.types) && hasFrameCleanup(resultType, plan.types)) {
      lines.push(`frame->${frameLiveField(site.resultBinding)} = false;`);
    }
  }
  if (hasFrameCleanup(site.generator.elementType, plan.types)) {
    lines.push(`frame->${frameLiveField(site.elementBinding)} = true;`);
  }
  const elementDeclaration = plan.types.structs.get(site.generator.elementType);
  for (const binding of site.statement.objectBindings ?? []) {
    const field = elementDeclaration!.fields.find((candidate) => candidate.name === binding.fieldName)!;
    const destination = frameStoredValue(binding.bindingName, field.type.name, plan.types);
    const source = `((${element}).${field.name})`;
    if (requiresNativeFramePlacement(field.type.name, plan.types)) {
      lines.push(`new (frame->${frameField(binding.bindingName)}) ${cFrameType(field.type.name, plan.types)}(std::move(${source}));`);
    } else {
      lines.push(`${destination} = ${source};`);
    }
    if (hasFrameCleanup(field.type.name, plan.types)) {
      lines.push(
        `${source} = ${asyncFrameZeroValue(field.type.name, plan.types)};`,
        `frame->${frameLiveField(binding.bindingName)} = true;`,
      );
    }
  }
  lines.push(
    `frame->state = ${asyncLabelMarker(operation.bodyLabel)};`,
    "continue;",
  );
  return lines;
}

function emitAsyncForCleanup(
  operation: Extract<AsyncOperation, { kind: "asyncForCleanup" }>,
  plan: AsyncFunctionPlan,
  nextState: number,
): string[] {
  const { site } = operation;
  const lines: string[] = [];
  const elementDeclaration = plan.types.structs.get(site.generator.elementType);
  for (const binding of [...(site.statement.objectBindings ?? [])].reverse()) {
    const field = elementDeclaration!.fields.find((candidate) => candidate.name === binding.fieldName)!;
    if (!hasFrameCleanup(field.type.name, plan.types)) continue;
    const value = frameStoredValue(binding.bindingName, field.type.name, plan.types);
    lines.push(
      `if (frame->${frameLiveField(binding.bindingName)}) {`,
      `  ${frameCleanup(value, field.type.name, plan.types)}`,
      `  frame->${frameLiveField(binding.bindingName)} = false;`,
      "}",
    );
  }
  if (hasFrameCleanup(site.generator.elementType, plan.types)) {
    const binding = frameStoredValue(site.elementBinding, site.generator.elementType, plan.types);
    lines.push(
      `if (frame->${frameLiveField(site.elementBinding)}) {`,
      `  ${frameCleanup(binding, site.generator.elementType, plan.types)}`,
      `  frame->${frameLiveField(site.elementBinding)} = false;`,
      "}",
    );
  }
  const resultType = optionTypeName(site.generator.elementType);
  if (hasFrameCleanup(resultType, plan.types)) {
    const result = frameStoredValue(site.resultBinding, resultType, plan.types);
    lines.push(
      `if (frame->${frameLiveField(site.resultBinding)}) {`,
      `  ${frameCleanup(result, resultType, plan.types)}`,
      `  frame->${frameLiveField(site.resultBinding)} = false;`,
      "}",
    );
  }
  if (operation.destroyHandle && site.handleBinding) {
    const handle = frameStoredValue(site.handleBinding, site.generatorType, plan.types);
    lines.push(
      `if (frame->${frameLiveField(site.handleBinding)}) {`,
      `  ${frameCleanup(handle, site.generatorType, plan.types)}`,
      `  frame->${frameLiveField(site.handleBinding)} = false;`,
      "}",
    );
  }
  lines.push(`frame->state = ${nextState};`, "continue;");
  return lines;
}

function asyncMatchSubject(
  site: AsyncMatchSite,
  plan: AsyncFunctionPlan,
  fileName: string,
): string {
  return site.subjectBinding
    ? frameStoredValue(site.subjectBinding, site.subjectType, plan.types)
    : emitFrameExpression(site.match.expression, plan, fileName);
}

function emitAsyncMatchInitialize(
  site: AsyncMatchSite,
  plan: AsyncFunctionPlan,
  fileName: string,
  nextState: number,
): string[] {
  if (!site.subjectBinding) return [`frame->state = ${nextState};`, "continue;"];
  let value = emitFrameExpression(site.match.expression, plan, fileName);
  const suspension = plan.suspensions.get(site.match.expression.location.offset);
  if (suspension && hasFrameCleanup(site.subjectType, plan.types)) {
    value = frameTransferredValue(
      value,
      `frame->${suspension.field}_live`,
      site.subjectType,
      plan.types,
    );
  }
  const destination = frameStoredValue(site.subjectBinding, site.subjectType, plan.types);
  const initialize = requiresNativeFramePlacement(site.subjectType, plan.types)
    ? `new (frame->${frameField(site.subjectBinding)}) ${cFrameType(site.subjectType, plan.types)}(${value});`
    : `${destination} = ${value};`;
  return [
    initialize,
    ...(hasFrameCleanup(site.subjectType, plan.types)
      ? [`frame->${frameLiveField(site.subjectBinding)} = true;`]
      : []),
    `frame->state = ${nextState};`,
    "continue;",
  ];
}

function emitAsyncMatchDispatch(
  operation: Extract<AsyncOperation, { kind: "matchDispatch" }>,
  plan: AsyncFunctionPlan,
  fileName: string,
): string[] {
  const { site } = operation;
  const declaration = plan.types.enums.get(site.subjectType);
  if (!declaration) unsupported(fileName, site.match.location, "missing persistent async match enum");
  const subject = asyncMatchSubject(site, plan, fileName);
  return [
    `switch ((${subject}).tag) {`,
    ...site.match.arms.map((arm, index) => (
      `  case ${resultTag(site.subjectType, arm.variantName)}: frame->state = ${asyncLabelMarker(operation.armLabels[index])}; break;`
    )),
    "  default: abort();",
    "}",
    "continue;",
  ];
}

function emitAsyncMatchBinding(
  operation: Extract<AsyncOperation, { kind: "matchBind" }>,
  plan: AsyncFunctionPlan,
  fileName: string,
): string[] {
  const { site } = operation;
  const declaration = plan.types.enums.get(site.subjectType);
  const arm = site.match.arms[operation.armIndex];
  const variant = declaration?.variants.find((candidate) => candidate.name === arm.variantName);
  if (!declaration || !variant) unsupported(fileName, site.match.location, "missing persistent async match variant");
  const subject = asyncMatchSubject(site, plan, fileName);
  const payload = `((${subject}).data.${variant!.name})`;
  const lines: string[] = [];
  if (arm.binding && variant!.payload) {
    if (site.subjectBinding) {
      const destination = frameStoredValue(arm.binding, variant!.payload.name, plan.types);
      lines.push(requiresNativeFramePlacement(variant!.payload.name, plan.types)
        ? `new (frame->${frameField(arm.binding)}) ${cFrameType(variant!.payload.name, plan.types)}(std::move(${payload}));`
        : `${destination} = ${payload};`);
      if (hasFrameCleanup(variant!.payload.name, plan.types)) {
        lines.push(`frame->${frameLiveField(arm.binding)} = true;`);
      }
      if (hasFrameCleanup(site.subjectType, plan.types)) {
        const nativePayload = requiresNativeFramePlacement(variant!.payload.name, plan.types);
        if (!nativePayload) {
          lines.push(`${payload} = ${asyncFrameZeroValue(variant!.payload.name, plan.types)};`);
        }
        if (nativePayload) lines.push(`std::destroy_at(&(${subject}));`);
        lines.push(`frame->${frameLiveField(site.subjectBinding)} = false;`);
      }
    } else {
      lines.push(assignPersistentBorrowedBinding(arm.binding, variant!.payload.name, payload, plan));
    }
  }
  const aggregate = variant!.payload ? plan.types.structs.get(variant!.payload.name) : null;
  const access = aggregate?.kind === "class" ? "->" : ".";
  for (const binding of arm.objectBindings ?? []) {
    const field = aggregate!.fields.find((candidate) => candidate.name === binding.fieldName)!;
    lines.push(assignPersistentBorrowedBinding(
      binding.bindingName,
      field.type.name,
      `((${payload})${access}${field.name})`,
      plan,
    ));
  }
  return lines;
}

function emitAsyncMatchCleanupLines(
  site: AsyncMatchSite,
  armIndex: number,
  plan: AsyncFunctionPlan,
): string[] {
  if (!site.subjectBinding) return [];
  const arm = site.match.arms[armIndex];
  const declaration = plan.types.enums.get(site.subjectType)!;
  const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName)!;
  const lines: string[] = [];
  if (arm.binding && variant.payload && hasFrameCleanup(variant.payload.name, plan.types)) {
    lines.push(
      `if (frame->${frameLiveField(arm.binding)}) {`,
      `  ${frameCleanup(frameStoredValue(arm.binding, variant.payload.name, plan.types), variant.payload.name, plan.types)}`,
      `  frame->${frameLiveField(arm.binding)} = false;`,
      "}",
    );
  }
  if (hasFrameCleanup(site.subjectType, plan.types)) {
    lines.push(
      `if (frame->${frameLiveField(site.subjectBinding)}) {`,
      `  ${frameCleanup(frameStoredValue(site.subjectBinding, site.subjectType, plan.types), site.subjectType, plan.types)}`,
      `  frame->${frameLiveField(site.subjectBinding)} = false;`,
      "}",
    );
  }
  return lines;
}

function emitAsyncMatchCleanup(
  operation: Extract<AsyncOperation, { kind: "matchCleanup" }>,
  plan: AsyncFunctionPlan,
  nextState: number,
): string[] {
  return [
    ...emitAsyncMatchCleanupLines(operation.site, operation.armIndex, plan),
    `frame->state = ${nextState};`,
    "continue;",
  ];
}

function emitAsyncMatchSelect(
  operation: Extract<AsyncOperation, { kind: "matchSelect" }>,
  plan: AsyncFunctionPlan,
  fileName: string,
): string[] {
  const { site } = operation;
  let value = emitFrameExpression(operation.expression, plan, fileName);
  const suspension = plan.suspensions.get(operation.expression.location.offset);
  if (suspension && hasFrameCleanup(site.destinationType, plan.types)) {
    value = frameTransferredValue(
      value,
      `frame->${suspension.field}_live`,
      site.destinationType,
      plan.types,
    );
  }
  const initialize = requiresNativeFramePlacement(site.destinationType, plan.types)
    ? `new (${site.destination}) ${cFrameType(site.destinationType, plan.types)}(${value});`
    : `${site.destination} = ${value};`;
  const lines = [
    initialize,
    ...(hasFrameCleanup(site.destinationType, plan.types)
      ? [`${destinationLiveFlag(site.destination, plan)} = true;`]
      : []),
    ...emitAsyncMatchCleanupLines(site, operation.armIndex, plan),
  ];
  if (site.terminal) {
    if (plan.declaration.errorType) lines.push("frame->failed = false;");
    lines.push(`frame->state = ${finalizeStateMarker};`, "continue;");
  } else {
    lines.push(`frame->state = ${asyncLabelMarker(site.endLabel)};`, "continue;");
  }
  return lines;
}

function emitAsyncBranchSelect(
  operation: Extract<AsyncOperation, { kind: "branchSelect" }>,
  plan: AsyncFunctionPlan,
  fileName: string,
): string[] {
  const { site } = operation;
  const prepared = emitPreparedFrameExpression(operation.expression, plan, fileName);
  let value = prepared.value;
  const suspension = plan.suspensions.get(operation.expression.location.offset);
  if (suspension && hasFrameCleanup(site.destinationType, plan.types)) {
    value = frameTransferredValue(
      value,
      `frame->${suspension.field}_live`,
      site.destinationType,
      plan.types,
    );
  }
  const initialize = requiresNativeFramePlacement(site.destinationType, plan.types)
    ? `new (${site.destination}) ${cFrameType(site.destinationType, plan.types)}(${value});`
    : `${site.destination} = ${value};`;
  const lines = [
    ...prepared.prefix,
    initialize,
    ...(hasFrameCleanup(site.destinationType, plan.types)
      ? [`${destinationLiveFlag(site.destination, plan)} = true;`]
      : []),
  ];
  if (site.terminal) {
    if (plan.declaration.errorType) lines.push("frame->failed = false;");
    lines.push(`frame->state = ${finalizeStateMarker};`, "continue;");
  } else {
    lines.push(`frame->state = ${asyncLabelMarker(site.endLabel)};`, "continue;");
  }
  return lines;
}

function generatePoll(
  plan: AsyncFunctionPlan,
  planByKey: ReadonlyMap<string, AsyncFunctionPlan>,
  fileName: string,
): string {
  if (plan.foreign) return generateForeignAsyncPoll(plan);
  const cases: string[] = [];
  const labels = new Map<number, number>();
  let state = 0;
  const emitNestedAwaits = (expression: Expression): void => {
    for (const nested of plan.nestedAwaits.get(expression.location.offset) ?? []) {
      const site = nested.await;
      if (site.intrinsic === "delay" || site.intrinsic === "yield") {
        unsupported(fileName, nested.expression.location, `a void ${site.intrinsic} cannot be embedded in a value expression`);
      }
      if (!site.spawn) {
        cases.push(caseBlock(state, beginAwait(site, plan, planByKey, fileName, state + 1)));
        state += 1;
      }
      cases.push(caseBlock(state, awaitCompletion(
        site,
        plan,
        `frame->${nested.field}`,
        nested.type,
        false,
        state + 1,
      )));
      state += 1;
    }
  };
  for (const operation of plan.operations) {
    if (operation.kind === "label") {
      labels.set(operation.label, state);
      continue;
    }
    if (operation.kind === "jump") {
      cases.push(caseBlock(state, [
        `frame->state = ${asyncLabelMarker(operation.label)};`,
        "continue;",
      ]));
      state += 1;
      continue;
    }
    if (operation.kind === "branch") {
      emitNestedAwaits(operation.condition);
      const condition = emitFrameExpression(operation.condition, plan, fileName);
      cases.push(caseBlock(state, [
        `frame->state = (${condition}) ? ${asyncLabelMarker(operation.thenLabel)} : ${asyncLabelMarker(operation.elseLabel)};`,
        "continue;",
      ]));
      state += 1;
      continue;
    }
    if (operation.kind === "forBranch") {
      cases.push(caseBlock(state, emitAsyncForBranch(operation, plan, fileName)));
      state += 1;
      continue;
    }
    if (operation.kind === "forIncrement") {
      const index = frameStoredValue(operation.indexBinding, "usize", plan.types);
      cases.push(caseBlock(state, [
        `${index} += 1;`,
        `frame->state = ${state + 1};`,
        "continue;",
      ]));
      state += 1;
      continue;
    }
    if (operation.kind === "asyncForInitialize") {
      cases.push(caseBlock(state, emitAsyncForInitialize(operation.site, plan, fileName, state + 1)));
      state += 1;
      continue;
    }
    if (operation.kind === "asyncForBegin") {
      cases.push(caseBlock(state, emitAsyncForBegin(operation.site, plan, fileName, state + 1)));
      state += 1;
      continue;
    }
    if (operation.kind === "asyncForComplete") {
      cases.push(caseBlock(state, emitAsyncForComplete(operation, plan, fileName)));
      state += 1;
      continue;
    }
    if (operation.kind === "asyncForCleanup") {
      cases.push(caseBlock(state, emitAsyncForCleanup(operation, plan, state + 1)));
      state += 1;
      continue;
    }
    if (operation.kind === "matchInitialize") {
      emitNestedAwaits(operation.site.match.expression);
      cases.push(caseBlock(state, emitAsyncMatchInitialize(operation.site, plan, fileName, state + 1)));
      state += 1;
      continue;
    }
    if (operation.kind === "matchDispatch") {
      if (!operation.site.subjectBinding) emitNestedAwaits(operation.site.match.expression);
      cases.push(caseBlock(state, emitAsyncMatchDispatch(operation, plan, fileName)));
      state += 1;
      continue;
    }
    if (operation.kind === "matchCleanup") {
      cases.push(caseBlock(state, emitAsyncMatchCleanup(operation, plan, state + 1)));
      state += 1;
      continue;
    }
    if (operation.kind === "matchSelect") {
      emitNestedAwaits(operation.expression);
      cases.push(caseBlock(state, emitAsyncMatchSelect(operation, plan, fileName)));
      state += 1;
      continue;
    }
    if (operation.kind === "branchSelect") {
      emitNestedAwaits(operation.expression);
      cases.push(caseBlock(state, emitAsyncBranchSelect(operation, plan, fileName)));
      state += 1;
      continue;
    }
    if (operation.kind === "matchBind") {
      cases.push(caseBlock(state, [
        ...emitAsyncMatchBinding(operation, plan, fileName),
        `frame->state = ${state + 1};`,
        "continue;",
      ]));
      state += 1;
      continue;
    }
    if (operation.kind === "scopeEnter") {
      cases.push(caseBlock(state, [
        `frame->${frameField(operation.name)} = z_task_scope_new(frame->task.executor);`,
        `frame->${frameLiveField(operation.name)} = true;`,
        `frame->state = ${state + 1};`,
        "continue;",
      ]));
      state += 1;
      continue;
    }
    if (operation.kind === "scopeExit") {
      for (const site of [...plan.spawns.values()].filter((candidate) => candidate.scope === operation.scope)) {
        const target = planByKey.get(targetKey(site.target))!;
        const child = `frame->child_${site.index}`;
        cases.push(caseBlock(state, [
          `if (${child} != NULL) {`,
          ...(operation.cancel ? [`  ${cancelChild(site, plan, `&${child}->task`)}`] : []),
          `  if (!z_async_wait(&frame->task, &${child}->task)) return;`,
          `  ${target.destroyName}(${child});`,
          `  free(${child});`,
          `  frame->child_${site.index} = NULL;`,
          ...(site.binding ? [`  frame->${frameField(site.binding)} = NULL;`] : []),
          "}",
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
        state += 1;
      }
      if (operation.name) {
        const scope = `frame->${frameField(operation.name)}`;
        cases.push(caseBlock(state, [
          `if (frame->${frameLiveField(operation.name)}) {`,
          `  if (!z_task_scope_join(${scope}, &frame->task, ${operation.cancel ? "true" : "frame->cancel_children"})) return;`,
          `  z_task_scope_release(${scope});`,
          `  frame->${frameField(operation.name)} = NULL;`,
          `  frame->${frameLiveField(operation.name)} = false;`,
          "}",
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
        state += 1;
      }
      continue;
    }
    if (operation.kind === "localCleanup") {
      cases.push(caseBlock(state, [
        `if (frame->${frameLiveField(operation.name)}) {`,
        `  ${frameCleanup(frameStoredValue(operation.name, operation.type, plan.types), operation.type, plan.types)}`,
        `  frame->${frameLiveField(operation.name)} = false;`,
        "}",
        `frame->state = ${state + 1};`,
        "continue;",
      ]));
      state += 1;
      continue;
    }
    const statement = operation.statement;
    if (statement.kind === "variable" && statement.initializer) emitNestedAwaits(statement.initializer);
    else if (statement.kind === "assignment") {
      emitNestedAwaits(statement.target);
      emitNestedAwaits(statement.expression);
    }
    else if (statement.kind === "return" && statement.expression) emitNestedAwaits(statement.expression);
    else if (statement.kind === "throw" || statement.kind === "expressionStatement") {
      emitNestedAwaits(statement.expression);
    }
    if (statement.kind === "variable") {
      const initializer = statement.initializer;
      if (!initializer) {
        cases.push(caseBlock(state, [
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
        state += 1;
        continue;
      }
      const spawnedSite = initializer.kind === "spawn"
          || initializer.kind === "call"
          || (initializer.kind === "executorPlacement" && initializer.mode === "spawn")
        ? plan.spawns.get(initializer.location.offset)
        : null;
      if (spawnedSite) {
        const site = spawnedSite;
        const target = planByKey.get(targetKey(site.target))!;
        const arguments_ = emitAwaitArguments(site, plan, fileName);
        cases.push(caseBlock(state, [
          `frame->child_${site.index} = ${target.startName}(${[childExecutor(site, plan), ...arguments_].join(", ")});`,
          `frame->${frameField(statement.name)} = &frame->child_${site.index}->task;`,
          site.nativeThread
            ? `z_async_start_native_thread(&frame->child_${site.index}->task, ${site.asyncNativeThread ? "true" : "false"});`
            : schedulePlacedChild(site, plan, `frame->child_${site.index}`).join("\n"),
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
        state += 1;
        continue;
      }
      const operation = awaitOperation(initializer);
      if (operation) {
        const site = plan.awaits.get(operation.expression.location.offset)!;
        if (site.intrinsic === "delay" || site.intrinsic === "yield" || site.intrinsic === "cancel" || site.intrinsic === "scopeClose" || site.intrinsic === "scopeCancel") {
          unsupported(fileName, statement.location, `the void ${site.intrinsic} operation cannot initialize a binding`);
        }
        if (!site.spawn) {
          cases.push(caseBlock(state, beginAwait(site, plan, planByKey, fileName, state + 1)));
          state += 1;
        }
        cases.push(
          caseBlock(
            state,
            awaitCompletion(
              site,
              plan,
              `frame->${frameField(statement.name)}`,
              plan.locals.get(statement.name)!,
              false,
              state + 1,
            ),
          ),
        );
        state += 1;
      } else if (plan.nativeThread && initializer.kind === "try") {
        cases.push(caseBlock(state, emitThreadTryBinding(
          initializer.expression,
          plan,
          fileName,
          state,
          statement.name,
          state + 1,
        )));
        state += 1;
      } else if (initializer.kind === "matchExpression") {
        const type = plan.locals.get(statement.name)!;
        cases.push(caseBlock(state, emitAsyncMatchExpression(
          initializer,
          plan,
          fileName,
          `frame->${frameField(statement.name)}`,
          type,
          false,
          state + 1,
        )));
        state += 1;
      } else {
        const type = plan.locals.get(statement.name)!;
        const prepared = emitPreparedFrameExpression(initializer, plan, fileName);
        const initialize = requiresNativeFramePlacement(type, plan.types)
          ? `new (frame->${frameField(statement.name)}) ${cFrameType(type, plan.types)}(${prepared.value});`
          : `frame->${frameField(statement.name)} = ${prepared.value};`;
        cases.push(caseBlock(state, [
          ...prepared.prefix,
          initialize,
          ...(hasFrameCleanup(type, plan.types)
            ? [`frame->${frameLiveField(statement.name)} = true;`]
            : []),
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
        state += 1;
      }
      continue;
    }
    if (statement.kind === "assignment") {
      const type = frameExpressionType(statement.target, plan);
      if (hasFrameCleanup(type, plan.types)) {
        unsupported(
          fileName,
          statement.location,
          "ownership-bearing replacement assignment is not executable in async frames yet",
          "initialize a new owned binding, or use direct-awaited inout mutation",
        );
      }
      const prepared = emitPreparedFrameExpression(statement.expression, plan, fileName);
      cases.push(caseBlock(state, [
        ...prepared.prefix,
        `${emitFrameExpression(statement.target, plan, fileName)} = ${prepared.value};`,
        `frame->state = ${state + 1};`,
        "continue;",
      ]));
      state += 1;
      continue;
    }
    if (statement.kind === "yield") {
      const generator = plan.generator!;
      const successType = asyncGeneratorAdvanceType(generator);
      const prepared = emitPreparedFrameExpression(statement.expression, plan, fileName);
      const value = emitAsyncEnumVariant(
        successType,
        generator.returnType ? "yielded" : "some",
        prepared.value,
        plan.types,
      );
      const initialize = requiresNativeFramePlacement(successType, plan.types)
        ? `new (frame->result) ${cFrameType(successType, plan.types)}(${value});`
        : `frame->result = ${value};`;
      cases.push(caseBlock(state, [
        ...prepared.prefix,
        initialize,
        ...(hasFrameCleanup(successType, plan.types) ? ["frame->live_result = true;"] : []),
        ...(plan.declaration.errorType ? ["frame->failed = false;"] : []),
        `frame->state = ${state + 1};`,
        "frame->generator_active = false;",
        "z_async_complete_task(&frame->task);",
        "return;",
      ]));
      state += 1;
      continue;
    }
    if (statement.kind === "return") {
      if (plan.generator) {
        const successType = asyncGeneratorAdvanceType(plan.generator);
        const prepared = statement.expression
          ? emitPreparedFrameExpression(statement.expression, plan, fileName)
          : null;
        const value = emitAsyncEnumVariant(
          successType,
          plan.generator.returnType ? "complete" : "none",
          prepared?.value ?? null,
          plan.types,
        );
        const initialize = requiresNativeFramePlacement(successType, plan.types)
          ? `new (frame->result) ${cFrameType(successType, plan.types)}(${value});`
          : `frame->result = ${value};`;
        cases.push(caseBlock(state, [
          ...(prepared?.prefix ?? []),
          initialize,
          ...(hasFrameCleanup(successType, plan.types) ? ["frame->live_result = true;"] : []),
          ...(plan.declaration.errorType ? ["frame->failed = false;"] : []),
          "frame->generator_finished = true;",
          `frame->state = ${finalizeStateMarker};`,
          "continue;",
        ]));
        state += 1;
        continue;
      }
      const operation = statement.expression ? awaitOperation(statement.expression) : null;
      if (operation) {
        const site = plan.awaits.get(operation.expression.location.offset)!;
        if (site.intrinsic === "delay") {
          cases.push(caseBlock(state, scheduleDelay(site, plan, fileName, state + 1)));
          state += 1;
          cases.push(caseBlock(state, [
            ...(plan.declaration.errorType ? ["frame->failed = false;"] : []),
            `frame->state = ${finalizeStateMarker};`,
            "continue;",
          ]));
          state += 1;
          continue;
        }
        if (site.intrinsic === "yield") {
          cases.push(caseBlock(state, scheduleYield(state + 1)));
          state += 1;
          cases.push(caseBlock(state, [
            ...(plan.declaration.errorType ? ["frame->failed = false;"] : []),
            `frame->state = ${finalizeStateMarker};`,
            "continue;",
          ]));
          state += 1;
          continue;
        }
        if (site.intrinsic === "scopeClose" || site.intrinsic === "scopeCancel") {
          const receiver = emitFrameExpression(site.receiver!, plan, fileName);
          cases.push(caseBlock(state, [
            `if (!z_task_scope_join(${receiver}, &frame->task, ${site.intrinsic === "scopeCancel" ? "true" : "false"})) return;`,
            ...(plan.declaration.errorType ? ["frame->failed = false;"] : []),
            `frame->state = ${finalizeStateMarker};`,
            "continue;",
          ]));
          state += 1;
          continue;
        }
        if (!site.spawn) {
          cases.push(caseBlock(state, beginAwait(site, plan, planByKey, fileName, state + 1)));
          state += 1;
        }
        cases.push(caseBlock(state, awaitCompletion(
          site,
          plan,
          "frame->result",
          plan.declaration.returnType.name,
          true,
          state + 1,
        )));
      } else if (statement.expression?.kind === "matchExpression") {
        cases.push(caseBlock(state, emitAsyncMatchExpression(
          statement.expression,
          plan,
          fileName,
          "frame->result",
          plan.declaration.returnType.name,
          true,
          state + 1,
        )));
      } else if (plan.nativeThread && statement.expression?.kind === "try") {
        cases.push(caseBlock(state, emitThreadTryReturn(statement.expression.expression, plan, fileName, state)));
      } else {
        const completion: string[] = [];
        const prepared = statement.expression
          ? emitPreparedFrameExpression(statement.expression, plan, fileName)
          : null;
        if (statement.expression) {
          completion.push(requiresNativeFramePlacement(plan.declaration.returnType.name, plan.types)
            ? `new (frame->result) ${cFrameType(plan.declaration.returnType.name, plan.types)}(${prepared!.value});`
            : `frame->result = ${prepared!.value};`);
          if (hasFrameCleanup(plan.declaration.returnType.name, plan.types)) {
            completion.push("frame->live_result = true;");
          }
        }
        cases.push(caseBlock(state, [
          ...(prepared?.prefix ?? []),
          ...completion,
          ...(plan.declaration.errorType ? ["frame->failed = false;"] : []),
          `frame->state = ${finalizeStateMarker};`,
          "continue;",
        ]));
      }
      state += 1;
      continue;
    }
    if (statement.kind === "throw") {
      const errorType = plan.declaration.errorType!.name;
      const prepared = emitPreparedFrameExpression(statement.expression, plan, fileName);
      const initialize = requiresNativeFramePlacement(errorType, plan.types)
        ? `new (frame->error) ${cFrameType(errorType, plan.types)}(${prepared.value});`
        : `frame->error = ${prepared.value};`;
      cases.push(caseBlock(state, [
        ...prepared.prefix,
        initialize,
        ...(hasFrameCleanup(errorType, plan.types) ? ["frame->live_error = true;"] : []),
        "frame->failed = true;",
        "frame->cancel_children = true;",
        ...(plan.generator ? ["frame->generator_finished = true;"] : []),
        `frame->state = ${finalizeStateMarker};`,
        "continue;",
      ]));
      state += 1;
      continue;
    }
    if (statement.kind === "expressionStatement") {
      if (
        statement.expression.kind === "spawn"
        || (statement.expression.kind === "executorPlacement" && statement.expression.mode === "spawn")
      ) {
        const site = plan.spawns.get(statement.expression.location.offset)!;
        const target = planByKey.get(targetKey(site.target))!;
        const arguments_ = emitAwaitArguments(site, plan, fileName);
        cases.push(caseBlock(state, [
          `frame->child_${site.index} = ${target.startName}(${[childExecutor(site, plan), ...arguments_].join(", ")});`,
          site.nativeThread
            ? `z_async_start_native_thread(&frame->child_${site.index}->task, ${site.asyncNativeThread ? "true" : "false"});`
            : schedulePlacedChild(site, plan, `frame->child_${site.index}`).join("\n"),
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
        state += 1;
        continue;
      }
      if (
        statement.expression.kind === "call"
        && plan.types.semanticInfo.consoleCalls.has(statement.expression.location.offset)
      ) {
        cases.push(caseBlock(state, [
          ...emitAsyncConsoleCall(statement.expression, plan, fileName),
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
        state += 1;
        continue;
      }
      if (
        statement.expression.kind === "call"
        && plan.types.semanticInfo.objcCalls.has(statement.expression.location.offset)
        && statement.expression.arguments.some((argument) => (
          plan.types.semanticInfo.objcBlockArguments.has(argument.location.offset)
        ))
      ) {
        cases.push(caseBlock(state, [
          ...emitAsyncObjCCall(statement.expression, plan, fileName),
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
        state += 1;
        continue;
      }
      const operation = awaitOperation(statement.expression)!;
      if (!operation) {
        const prepared = emitPreparedFrameExpression(statement.expression, plan, fileName);
        cases.push(caseBlock(state, [
          ...prepared.prefix,
          `(void)${prepared.value};`,
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
        state += 1;
        continue;
      }
      const site = plan.awaits.get(operation.expression.location.offset)!;
      if (site.intrinsic === "delay") {
        cases.push(caseBlock(state, scheduleDelay(site, plan, fileName, state + 1)));
        state += 1;
        continue;
      }
      if (site.intrinsic === "yield") {
        cases.push(caseBlock(state, scheduleYield(state + 1)));
        state += 1;
        continue;
      }
      if (site.intrinsic === "scopeClose" || site.intrinsic === "scopeCancel") {
        const receiver = emitFrameExpression(site.receiver!, plan, fileName);
        cases.push(caseBlock(state, [
          `if (!z_task_scope_join(${receiver}, &frame->task, ${site.intrinsic === "scopeCancel" ? "true" : "false"})) return;`,
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
        state += 1;
        continue;
      }
      if (!site.spawn) {
        cases.push(caseBlock(state, beginAwait(site, plan, planByKey, fileName, state + 1)));
        state += 1;
      }
      cases.push(caseBlock(state, awaitCompletion(site, plan, null, null, false, state + 1)));
      state += 1;
    }
  }
  if (plan.generator && !plan.generator.returnType && !endsWithTermination(plan.declaration.body)) {
    const successType = asyncGeneratorAdvanceType(plan.generator);
    const value = emitAsyncEnumVariant(successType, "none", null, plan.types);
    cases.push(caseBlock(state, [
      requiresNativeFramePlacement(successType, plan.types)
        ? `new (frame->result) ${cFrameType(successType, plan.types)}(${value});`
        : `frame->result = ${value};`,
      ...(hasFrameCleanup(successType, plan.types) ? ["frame->live_result = true;"] : []),
      ...(plan.declaration.errorType ? ["frame->failed = false;"] : []),
      "frame->generator_finished = true;",
      `frame->state = ${finalizeStateMarker};`,
      "continue;",
    ]));
    state += 1;
  } else if (!plan.generator && plan.declaration.returnType.name === "void" && !endsWithTermination(plan.declaration.body)) {
    cases.push(caseBlock(state, [
      ...(plan.declaration.errorType ? ["frame->failed = false;"] : []),
      `frame->state = ${finalizeStateMarker};`,
      "continue;",
    ]));
    state += 1;
  }
  const finalizeState = state;
  for (const site of plan.awaits.values()) {
    if (!site.generator) continue;
    const child = `frame->child_${site.index}`;
    cases.push(caseBlock(state, [
      `if (${child} != NULL) {`,
      `  if (frame->cancel_children) z_async_cancel(${child});`,
      `  if (!z_async_wait(&frame->task, ${child})) return;`,
      `  frame->child_${site.index} = NULL;`,
      "}",
      `frame->state = ${state + 1};`,
      "continue;",
    ]));
    state += 1;
  }
  for (const site of plan.asyncForSites) {
    const child = `frame->child_${site.index}`;
    cases.push(caseBlock(state, [
      `if (${child} != NULL) {`,
      `  if (frame->cancel_children) z_async_cancel(${child});`,
      `  if (!z_async_wait(&frame->task, ${child})) return;`,
      `  frame->child_${site.index} = NULL;`,
      "}",
      `frame->state = ${state + 1};`,
      "continue;",
    ]));
    state += 1;
  }
  for (const [index, childTarget] of plan.children) {
    const target = planByKey.get(targetKey(childTarget))!;
    const site = [...plan.spawns.values()].find((candidate) => candidate.index === index)
      ?? [...plan.awaits.values()].find((candidate) => candidate.index === index);
    const child = `frame->child_${index}`;
    cases.push(caseBlock(state, [
      `if (${child} != NULL) {`,
      `  if (frame->cancel_children) ${cancelChild(site, plan, `&${child}->task`)}`,
      `  if (!z_async_wait(&frame->task, &${child}->task)) return;`,
      `  ${target.destroyName}(${child});`,
      `  free(${child});`,
      `  frame->child_${index} = NULL;`,
      ...(site?.binding ? [`  frame->${frameField(site.binding)} = NULL;`] : []),
      "}",
      `frame->state = ${state + 1};`,
      "continue;",
    ]));
    state += 1;
  }
  const nativeThreadCleanup = plan.nativeThread
    ? [
        ...[...plan.locals].reverse().flatMap(([name, type]) => (
          plan.borrowedLocals.has(name) || !hasFrameCleanup(type, plan.types)
            ? []
            : [
                `if (frame->${frameLiveField(name)}) {`,
                `  ${isExecutorBoundClassType(type, plan.types)
                  ? `z_async_release_from_thread(frame->task.completion_executor, ${frameStoredValue(name, type, plan.types)}, ${executorBoundReleaseAdapter(type)});`
                  : frameCleanup(frameStoredValue(name, type, plan.types), type, plan.types)}`,
                `  frame->${frameLiveField(name)} = false;`,
                "}",
              ]
        )),
        ...[...plan.suspensions.values()].reverse().flatMap((site) => (
          !hasFrameCleanup(site.type, plan.types)
            ? []
            : [
                `if (frame->${site.field}_live) {`,
                `  ${frameCleanup(frameSuspensionValue(site, plan.types), site.type, plan.types)}`,
                `  frame->${site.field}_live = false;`,
                "}",
              ]
        )),
      ]
    : [];
  cases.push(caseBlock(state, [
    ...nativeThreadCleanup,
    "frame->task.cancelled = z_async_is_cancellation_requested(&frame->task);",
    ...(plan.generator ? ["frame->generator_active = false;", "frame->generator_finished = true;"] : []),
    "z_async_complete_task(&frame->task);",
    "return;",
  ]));
  const renderedCases = cases.map((item) => {
    let rendered = item.replaceAll(finalizeStateMarker, String(finalizeState));
    for (const [label, target] of labels) {
      rendered = rendered.replaceAll(asyncLabelMarker(label), String(target));
    }
    return rendered;
  });
  return `static void ${plan.pollName}(Z_AsyncTask *task) {
  ${plan.frameName} *frame = (${plan.frameName} *)task;
  if (z_async_is_cancellation_requested(&frame->task)) {
    frame->cancel_children = true;
    if (frame->state < ${finalizeState}) frame->state = ${finalizeState};
  }
  for (;;) {
    switch (frame->state) {
${renderedCases.map((item) => indent(item, 6)).join("\n")}
      default:
        abort();
    }
  }
}`;
}

function generateForeignAsyncPoll(plan: AsyncFunctionPlan): string {
  const projection = plan.foreign!;
  const callback = projection.method.parameters[projection.callbackParameter].type;
  if (callback.kind !== "block") throw new Error("invalid foreign async callback projection");
  const callbackArguments = callback.parameters.map((parameter, index) => ({
    declaration: `${parameter.cName} callback_value_${index}`,
    value: `callback_value_${index}`,
  }));
  const resultValue = projection.method.asyncResultParameter === null
    ? null
    : callbackArguments[projection.method.asyncResultParameter].value;
  const errorValue = projection.method.asyncErrorParameter === null
    ? null
    : callbackArguments[projection.method.asyncErrorParameter].value;
  const callbackLines: string[] = [];
  callbackLines.push("if (__atomic_exchange_n(&callback_invoked, true, __ATOMIC_ACQ_REL)) abort();");
  if (errorValue && projection.errorType) {
    callbackLines.push(`if (${errorValue} != nil) {`);
    callbackLines.push(`  frame->error = ${errorValue};`);
    if (hasFrameCleanup(projection.errorType, plan.types)) callbackLines.push("  frame->live_error = true;");
    callbackLines.push("  frame->failed = true;");
    callbackLines.push("} else {");
    if (resultValue) callbackLines.push(`  frame->result = ${resultValue};`);
    if (projection.resultType !== "void" && hasFrameCleanup(projection.resultType, plan.types)) {
      callbackLines.push("  frame->live_result = true;");
    }
    callbackLines.push("  frame->failed = false;");
    callbackLines.push("}");
  } else {
    if (resultValue) callbackLines.push(`frame->result = ${resultValue};`);
    if (projection.resultType !== "void" && hasFrameCleanup(projection.resultType, plan.types)) {
      callbackLines.push("frame->live_result = true;");
    }
  }
  callbackLines.push("z_async_report_external_completion(&frame->task);");
  const signature = callbackArguments.length === 0
    ? "void"
    : callbackArguments.map((argument) => argument.declaration).join(", ");
  const block = `^void(${signature}) {\n${indent(callbackLines.join("\n"), 4)}\n  }`;
  const visibleInputs = frameInputs(plan);
  let inputIndex = 0;
  const arguments_ = projection.method.parameters.map((_, index) => {
    if (index === projection.callbackParameter) return block;
    const input = visibleInputs[inputIndex++];
    return frameStoredValue(input.name, input.type, plan.types);
  });
  const invocation = generateObjCMessage(projection.className, projection.selector, arguments_);
  return [
    `static void ${plan.pollName}(Z_AsyncTask *task) {`,
    `  ${plan.frameName} *frame = (${plan.frameName} *)task;`,
    "  if (frame->state != 0) abort();",
    "  if (z_async_is_cancellation_requested(task)) {",
    "    task->cancelled = true;",
    "    z_async_complete_task(task);",
    "    return;",
    "  }",
    "  __block bool callback_invoked = false;",
    "  frame->state = 1;",
    "  z_async_begin_external_completion(task);",
    `  (void)${invocation};`,
    "}",
  ].join("\n");
}

function scheduleDelay(
  site: AwaitSite,
  parent: AsyncFunctionPlan,
  fileName: string,
  nextState: number,
): string[] {
  const milliseconds = emitFrameExpression(site.call.arguments[0], parent, fileName);
  return [
    `z_async_schedule_delay(&frame->task, ${milliseconds});`,
    `frame->state = ${nextState};`,
    "return;",
  ];
}

function scheduleYield(nextState: number): string[] {
  return [
    `frame->state = ${nextState};`,
    "return;",
  ];
}

function awaitCompletion(
  site: AwaitSite,
  parent: AsyncFunctionPlan,
  destination: string | null,
  destinationType: string | null,
  terminal: boolean,
  nextState: number,
): string[] {
  if (site.generator) {
    return awaitAsyncGeneratorCompletion(site, parent, destination, destinationType, terminal, nextState);
  }
  const child = `frame->child_${site.index}`;
  if (site.intrinsic === "cancel") {
    const lines = [
      `z_async_cancel(&${child}->task);`,
      `if (!z_async_wait(&frame->task, &${child}->task)) return;`,
      `z_async_destroy_${targetPart(site.target)}(${child});`,
      `free(${child});`,
      `frame->child_${site.index} = NULL;`,
      ...(site.spawn?.binding ? [`frame->${frameField(site.spawn.binding)} = NULL;`] : []),
    ];
    if (terminal) {
      if (parent.declaration.errorType) lines.push("frame->failed = false;");
      lines.push(`frame->state = ${finalizeStateMarker};`, "continue;");
    } else {
      lines.push(`frame->state = ${nextState};`, "continue;");
    }
    return lines;
  }
  const resultType = site.target.declaration.returnType.name;
  const childResult = resultType === "void"
    ? ""
    : frameResultValue(child, resultType, parent.types);
  const lines = [
    `if (!z_async_wait(&frame->task, &${child}->task)) return;`,
  ];
  if (site.mode === "try") {
    const errorType = site.target.declaration.errorType!.name;
    const childError = frameErrorValue(child, errorType, parent.types);
    const transferredError = frameTransferredValue(
      childError,
      `${child}->live_error`,
      errorType,
      parent.types,
    );
    const initializeError = requiresNativeFramePlacement(errorType, parent.types)
      ? `new (frame->error) ${cFrameType(errorType, parent.types)}(${transferredError});`
      : `frame->error = ${transferredError};`;
    lines.push(
      `if (${child}->failed) {`,
      `  ${initializeError}`,
      ...(hasFrameCleanup(errorType, parent.types) ? ["  frame->live_error = true;"] : []),
      `  z_async_destroy_${targetPart(site.target)}(${child});`,
      `  free(${child});`,
      `  frame->child_${site.index} = NULL;`,
      ...(site.spawn?.binding ? [`  frame->${frameField(site.spawn.binding)} = NULL;`] : []),
      "  frame->failed = true;",
      "  frame->cancel_children = true;",
      `  frame->state = ${finalizeStateMarker};`,
      "  continue;",
      "}",
    );
  } else if (site.mode === "attempt" && destination) {
    const errorType = site.target.declaration.errorType!.name;
    const result = resultTypeName(
      site.target.declaration.returnType.name,
      errorType,
    );
    const cResult = resultCName(result);
    const placed = requiresNativeFramePlacement(result, parent.types);
    const construct = (variant: "success" | "failure", payload: string | null): string => {
      if (placed) {
        const value = `${cResult}::make_${nativePart(variant)}(${payload ?? ""})`;
        return `new (${destination}) ${cResult}(${value});`;
      }
      const initialized = payload === null ? "" : `, .data = { .${variant} = ${payload} }`;
      return `${destination} = (${cResult}){ .tag = ${resultTag(result, variant)}${initialized} };`;
    };
    lines.push(`if (${child}->failed) {`);
    const childError = frameErrorValue(child, errorType, parent.types);
    const transferredError = frameTransferredValue(
      childError,
      `${child}->live_error`,
      errorType,
      parent.types,
    );
    lines.push(`  ${construct("failure", transferredError)}`, "} else {");
    const transferredResult = requiresNativeFramePlacement(site.target.declaration.returnType.name, parent.types)
      ? frameTakeExpression(childResult, `${child}->live_result`)
      : childResult;
    const successPayload = site.target.declaration.returnType.name === "void"
      ? null
      : transferredResult;
    lines.push(`  ${construct("success", successPayload)}`);
    if (
      hasFrameCleanup(site.target.declaration.returnType.name, parent.types)
      && !requiresNativeFramePlacement(site.target.declaration.returnType.name, parent.types)
    ) {
      lines.push(`  ${child}->live_result = false;`);
    }
    lines.push("}");
  }

  if (site.mode !== "attempt" && destination && site.target.declaration.returnType.name !== "void") {
    const placed = destinationType ? requiresNativeFramePlacement(destinationType, parent.types) : false;
    lines.push(placed
      ? `new (${destination}) ${cFrameType(destinationType!, parent.types)}(${frameTakeExpression(childResult, `${child}->live_result`)});`
      : `${destination} = ${childResult};`);
    if (
      hasFrameCleanup(site.target.declaration.returnType.name, parent.types)
      && !requiresNativeFramePlacement(site.target.declaration.returnType.name, parent.types)
    ) {
      lines.push(`${child}->live_result = false;`);
    }
  }
  if (destination && destinationType && hasFrameCleanup(destinationType, parent.types)) {
    lines.push(`${destinationLiveFlag(destination, parent)} = true;`);
  }
  lines.push(
    `z_async_destroy_${targetPart(site.target)}(${child});`,
    `free(${child});`,
    `frame->child_${site.index} = NULL;`,
  );
  if (site.spawn?.binding) lines.push(`frame->${frameField(site.spawn.binding)} = NULL;`);
  if (terminal) {
    if (parent.declaration.errorType) lines.push("frame->failed = false;");
    lines.push(`frame->state = ${finalizeStateMarker};`, "continue;");
  } else {
    lines.push(`frame->state = ${nextState};`, "continue;");
  }
  return lines;
}

function awaitAsyncGeneratorCompletion(
  site: AwaitSite,
  parent: AsyncFunctionPlan,
  destination: string | null,
  destinationType: string | null,
  terminal: boolean,
  nextState: number,
): string[] {
  const child = `frame->child_${site.index}`;
  const handle = emitFrameExpression(site.generator!.receiver, parent, "<async-generator>");
  const successType = site.target.declaration.returnType.name;
  const errorType = site.target.declaration.errorType?.name ?? null;
  const lines = [`if (!z_async_wait(&frame->task, ${child})) return;`];

  if (site.mode === "try" && errorType) {
    lines.push(`if ((${handle}).failed((${handle}).context)) {`);
    if (requiresNativeFramePlacement(errorType, parent.types)) {
      lines.push(`  (${handle}).take_error((${handle}).context, frame->error);`);
    } else {
      lines.push(`  (${handle}).take_error((${handle}).context, &frame->error);`);
    }
    if (hasFrameCleanup(errorType, parent.types)) lines.push("  frame->live_error = true;");
    lines.push(
      `  frame->child_${site.index} = NULL;`,
      "  frame->failed = true;",
      "  frame->cancel_children = true;",
      `  frame->state = ${finalizeStateMarker};`,
      "  continue;",
      "}",
    );
  }

  if (site.mode === "attempt" && destination && errorType) {
    const resultType = resultTypeName(successType, errorType);
    const cResult = resultCName(resultType);
    const placedResult = requiresNativeFramePlacement(resultType, parent.types);
    const emitPayloadVariant = (variant: "success" | "failure", payloadType: string): string[] => {
      if (placedResult) {
        const cPayload = cFrameType(payloadType, parent.types);
        const storage = `_z_async_generator_payload_${site.index}_${variant}`;
        return [
          `alignas(${cPayload}) unsigned char ${storage}[sizeof(${cPayload})];`,
          `(${handle}).take_${variant === "success" ? "result" : "error"}((${handle}).context, ${storage});`,
          `new (${destination}) ${cResult}(${cResult}::make_${variant}(std::move(*std::launder(reinterpret_cast<${cPayload} *>(${storage})))));`,
        ];
      }
      return [
        `${destination} = (${cResult}){ .tag = ${resultTag(resultType, variant)} };`,
        `(${handle}).take_${variant === "success" ? "result" : "error"}((${handle}).context, &(${destination}.data.${variant}));`,
      ];
    };
    lines.push(
      `if ((${handle}).failed((${handle}).context)) {`,
      ...emitPayloadVariant("failure", errorType).map((line) => `  ${line}`),
      "} else {",
      ...emitPayloadVariant("success", successType).map((line) => `  ${line}`),
      "}",
    );
  } else if (destination && destinationType) {
    const destinationPointer = requiresNativeFramePlacement(destinationType, parent.types)
      ? destination
      : `&(${destination})`;
    lines.push(`(${handle}).take_result((${handle}).context, ${destinationPointer});`);
  } else {
    const cSuccess = cFrameType(successType, parent.types);
    const temporary = `_z_async_generator_discard_${site.index}`;
    lines.push(`${cSuccess} ${temporary};`);
    lines.push(`(${handle}).take_result((${handle}).context, &${temporary});`);
    if (hasFrameCleanup(successType, parent.types)) {
      lines.push(frameCleanup(temporary, successType, parent.types));
    }
  }

  if (destination && destinationType && hasFrameCleanup(destinationType, parent.types)) {
    lines.push(`${destinationLiveFlag(destination, parent)} = true;`);
  }
  lines.push(`frame->child_${site.index} = NULL;`);
  if (terminal) {
    if (parent.declaration.errorType) lines.push("frame->failed = false;");
    lines.push(`frame->state = ${finalizeStateMarker};`, "continue;");
  } else {
    lines.push(`frame->state = ${nextState};`, "continue;");
  }
  return lines;
}

function caseBlock(state: number, statements: readonly string[]): string {
  return `case ${state}: {
${statements.map((statement) => `  ${statement}`).join("\n")}
}`;
}

function validateAsyncMatchExpression(
  expression: Extract<Expression, { kind: "matchExpression" }>,
  locals: ReadonlyMap<string, string>,
  fileName: string,
  types: AsyncTypeContext,
  suspensions: ReadonlyMap<number, NestedAwaitSite>,
): void {
  inspectAsyncMatchExpression(expression, { locals, types, suspensions }, fileName);
}

function emitAsyncMatchExpression(
  expression: Extract<Expression, { kind: "matchExpression" }>,
  plan: AsyncFunctionPlan,
  fileName: string,
  destination: string,
  destinationType: string,
  terminal: boolean,
  nextState: number,
): string[] {
  const inspected = inspectAsyncMatchExpression(expression, plan, fileName);
  const temporary = `_z_async_match_${expression.location.offset}`;
  const borrowed = plan.types.semanticInfo.borrowedMatches.has(expression.location.offset);
  const subject = emitFrameExpression(expression.expression, plan, fileName);
  const cType = cFrameType(inspected.subjectType, plan.types);
  const subjectTransfersItself = plan.types.semanticInfo.movedExpressions.has(expression.expression.location.offset);
  const ownershipFlag = borrowed || subjectTransfersItself ? null : asyncExpressionLiveFlag(expression.expression, plan);
  const storage = borrowed
    ? `const ${cType} *${temporary} = &(${subject});`
    : requiresNativeFramePlacement(inspected.subjectType, plan.types)
      ? `${cType} ${temporary} = ${ownershipFlag
          ? frameTakeExpression(subject, ownershipFlag)
          : subjectTransfersItself ? subject : `std::move(${subject})`};`
      : `const ${cType} ${temporary} = ${subject};`;
  const storedSubject = borrowed ? `(*${temporary})` : temporary;
  const lines = [storage, `switch (${storedSubject}.tag) {`];
  for (const arm of expression.arms) {
    const variant = inspected.declaration.variants.find((candidate) => candidate.name === arm.variantName)!;
    const armContext = asyncMatchArmContext(arm, variant, storedSubject, plan);
    const value = emitFrameExpression(asyncMatchArmValue(arm, fileName), armContext, fileName);
    lines.push(
      `  case ${resultTag(inspected.subjectType, variant.name)}: {`,
      `    ${destination} = ${value};`,
      "    break;",
      "  }",
    );
  }
  if (requiresNativeFramePlacement(inspected.subjectType, plan.types)) {
    lines.push("  default:", "    abort();");
  }
  lines.push("}");
  if (hasFrameCleanup(destinationType, plan.types)) {
    lines.push(`${destinationLiveFlag(destination, plan)} = true;`);
  }
  if (terminal) {
    if (plan.declaration.errorType) lines.push("frame->failed = false;");
    lines.push(`frame->state = ${finalizeStateMarker};`, "continue;");
  } else {
    lines.push(`frame->state = ${nextState};`, "continue;");
  }
  return lines;
}

function inspectAsyncMatchExpression(
  expression: Extract<Expression, { kind: "matchExpression" }>,
  plan: FrameExpressionContext,
  fileName: string,
): { readonly subjectType: string; readonly declaration: EnumDeclaration } {
  const subjectType = frameExpressionType(expression.expression, plan);
  const declaration = plan.types.enums.get(subjectType);
  if (!declaration) {
    unsupported(fileName, expression.expression.location, "async match lowering requires an enum subject");
  }
  const borrowed = plan.types.semanticInfo.borrowedMatches.has(expression.location.offset);
  if (
    hasFrameCleanup(subjectType, plan.types)
    && !borrowed
    && !requiresNativeFramePlacement(subjectType, plan.types)
  ) {
    unsupported(
      fileName,
      expression.location,
      "consuming this ownership-bearing enum inside an async frame has not landed yet",
      "use `match (in value)` to inspect it without consuming, or match a move-only native Result/Option whose frame transfer is supported",
    );
  }
  const resultType = frameExpressionType(expression, plan);
  if (hasFrameCleanup(resultType, plan.types)) {
    unsupported(
      fileName,
      expression.location,
      "an async match cannot produce an ownership-bearing value yet",
      "produce a scalar or plain-data value while owned match-result transfer is implemented",
    );
  }
  emitFrameExpression(expression.expression, plan, fileName);
  for (const arm of expression.arms) {
    const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName)!;
    const armContext = asyncMatchArmContext(arm, variant, "_z_async_match_subject", plan);
    emitFrameExpression(asyncMatchArmValue(arm, fileName), armContext, fileName);
  }
  return { subjectType, declaration };
}

function asyncMatchArmContext(
  arm: Extract<Expression, { kind: "matchExpression" }>["arms"][number],
  variant: EnumDeclaration["variants"][number],
  subject: string,
  plan: FrameExpressionContext,
): FrameExpressionContext {
  const locals = new Map(plan.locals);
  const bindings = new Map(plan.bindings ?? []);
  if (variant.payload && arm.binding) {
    locals.set(arm.binding, variant.payload.name);
    bindings.set(arm.binding, `((${subject}).data.${variant.name})`);
  }
  if (variant.payload && arm.objectBindings) {
    const payload = plan.types.structs.get(variant.payload.name)!;
    const access = payload.kind === "class" ? "->" : ".";
    for (const fieldBinding of arm.objectBindings) {
      const field = payload.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
      locals.set(fieldBinding.bindingName, field.type.name);
      bindings.set(
        fieldBinding.bindingName,
        `(((${subject}).data.${variant.name})${access}${field.name})`,
      );
    }
  }
  return { locals, types: plan.types, bindings, suspensions: plan.suspensions };
}

function asyncMatchArmValue(
  arm: Extract<Expression, { kind: "matchExpression" }>["arms"][number],
  fileName: string,
): Expression {
  if (arm.body.kind === "expressionStatement" || arm.body.kind === "select") {
    return arm.body.expression;
  }
  unsupported(
    fileName,
    arm.body.location,
    "async match arms must be single synchronous expressions in this lowering tier",
    "use `variant(binding) => expression;`; block arms and suspending arms will land in a later tier",
  );
}

function validateFrameExpression(
  expression: Expression,
  locals: ReadonlyMap<string, string>,
  fileName: string,
  types: AsyncTypeContext,
  suspensions: ReadonlyMap<number, NestedAwaitSite>,
): void {
  if (
    expression.kind === "call"
    && types.semanticInfo.taskScopeAsyncCalls.has(expression.location.offset)
  ) {
    if (expression.callee.kind !== "member") {
      unsupported(fileName, expression.location, "TaskScope.schedule lowering requires a member call");
    }
    emitFrameExpression(expression.callee.object, { locals, types, suspensions }, fileName);
    const closureOffset = types.semanticInfo.taskScopeAsyncCalls.get(expression.location.offset)!;
    const closure = types.semanticInfo.closures.get(closureOffset)!;
    for (const capture of closure.captures) {
      emitFrameExpression(
        { kind: "identifier", name: capture.name, location: capture.location },
        { locals, types, suspensions },
        fileName,
      );
    }
    return;
  }
  if (
    expression.kind === "call"
    && types.semanticInfo.objcCalls.has(expression.location.offset)
    && expression.arguments.some((argument) => types.semanticInfo.objcBlockArguments.has(argument.location.offset))
  ) {
    const objcCall = types.semanticInfo.objcCalls.get(expression.location.offset)!;
    if (objcCall.instance) {
      emitFrameExpression(expression.callee.kind === "member" ? expression.callee.object : expression, { locals, types, suspensions }, fileName);
    }
    for (const argument of expression.arguments) {
      if (types.semanticInfo.objcBlockArguments.has(argument.location.offset)) {
        if (argument.kind !== "closure" || !types.semanticInfo.closures.has(argument.location.offset)) {
          unsupported(fileName, argument.location, "async Objective-C block lowering requires an analyzed inline closure");
        }
        continue;
      }
      emitFrameExpression(argument, { locals, types, suspensions }, fileName);
    }
    return;
  }
  emitPreparedFrameExpression(expression, { locals, types, suspensions }, fileName);
}

function emitPreparedFrameExpression(
  expression: Expression,
  plan: FrameExpressionContext,
  fileName: string,
): { readonly prefix: readonly string[]; readonly value: string } {
  if (
    expression.kind === "call"
    && plan.types.semanticInfo.taskScopeAsyncCalls.has(expression.location.offset)
  ) {
    return { prefix: [], value: emitFrameExpression(expression, plan, fileName) };
  }
  const prefix: string[] = [];
  const expressionBindings = new Map(plan.expressionBindings ?? []);

  const visit = (candidate: Expression): void => {
    switch (candidate.kind) {
      case "closure": {
        const closure = plan.types.semanticInfo.closures.get(candidate.location.offset);
        if (!closure) {
          unsupported(fileName, candidate.location, "async closure lowering requires analyzed closure metadata");
        }
        if (closure.owned) {
          unsupported(
            fileName,
            candidate.location,
            "an owned or escaping inline closure is not executable in an async frame yet",
            "use a synchronous nonescaping closure parameter here, or construct the owned closure outside the async function",
          );
        }
        const functionType = closureFunctionType(closure);
        const functionValue = `_z_async_inline_function_${candidate.location.offset}`;
        if (closure.captures.length === 0) {
          prefix.push(
            `${functionTypeCName(functionType)} ${functionValue} = ${functionValueLiteral(
              functionType,
              closureAdapterName(closure),
            )};`,
          );
          expressionBindings.set(candidate.location.offset, functionValue);
          return;
        }
        const environmentType = closureEnvironmentName(closure);
        const environment = `_z_async_inline_environment_${candidate.location.offset}`;
        prefix.push(`${environmentType} ${environment};`);
        for (const capture of closure.captures) {
          const captured: Expression = {
            kind: "identifier",
            name: capture.name,
            location: capture.location,
          };
          const value = emitFrameExpression(captured, plan, fileName);
          const hasReferenceIdentity = capture.type === "TaskScope"
            || capture.type === "TaskControl"
            || plan.types.structs.get(capture.type)?.kind === "class"
            || plan.types.semanticInfo.foreignNamedTypes.get(capture.type)?.kind === "object";
          const borrowedPointer = capture.mode !== "value"
            && !(capture.mode === "in" && hasReferenceIdentity);
          prefix.push(`${environment}.${capture.name} = ${borrowedPointer ? `&(${value})` : value};`);
        }
        prefix.push(
          `${functionTypeCName(functionType)} ${functionValue} = ${functionValueLiteral(
            functionType,
            closureAdapterName(closure),
            `&${environment}`,
          )};`,
        );
        expressionBindings.set(candidate.location.offset, functionValue);
        return;
      }
      case "number":
      case "string":
      case "boolean":
      case "null":
      case "identifier":
      case "argumentReference":
      case "dynamicArrayExpression":
        return;
      case "template":
        for (const part of candidate.parts) if (part.kind === "value") visit(part.expression);
        return;
      case "unary":
        visit(candidate.operand);
        return;
      case "weak":
      case "attempt":
      case "try":
      case "await":
      case "spawn":
        visit(candidate.expression);
        return;
      case "binary":
        visit(candidate.left);
        visit(candidate.right);
        return;
      case "conditional":
        visit(candidate.condition);
        visit(candidate.thenExpression);
        visit(candidate.elseExpression);
        return;
      case "new":
      case "call":
        if (candidate.kind === "call") visit(candidate.callee);
        for (const argument of candidate.arguments) visit(argument);
        return;
      case "member":
        visit(candidate.object);
        return;
      case "index":
        visit(candidate.object);
        visit(candidate.index);
        return;
      case "arrayExpression":
        for (const element of candidate.elements) visit(element);
        return;
      case "structExpression":
      case "objectExpression":
        for (const field of candidate.fields) visit(field.expression);
        return;
      case "variantExpression":
        visit(candidate.payload);
        return;
      case "executorPlacement":
      case "matchExpression":
      case "ifExpression":
      case "whileExpression":
      case "forExpression":
        // These expressions own nested statement lowering. Their individual
        // synchronous operands are prepared when those statements are emitted.
        return;
    }
  };

  visit(expression);
  const preparedPlan = expressionBindings.size === 0 ? plan : { ...plan, expressionBindings };
  return {
    prefix,
    value: emitFrameExpression(expression, preparedPlan, fileName),
  };
}

function validateAsyncConsoleCall(
  expression: CallExpression,
  locals: ReadonlyMap<string, string>,
  fileName: string,
  types: AsyncTypeContext,
  suspensions: ReadonlyMap<number, NestedAwaitSite>,
): void {
  emitAsyncConsoleCall(expression, { locals, types, suspensions }, fileName);
}

function emitAsyncObjCCall(
  expression: CallExpression,
  plan: FrameExpressionContext,
  fileName: string,
): string[] {
  const call = plan.types.semanticInfo.objcCalls.get(expression.location.offset);
  if (!call || expression.callee.kind !== "member") {
    unsupported(fileName, expression.location, "Objective-C async-frame lowering requires a resolved method call");
  }
  const lines: string[] = [];
  const arguments_ = expression.arguments.map((argument) => {
    const block = plan.types.semanticInfo.objcBlockArguments.get(argument.location.offset);
    if (!block) return emitFrameExpression(argument, plan, fileName);
    if (argument.kind !== "closure") {
      unsupported(fileName, argument.location, "async Objective-C block lowering requires an inline closure");
    }
    const closure = plan.types.semanticInfo.closures.get(argument.location.offset)!;
    const functionType = closureFunctionType(closure);
    const functionValue = `_z_async_objc_function_${argument.location.offset}`;
    if (!closure.owned && closure.captures.length === 0) {
      lines.push(
        `${functionTypeCName(functionType)} ${functionValue} = ${functionValueLiteral(functionType, closureAdapterName(closure))};`,
      );
    } else {
      if (!closure.owned) {
        unsupported(fileName, argument.location, "escaping async Objective-C blocks require an owned move closure");
      }
      const environmentType = closureEnvironmentName(closure);
      const environment = `_z_async_objc_environment_${argument.location.offset}`;
      lines.push(
        `${environmentType} *${environment} = (${environmentType} *)calloc(1, sizeof(${environmentType}));`,
        `if (${environment} == NULL) abort();`,
        `${environment}->refcount = 1;`,
      );
      for (const capture of closure.captures) {
        const captured: Expression = {
          kind: "identifier",
          name: capture.name,
          location: capture.location,
        };
        let value = emitFrameExpression(captured, plan, fileName);
        if (capture.type === "TaskScope") value = `z_task_scope_retain(${value})`;
        else if (capture.type === "TaskControl") value = `z_task_control_retain(${value})`;
        else if (plan.types.structs.get(capture.type)?.kind === "class") {
          value = `Z_${capture.type}_retain(${value})`;
        }
        lines.push(`${environment}->${capture.name} = ${value};`);
      }
      lines.push(
        `${functionTypeCName(functionType)} ${functionValue} = ${functionValueLiteral(
          functionType,
          closureAdapterName(closure),
          environment,
          closureEnvironmentRetainName(closure),
          closureEnvironmentReleaseName(closure),
        )};`,
      );
    }
    const box = `_z_async_objc_box_${argument.location.offset}`;
    const nativeBlock = `_z_async_objc_block_${argument.location.offset}`;
    lines.push(...generateObjCBlockArgument(block, functionValue, box, nativeBlock));
    return nativeBlock;
  });
  const receiver = call.instance
    ? emitFrameExpression(expression.callee.object, plan, fileName)
    : call.className;
  lines.push(`(void)${generateObjCMessage(receiver, call.selector, arguments_)};`);
  for (const argument of expression.arguments) {
    if (!plan.types.semanticInfo.objcBlockArguments.has(argument.location.offset)) continue;
    const functionValue = `_z_async_objc_function_${argument.location.offset}`;
    lines.push(`if (${functionValue}.release != NULL) ${functionValue}.release(${functionValue}.context);`);
  }
  return lines;
}

function emitAsyncConsoleCall(
  expression: CallExpression,
  plan: FrameExpressionContext,
  fileName: string,
): string[] {
  if (expression.callee.kind !== "member") {
    unsupported(fileName, expression.location, "console lowering requires a member call");
  }
  const stream = expression.callee.property === "log" || expression.callee.property === "write"
    ? "stdout"
    : "stderr";
  const lines: string[] = [];
  expression.arguments.forEach((argument, index) => {
    if (index > 0) lines.push(`fputc(' ', ${stream});`);
    if (argument.kind === "template") {
      for (const part of argument.parts) {
        if (part.kind === "text") {
          if (part.value) lines.push(`fputs(${JSON.stringify(part.value)}, ${stream});`);
        } else {
          lines.push(...emitAsyncConsoleValue(part.expression, stream, plan, fileName));
        }
      }
    } else if (argument.kind === "string") {
      lines.push(`fputs(${JSON.stringify(argument.value)}, ${stream});`);
    } else {
      lines.push(...emitAsyncConsoleValue(argument, stream, plan, fileName));
    }
  });
  if (expression.callee.property !== "write") lines.push(`fputc('\\n', ${stream});`);
  lines.push(`fflush(${stream});`);
  return lines;
}

function emitAsyncConsoleValue(
  expression: Expression,
  stream: "stdout" | "stderr",
  plan: FrameExpressionContext,
  fileName: string,
): string[] {
  const type = frameExpressionType(expression, plan);
  if (type === "null") return [`fputs("null", ${stream});`];
  if (expression.kind === "string") return [`fputs(${JSON.stringify(expression.value)}, ${stream});`];
  const temporary = `_z_async_console_${expression.location.offset}`;
  const value = emitFrameExpression(expression, plan, fileName);
  return [
    `${cFrameType(type, plan.types)} ${temporary} = ${value};`,
    ...renderAsyncConsoleValue(temporary, type, stream, expression.location, plan, fileName),
  ];
}

function renderAsyncConsoleValue(
  value: string,
  type: string,
  stream: "stdout" | "stderr",
  location: SourceLocation,
  plan: FrameExpressionContext,
  fileName: string,
): string[] {
  if (["i8", "i16", "i32", "i64", "isize"].includes(type)) {
    return [`fprintf(${stream}, "%lld", (long long)(${value}));`];
  }
  if (["u8", "u16", "u32", "u64", "usize"].includes(type)) {
    return [`fprintf(${stream}, "%llu", (unsigned long long)(${value}));`];
  }
  if (type === "f32" || type === "f64") {
    return [`fprintf(${stream}, "%g", (double)(${value}));`];
  }
  if (type === "boolean") return [`fputs((${value}) ? "true" : "false", ${stream});`];
  if (type === "cstring") return [`fputs((${value}) != NULL ? (${value}) : "null", ${stream});`];
  if (type === "String") {
    return [`if ((${value}).length > 0) fwrite((${value}).data, 1, (${value}).length, ${stream});`];
  }

  const declaration = plan.types.structs.get(type);
  if (declaration?.kind === "class") {
    const displayName = plan.types.semanticInfo.typeDisplayNames.get(type) ?? type;
    return [`fprintf(${stream}, ${JSON.stringify(`${displayName}@%p`)}, (void *)(${value}));`];
  }
  if (declaration?.kind === "struct") {
    const displayName = plan.types.semanticInfo.typeDisplayNames.get(type) ?? type;
    const lines = [`fputs(${JSON.stringify(`${displayName} { `)}, ${stream});`];
    declaration.fields.forEach((field, index) => {
      if (index > 0) lines.push(`fputs(", ", ${stream});`);
      lines.push(`fputs(${JSON.stringify(`${field.name}: `)}, ${stream});`);
      lines.push(...renderAsyncConsoleValue(`(${value}).${field.name}`, field.type.name, stream, location, plan, fileName));
    });
    lines.push(`fputs(" }", ${stream});`);
    return lines;
  }

  const enumeration = plan.types.enums.get(type);
  if (enumeration) {
    const displayName = plan.types.semanticInfo.typeDisplayNames.get(type) ?? type;
    const lines = [`switch ((${value}).tag) {`];
    for (const variant of enumeration.variants) {
      lines.push(`  case ${resultTag(type, variant.name)}:`);
      lines.push(`    fputs(${JSON.stringify(`${displayName}.${variant.name}`)}, ${stream});`);
      if (variant.payload) {
        lines.push(`    fputc('(', ${stream});`);
        lines.push(...renderAsyncConsoleValue(
          `(${value}).data.${variant.name}`,
          variant.payload.name,
          stream,
          location,
          plan,
          fileName,
        ).map((line) => indent(line, 4)));
        lines.push(`    fputc(')', ${stream});`);
      }
      lines.push("    break;");
    }
    lines.push("}");
    return lines;
  }
  unsupported(fileName, location, `console formatting for ${JSON.stringify(type)} is not executable in async frames yet`);
}

function emitFrameExpression(
  expression: Expression,
  plan: FrameExpressionContext,
  fileName: string,
): string {
  const value = emitFrameExpressionInner(expression, plan, fileName);
  return plan.types.semanticInfo.viewLoadExpressions.has(expression.location.offset)
    ? `(*(${value}))`
    : value;
}

function emitFrameExpressionInner(
  expression: Expression,
  plan: FrameExpressionContext,
  fileName: string,
): string {
  const suspension = plan.suspensions?.get(expression.location.offset);
  if (suspension) return frameSuspensionValue(suspension, plan.types);
  const prepared = plan.expressionBindings?.get(expression.location.offset);
  if (prepared) return prepared;
  const foreignConstant = plan.types.semanticInfo.foreignConstantNames.get(expression.location.offset);
  if (foreignConstant) return foreignConstant;
  switch (expression.kind) {
    case "raw":
      unsupported(fileName, expression.location, "raw native expressions are not executable in async frames yet");
    case "number":
      return expression.value;
    case "boolean":
      return expression.value ? "true" : "false";
    case "null":
      return "NULL";
    case "string": {
      const type = plan.types.semanticInfo.expressionTypes.get(expression.location.offset);
      const convertedToCString = plan.types.semanticInfo.cstringConversions.has(expression.location.offset);
      return type === "String" && !convertedToCString
        ? `(Z_String){ .data = ${JSON.stringify(expression.value)}, .length = sizeof(${JSON.stringify(expression.value)}) - 1, .capacity = 0 }`
        : JSON.stringify(expression.value);
    }
    case "identifier":
      if (plan.bindings?.has(expression.name)) {
        const value = plan.bindings.get(expression.name)!;
        const type = plan.locals.get(expression.name);
        if (
          type
          && plan.types.semanticInfo.movedExpressions.has(expression.location.offset)
          && requiresNativeFramePlacement(type, plan.types)
        ) {
          return `std::move(${value})`;
        }
        if (
          type
          && plan.types.semanticInfo.managedCopies.has(expression.location.offset)
          && (type === "TaskScope" || type === "TaskControl" || plan.types.structs.get(type)?.kind === "class")
        ) {
          return type === "TaskScope"
            ? `z_task_scope_retain(${value})`
            : type === "TaskControl"
              ? `z_task_control_retain(${value})`
              : `Z_${type}_retain(${value})`;
        }
        return value;
      }
      if (!plan.locals.has(expression.name)) {
        unsupported(fileName, expression.location, "the first async lowering slice cannot reference this value");
      }
      {
        const type = plan.locals.get(expression.name)!;
        const value = plan.borrowedLocals?.has(expression.name)
          ? borrowedFrameValue(expression.name, type, plan.types)
          : frameStoredValue(expression.name, type, plan.types);
        if (plan.types.semanticInfo.movedExpressions.has(expression.location.offset)) {
          if (requiresNativeFramePlacement(type, plan.types)) {
            return frameTakeExpression(value, `frame->${frameLiveField(expression.name)}`);
          }
          return `(frame->${frameLiveField(expression.name)} = false, ${value})`;
        }
        if (
          plan.types.semanticInfo.managedCopies.has(expression.location.offset)
          && (type === "TaskScope" || type === "TaskControl" || plan.types.structs.get(type)?.kind === "class")
        ) {
          return type === "TaskScope"
            ? `z_task_scope_retain(${value})`
            : type === "TaskControl"
              ? `z_task_control_retain(${value})`
              : `Z_${type}_retain(${value})`;
        }
        return value;
      }
    case "attempt":
      return emitFrameExpression(expression.expression, plan, fileName);
    case "try":
      unsupported(
        fileName,
        expression.location,
        "an embedded synchronous `try` expression is not executable in an async frame yet",
        "bind it first with `const value = try operation();`, then use value in the surrounding expression",
      );
    case "argumentReference":
      return emitFrameExpression(
        { kind: "identifier", name: expression.name, location: expression.location },
        plan,
        fileName,
      );
    case "unary":
      {
        const explicitCopy = plan.types.semanticInfo.explicitCopies.get(expression.location.offset);
        if (explicitCopy) {
          const source = emitFrameExpression(expression.operand, plan, fileName);
          const value = explicitCopy.sourceIsView ? `(*(${source}))` : source;
          if (explicitCopy.kind === "string") return `z_string_copy(${value})`;
          if (explicitCopy.kind === "aggregate") return `z_copy_${asyncNativeSymbolPart(explicitCopy.type)}(${value})`;
          return value;
        }
        if (expression.operator === "move") return emitFrameExpression(expression.operand, plan, fileName);
        const contextualType = plan.types.semanticInfo.numericLiteralTypes.get(expression.location.offset);
        if (
          contextualType
          && expression.operand.kind === "number"
          && (expression.operator === "+" || expression.operator === "-")
        ) {
          return asyncContextualSignedLiteral(expression.operator, expression.operand.value, contextualType);
        }
        const integerOperation = plan.types.semanticInfo.integerOperations.get(expression.location.offset);
        if (integerOperation) {
          return `${asyncIntegerOperationName(integerOperation.kind, integerOperation.type)}(${emitFrameExpression(expression.operand, plan, fileName)})`;
        }
        if (expression.operator === "+" || expression.operator === "-" || expression.operator === "!" || expression.operator === "~") {
          return `(${expression.operator}${emitFrameExpression(expression.operand, plan, fileName)})`;
        }
        unsupported(fileName, expression.location, "this unary expression is not executable in an async frame yet");
      }
    case "binary":
      {
        const integerOperation = plan.types.semanticInfo.integerOperations.get(expression.location.offset);
        if (integerOperation) {
          return `${asyncIntegerOperationName(integerOperation.kind, integerOperation.type)}(${emitFrameExpression(expression.left, plan, fileName)}, ${emitFrameExpression(expression.right, plan, fileName)})`;
        }
        if (
          (expression.operator === "==" || expression.operator === "!=")
          && frameExpressionType(expression.left, plan) === "String"
          && frameExpressionType(expression.right, plan) === "String"
        ) {
          const comparison = `z_string_equal(${emitFrameExpression(expression.left, plan, fileName)}, ${emitFrameExpression(expression.right, plan, fileName)})`;
          return expression.operator === "==" ? comparison : `(!${comparison})`;
        }
        const leftType = frameExpressionType(expression.left, plan);
        const comparableEnum = plan.types.enums.get(leftType);
        if (
          (expression.operator === "==" || expression.operator === "!=")
          && comparableEnum
          && comparableEnum.variants.every((variant) => variant.payload === null)
        ) {
          return `((${emitFrameExpression(expression.left, plan, fileName)}).tag ${expression.operator} (${emitFrameExpression(expression.right, plan, fileName)}).tag)`;
        }
        if (!safeBinaryOperators.has(expression.operator)) {
          unsupported(fileName, expression.location, "this arithmetic expression is not executable in an async frame yet");
        }
        return `(${emitFrameExpression(expression.left, plan, fileName)} ${expression.operator} ${emitFrameExpression(expression.right, plan, fileName)})`;
      }
    case "conditional":
      return `(${emitFrameExpression(expression.condition, plan, fileName)} ? ${emitFrameExpression(expression.thenExpression, plan, fileName)} : ${emitFrameExpression(expression.elseExpression, plan, fileName)})`;
    case "arrayExpression": {
      const type = plan.types.semanticInfo.expressionTypes.get(expression.location.offset);
      if (!type || !parseFixedArrayType(type)) {
        unsupported(fileName, expression.location, "async array construction requires a fixed array type");
      }
      const elements = expression.elements.map((element) => emitFrameExpression(element, plan, fileName));
      return `(${cFrameType(type, plan.types)}){ .data = { ${elements.join(", ")} } }`;
    }
    case "dynamicArrayExpression": {
      const type = dynamicArrayTypeName(expression.elementType);
      return `(${cFrameType(type, plan.types)}){ .data = NULL, .length = 0, .capacity = 0 }`;
    }
    case "index": {
      const analyzedOwnerType = frameExpressionType(expression.object, plan);
      const ownerType = expression.object.kind === "identifier"
        ? plan.locals.get(expression.object.name) ?? analyzedOwnerType
        : analyzedOwnerType;
      const array = parseFixedArrayType(ownerType);
      const slice = parseSliceType(ownerType);
      const dynamic = parseDynamicArrayType(ownerType);
      if (!array && !slice && !dynamic) {
        unsupported(fileName, expression.location, `indexing async value ${JSON.stringify(ownerType)} is not supported`);
      }
      const owner = emitFrameExpression(expression.object, plan, fileName);
      const length = array ? String(array.length) : `((${owner}).length)`;
      const value = `((${owner}).data[z_async_bounds_index((uintptr_t)(${emitFrameExpression(expression.index, plan, fileName)}), ${length})])`;
      const elementType = (array ?? slice ?? dynamic)!.elementType;
      return plan.types.semanticInfo.managedCopies.has(expression.location.offset)
        && plan.types.structs.get(elementType)?.kind === "class"
        ? `Z_${elementType}_retain(${value})`
        : value;
    }
    case "member": {
      if (expression.object.kind === "identifier") {
        const enumeration = plan.types.enums.get(expression.object.name);
        const variant = enumeration?.variants.find((candidate) => candidate.name === expression.property);
        if (enumeration && variant && !variant.payload) {
          return `(${resultCName(enumeration.name)}){ .tag = ${resultTag(enumeration.name, variant.name)} }`;
        }
      }
      const ownerType = frameExpressionType(expression.object, plan);
      const ownerView = parseViewType(ownerType);
      if ((ownerView?.target ?? ownerType) === "TaskControl") {
        const owner = emitFrameExpression(expression.object, plan, fileName);
        const value = ownerView ? `(*(${owner}))` : owner;
        if (expression.property === "accepted") return `z_task_control_is_accepted(${value})`;
        if (expression.property === "isCancellationRequested") {
          return `z_task_control_is_cancellation_requested(${value})`;
        }
      }
      if (ownerType === "String" || ownerType === "TextBuffer") {
        const owner = emitFrameExpression(expression.object, plan, fileName);
        if (expression.property === "byteLength") return `((${owner}).length)`;
        if (expression.property === "isEmpty") return `((${owner}).length == 0)`;
      }
      const access = ownerView || plan.types.structs.get(ownerType)?.kind === "class" ? "->" : ".";
      const value = `((${emitFrameExpression(expression.object, plan, fileName)})${access}${expression.property})`;
      const type = frameExpressionType(expression, plan);
      if (
        plan.types.semanticInfo.managedCopies.has(expression.location.offset)
        && plan.types.structs.get(type)?.kind === "class"
      ) {
        return `Z_${type}_retain(${value})`;
      }
      return value;
    }
    case "structExpression":
      return emitStructValue(expression.typeName, expression.fields, plan, fileName, expression.location);
    case "variantExpression":
      return emitAsyncEnumVariant(
        expression.enumName,
        expression.variantName,
        emitFrameExpression(expression.payload, plan, fileName),
        plan.types,
      );
    case "call": {
      if (
        expression.callee.kind === "member"
        && (parseViewType(
          expression.callee.object.kind === "identifier"
            ? plan.locals.get(expression.callee.object.name) ?? frameExpressionType(expression.callee.object, plan)
            : frameExpressionType(expression.callee.object, plan),
        )?.target ?? frameExpressionType(expression.callee.object, plan)) === "TaskControl"
      ) {
        const receiverType = expression.callee.object.kind === "identifier"
          ? plan.locals.get(expression.callee.object.name) ?? frameExpressionType(expression.callee.object, plan)
          : frameExpressionType(expression.callee.object, plan);
        const receiver = emitFrameExpression(expression.callee.object, plan, fileName);
        const value = parseViewType(receiverType) ? `(*(${receiver}))` : receiver;
        return `z_task_control_request_cancel(${value})`;
      }
      if (
        plan.types.semanticInfo.taskScopeAsyncCalls.has(expression.location.offset)
        && expression.callee.kind === "member"
      ) {
        const closureOffset = plan.types.semanticInfo.taskScopeAsyncCalls.get(expression.location.offset)!;
        const closure = plan.types.semanticInfo.closures.get(closureOffset)!;
        const scope = emitFrameExpression(expression.callee.object, plan, fileName);
        const captures = closure.captures.map((capture) => {
          let value = emitFrameExpression(
            { kind: "identifier", name: capture.name, location: capture.location },
            plan,
            fileName,
          );
          if (capture.type === "TaskScope") {
            value = `z_task_scope_retain(${value})`;
          } else if (capture.type === "TaskControl") {
            value = `z_task_control_retain(${value})`;
          } else if (plan.types.structs.get(capture.type)?.kind === "class") {
            value = `Z_${capture.type}_retain(${value})`;
          }
          return value;
        });
        return `${taskScopeAsyncScheduleName(expression.location.offset)}(${[scope, ...captures].join(", ")})`;
      }
      const integerConversion = plan.types.semanticInfo.integerConversions.get(expression.location.offset);
      if (integerConversion) {
        const value = emitFrameExpression(expression.arguments[0], plan, fileName);
        const targetType = cFrameType(integerConversion.targetType, plan.types);
        return integerConversion.checked
          ? `z_checked_convert_${integerConversion.sourceType}_to_${integerConversion.targetType}(${value})`
          : `((${targetType})(${value}))`;
      }
      const standard = plan.types.semanticInfo.standardFunctionReferences.get(expression.callee.location.offset);
      if (standard) {
        const signature = standardFunctionSignature(standard);
        if (signature.async) {
          unsupported(fileName, expression.location, "an async standard function must be lowered beneath await");
        }
        return `${signature.cName}(${emitSyncCallArguments(expression, plan, fileName, signature).join(", ")})`;
      }
      if (
        expression.callee.kind === "identifier"
        && plan.types.semanticInfo.standardTypeBindings.get(expression.callee.name) === "TextBuffer"
      ) {
        return "z_string_new()";
      }
      if (expression.callee.kind === "member" && expression.callee.object.kind === "identifier") {
        if (expression.callee.object.name === "String" && expression.callee.property === "from") {
          return `z_string_from_cstring(${emitFrameExpression(expression.arguments[0], plan, fileName)})`;
        }
        const owner = plan.types.structs.get(expression.callee.object.name);
        const staticMethod = owner?.methods.find((candidate) => (
          candidate.static && !candidate.async && candidate.name === expression.callee.property
        ));
        if (owner && staticMethod) {
          return `Z_${owner.name}_${staticMethod.name}(${emitSyncCallArguments(expression, plan, fileName).join(", ")})`;
        }
        const enumeration = plan.types.enums.get(expression.callee.object.name);
        const variant = enumeration?.variants.find((candidate) => candidate.name === expression.callee.property);
        if (enumeration && variant) {
          return emitAsyncEnumVariant(
            enumeration.name,
            variant.name,
            variant.payload ? emitFrameExpression(expression.arguments[0], plan, fileName) : null,
            plan.types,
          );
        }
      }
      const objcCall = plan.types.semanticInfo.objcCalls.get(expression.location.offset);
      if (objcCall && expression.callee.kind === "member") {
        if (expression.arguments.some((argument) => plan.types.semanticInfo.objcBlockArguments.has(argument.location.offset))) {
          unsupported(fileName, expression.location, "an Objective-C block call requires statement-position async lowering");
        }
        const receiver = objcCall.instance
          ? emitFrameExpression(expression.callee.object, plan, fileName)
          : objcCall.className;
        const arguments_ = emitSyncCallArguments(expression, plan, fileName);
        return generateObjCMessage(receiver, objcCall.selector, arguments_);
      }
      const cxxMethod = plan.types.semanticInfo.foreignCxxMethodCalls.get(expression.location.offset);
      if (cxxMethod && expression.callee.kind === "member") {
        const receiver = emitFrameExpression(expression.callee.object, plan, fileName);
        const arguments_ = emitSyncCallArguments(expression, plan, fileName);
        return `${receiver}.${cxxMethod.name}(${arguments_.join(", ")})`;
      }
      const foreignFunction = plan.types.semanticInfo.foreignFunctionNames.get(expression.callee.location.offset);
      if (foreignFunction) {
        return `${foreignFunction}(${emitSyncCallArguments(expression, plan, fileName).join(", ")})`;
      }
      if (
        expression.callee.kind === "identifier"
        && plan.types.structs.get(expression.callee.name)?.kind === "struct"
        && expression.arguments.length === 1
        && expression.arguments[0].kind === "objectExpression"
      ) {
        return emitStructValue(
          expression.callee.name,
          expression.arguments[0].fields,
          plan,
          fileName,
          expression.location,
        );
      }
      if (expression.callee.kind === "member") {
        const receiverType = frameExpressionType(expression.callee.object, plan);
        if (receiverType === "String") {
          const receiver = emitFrameExpression(expression.callee.object, plan, fileName);
          if (expression.callee.property === "byteAt") {
            return `z_string_byte_at(${receiver}, ${emitFrameExpression(expression.arguments[0], plan, fileName)})`;
          }
          if (expression.callee.property === "copyBytes") {
            return `z_string_copy_bytes(${receiver}, ${emitFrameExpression(expression.arguments[0], plan, fileName)}, ${emitFrameExpression(expression.arguments[1], plan, fileName)})`;
          }
        }
        if (receiverType === "TextBuffer") {
          const receiver = emitFrameExpression(expression.callee.object, plan, fileName);
          if (expression.callee.property === "append") {
            return `z_text_buffer_append(&(${receiver}), ${emitFrameExpression(expression.arguments[0], plan, fileName)})`;
          }
          if (expression.callee.property === "appendBytes") {
            return `z_text_buffer_append_bytes(&(${receiver}), ${emitFrameExpression(expression.arguments[0], plan, fileName)}, ${emitFrameExpression(expression.arguments[1], plan, fileName)}, ${emitFrameExpression(expression.arguments[2], plan, fileName)})`;
          }
          if (expression.callee.property === "appendAscii") {
            return `z_text_buffer_append_ascii(&(${receiver}), ${emitFrameExpression(expression.arguments[0], plan, fileName)})`;
          }
          if (expression.callee.property === "finish") return receiver;
        }
        if (parseDynamicArrayType(receiverType) && expression.callee.property === "push") {
          const receiver = emitFrameExpression(expression.callee.object, plan, fileName);
          const argument = emitFrameExpression(expression.arguments[0], plan, fileName);
          return `${dynamicArrayPushName(receiverType)}(&(${receiver}), ${argument})`;
        }
        const owner = plan.types.structs.get(receiverType);
        const method = owner?.methods.find((candidate) => (
          !candidate.static && !candidate.async && candidate.name === expression.callee.property
        ));
        if (owner && method) {
          const receiverValue = emitFrameExpression(expression.callee.object, plan, fileName);
          const receiver = owner.kind === "class" || method.receiverMode === "move"
            ? receiverValue
            : `&(${receiverValue})`;
          const arguments_ = emitSyncCallArguments(expression, plan, fileName);
          return `Z_${owner.name}_${method.name}(${[receiver, ...arguments_].join(", ")})`;
        }
      }
      if (expression.callee.kind === "identifier") {
        const declaration = plan.types.functions.get(expression.callee.name);
        if (declaration && parseAsyncGeneratorType(declaration.returnType.name)) {
          return `${asyncGeneratorFactoryName({ declaration, owner: null })}(${emitSyncCallArguments(expression, plan, fileName).join(", ")})`;
        }
        if (declaration && !declaration.async) {
          return `${declaration.name}(${emitSyncCallArguments(expression, plan, fileName).join(", ")})`;
        }
      }
      unsupported(fileName, expression.location, "only aggregate construction is executable as a synchronous async-frame call yet");
    }
    case "new": {
      if (plan.types.semanticInfo.taskScopeConstructors.has(expression.location.offset)) {
        return "z_task_scope_new(frame->task.executor)";
      }
      const declaration = plan.types.structs.get(expression.typeName);
      if (declaration?.kind !== "class") {
        unsupported(fileName, expression.location, "async new requires a Z class type");
      }
      if (declaration.constructor) {
        unsupported(fileName, expression.location, "user-defined class constructors in async frames have not landed yet");
      }
      const object = expression.arguments[0];
      if (!object || object.kind !== "objectExpression") {
        unsupported(fileName, expression.location, "synthesized async class initialization requires an object literal");
      }
      const provided = new Map(object.fields.map((field) => [field.name, field.expression]));
      const fields = declaration.fields.map((field) => (
        emitFrameExpression(provided.get(field.name)!, plan, fileName)
      ));
      return `Z_${expression.typeName}_new(${fields.join(", ")})`;
    }
    default:
      unsupported(
        fileName,
        expression.location,
        `expression ${JSON.stringify(expression.kind)} is not executable in the first Phase 1 async slice`,
      );
  }
}

function validateThreadTryCall(
  expression: Expression,
  fileName: string,
  types: AsyncTypeContext,
): void {
  if (
    expression.kind !== "call"
    || expression.callee.kind !== "identifier"
    || !types.functions.get(expression.callee.name)?.errorType
  ) {
    unsupported(
      fileName,
      expression.location,
      "thread worker `try` currently requires a direct synchronous throwing function call",
      "call a named `function operation(...): T throws E` directly beneath `try`",
    );
  }
}

function emitThreadTryReturn(
  expression: Expression,
  plan: AsyncFunctionPlan,
  fileName: string,
  state: number,
): string[] {
  return emitThreadTryOperation(expression, plan, fileName, state, null, finalizeStateMarker);
}

function emitThreadTryBinding(
  expression: Expression,
  plan: AsyncFunctionPlan,
  fileName: string,
  state: number,
  binding: string,
  nextState: number,
): string[] {
  return emitThreadTryOperation(expression, plan, fileName, state, binding, String(nextState));
}

function emitThreadTryOperation(
  expression: Expression,
  plan: AsyncFunctionPlan,
  fileName: string,
  state: number,
  binding: string | null,
  successState: string,
): string[] {
  validateThreadTryCall(expression, fileName, plan.types);
  const call = expression as CallExpression;
  const declaration = plan.types.functions.get((call.callee as Extract<Expression, { kind: "identifier" }>).name)!;
  const successType = declaration.returnType.name;
  const errorType = declaration.errorType!.name;
  const resultType = resultTypeName(successType, errorType);
  const temporary = `_z_thread_try_${state}`;
  const errorPayload = requiresNativeFramePlacement(errorType, plan.types)
    ? `std::move(${temporary}.data.failure)`
    : `${temporary}.data.failure`;
  const lines = [
    `${cFrameType(resultType, plan.types)} ${temporary} = ${emitFrameExpression(call, plan, fileName)};`,
    `if (${temporary}.tag == ${resultTag(resultType, "failure")}) {`,
    requiresNativeFramePlacement(errorType, plan.types)
      ? `  new (frame->error) ${cFrameType(errorType, plan.types)}(${errorPayload});`
      : `  frame->error = ${errorPayload};`,
    ...(hasFrameCleanup(errorType, plan.types) ? ["  frame->live_error = true;"] : []),
    "  frame->failed = true;",
    "  frame->cancel_children = true;",
    `  frame->state = ${finalizeStateMarker};`,
    "  continue;",
    "}",
  ];
  if (successType !== "void") {
    const destination = binding ? `frame->${frameField(binding)}` : "frame->result";
    const successPayload = requiresNativeFramePlacement(successType, plan.types)
      ? `std::move(${temporary}.data.success)`
      : `${temporary}.data.success`;
    lines.push(requiresNativeFramePlacement(successType, plan.types)
      ? `new (${destination}) ${cFrameType(successType, plan.types)}(${successPayload});`
      : `${destination} = ${successPayload};`);
    if (hasFrameCleanup(successType, plan.types)) {
      lines.push(binding ? `frame->${frameLiveField(binding)} = true;` : "frame->live_result = true;");
    }
  }
  lines.push(
    "frame->failed = false;",
    `frame->state = ${successState};`,
    "continue;",
  );
  return lines;
}

function emitSyncCallArguments(
  expression: CallExpression,
  plan: Pick<AsyncFunctionPlan, "locals" | "types">,
  fileName: string,
  standardSignature?: ReturnType<typeof standardFunctionSignature>,
): string[] {
  return expression.arguments.map((argument, index) => {
    const value = emitFrameExpression(argument, plan, fileName);
    const slice = emitFrameSliceConversion(argument, value, plan, fileName);
    if (slice) return slice;
    const parameter = synchronousZCallParameter(expression, index, plan);
    if (parameter && parseSliceType(parameter.type.name)) return value;
    if (standardSignature?.parameters[index]?.abi === "value") return value;
    if (plan.types.semanticInfo.foreignCxxArgumentAccesses.has(argument.location.offset)) return value;
    if (plan.types.semanticInfo.foreignArgumentAccesses.get(argument.location.offset) === "in") return `&(${value})`;
    const access = plan.types.semanticInfo.nativeArgumentAccesses.get(argument.location.offset);
    if (!access) return value;
    const type = frameExpressionType(argument, plan);
    if (access === "in" && plan.types.structs.get(type)?.kind === "class") return value;
    return `&(${value})`;
  });
}

function synchronousZCallParameter(
  expression: CallExpression,
  index: number,
  plan: Pick<AsyncFunctionPlan, "locals" | "types">,
): FunctionDeclaration["parameters"][number] | undefined {
  if (expression.callee.kind === "identifier") {
    return plan.types.functions.get(expression.callee.name)?.parameters[index];
  }
  if (expression.callee.kind !== "member") return undefined;
  if (expression.callee.object.kind === "identifier") {
    const staticOwner = plan.types.structs.get(expression.callee.object.name);
    const staticMethod = staticOwner?.methods.find((candidate) => (
      candidate.static && !candidate.async && candidate.name === expression.callee.property
    ));
    if (staticMethod) return staticMethod.parameters[index];
  }
  const receiverType = frameExpressionType(expression.callee.object, plan);
  return plan.types.structs.get(receiverType)?.methods.find((candidate) => (
    !candidate.static && !candidate.async && candidate.name === expression.callee.property
  ))?.parameters[index];
}

function requireScalar(type: string, location: SourceLocation, fileName: string, role: string): void {
  if (!scalarTypes.has(type)) {
    unsupported(fileName, location, `${role} type ${JSON.stringify(type)} needs owned task-frame lowering`);
  }
}

function emitStructValue(
  type: string,
  fields: readonly { readonly name: string; readonly expression: Expression }[],
  plan: Pick<AsyncFunctionPlan, "locals" | "types">,
  fileName: string,
  location: SourceLocation,
): string {
  const declaration = plan.types.structs.get(type);
  if (!declaration || declaration.kind !== "struct" || !isSupportedFrameType(type, plan.types)) {
    unsupported(fileName, location, `struct ${JSON.stringify(type)} needs owned cleanup-aware task-frame lowering`);
  }
  const provided = new Map(fields.map((field) => [field.name, field.expression]));
  const initialized = declaration.fields.map((field) => (
    `.${field.name} = ${emitFrameExpression(provided.get(field.name)!, plan, fileName)}`
  ));
  return `(${cFrameType(type, plan.types)}){ ${initialized.join(", ")} }`;
}

function requireFrameType(
  type: string,
  location: SourceLocation,
  fileName: string,
  role: string,
  types: AsyncTypeContext,
): void {
  if (!isSupportedFrameType(type, types)) {
    unsupported(fileName, location, `${role} type ${JSON.stringify(type)} needs owned task-frame lowering`);
  }
}

function cScalar(type: string): string {
  const mapped = scalarTypes.get(type);
  if (!mapped) throw new Error(`missing async scalar ABI type ${JSON.stringify(type)}`);
  return mapped;
}

function cFrameType(type: string, types: AsyncTypeContext): string {
  if (parseTaskType(type)) return "Z_AsyncTask *";
  if (type === "TaskScope") return "Z_TaskScope *";
  if (type === "TaskControl") return "Z_TaskControl *";
  if (parseAsyncGeneratorType(type)) return asyncGeneratorCName(type);
  const view = parseViewType(type);
  if (view) return `const ${cFrameType(view.target, types)} *`;
  if (scalarTypes.has(type)) return cScalar(type);
  if (type === "String" || type === "TextBuffer") return "Z_String";
  if (parseFixedArrayType(type)) return `Z_Array_${asyncNativeSymbolPart(type)}`;
  if (parseSliceType(type)) return `Z_Slice_${asyncNativeSymbolPart(type)}`;
  if (parseDynamicArrayType(type)) return `Z_DynamicArray_${asyncNativeSymbolPart(type)}`;
  const aggregate = types.structs.get(type);
  if (aggregate) return aggregate.kind === "class" ? `Z_${type} *` : `Z_${type}`;
  if (types.enums.has(type)) return resultCName(type);
  const foreign = types.semanticInfo.foreignNamedTypes.get(type);
  if (foreign) return foreign.cName;
  const foreignPointer = types.semanticInfo.foreignTypes.get(type);
  if (foreignPointer) return foreignPointer.cName;
  throw new Error(`missing async aggregate ABI type ${JSON.stringify(type)}`);
}

function asyncNativeSymbolPart(name: string): string {
  return [...name].map((character) => (
    /[A-Za-z0-9_]/.test(character) ? character : `_${character.codePointAt(0)!.toString(16)}_`
  )).join("");
}

function asyncGeneratorCName(type: string): string {
  return `Z_AsyncGenerator_${asyncNativeSymbolPart(type)}`;
}

function borrowedFrameType(type: string, types: AsyncTypeContext, mutable = false): string {
  const cType = cFrameType(type, types);
  return isFrameReferenceIdentityType(type, types)
    ? cType
    : `${mutable ? "" : "const "}${cType} *`;
}

function borrowedFrameValue(name: string, type: string, types: AsyncTypeContext): string {
  const field = `frame->${frameField(name)}`;
  return isFrameReferenceIdentityType(type, types) ? field : `(*${field})`;
}

function isFrameReferenceIdentityType(type: string, types: AsyncTypeContext): boolean {
  return types.structs.get(type)?.kind === "class"
    || types.semanticInfo.foreignObjectTypes.has(type)
    || types.semanticInfo.foreignNamedTypes.get(type)?.kind === "object";
}

function isSupportedFrameType(type: string, types: AsyncTypeContext, visiting = new Set<string>()): boolean {
  if (parseTaskType(type)) return true;
  if (type === "TaskScope") return true;
  if (type === "TaskControl") return true;
  if (parseAsyncGeneratorType(type)) return true;
  if (parseViewType(type)) return true;
  if (scalarTypes.has(type)) return true;
  if (type === "String" || type === "TextBuffer") return true;
  const fixedArray = parseFixedArrayType(type);
  if (fixedArray) {
    return isSupportedFrameType(fixedArray.elementType, types, visiting);
  }
  const dynamicArray = parseDynamicArrayType(type);
  if (dynamicArray) return isSupportedFrameType(dynamicArray.elementType, types, visiting);
  if (parseSliceType(type)) return true;
  if (isDirectForeignFrameValue(type, types)) return true;
  if (types.semanticInfo.foreignTypes.has(type)) return true;
  if (
    types.semanticInfo.foreignObjectTypes.has(type)
    || types.semanticInfo.foreignNamedTypes.get(type)?.kind === "object"
  ) return true;
  if (visiting.has(type)) return true;
  const aggregate = types.structs.get(type);
  if (aggregate) {
    if (aggregate.kind === "class") return true;
    visiting.add(type);
    const supported = aggregate.fields.every((field) => isSupportedFrameType(field.type.name, types, visiting));
    visiting.delete(type);
    return supported;
  }
  const enumeration = types.enums.get(type);
  if (enumeration) {
    visiting.add(type);
    const supported = enumeration.variants.every((variant) => (
      !variant.payload || isSupportedFrameType(variant.payload.name, types, visiting)
    ));
    visiting.delete(type);
    return supported;
  }
  return false;
}

function hasFrameCleanup(type: string, types: AsyncTypeContext, visiting = new Set<string>()): boolean {
  if (visiting.has(type)) return false;
  if (parseAsyncGeneratorType(type)) return true;
  if (type === "String" || type === "TextBuffer" || type === "TaskScope" || type === "TaskControl") return true;
  if (
    types.semanticInfo.foreignObjectTypes.has(type)
    || types.semanticInfo.foreignNamedTypes.get(type)?.kind === "object"
  ) return true;
  if (requiresNativeFramePlacement(type, types)) return true;
  if (directForeignFrameValue(type, types)?.lifecycle.deinit) return true;
  const foreignPointer = types.semanticInfo.foreignTypes.get(type);
  if (foreignPointer?.ownership === "owned" && foreignPointer.release) return true;
  if (parseDynamicArrayType(type)) return true;
  const fixedArray = parseFixedArrayType(type);
  if (fixedArray) return hasFrameCleanup(fixedArray.elementType, types, visiting);
  const aggregate = types.structs.get(type);
  if (aggregate?.kind === "class") return true;
  const enumeration = types.enums.get(type);
  if (!aggregate && !enumeration) return false;
  if (aggregate?.deinitializer) return true;
  visiting.add(type);
  const cleanup = aggregate
    ? aggregate.fields.some((field) => hasFrameCleanup(field.type.name, types, visiting))
    : enumeration!.variants.some((variant) => (
        variant.payload ? hasFrameCleanup(variant.payload.name, types, visiting) : false
      ));
  visiting.delete(type);
  return cleanup;
}

function frameCleanup(value: string, type: string, types: AsyncTypeContext): string {
  if (parseAsyncGeneratorType(type)) {
    return `if ((${value}).context != NULL) { (${value}).destroy((${value}).context); (${value}).context = NULL; }`;
  }
  if (requiresNativeFramePlacement(type, types)) {
    const managed = frameManagedCleanup(value, type, types);
    const native = `std::destroy_at(&(${value}));`;
    return managed ? `${managed}\n${native}` : native;
  }
  if (type === "String" || type === "TextBuffer") {
    return `if ((${value}).capacity > 0) free((void *)(${value}).data);`;
  }
  if (type === "TaskScope") return `z_task_scope_release(${value});`;
  if (type === "TaskControl") return `z_task_control_release(${value});`;
  if (
    types.semanticInfo.foreignObjectTypes.has(type)
    || types.semanticInfo.foreignNamedTypes.get(type)?.kind === "object"
  ) return `${value} = nil;`;
  const foreignPointer = types.semanticInfo.foreignTypes.get(type);
  if (foreignPointer?.ownership === "owned" && foreignPointer.release) {
    return foreignPointer.nullable
      ? `if (${value} != NULL) ${foreignPointer.release}(${value});`
      : `${foreignPointer.release}(${value});`;
  }
  const dynamicArray = parseDynamicArrayType(type);
  if (dynamicArray) {
    const lines: string[] = [];
    if (hasFrameCleanup(dynamicArray.elementType, types)) {
      const index = `_z_async_cleanup_${asyncNativeSymbolPart(type)}`;
      const element = `(${value}).data[${index} - 1]`;
      lines.push(
        `for (uintptr_t ${index} = (${value}).length; ${index} > 0; ${index} -= 1) {\n`
          + `${indent(frameCleanup(element, dynamicArray.elementType, types), 2)}\n}`,
      );
    }
    lines.push(
      requiresNativeFramePlacement(dynamicArray.elementType, types)
        ? `::operator delete((${value}).data);`
        : `free((${value}).data);`,
    );
    return lines.join("\n");
  }
  const fixedArray = parseFixedArrayType(type);
  if (fixedArray) {
    const index = `_z_async_cleanup_${asyncNativeSymbolPart(type)}`;
    const element = `(${value}).data[${index} - 1]`;
    return `for (uintptr_t ${index} = ${fixedArray.length}; ${index} > 0; ${index} -= 1) {\n`
      + `${indent(frameCleanup(element, fixedArray.elementType, types), 2)}\n}`;
  }
  const aggregate = types.structs.get(type);
  if (aggregate?.kind === "class") return `Z_${type}_release(${value});`;
  if (aggregate?.kind === "struct") return `Z_${type}_deinit(&(${value}));`;
  const enumeration = types.enums.get(type);
  if (enumeration) {
    const niche = asyncOptionNichePayload(type, types);
    if (niche) return frameCleanup(value, niche, types);
    const cases = enumeration.variants.flatMap((variant) => {
      if (!variant.payload || !hasFrameCleanup(variant.payload.name, types)) return [];
      const cleanup = frameCleanup(`(${value}).data.${variant.name}`, variant.payload.name, types);
      return [
        `case ${resultTag(type, variant.name)}:\n${indent(cleanup, 2)}\n  break;`,
      ];
    });
    return `switch ((${value}).tag) {\n${indent(cases.join("\n"), 2)}\n  default:\n    break;\n}`;
  }
  throw new Error(`missing async cleanup lowering for ${JSON.stringify(type)}`);
}

function frameManagedCleanup(value: string, type: string, types: AsyncTypeContext): string {
  if (isDirectForeignFrameValue(type, types)) return "";
  if (type === "String" || type === "TextBuffer") {
    return `if ((${value}).capacity > 0) free((void *)(${value}).data);`;
  }
  if (
    types.semanticInfo.foreignObjectTypes.has(type)
    || types.semanticInfo.foreignNamedTypes.get(type)?.kind === "object"
  ) return `${value} = nil;`;
  const fixedArray = parseFixedArrayType(type);
  if (fixedArray) {
    const cleanup = frameManagedCleanup(
      `(${value}).data[_z_async_managed_${asyncNativeSymbolPart(type)} - 1]`,
      fixedArray.elementType,
      types,
    );
    if (!cleanup) return "";
    const index = `_z_async_managed_${asyncNativeSymbolPart(type)}`;
    return `for (uintptr_t ${index} = ${fixedArray.length}; ${index} > 0; ${index} -= 1) {\n`
      + `${indent(cleanup, 2)}\n}`;
  }
  const aggregate = types.structs.get(type);
  if (aggregate?.kind === "class") return `Z_${type}_release(${value});`;
  if (aggregate?.kind === "struct") return hasManagedFrameCleanup(type, types) ? `Z_${type}_deinit(&(${value}));` : "";
  const enumeration = types.enums.get(type);
  if (!enumeration) return "";
  const niche = asyncOptionNichePayload(type, types);
  if (niche) return frameManagedCleanup(value, niche, types);
  const cases = enumeration.variants.flatMap((variant) => {
    if (!variant.payload) return [];
    const cleanup = frameManagedCleanup(`(${value}).data.${variant.name}`, variant.payload.name, types);
    return cleanup
      ? [`case ${resultTag(type, variant.name)}:\n${indent(cleanup, 2)}\n  break;`]
      : [];
  });
  if (cases.length === 0) return "";
  return `switch ((${value}).tag) {\n${indent(cases.join("\n"), 2)}\n  default:\n    break;\n}`;
}

function hasManagedFrameCleanup(type: string, types: AsyncTypeContext, visiting = new Set<string>()): boolean {
  if (visiting.has(type) || isDirectForeignFrameValue(type, types)) return false;
  if (type === "String" || type === "TextBuffer") return true;
  if (
    types.semanticInfo.foreignObjectTypes.has(type)
    || types.semanticInfo.foreignNamedTypes.get(type)?.kind === "object"
  ) return true;
  const fixedArray = parseFixedArrayType(type);
  if (fixedArray) return hasManagedFrameCleanup(fixedArray.elementType, types, visiting);
  const aggregate = types.structs.get(type);
  if (aggregate?.kind === "class") return true;
  const enumeration = types.enums.get(type);
  if (!aggregate && !enumeration) return false;
  if (aggregate?.deinitializer) return true;
  visiting.add(type);
  const result = aggregate
    ? aggregate.fields.some((field) => hasManagedFrameCleanup(field.type.name, types, visiting))
    : enumeration!.variants.some((variant) => (
        variant.payload ? hasManagedFrameCleanup(variant.payload.name, types, visiting) : false
      ));
  visiting.delete(type);
  return result;
}

function directForeignFrameValue(type: string, types: AsyncTypeContext) {
  const foreign = types.semanticInfo.foreignNamedTypes.get(type);
  return foreign?.kind === "value" && foreign.lifecycle.move && !foreign.lifecycle.copy
    ? foreign
    : null;
}

function isDirectForeignFrameValue(type: string, types: AsyncTypeContext): boolean {
  return directForeignFrameValue(type, types) !== null;
}

function requiresNativeFramePlacement(
  type: string,
  types: AsyncTypeContext,
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(type)) return false;
  if (isDirectForeignFrameValue(type, types)) return true;
  const fixedArray = parseFixedArrayType(type);
  if (fixedArray) return requiresNativeFramePlacement(fixedArray.elementType, types, visiting);
  const aggregate = types.structs.get(type);
  const enumeration = types.enums.get(type);
  if (!aggregate && !enumeration) return false;
  if (aggregate?.kind === "class") return false;
  visiting.add(type);
  const result = aggregate
    ? aggregate.fields.some((field) => requiresNativeFramePlacement(field.type.name, types, visiting))
    : enumeration!.variants.some((variant) => (
        variant.payload ? requiresNativeFramePlacement(variant.payload.name, types, visiting) : false
      ));
  visiting.delete(type);
  return result;
}

function dynamicArrayPushName(type: string): string {
  return `Z_DynamicArray_${asyncNativeSymbolPart(type)}_push`;
}

function frameStoredValue(name: string, type: string, types: AsyncTypeContext): string {
  const field = `frame->${frameField(name)}`;
  const cType = cFrameType(type, types);
  return requiresNativeFramePlacement(type, types)
    ? `(*std::launder(reinterpret_cast<${cType} *>(${field})))`
    : field;
}

function frameResultValue(frame: string, type: string, types: AsyncTypeContext): string {
  const field = `${frame}->result`;
  const cType = cFrameType(type, types);
  return requiresNativeFramePlacement(type, types)
    ? `(*std::launder(reinterpret_cast<${cType} *>(${field})))`
    : field;
}

function frameErrorValue(frame: string, type: string, types: AsyncTypeContext): string {
  const field = `${frame}->error`;
  const cType = cFrameType(type, types);
  return requiresNativeFramePlacement(type, types)
    ? `(*std::launder(reinterpret_cast<${cType} *>(${field})))`
    : field;
}

function frameTransferredValue(
  value: string,
  liveFlag: string,
  type: string,
  types: AsyncTypeContext,
): string {
  if (!hasFrameCleanup(type, types)) return value;
  return requiresNativeFramePlacement(type, types)
    ? frameTakeExpression(value, liveFlag)
    : `(${liveFlag} = false, ${value})`;
}

function frameSuspensionValue(site: NestedAwaitSite, types: AsyncTypeContext): string {
  const field = `frame->${site.field}`;
  const cType = cFrameType(site.type, types);
  return requiresNativeFramePlacement(site.type, types)
    ? `(*std::launder(reinterpret_cast<${cType} *>(${field})))`
    : field;
}

function frameTakeExpression(value: string, liveFlag: string): string {
  return `z_async_take(&(${value}), &(${liveFlag}))`;
}

function asyncExpressionLiveFlag(expression: Expression, plan: AsyncFunctionPlan): string | null {
  const suspension = plan.suspensions.get(expression.location.offset);
  if (suspension && hasFrameCleanup(suspension.type, plan.types)) {
    return `frame->${suspension.field}_live`;
  }
  if (expression.kind === "identifier") {
    const type = plan.locals.get(expression.name);
    if (type && hasFrameCleanup(type, plan.types)) return `frame->${frameLiveField(expression.name)}`;
  }
  return null;
}

function emitAsyncEnumVariant(
  enumType: string,
  variant: string,
  payload: string | null,
  types: AsyncTypeContext,
): string {
  const cType = resultCName(enumType);
  if (requiresNativeFramePlacement(enumType, types)) {
    return `${cType}::make_${nativePart(variant)}(${payload ?? ""})`;
  }
  const initialized = payload === null ? "" : `, .data = { .${variant} = ${payload} }`;
  return `(${cType}){ .tag = ${resultTag(enumType, variant)}${initialized} }`;
}

function frameExpressionType(
  expression: Expression,
  plan: FrameExpressionContext,
): string {
  const analyzed = plan.types.semanticInfo.expressionTypes.get(expression.location.offset);
  if (analyzed) return analyzed;
  if (expression.kind === "identifier") return plan.locals.get(expression.name) ?? "i32";
  if (expression.kind === "new" || expression.kind === "structExpression") return expression.typeName;
  if (expression.kind === "boolean" || expression.kind === "binary" || expression.kind === "unary") return "boolean";
  if (expression.kind === "number") {
    return plan.types.semanticInfo.numericLiteralTypes.get(expression.location.offset) ?? "i32";
  }
  return "i32";
}

function asyncIntegerOperationName(kind: IntegerOperation["kind"], type: string): string {
  const names: Readonly<Record<IntegerOperation["kind"], string>> = {
    checkedAdd: "checked_add",
    checkedSubtract: "checked_subtract",
    checkedMultiply: "checked_multiply",
    checkedDivide: "checked_divide",
    checkedRemainder: "checked_remainder",
    checkedNegate: "checked_negate",
    checkedShiftLeft: "checked_shift_left",
    checkedShiftRight: "checked_shift_right",
    wrappingAdd: "wrapping_add",
    wrappingSubtract: "wrapping_subtract",
    wrappingMultiply: "wrapping_multiply",
    saturatingAdd: "saturating_add",
    saturatingSubtract: "saturating_subtract",
    saturatingMultiply: "saturating_multiply",
  };
  return `z_${names[kind]}_${type}`;
}

function asyncContextualSignedLiteral(operator: "+" | "-", value: string, type: string): string {
  const literal = asyncNumericLiteral(value, type);
  if (operator === "+") return literal;
  if (/[.eE]/.test(value)) return `(-${literal})`;
  const widths: Readonly<Record<string, number>> = {
    i8: 8,
    i16: 16,
    i32: 32,
    i64: 64,
    isize: process.arch.includes("64") ? 64 : 32,
  };
  const minimums: Readonly<Record<string, string>> = {
    i8: "INT8_MIN",
    i16: "INT16_MIN",
    i32: "INT32_MIN",
    i64: "INT64_MIN",
    isize: "INTPTR_MIN",
  };
  const width = widths[type];
  if (width && -BigInt(value) === -(1n << BigInt(width - 1))) return minimums[type];
  return `(-${literal})`;
}

function asyncNumericLiteral(value: string, type: string): string {
  const floating = /[.eE]/.test(value);
  if (type === "f32") return `${value}${floating ? "F" : ".0F"}`;
  if (type === "f64") return floating ? value : `${value}.0`;
  if (type === "u32") return `${value}U`;
  if (type === "u64" || type === "usize") return `${value}ULL`;
  if (type === "i64" || type === "isize") return `${value}LL`;
  return value;
}

function destinationLiveFlag(destination: string, plan: AsyncFunctionPlan): string {
  if (destination === "frame->result") return "frame->live_result";
  for (const name of plan.locals.keys()) {
    if (destination === `frame->${frameField(name)}`) return `frame->${frameLiveField(name)}`;
  }
  for (const site of plan.suspensions.values()) {
    if (destination === `frame->${site.field}`) return `frame->${site.field}_live`;
  }
  throw new Error(`missing async live flag destination for ${JSON.stringify(destination)}`);
}

function resultCName(type: string): string {
  const name = type.replace(/^__z_/, "");
  const encoded = [...name].map((character) => (
    /[A-Za-z0-9_]/.test(character) ? character : `_${character.codePointAt(0)!.toString(16)}_`
  )).join("");
  return `Z_${encoded}`;
}

function resultTag(type: string, variant: string): string {
  return `${resultCName(type)}_${variant}`;
}

function endsWithTermination(statements: readonly Statement[]): boolean {
  return statements.at(-1)?.kind === "return" || statements.at(-1)?.kind === "throw";
}

function frameField(name: string): string {
  return `value_${nativePart(name)}`;
}

function frameLiveField(name: string): string {
  return `live_${nativePart(name)}`;
}

function nestedAwaitField(offset: number): string {
  return `suspend_${offset}`;
}

function asyncLabelMarker(label: number): string {
  return `__Z_ASYNC_LABEL_${label}__`;
}

function targetKey(target: Pick<AsyncTarget, "declaration" | "owner">): string {
  return target.owner ? `${target.owner.name}.${target.declaration.name}` : target.declaration.name;
}

function targetPart(target: Pick<AsyncTarget, "declaration" | "owner">): string {
  return nativePart(target.owner
    ? `${target.owner.name}_${target.declaration.name}`
    : target.declaration.name);
}

function nativePart(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function unsupported(
  fileName: string,
  location: SourceLocation,
  message: string,
  help = "use `z check` while this async lowering tier is expanded",
): never {
  throw new DiagnosticError(fileName, location, message, {
    code: "Z0700",
    notes: ["Phase 1 executes owned task frames, synchronous calls and console output, FIFO scheduling, scoped tasks, cancellation, and timer delay"],
    helps: [help],
  });
}
