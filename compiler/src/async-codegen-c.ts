import type {
  CallExpression,
  Expression,
  FunctionDeclaration,
  Program,
  SourceLocation,
  Statement,
  StructDeclaration,
  EnumDeclaration,
} from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { parseTaskType } from "./async-types.ts";
import { dynamicArrayTypeName, parseDynamicArrayType, parseFixedArrayType, parseSliceType } from "./array-types.ts";
import { resultTypeName } from "./results.ts";
import { standardFunctionSignature } from "./standard-library.ts";
import type { IntegerOperation, SemanticInfo } from "./sema.ts";

type AwaitSite = {
  readonly index: number;
  readonly mode: "await" | "try" | "attempt";
  readonly intrinsic: "delay" | "cancel" | null;
  readonly expression: Expression;
  readonly call: CallExpression;
  readonly target: AsyncTarget;
  readonly receiver: Expression | null;
  readonly spawn: SpawnSite | null;
  readonly placement: "sync" | "await" | null;
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
  readonly placement: "main" | null;
};

type PlacementTarget = {
  readonly target: AsyncTarget;
  readonly captures: readonly {
    readonly name: string;
    readonly type: string;
    readonly kind: "plain" | "string" | "class" | "objc";
    readonly location: SourceLocation;
  }[];
};

type NestedAwaitSite = {
  readonly expression: Expression;
  readonly await: AwaitSite;
  readonly type: string;
  readonly field: string;
};

type AsyncOperation =
  | { readonly kind: "statement"; readonly statement: Statement }
  | { readonly kind: "scopeExit"; readonly scope: number }
  | { readonly kind: "branch"; readonly condition: Expression; readonly thenLabel: number; readonly elseLabel: number }
  | { readonly kind: "jump"; readonly label: number }
  | { readonly kind: "label"; readonly label: number };

type AsyncTarget = {
  readonly declaration: FunctionDeclaration;
  readonly owner: StructDeclaration | null;
};

type AsyncFunctionPlan = {
  readonly declaration: FunctionDeclaration;
  readonly owner: StructDeclaration | null;
  readonly nativeThread: boolean;
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
  readonly children: ReadonlyMap<number, AsyncTarget>;
  readonly types: AsyncTypeContext;
};

type AsyncTypeContext = {
  readonly structs: ReadonlyMap<string, StructDeclaration>;
  readonly enums: ReadonlyMap<string, EnumDeclaration>;
  readonly functions: ReadonlyMap<string, FunctionDeclaration>;
  readonly semanticInfo: SemanticInfo;
};

type FrameExpressionContext = {
  readonly locals: ReadonlyMap<string, string>;
  readonly borrowedLocals?: ReadonlySet<string>;
  readonly types: AsyncTypeContext;
  readonly bindings?: ReadonlyMap<string, string>;
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
  const targets: AsyncTarget[] = [...sourceTargets, ...threadTargets.values()];
  const functions = new Map(
    targets.filter((target) => !target.owner).map((target) => [target.declaration.name, target]),
  );
  const types: AsyncTypeContext = {
    structs: new Map(program.structs.map((declaration) => [declaration.name, declaration])),
    enums: new Map(program.enums.map((declaration) => [declaration.name, declaration])),
    functions: new Map(program.functions.map((declaration) => [declaration.name, declaration])),
    semanticInfo,
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
  ));
  const usesNativeThreads = plans.some((plan) => (
    [...plan.spawns.values()].some((site) => site.nativeThread)
  ));
  return {
    synchronousProgram,
    source: generateRuntime(plans, planByKey, main, fileName),
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
  const nativeThread = [...threadTargets.values()].includes(target);
  requireFrameType(declaration.returnType.name, declaration.returnType.location, fileName, "async return", types);
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
  const spawnBindings = new Map<string, SpawnSite>();
  const children = new Map<number, AsyncTarget>();
  const joinedSpawns = new Set<number>();
  const nextChild = { value: 0 };
  const nextScope = { value: 1 };
  const nextLabel = { value: 0 };
  const operations: AsyncOperation[] = [];
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
    if (!site.intrinsic) children.set(site.index, site.target);
    return site;
  };
  const recordNestedAwaits = (expression: Expression, group: Expression = expression): void => {
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
      if (hasFrameCleanup(type, types) && !/^__z_Result_/.test(type)) {
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
  const planStatements = (statements: readonly Statement[], scope: number, controlDepth = 0): void => {
    for (const statement of statements) {
      if (statement.kind === "asyncScope") {
        const childScope = nextScope.value++;
        planStatements(statement.body.statements, childScope, controlDepth);
        operations.push({ kind: "scopeExit", scope: childScope });
        continue;
      }
      if (statement.kind === "if") {
        recordNestedAwaits(statement.condition);
        validateFrameExpression(statement.condition, locals, fileName, types, suspensions);
        const thenLabel = nextLabel.value++;
        const elseLabel = nextLabel.value++;
        const endLabel = nextLabel.value++;
        const incomingJoins = new Set(joinedSpawns);
        operations.push({ kind: "branch", condition: statement.condition, thenLabel, elseLabel });
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
      operations.push({ kind: "statement", statement });
      if (statement.kind === "variable") {
        const threadSpawn = statement.initializer?.kind === "call"
          && semanticInfo.threadSpawnCalls.has(statement.initializer.location.offset);
        if (scope !== 0 && statement.initializer?.kind !== "spawn" && !threadSpawn) {
          unsupported(
            fileName,
            statement.location,
            "scope-local value bindings are not executable yet",
            "bind values outside the `async scope`; scope-local spawned task handles are supported",
          );
        }
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
        if (controlDepth > 0 && hasFrameCleanup(type, types)) {
          unsupported(
            fileName,
            statement.nameLocation,
            "a cleanup-bearing conditional-local binding needs lexical frame cleanup states",
          );
        }
        locals.set(statement.name, type);
        if (!statement.initializer) continue;
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
                locals,
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
                locals,
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
        "the current state-machine lowering supports owned bindings, direct await, spawn, throw, and return",
      );
    }
  };
  planStatements(declaration.body, 0);

  const unjoinedThrowing = [...spawns.values()].find((site) => (
    !joinedSpawns.has(site.index) && site.target.declaration.errorType
  ));
  if (unjoinedThrowing) {
    unsupported(
      fileName,
      unjoinedThrowing.expression.location,
      "a throwing spawned task must be joined explicitly",
      "bind the spawned task and acknowledge its error with `try await` or `attempt await`",
    );
  }

  const part = nativePart(owner ? `${owner.name}_${declaration.name}` : declaration.name);
  return {
    declaration,
    owner,
    nativeThread,
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
    children,
    types,
  };
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
    };
  }
  if (expression.expression.kind === "identifier" && parseTaskType(locals.get(expression.expression.name) ?? "")) {
    const spawn = spawnBindings.get(expression.expression.name);
    if (!spawn) {
      unsupported(fileName, expression.location, "awaiting task parameters or aliases is not executable yet");
    }
    if (joinedSpawns.has(spawn.index)) {
      unsupported(fileName, expression.location, "a spawned task handle can only be joined once");
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
    && call.callee.property === "cancel"
    && call.callee.object.kind === "identifier"
    && parseTaskType(locals.get(call.callee.object.name) ?? "")
  ) {
    const spawn = spawnBindings.get(call.callee.object.name);
    if (!spawn) {
      unsupported(fileName, expression.location, "cancelling task parameters or aliases is not executable yet");
    }
    if (joinedSpawns.has(spawn.index)) {
      unsupported(fileName, expression.location, "a spawned task handle can only be joined or cancelled once");
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
    };
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

function createPlacementTarget(
  expression: Extract<Expression, { kind: "executorPlacement" }>,
  locals: ReadonlyMap<string, string>,
  types: AsyncTypeContext,
  fileName: string,
  fromNativeThread: boolean,
): PlacementTarget {
  const captures = collectPlacementCaptures(expression.body, locals);
  const mutated = captures.find((capture) => capture.mutated);
  if (mutated) {
    unsupported(
      fileName,
      mutated.location,
      `executor placement cannot mutate captured binding ${JSON.stringify(mutated.name)} in the first runtime tier`,
      "return a selected value from the placement block and apply mutation after awaiting it",
    );
  }
  const captureKinds = new Map<string, PlacementTarget["captures"][number]["kind"]>();
  for (const capture of captures) {
    const type = locals.get(capture.name)!;
    const kind = placementCaptureKind(type, types, fromNativeThread);
    if (!kind) {
      unsupported(
        fileName,
        capture.location,
        `executor placement capture ${JSON.stringify(capture.name)} of type ${JSON.stringify(type)} is not transferable yet`,
        "capture a plain value, String, Z class, or Objective-C identity; native resources, mutable borrows, and affinity transfer require explicit contracts",
      );
    }
    captureKinds.set(capture.name, kind);
  }
  if (placementContainsFunctionReturn(expression.body)) {
    unsupported(
      fileName,
      expression.location,
      "return from an executor-placement block is not executable yet",
      "use `select` to produce the block value; enclosing-function return lowering follows after placed-frame unwinding",
    );
  }
  if (expression.mode === "sync" && placementContainsAsyncWork(expression.body)) {
    unsupported(
      fileName,
      expression.location,
      "synchronous `on thread.main` cannot suspend or spawn",
      "use `await on thread.main` or `spawn on thread.main` for asynchronous work",
    );
  }
  const final = expression.body.statements.at(-1);
  const selected = final?.kind === "select" ? final : null;
  const successType = expression.returnType?.name
    ?? (selected ? types.semanticInfo.expressionTypes.get(selected.expression.location.offset) : null)
    ?? "void";
  requireFrameType(successType, expression.returnType?.location ?? expression.location, fileName, "executor placement result", types);
  const body = selected
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
      mode: "value" as const,
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
      kind: captureKinds.get(capture.name)!,
      location: capture.location,
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
    arguments: placement.captures.map((capture) => ({
      kind: "identifier",
      name: capture.name,
      location: capture.location,
    })),
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
  types: AsyncTypeContext,
  fromNativeThread: boolean,
): PlacementTarget["captures"][number]["kind"] | null {
  if (type === "String") return "string";
  const aggregate = types.structs.get(type);
  if (aggregate?.kind === "class") {
    return !fromNativeThread || types.semanticInfo.shareableClasses.has(type) ? "class" : null;
  }
  if (
    types.semanticInfo.foreignObjectTypes.has(type)
    || types.semanticInfo.foreignNamedTypes.get(type)?.kind === "object"
  ) {
    return fromNativeThread ? null : "objc";
  }
  return isPlacementCopyType(type, types) ? "plain" : null;
}

function collectPlacementCaptures(
  body: Extract<Statement, { kind: "block" }>,
  outerLocals: ReadonlyMap<string, string>,
): readonly { readonly name: string; readonly location: SourceLocation; mutated: boolean }[] {
  const captures = new Map<string, { readonly name: string; readonly location: SourceLocation; mutated: boolean }>();
  const record = (name: string, location: SourceLocation, localNames: ReadonlySet<string>, mutated = false): void => {
    if (!outerLocals.has(name) || localNames.has(name)) return;
    const existing = captures.get(name);
    if (existing) existing.mutated ||= mutated;
    else captures.set(name, { name, location, mutated });
  };
  const expression = (value: Expression, localNames: ReadonlySet<string>, mutated = false): void => {
    switch (value.kind) {
      case "number": case "string": case "boolean": case "null": case "dynamicArrayExpression": return;
      case "identifier": record(value.name, value.location, localNames, mutated); return;
      case "argumentReference": record(value.name, value.location, localNames, true); return;
      case "template": for (const part of value.parts) if (part.kind === "value") expression(part.expression, localNames); return;
      case "unary": expression(value.operand, localNames); return;
      case "binary": expression(value.left, localNames); expression(value.right, localNames); return;
      case "conditional": expression(value.condition, localNames); expression(value.thenExpression, localNames); expression(value.elseExpression, localNames); return;
      case "new": for (const argument of value.arguments) expression(argument, localNames); return;
      case "weak": case "attempt": case "try": case "await": case "spawn": expression(value.expression, localNames); return;
      case "closure": return;
      case "call": expression(value.callee, localNames); for (const argument of value.arguments) expression(argument, localNames); return;
      case "member": expression(value.object, localNames, mutated); return;
      case "index": expression(value.object, localNames, mutated); expression(value.index, localNames); return;
      case "arrayExpression": for (const element of value.elements) expression(element, localNames); return;
      case "structExpression": case "objectExpression": for (const field of value.fields) expression(field.expression, localNames); return;
      case "variantExpression": expression(value.payload, localNames); return;
      case "executorPlacement": statement(value.body, new Set(localNames)); return;
      case "matchExpression":
        expression(value.expression, localNames);
        for (const arm of value.arms) {
          const names = new Set(localNames);
          if (arm.binding) names.add(arm.binding);
          for (const field of arm.objectBindings ?? []) names.add(field.bindingName);
          statement(arm.body, names);
        }
        return;
      case "ifExpression":
        expression(value.condition, localNames);
        statement(value.thenBranch, new Set(localNames));
        if (value.elseBranch.kind === "ifExpression") expression(value.elseBranch, new Set(localNames));
        else statement(value.elseBranch, new Set(localNames));
        return;
    }
  };
  const statements = (values: readonly Statement[], localNames: Set<string>): void => {
    for (const value of values) {
      if (value.kind === "variable") {
        if (value.initializer) expression(value.initializer, localNames);
        localNames.add(value.name);
      } else statement(value, localNames);
    }
  };
  const statement = (value: Statement, localNames: Set<string>): void => {
    switch (value.kind) {
      case "variable": if (value.initializer) expression(value.initializer, localNames); localNames.add(value.name); return;
      case "assignment": expression(value.target, localNames, true); expression(value.expression, localNames); return;
      case "return": if (value.expression) expression(value.expression, localNames); return;
      case "throw": case "select": case "expressionStatement": expression(value.expression, localNames); return;
      case "block": statements(value.statements, new Set(localNames)); return;
      case "if": expression(value.condition, localNames); statement(value.thenBranch, new Set(localNames)); if (value.elseBranch) statement(value.elseBranch, new Set(localNames)); return;
      case "while": expression(value.condition, localNames); statement(value.body, new Set(localNames)); return;
      case "for": { expression(value.iterable, localNames); const names = new Set(localNames); names.add(value.binding); statement(value.body, names); return; }
      case "match":
        expression(value.expression, localNames);
        for (const arm of value.arms) {
          const names = new Set(localNames);
          if (arm.binding) names.add(arm.binding);
          for (const field of arm.objectBindings ?? []) names.add(field.bindingName);
          statement(arm.body, names);
        }
        return;
      case "asyncScope": statement(value.body, new Set(localNames)); return;
      case "break": case "continue": return;
    }
  };
  statements(body.statements, new Set());
  return [...captures.values()];
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

function placementContainsAsyncWork(statement: Statement): boolean {
  if (statementContainsAwait(statement)) return true;
  const expressionHasSpawn = (value: Expression): boolean => {
    if (value.kind === "spawn" || (value.kind === "executorPlacement" && value.mode !== "sync")) return true;
    switch (value.kind) {
      case "weak": case "attempt": case "try": case "await": return expressionHasSpawn(value.expression);
      case "unary": return expressionHasSpawn(value.operand);
      case "binary": return expressionHasSpawn(value.left) || expressionHasSpawn(value.right);
      case "conditional": return expressionHasSpawn(value.condition) || expressionHasSpawn(value.thenExpression) || expressionHasSpawn(value.elseExpression);
      case "call": return expressionHasSpawn(value.callee) || value.arguments.some(expressionHasSpawn);
      case "member": return expressionHasSpawn(value.object);
      case "index": return expressionHasSpawn(value.object) || expressionHasSpawn(value.index);
      case "new": return value.arguments.some(expressionHasSpawn);
      case "template": return value.parts.some((part) => part.kind === "value" && expressionHasSpawn(part.expression));
      case "arrayExpression": return value.elements.some(expressionHasSpawn);
      case "structExpression": case "objectExpression": return value.fields.some((field) => expressionHasSpawn(field.expression));
      case "variantExpression": return expressionHasSpawn(value.payload);
      default: return false;
    }
  };
  switch (statement.kind) {
    case "variable": return Boolean(statement.initializer && expressionHasSpawn(statement.initializer));
    case "assignment": return expressionHasSpawn(statement.target) || expressionHasSpawn(statement.expression);
    case "return": return Boolean(statement.expression && expressionHasSpawn(statement.expression));
    case "throw": case "select": case "expressionStatement": return expressionHasSpawn(statement.expression);
    case "block": return statement.statements.some(placementContainsAsyncWork);
    case "if": return expressionHasSpawn(statement.condition) || placementContainsAsyncWork(statement.thenBranch)
      || Boolean(statement.elseBranch && placementContainsAsyncWork(statement.elseBranch));
    case "while": return expressionHasSpawn(statement.condition) || placementContainsAsyncWork(statement.body);
    case "for": return expressionHasSpawn(statement.iterable) || placementContainsAsyncWork(statement.body);
    case "match": return expressionHasSpawn(statement.expression) || statement.arms.some((arm) => placementContainsAsyncWork(arm.body));
    case "asyncScope": return placementContainsAsyncWork(statement.body);
    case "break": case "continue": return false;
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
    unsupported(fileName, expression.location, "spawn lowering requires a direct async call");
  }
  if (types.semanticInfo.standardFunctionReferences.get(expression.expression.callee.location.offset) === "delay") {
    unsupported(
      fileName,
      expression.location,
      "spawning the delay intrinsic is not executable yet",
      "await `delay(...)` directly, or spawn an async function that awaits it",
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
    placement: null,
  };
}

function placementSpawnSite(
  index: number,
  scope: number,
  expression: Extract<Expression, { kind: "executorPlacement" }>,
  binding: string | null,
  locals: ReadonlyMap<string, string>,
  registerPlacement: (
    expression: Extract<Expression, { kind: "executorPlacement" }>,
    locals: ReadonlyMap<string, string>,
    fromNativeThread: boolean,
  ) => PlacementTarget,
  fromNativeThread: boolean,
): SpawnSite {
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
  unsupported(fileName, call.location, "async lowering could not resolve the async call");
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
  if (site.intrinsic === "cancel") return "void";
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
            "await inside short-circuit logic needs branch-aware expression lowering",
            "bind the awaited operand first; lazy `&&` and `||` suspension lowering is a following tier",
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
            "await inside a conditional expression needs selected-branch suspension lowering",
            "use an awaited `if` statement for now; ternary and value-producing-if suspension will preserve lazy branch evaluation",
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
  fileName: string,
): string {
  const usesDelay = plans.some((plan) => [...plan.awaits.values()].some((site) => site.intrinsic === "delay"));
  const usesThreads = plans.some((plan) => [...plan.spawns.values()].some((site) => site.nativeThread));
  const usesMainPlacement = plans.some((plan) => (
    [...plan.awaits.values()].some((site) => site.placement !== null)
    || [...plan.spawns.values()].some((site) => site.placement !== null)
  ));
  const usesDarwinMainLoop = usesThreads && usesMainPlacement;
  const usesNativeFrameStorage = plans.some((plan) => (
    requiresNativeFramePlacement(plan.declaration.returnType.name, plan.types)
    || Boolean(plan.declaration.errorType && requiresNativeFramePlacement(plan.declaration.errorType.name, plan.types))
    || [...plan.locals].some(([name, type]) => (
      !plan.borrowedLocals.has(name) && requiresNativeFramePlacement(type, plan.types)
    ))
    || [...plan.suspensions.values()].some((site) => requiresNativeFramePlacement(site.type, plan.types))
  ));
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
    "struct Z_AsyncTask {",
    "  void (*poll)(Z_AsyncTask *task);",
    "  bool completed;",
    "  bool queued;",
    "  bool suspended;",
    "  bool cancellation_requested;",
    "  bool cancelled;",
    "  bool timer_scheduled;",
    "  bool native_thread;",
    "  bool thread_joined;",
    "  bool native_body_completed;",
    "  bool native_thread_finished;",
    "  uint64_t wake_at_ms;",
    "  Z_AsyncTask *waiter;",
    "  Z_AsyncTask *next;",
    "  Z_AsyncTask *timer_next;",
    "  Z_AsyncExecutor *executor;",
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
    "  Z_AsyncTask *head;",
    "  Z_AsyncTask *tail;",
    "  Z_AsyncTask *timers;",
    ...(usesThreads ? [
      "  Z_AsyncTask *thread_completions;",
      "  Z_AsyncTask *thread_enqueued_head;",
      "  Z_AsyncTask *thread_enqueued_tail;",
      "  size_t active_native_threads;",
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
    "static __attribute__((unused)) bool z_async_is_completed(Z_AsyncTask *task) {",
    ...(usesThreads ? [
      "  if (task->native_thread) return __atomic_load_n(&task->completed, __ATOMIC_ACQUIRE);",
    ] : []),
    "  return task->completed;",
    "}",
    "",
    "static __attribute__((unused)) bool z_async_is_cancellation_requested(Z_AsyncTask *task) {",
    ...(usesThreads ? [
      "  if (task->native_thread) return __atomic_load_n(&task->cancellation_requested, __ATOMIC_ACQUIRE);",
    ] : []),
    "  return task->cancellation_requested;",
    "}",
    "",
    "static __attribute__((unused)) void z_async_complete_task(Z_AsyncTask *task) {",
    ...(usesThreads ? [
      "  if (task->native_thread) {",
      "    task->native_body_completed = true;",
      "    if (task->native_thread_finished) __atomic_store_n(&task->completed, true, __ATOMIC_RELEASE);",
      "    return;",
      "  }",
    ] : []),
    "  task->completed = true;",
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
      "static void z_async_executor_init(Z_AsyncExecutor *executor) {",
      "  executor->head = NULL;",
      "  executor->tail = NULL;",
      "  executor->timers = NULL;",
      "  executor->thread_completions = NULL;",
      "  executor->thread_enqueued_head = NULL;",
      "  executor->thread_enqueued_tail = NULL;",
      "  executor->active_native_threads = 0;",
      "#if defined(_WIN32)",
      "  InitializeCriticalSection(&executor->thread_mutex);",
      "  InitializeConditionVariable(&executor->thread_condition);",
      "#else",
      "  if (pthread_mutex_init(&executor->thread_mutex, NULL) != 0) abort();",
      "  if (pthread_cond_init(&executor->thread_condition, NULL) != 0) abort();",
      "#endif",
      ...(usesDarwinMainLoop ? [
        "#if defined(__APPLE__)",
        "  executor->main_run_loop = CFRunLoopGetMain();",
        "  CFRetain(executor->main_run_loop);",
        "  CFRunLoopSourceContext source_context = { 0 };",
        "  source_context.info = executor;",
        "  source_context.perform = z_async_main_source_perform;",
        "  executor->main_source = CFRunLoopSourceCreate(NULL, 0, &source_context);",
        "  if (executor->main_source == NULL) abort();",
        "  CFRunLoopAddSource(executor->main_run_loop, executor->main_source, kCFRunLoopCommonModes);",
        "#endif",
      ] : []),
      "}",
      "",
      "static void z_async_executor_destroy(Z_AsyncExecutor *executor) {",
      "  if (executor->thread_completions != NULL || executor->thread_enqueued_head != NULL) abort();",
      "  if (executor->active_native_threads != 0) abort();",
      ...(usesDarwinMainLoop ? [
        "#if defined(__APPLE__)",
        "  CFRunLoopRemoveSource(executor->main_run_loop, executor->main_source, kCFRunLoopCommonModes);",
        "  CFRelease(executor->main_source);",
        "  CFRelease(executor->main_run_loop);",
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
      "  Z_AsyncExecutor *executor = task->executor;",
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
      "#if defined(_WIN32)",
      "static DWORD WINAPI z_async_native_thread_entry(LPVOID context) {",
      "  Z_AsyncTask *task = (Z_AsyncTask *)context;",
      "  task->poll(task);",
      "  z_async_report_native_completion(task);",
      "  return 0;",
      "}",
      "#else",
      "static void *z_async_native_thread_entry(void *context) {",
      "  Z_AsyncTask *task = (Z_AsyncTask *)context;",
      "  task->poll(task);",
      "  z_async_report_native_completion(task);",
      "  return NULL;",
      "}",
      "#endif",
      "",
      "static void z_async_start_native_thread(Z_AsyncTask *task) {",
      "  task->native_thread = true;",
      "  task->thread_joined = false;",
      "  task->completion_queued = false;",
      "  task->thread_queued = false;",
      "  task->completion_next = NULL;",
      "  task->thread_next = NULL;",
      "  z_async_thread_lock(task->executor);",
      "  task->executor->active_native_threads += 1;",
      "  z_async_thread_unlock(task->executor);",
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
        "  CFRunLoopSourceSignal(executor->main_source);",
        "  CFRunLoopWakeUp(executor->main_run_loop);",
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
      "static void z_async_drain_native_completions(Z_AsyncExecutor *executor) {",
      "  z_async_thread_lock(executor);",
      "  Z_AsyncTask *completed = executor->thread_completions;",
      "  executor->thread_completions = NULL;",
      "  Z_AsyncTask *enqueued = executor->thread_enqueued_head;",
      "  executor->thread_enqueued_head = NULL;",
      "  executor->thread_enqueued_tail = NULL;",
      "  for (Z_AsyncTask *task = completed; task != NULL; task = task->completion_next) {",
      "    task->completion_queued = false;",
      "  }",
      "  z_async_thread_unlock(executor);",
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
    "static bool z_async_run_one(Z_AsyncExecutor *executor) {",
    "  Z_AsyncTask *task = executor->head;",
    "  if (task == NULL) return false;",
    "  executor->head = task->next;",
    "  if (executor->head == NULL) executor->tail = NULL;",
    "  task->queued = false;",
    "  task->next = NULL;",
    "  if (!z_async_is_completed(task)) task->poll(task);",
    "  if (z_async_is_completed(task)) {",
    "    if (task->waiter != NULL) {",
    "      Z_AsyncTask *waiter = task->waiter;",
    "      task->waiter = NULL;",
    "      waiter->suspended = false;",
    "      z_async_enqueue(executor, waiter);",
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
      "static bool z_async_wait_for_work(Z_AsyncExecutor *executor) {",
      "  z_async_thread_lock(executor);",
      "  if (executor->thread_completions == NULL",
      "      && executor->thread_enqueued_head == NULL",
      "      && executor->active_native_threads == 0",
      "      && executor->timers == NULL) {",
      "    z_async_thread_unlock(executor);",
      "    return false;",
      "  }",
      "  if (executor->thread_completions == NULL && executor->thread_enqueued_head == NULL) {",
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
      "  if (task->native_thread) {",
      "    z_async_thread_lock(task->executor);",
      "    if (!__atomic_load_n(&task->completed, __ATOMIC_ACQUIRE)) {",
      "      __atomic_store_n(&task->cancellation_requested, true, __ATOMIC_RELEASE);",
      "    }",
      "    z_async_thread_unlock(task->executor);",
      "    return;",
      "  }",
    ] : []),
    "  if (z_async_is_completed(task)) return;",
    "  task->cancellation_requested = true;",
    ...(usesDelay ? ["  z_async_remove_timer(task);"] : []),
    "  task->suspended = false;",
    "  z_async_enqueue(task->executor, task);",
    "}",
    "",
    "static __attribute__((unused)) bool z_async_wait(Z_AsyncTask *parent, Z_AsyncTask *child) {",
    ...(usesThreads ? [
      "  if (child->native_thread) {",
      "    Z_AsyncExecutor *executor = child->executor;",
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
      "    if (completed) z_async_join_native_thread(child);",
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
      "    if (executor->head == NULL && !z_async_wait_for_work(executor)) abort();",
      "    if (executor->head == NULL) continue;",
    ] : usesDelay ? [
      "    if (executor->head == NULL) z_async_wait_for_timer(executor);",
    ] : []),
    "    if (!z_async_run_one(executor)) abort();",
    "  }",
    "}",
    "",
  ];

  for (const plan of plans) lines.push(`typedef struct ${plan.frameName} ${plan.frameName};`);
  if (plans.length > 0) lines.push("");
  for (const plan of plans) lines.push(generateFrame(plan, planByKey), "");
  for (const plan of plans) lines.push(`static void ${plan.pollName}(Z_AsyncTask *task);`);
  for (const plan of plans) lines.push(`static void ${plan.destroyName}(${plan.frameName} *frame);`);
  for (const plan of plans) lines.push(`${generateStartSignature(plan)};`);
  if (plans.length > 0) lines.push("");
  for (const plan of plans) lines.push(generateDestroy(plan, planByKey), "");
  for (const plan of plans) lines.push(generateStart(plan), "");
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
        ? ["  Z_AsyncExecutor executor;", "  z_async_executor_init(&executor);"]
        : ["  Z_AsyncExecutor executor = { .head = NULL, .tail = NULL, .timers = NULL };"]),
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
  if (plan.declaration.returnType.name !== "void") {
    const type = cFrameType(plan.declaration.returnType.name, plan.types);
    if (requiresNativeFramePlacement(plan.declaration.returnType.name, plan.types)) {
      lines.push(`  alignas(${type}) unsigned char result[sizeof(${type})];`);
    } else {
      lines.push(`  ${cFrameType(plan.declaration.returnType.name, plan.types)} result;`);
    }
    if (hasFrameCleanup(plan.declaration.returnType.name, plan.types)) {
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
  if (
    plan.declaration.returnType.name !== "void"
    && hasFrameCleanup(plan.declaration.returnType.name, plan.types)
  ) {
    lines.push(
      "  if (frame->live_result) {",
      `    ${frameCleanup(frameResultValue("frame", plan.declaration.returnType.name, plan.types), plan.declaration.returnType.name, plan.types)}`,
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
    "  frame->task.cancelled = false;",
    "  frame->task.timer_scheduled = false;",
    "  frame->task.native_thread = false;",
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
  if (plan.declaration.errorType) {
    lines.push("  frame->failed = false;");
    if (hasFrameCleanup(plan.declaration.errorType.name, plan.types)) lines.push("  frame->live_error = false;");
  }
  if (
    plan.declaration.returnType.name !== "void"
    && hasFrameCleanup(plan.declaration.returnType.name, plan.types)
  ) lines.push("  frame->live_result = false;");
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
  lines.push("  return frame;", "}");
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
    let value = emitFrameExpression(argument, parent, fileName);
    if (site.placement && argument.kind === "identifier" && parameter?.mode === "value") {
      const type = parent.locals.get(argument.name);
      if (type === "String") {
        value = `z_string_copy_bytes(${value}, 0, (${value}).length)`;
      } else if (type && parent.types.structs.get(type)?.kind === "class") {
        value = `Z_${type}_retain(${value})`;
      }
    }
    if (parameter && parseSliceType(parameter.type.name)) {
      return emitFrameSliceConversion(argument, value, parent, fileName) ?? value;
    }
    if (site.nativeThread && argument.kind === "identifier" && parameter?.mode === "value") {
      const type = parent.locals.get(argument.name);
      if (type && hasFrameCleanup(type, parent.types)) {
        const liveFlag = `frame->${frameLiveField(argument.name)}`;
        return requiresNativeFramePlacement(type, parent.types)
          ? frameTakeExpression(value, liveFlag)
          : `(${liveFlag} = false, ${value})`;
      }
    }
    if (parameter?.mode !== "in" && parameter?.mode !== "inout" && parameter?.mode !== "out") return value;
    return parameter.mode === "in" && parent.types.structs.get(parameter.type.name)?.kind === "class"
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
  if ("placement" in site && site.placement === "sync") {
    return [
      `${child}->task.poll(&${child}->task);`,
      `if (!z_async_is_completed(&${child}->task)) abort();`,
    ];
  }
  if ("placement" in site && site.placement && parent.nativeThread) {
    return [`z_async_enqueue_from_thread(frame->task.executor, &${child}->task);`];
  }
  return [`z_async_enqueue(frame->task.executor, &${child}->task);`];
}

function generatePoll(
  plan: AsyncFunctionPlan,
  planByKey: ReadonlyMap<string, AsyncFunctionPlan>,
  fileName: string,
): string {
  const cases: string[] = [];
  const labels = new Map<number, number>();
  let state = 0;
  const emitNestedAwaits = (expression: Expression): void => {
    for (const nested of plan.nestedAwaits.get(expression.location.offset) ?? []) {
      const site = nested.await;
      if (site.intrinsic === "delay") {
        unsupported(fileName, nested.expression.location, "a void delay cannot be embedded in a value expression");
      }
      if (!site.spawn) {
        const target = planByKey.get(targetKey(site.target))!;
        const arguments_ = emitAwaitArguments(site, plan, fileName);
        cases.push(caseBlock(state, [
          `frame->child_${site.index} = ${target.startName}(${["frame->task.executor", ...arguments_].join(", ")});`,
          ...schedulePlacedChild(site, plan, `frame->child_${site.index}`),
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
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
    if (operation.kind === "scopeExit") {
      for (const site of [...plan.spawns.values()].filter((candidate) => candidate.scope === operation.scope)) {
        const target = planByKey.get(targetKey(site.target))!;
        const child = `frame->child_${site.index}`;
        cases.push(caseBlock(state, [
          `if (${child} != NULL) {`,
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
          `frame->child_${site.index} = ${target.startName}(${["frame->task.executor", ...arguments_].join(", ")});`,
          `frame->${frameField(statement.name)} = &frame->child_${site.index}->task;`,
          site.nativeThread
            ? `z_async_start_native_thread(&frame->child_${site.index}->task);`
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
        if (site.intrinsic === "delay" || site.intrinsic === "cancel") {
          unsupported(fileName, statement.location, `the void ${site.intrinsic} operation cannot initialize a binding`);
        }
        if (!site.spawn) {
          const target = planByKey.get(targetKey(site.target))!;
          const arguments_ = emitAwaitArguments(site, plan, fileName);
          cases.push(
            caseBlock(state, [
              `frame->child_${site.index} = ${target.startName}(${["frame->task.executor", ...arguments_].join(", ")});`,
              ...schedulePlacedChild(site, plan, `frame->child_${site.index}`),
              `frame->state = ${state + 1};`,
              "continue;",
            ]),
          );
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
        const value = emitFrameExpression(initializer, plan, fileName);
        const initialize = requiresNativeFramePlacement(type, plan.types)
          ? `new (frame->${frameField(statement.name)}) ${cFrameType(type, plan.types)}(${value});`
          : `frame->${frameField(statement.name)} = ${value};`;
        cases.push(caseBlock(state, [
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
      cases.push(caseBlock(state, [
        `${emitFrameExpression(statement.target, plan, fileName)} = ${emitFrameExpression(statement.expression, plan, fileName)};`,
        `frame->state = ${state + 1};`,
        "continue;",
      ]));
      state += 1;
      continue;
    }
    if (statement.kind === "return") {
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
        if (!site.spawn) {
          const target = planByKey.get(targetKey(site.target))!;
          const arguments_ = emitAwaitArguments(site, plan, fileName);
          cases.push(caseBlock(state, [
            `frame->child_${site.index} = ${target.startName}(${["frame->task.executor", ...arguments_].join(", ")});`,
            ...schedulePlacedChild(site, plan, `frame->child_${site.index}`),
            `frame->state = ${state + 1};`,
            "continue;",
          ]));
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
        if (statement.expression) {
          const value = emitFrameExpression(statement.expression, plan, fileName);
          completion.push(requiresNativeFramePlacement(plan.declaration.returnType.name, plan.types)
            ? `new (frame->result) ${cFrameType(plan.declaration.returnType.name, plan.types)}(${value});`
            : `frame->result = ${value};`);
          if (hasFrameCleanup(plan.declaration.returnType.name, plan.types)) {
            completion.push("frame->live_result = true;");
          }
        }
        cases.push(caseBlock(state, [
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
      const value = emitFrameExpression(statement.expression, plan, fileName);
      const initialize = requiresNativeFramePlacement(errorType, plan.types)
        ? `new (frame->error) ${cFrameType(errorType, plan.types)}(${value});`
        : `frame->error = ${value};`;
      cases.push(caseBlock(state, [
        initialize,
        ...(hasFrameCleanup(errorType, plan.types) ? ["frame->live_error = true;"] : []),
        "frame->failed = true;",
        "frame->cancel_children = true;",
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
          `frame->child_${site.index} = ${target.startName}(${["frame->task.executor", ...arguments_].join(", ")});`,
          site.nativeThread
            ? `z_async_start_native_thread(&frame->child_${site.index}->task);`
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
      const operation = awaitOperation(statement.expression)!;
      if (!operation) {
        cases.push(caseBlock(state, [
          `(void)${emitFrameExpression(statement.expression, plan, fileName)};`,
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
      if (!site.spawn) {
        const target = planByKey.get(targetKey(site.target))!;
        const arguments_ = emitAwaitArguments(site, plan, fileName);
        cases.push(caseBlock(state, [
          `frame->child_${site.index} = ${target.startName}(${["frame->task.executor", ...arguments_].join(", ")});`,
          ...schedulePlacedChild(site, plan, `frame->child_${site.index}`),
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
        state += 1;
      }
      cases.push(caseBlock(state, awaitCompletion(site, plan, null, null, false, state + 1)));
      state += 1;
    }
  }
  if (plan.declaration.returnType.name === "void" && !endsWithTermination(plan.declaration.body)) {
    cases.push(caseBlock(state, [
      ...(plan.declaration.errorType ? ["frame->failed = false;"] : []),
      `frame->state = ${finalizeStateMarker};`,
      "continue;",
    ]));
    state += 1;
  }
  const finalizeState = state;
  for (const [index, childTarget] of plan.children) {
    const target = planByKey.get(targetKey(childTarget))!;
    const site = [...plan.spawns.values()].find((candidate) => candidate.index === index);
    const child = `frame->child_${index}`;
    cases.push(caseBlock(state, [
      `if (${child} != NULL) {`,
      `  if (frame->cancel_children) z_async_cancel(&${child}->task);`,
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
                `  ${frameCleanup(frameStoredValue(name, type, plan.types), type, plan.types)}`,
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

function awaitCompletion(
  site: AwaitSite,
  parent: AsyncFunctionPlan,
  destination: string | null,
  destinationType: string | null,
  terminal: boolean,
  nextState: number,
): string[] {
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
      const initialized = payload === null ? "" : `, .data.${variant} = ${payload}`;
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
  emitFrameExpression(expression, { locals, types, suspensions }, fileName);
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
  switch (expression.kind) {
    case "number":
      return expression.value;
    case "boolean":
      return expression.value ? "true" : "false";
    case "null":
      return "NULL";
    case "string": {
      const type = plan.types.semanticInfo.expressionTypes.get(expression.location.offset);
      return type === "String"
        ? `(Z_String){ .data = ${JSON.stringify(expression.value)}, .length = sizeof(${JSON.stringify(expression.value)}) - 1, .capacity = 0 }`
        : JSON.stringify(expression.value);
    }
    case "identifier":
      if (plan.bindings?.has(expression.name)) {
        const value = plan.bindings.get(expression.name)!;
        const type = plan.locals.get(expression.name);
        return type
          && plan.types.semanticInfo.movedExpressions.has(expression.location.offset)
          && requiresNativeFramePlacement(type, plan.types)
          ? `std::move(${value})`
          : value;
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
          && plan.types.structs.get(type)?.kind === "class"
        ) {
          return `Z_${type}_retain(${value})`;
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
      const ownerType = frameExpressionType(expression.object, plan);
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
      if (ownerType === "String" || ownerType === "TextBuffer") {
        const owner = emitFrameExpression(expression.object, plan, fileName);
        if (expression.property === "byteLength") return `((${owner}).length)`;
        if (expression.property === "isEmpty") return `((${owner}).length == 0)`;
      }
      const access = plan.types.structs.get(ownerType)?.kind === "class" ? "->" : ".";
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
        if (declaration && !declaration.async) {
          return `${declaration.name}(${emitSyncCallArguments(expression, plan, fileName).join(", ")})`;
        }
      }
      unsupported(fileName, expression.location, "only aggregate construction is executable as a synchronous async-frame call yet");
    }
    case "new": {
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

function borrowedFrameType(type: string, types: AsyncTypeContext, mutable = false): string {
  const cType = cFrameType(type, types);
  return types.structs.get(type)?.kind === "class" ? cType : `${mutable ? "" : "const "}${cType} *`;
}

function borrowedFrameValue(name: string, type: string, types: AsyncTypeContext): string {
  const field = `frame->${frameField(name)}`;
  return types.structs.get(type)?.kind === "class" ? field : `(*${field})`;
}

function isSupportedFrameType(type: string, types: AsyncTypeContext, visiting = new Set<string>()): boolean {
  if (parseTaskType(type)) return true;
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
  if (type === "String" || type === "TextBuffer") return true;
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
  if (requiresNativeFramePlacement(type, types)) {
    const managed = frameManagedCleanup(value, type, types);
    const native = `std::destroy_at(&(${value}));`;
    return managed ? `${managed}\n${native}` : native;
  }
  if (type === "String" || type === "TextBuffer") {
    return `if ((${value}).capacity > 0) free((void *)(${value}).data);`;
  }
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
  const initialized = payload === null ? "" : `, .data.${variant} = ${payload}`;
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
    notes: ["Phase 1 executes owned task frames, synchronous calls and console output, FIFO scheduling, scoped spawn, cancellation, and timer delay"],
    helps: [help],
  });
}
