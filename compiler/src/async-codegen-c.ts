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
import { resultTypeName } from "./results.ts";
import { standardFunctionSignature } from "./standard-library.ts";
import type { IntegerOperation, SemanticInfo } from "./sema.ts";

type AwaitSite = {
  readonly index: number;
  readonly mode: "await" | "try" | "attempt";
  readonly intrinsic: "delay" | null;
  readonly expression: Extract<Expression, { kind: "await" }>;
  readonly call: CallExpression;
  readonly target: AsyncTarget;
  readonly receiver: Expression | null;
  readonly spawn: SpawnSite | null;
};

type SpawnSite = {
  readonly index: number;
  readonly scope: number;
  readonly expression: Extract<Expression, { kind: "spawn" }>;
  readonly call: CallExpression;
  readonly target: AsyncTarget;
  readonly receiver: Expression | null;
  readonly binding: string | null;
};

type AsyncOperation =
  | { readonly kind: "statement"; readonly statement: Statement }
  | { readonly kind: "scopeExit"; readonly scope: number };

type AsyncTarget = {
  readonly declaration: FunctionDeclaration;
  readonly owner: StructDeclaration | null;
};

type AsyncFunctionPlan = {
  readonly declaration: FunctionDeclaration;
  readonly owner: StructDeclaration | null;
  readonly frameName: string;
  readonly pollName: string;
  readonly startName: string;
  readonly destroyName: string;
  readonly operations: readonly AsyncOperation[];
  readonly locals: ReadonlyMap<string, string>;
  readonly awaits: ReadonlyMap<number, AwaitSite>;
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
  readonly types: AsyncTypeContext;
  readonly bindings?: ReadonlyMap<string, string>;
};

export type AsyncCGeneration = {
  readonly synchronousProgram: Program;
  readonly source: string;
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
  ["bool", "bool"],
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
  const targets: AsyncTarget[] = [
    ...program.functions.filter((declaration) => declaration.async).map((declaration) => ({
      declaration,
      owner: null,
    })),
    ...program.structs.flatMap((owner) => owner.methods.filter((method) => method.async).map((declaration) => ({
      declaration,
      owner,
    }))),
  ];
  const functions = new Map(
    targets.filter((target) => !target.owner).map((target) => [target.declaration.name, target]),
  );
  const types: AsyncTypeContext = {
    structs: new Map(program.structs.map((declaration) => [declaration.name, declaration])),
    enums: new Map(program.enums.map((declaration) => [declaration.name, declaration])),
    functions: new Map(program.functions.map((declaration) => [declaration.name, declaration])),
    semanticInfo,
  };
  const plans = targets.map((target) => planFunction(target, functions, fileName, semanticInfo, types));
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

  return {
    synchronousProgram,
    source: generateRuntime(plans, planByKey, main, fileName),
  };
}

function planFunction(
  target: AsyncTarget,
  functions: ReadonlyMap<string, AsyncTarget>,
  fileName: string,
  semanticInfo: SemanticInfo,
  types: AsyncTypeContext,
): AsyncFunctionPlan {
  const { declaration, owner } = target;
  requireFrameType(declaration.returnType.name, declaration.returnType.location, fileName, "async return", types);
  if (declaration.errorType) {
    requireFrameType(declaration.errorType.name, declaration.errorType.location, fileName, "async error", types);
  }
  const locals = new Map<string, string>();
  if (owner && !declaration.static) {
    requireFrameType(owner.name, declaration.location, fileName, "async receiver", types);
    locals.set("this", owner.name);
  }
  for (const parameter of declaration.parameters) {
    if (parameter.mode !== "value") {
      unsupported(fileName, parameter.location, "borrowed async parameters are not executable yet");
    }
    requireFrameType(parameter.type.name, parameter.type.location, fileName, "async parameter", types);
    locals.set(parameter.name, parameter.type.name);
  }

  const awaits = new Map<number, AwaitSite>();
  const spawns = new Map<number, SpawnSite>();
  const spawnBindings = new Map<string, SpawnSite>();
  const children = new Map<number, AsyncTarget>();
  const joinedSpawns = new Set<number>();
  const nextChild = { value: 0 };
  const nextScope = { value: 1 };
  const operations: AsyncOperation[] = [];
  const recordAwait = (
    mode: AwaitSite["mode"],
    expression: Extract<Expression, { kind: "await" }>,
  ): void => {
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
    );
    awaits.set(expression.location.offset, site);
    if (!site.intrinsic) children.set(site.index, site.target);
  };
  const planStatements = (statements: readonly Statement[], scope: number): void => {
    for (const statement of statements) {
      if (statement.kind === "asyncScope") {
        const childScope = nextScope.value++;
        planStatements(statement.body.statements, childScope);
        operations.push({ kind: "scopeExit", scope: childScope });
        continue;
      }
      operations.push({ kind: "statement", statement });
      if (statement.kind === "variable") {
        if (!statement.initializer) {
          unsupported(fileName, statement.location, "uninitialized async frame locals are not executable yet");
        }
        if (scope !== 0 && statement.initializer.kind !== "spawn") {
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
        locals.set(statement.name, type);
        if (statement.initializer.kind === "spawn") {
          const site = spawnSite(
            nextChild.value++,
            scope,
            statement.initializer,
            statement.name,
            functions,
            fileName,
            locals,
            types,
          );
          spawns.set(statement.initializer.location.offset, site);
          spawnBindings.set(statement.name, site);
          children.set(site.index, site.target);
          continue;
        }
        const operation = awaitOperation(statement.initializer);
        if (operation) {
          recordAwait(operation.mode, operation.expression);
        } else if (statement.initializer.kind === "matchExpression") {
          validateAsyncMatchExpression(statement.initializer, locals, fileName, types);
        } else {
          validateFrameExpression(statement.initializer, locals, fileName, types);
        }
        continue;
      }
      if (statement.kind === "return") {
        const operation = statement.expression ? awaitOperation(statement.expression) : null;
        if (operation) {
          recordAwait(operation.mode, operation.expression);
        } else if (statement.expression?.kind === "matchExpression") {
          validateAsyncMatchExpression(statement.expression, locals, fileName, types);
        } else if (statement.expression) {
          validateFrameExpression(statement.expression, locals, fileName, types);
        }
        continue;
      }
      if (statement.kind === "throw") {
        validateFrameExpression(statement.expression, locals, fileName, types);
        continue;
      }
      if (statement.kind === "expressionStatement") {
        if (statement.expression.kind === "spawn") {
          const site = spawnSite(
            nextChild.value++,
            scope,
            statement.expression,
            null,
            functions,
            fileName,
            locals,
            types,
          );
          spawns.set(statement.expression.location.offset, site);
          children.set(site.index, site.target);
          continue;
        }
        if (
          statement.expression.kind === "call"
          && semanticInfo.consoleCalls.has(statement.expression.location.offset)
        ) {
          validateAsyncConsoleCall(statement.expression, locals, fileName, types);
          continue;
        }
        const operation = awaitOperation(statement.expression);
        if (operation) {
          recordAwait(operation.mode, operation.expression);
          continue;
        }
        if (statement.expression.kind === "call") {
          validateFrameExpression(statement.expression, locals, fileName, types);
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
    frameName: `Z_AsyncFrame_${part}`,
    pollName: `z_async_poll_${part}`,
    startName: `z_async_start_${part}`,
    destroyName: `z_async_destroy_${part}`,
    operations,
    locals,
    awaits,
    spawns,
    children,
    types,
  };
}

function awaitSite(
  mode: AwaitSite["mode"],
  expression: Extract<Expression, { kind: "await" }>,
  functions: ReadonlyMap<string, AsyncTarget>,
  fileName: string,
  locals: ReadonlyMap<string, string>,
  types: AsyncTypeContext,
  spawnBindings: ReadonlyMap<string, SpawnSite>,
  joinedSpawns: Set<number>,
  nextChild: { value: number },
): AwaitSite {
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
  readonly expression: Extract<Expression, { kind: "await" }>;
} | null {
  if (expression.kind === "await") return { mode: "await", expression };
  if ((expression.kind === "try" || expression.kind === "attempt") && expression.expression.kind === "await") {
    return { mode: expression.kind, expression: expression.expression };
  }
  return null;
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
  const lines = [
    "/* Z async Phase 1: FIFO-scheduled ownership-aware task frames. */",
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
    "  uint64_t wake_at_ms;",
    "  Z_AsyncTask *waiter;",
    "  Z_AsyncTask *next;",
    "  Z_AsyncTask *timer_next;",
    "  Z_AsyncExecutor *executor;",
    "};",
    "",
    "struct Z_AsyncExecutor {",
    "  Z_AsyncTask *head;",
    "  Z_AsyncTask *tail;",
    "  Z_AsyncTask *timers;",
    "};",
    "",
    "static __attribute__((unused)) void z_async_enqueue(Z_AsyncExecutor *executor, Z_AsyncTask *task) {",
    "  if (task->completed || task->queued || task->suspended) return;",
    "  task->queued = true;",
    "  task->next = NULL;",
    "  if (executor->tail != NULL) executor->tail->next = task;",
    "  else executor->head = task;",
    "  executor->tail = task;",
    "}",
    "",
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
    "static __attribute__((unused)) void z_async_cancel(Z_AsyncTask *task) {",
    "  if (task->completed) return;",
    "  task->cancellation_requested = true;",
    ...(usesDelay ? ["  z_async_remove_timer(task);"] : []),
    "  task->suspended = false;",
    "  z_async_enqueue(task->executor, task);",
    "}",
    "",
    "static __attribute__((unused)) bool z_async_wait(Z_AsyncTask *parent, Z_AsyncTask *child) {",
    "  if (child->completed) return true;",
    "  if (child->waiter != NULL && child->waiter != parent) abort();",
    "  child->waiter = parent;",
    "  parent->suspended = true;",
    "  return false;",
    "}",
    "",
    "static __attribute__((unused)) void z_async_run(Z_AsyncTask *root) {",
    "  Z_AsyncExecutor *executor = root->executor;",
    "  z_async_enqueue(executor, root);",
    "  while (!root->completed) {",
    ...(usesDelay ? [
      "    z_async_release_timers(executor);",
      "    if (executor->head == NULL) z_async_wait_for_timer(executor);",
    ] : []),
    "    Z_AsyncTask *task = executor->head;",
    "    if (task == NULL) abort();",
    "    executor->head = task->next;",
    "    if (executor->head == NULL) executor->tail = NULL;",
    "    task->queued = false;",
    "    task->next = NULL;",
    "    if (!task->completed) task->poll(task);",
    "    if (task->completed) {",
    "      if (task->waiter != NULL) {",
    "        Z_AsyncTask *waiter = task->waiter;",
    "        task->waiter = NULL;",
    "        waiter->suspended = false;",
    "        z_async_enqueue(executor, waiter);",
    "      }",
    "    } else if (!task->suspended) {",
    "      z_async_enqueue(executor, task);",
    "    }",
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
    lines.push(
      "int32_t main(void) {",
      "  Z_AsyncExecutor executor = { .head = NULL, .tail = NULL, .timers = NULL };",
      `  ${main.frameName} *root = ${main.startName}(&executor);`,
      "  z_async_run(&root->task);",
      ...(main.declaration.errorType
        ? [
            "  if (root->failed) {",
            `    ${main.destroyName}(root);`,
            "    free(root);",
            "    return 1;",
            "  }",
          ]
        : []),
      "  int32_t result = root->result;",
      `  ${main.destroyName}(root);`,
      "  free(root);",
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
    lines.push(`  ${cFrameType(plan.declaration.returnType.name, plan.types)} result;`);
    if (hasFrameCleanup(plan.declaration.returnType.name, plan.types)) {
      lines.push("  bool live_result;");
    }
  }
  if (plan.declaration.errorType) {
    lines.push("  bool failed;");
    lines.push(`  ${cFrameType(plan.declaration.errorType.name, plan.types)} error;`);
  }
  for (const [name, type] of plan.locals) {
    lines.push(`  ${cFrameType(type, plan.types)} ${frameField(name)};`);
    if (hasFrameCleanup(type, plan.types)) lines.push(`  bool ${frameLiveField(name)};`);
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
      `    ${frameCleanup("frame->result", plan.declaration.returnType.name, plan.types)}`,
      "    frame->live_result = false;",
      "  }",
    );
  }
  for (const [name, type] of [...plan.locals].reverse()) {
    if (!hasFrameCleanup(type, plan.types)) continue;
    lines.push(
      `  if (frame->${frameLiveField(name)}) {`,
      `    ${frameCleanup(`frame->${frameField(name)}`, type, plan.types)}`,
      `    frame->${frameLiveField(name)} = false;`,
      "  }",
    );
  }
  lines.push("}");
  return lines.join("\n");
}

function generateStartSignature(plan: AsyncFunctionPlan): string {
  const parameters = ["Z_AsyncExecutor *executor", ...frameInputs(plan).map((input) => (
    `${cFrameType(input.type, plan.types)} ${frameField(input.name)}`
  ))];
  return `static __attribute__((unused)) ${plan.frameName} *${plan.startName}(${parameters.join(", ")})`;
}

function generateStart(plan: AsyncFunctionPlan): string {
  const lines = [
    `${generateStartSignature(plan)} {`,
    `  ${plan.frameName} *frame = (${plan.frameName} *)malloc(sizeof(${plan.frameName}));`,
    "  if (frame == NULL) abort();",
    `  frame->task.poll = ${plan.pollName};`,
    "  frame->task.completed = false;",
    "  frame->task.cancellation_requested = false;",
    "  frame->task.cancelled = false;",
    "  frame->task.timer_scheduled = false;",
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
  if (plan.declaration.errorType) lines.push("  frame->failed = false;");
  if (
    plan.declaration.returnType.name !== "void"
    && hasFrameCleanup(plan.declaration.returnType.name, plan.types)
  ) lines.push("  frame->live_result = false;");
  const parameters = new Set(frameInputs(plan).map((input) => input.name));
  for (const [name, type] of plan.locals) {
    if (hasFrameCleanup(type, plan.types)) {
      lines.push(`  frame->${frameLiveField(name)} = ${parameters.has(name) ? "true" : "false"};`);
    }
  }
  for (const input of frameInputs(plan)) {
    const name = frameField(input.name);
    lines.push(`  frame->${name} = ${name};`);
  }
  for (const index of plan.children.keys()) lines.push(`  frame->child_${index} = NULL;`);
  lines.push("  return frame;", "}");
  return lines.join("\n");
}

function frameInputs(plan: AsyncFunctionPlan): readonly { readonly name: string; readonly type: string }[] {
  return [
    ...(plan.owner && !plan.declaration.static
      ? [{ name: "this", type: plan.owner.name }]
      : []),
    ...plan.declaration.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type.name,
    })),
  ];
}

function emitAwaitArguments(
  site: Pick<AwaitSite, "receiver" | "target" | "call">,
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
  arguments_.push(...site.call.arguments.map((argument) => (
    emitFrameExpression(argument, parent, fileName)
  )));
  return arguments_;
}

function generatePoll(
  plan: AsyncFunctionPlan,
  planByKey: ReadonlyMap<string, AsyncFunctionPlan>,
  fileName: string,
): string {
  const cases: string[] = [];
  let state = 0;
  for (const operation of plan.operations) {
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
    if (statement.kind === "variable") {
      const initializer = statement.initializer!;
      if (initializer.kind === "spawn") {
        const site = plan.spawns.get(initializer.location.offset)!;
        const target = planByKey.get(targetKey(site.target))!;
        const arguments_ = emitAwaitArguments(site, plan, fileName);
        cases.push(caseBlock(state, [
          `frame->child_${site.index} = ${target.startName}(${["frame->task.executor", ...arguments_].join(", ")});`,
          `frame->${frameField(statement.name)} = &frame->child_${site.index}->task;`,
          `z_async_enqueue(frame->task.executor, &frame->child_${site.index}->task);`,
          `frame->state = ${state + 1};`,
          "continue;",
        ]));
        state += 1;
        continue;
      }
      const operation = awaitOperation(initializer);
      if (operation) {
        const site = plan.awaits.get(operation.expression.location.offset)!;
        if (site.intrinsic === "delay") {
          unsupported(fileName, statement.location, "the void delay operation cannot initialize a binding");
        }
        if (!site.spawn) {
          const target = planByKey.get(targetKey(site.target))!;
          const arguments_ = emitAwaitArguments(site, plan, fileName);
          cases.push(
            caseBlock(state, [
              `frame->child_${site.index} = ${target.startName}(${["frame->task.executor", ...arguments_].join(", ")});`,
              `z_async_enqueue(frame->task.executor, &frame->child_${site.index}->task);`,
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
        cases.push(caseBlock(state, [
          `frame->${frameField(statement.name)} = ${emitFrameExpression(initializer, plan, fileName)};`,
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
            `z_async_enqueue(frame->task.executor, &frame->child_${site.index}->task);`,
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
      } else {
        const completion = statement.expression
          ? [
              `frame->result = ${emitFrameExpression(statement.expression, plan, fileName)};`,
              ...(hasFrameCleanup(plan.declaration.returnType.name, plan.types)
                ? ["frame->live_result = true;"]
                : []),
            ]
          : [];
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
      cases.push(caseBlock(state, [
        `frame->error = ${emitFrameExpression(statement.expression, plan, fileName)};`,
        "frame->failed = true;",
        "frame->cancel_children = true;",
        `frame->state = ${finalizeStateMarker};`,
        "continue;",
      ]));
      state += 1;
      continue;
    }
    if (statement.kind === "expressionStatement") {
      if (statement.expression.kind === "spawn") {
        const site = plan.spawns.get(statement.expression.location.offset)!;
        const target = planByKey.get(targetKey(site.target))!;
        const arguments_ = emitAwaitArguments(site, plan, fileName);
        cases.push(caseBlock(state, [
          `frame->child_${site.index} = ${target.startName}(${["frame->task.executor", ...arguments_].join(", ")});`,
          `z_async_enqueue(frame->task.executor, &frame->child_${site.index}->task);`,
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
          `z_async_enqueue(frame->task.executor, &frame->child_${site.index}->task);`,
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
  cases.push(caseBlock(state, [
    "frame->task.cancelled = frame->task.cancellation_requested;",
    "frame->task.completed = true;",
    "return;",
  ]));
  const renderedCases = cases
    .map((item) => item.replaceAll(finalizeStateMarker, String(finalizeState)));
  return `static void ${plan.pollName}(Z_AsyncTask *task) {
  ${plan.frameName} *frame = (${plan.frameName} *)task;
  if (frame->task.cancellation_requested) {
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
  const lines = [
    `if (!z_async_wait(&frame->task, &${child}->task)) return;`,
  ];
  if (site.mode === "try") {
    lines.push(
      `if (${child}->failed) {`,
      `  frame->error = ${child}->error;`,
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
    const result = resultTypeName(
      site.target.declaration.returnType.name,
      site.target.declaration.errorType!.name,
    );
    const cResult = resultCName(result);
    lines.push(`if (${child}->failed) {`);
    lines.push(
      `  ${destination} = (${cResult}){ .tag = ${resultTag(result, "failure")}, .data.failure = ${child}->error };`,
      "} else {",
    );
    const successPayload = site.target.declaration.returnType.name === "void"
      ? ""
      : `, .data.success = ${child}->result`;
    lines.push(`  ${destination} = (${cResult}){ .tag = ${resultTag(result, "success")}${successPayload} };`);
    if (hasFrameCleanup(site.target.declaration.returnType.name, parent.types)) {
      lines.push(`  ${child}->live_result = false;`);
    }
    lines.push("}");
  }

  if (site.mode !== "attempt" && destination && site.target.declaration.returnType.name !== "void") {
    lines.push(`${destination} = ${child}->result;`);
    if (hasFrameCleanup(site.target.declaration.returnType.name, parent.types)) {
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
): void {
  inspectAsyncMatchExpression(expression, { locals, types }, fileName);
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
  const lines = [
    `const ${cFrameType(inspected.subjectType, plan.types)} ${temporary} = ${emitFrameExpression(expression.expression, plan, fileName)};`,
    `switch (${temporary}.tag) {`,
  ];
  for (const arm of expression.arms) {
    const variant = inspected.declaration.variants.find((candidate) => candidate.name === arm.variantName)!;
    const armContext = asyncMatchArmContext(arm, variant, temporary, plan);
    const value = emitFrameExpression(asyncMatchArmValue(arm, fileName), armContext, fileName);
    lines.push(
      `  case ${resultTag(inspected.subjectType, variant.name)}: {`,
      `    ${destination} = ${value};`,
      "    break;",
      "  }",
    );
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
  if (hasFrameCleanup(subjectType, plan.types)) {
    unsupported(
      fileName,
      expression.location,
      "matching an ownership-bearing enum inside an async frame has not landed yet",
      "match scalar and plain-data payloads for now; owned payload arm lifetimes are the next ownership tier",
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
    bindings.set(arm.binding, `(${subject}.data.${variant.name})`);
  }
  if (variant.payload && arm.objectBindings) {
    const payload = plan.types.structs.get(variant.payload.name)!;
    const access = payload.kind === "class" ? "->" : ".";
    for (const fieldBinding of arm.objectBindings) {
      const field = payload.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
      locals.set(fieldBinding.bindingName, field.type.name);
      bindings.set(
        fieldBinding.bindingName,
        `((${subject}.data.${variant.name})${access}${field.name})`,
      );
    }
  }
  return { locals, types: plan.types, bindings };
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
): void {
  emitFrameExpression(expression, { locals, types }, fileName);
}

function validateAsyncConsoleCall(
  expression: CallExpression,
  locals: ReadonlyMap<string, string>,
  fileName: string,
  types: AsyncTypeContext,
): void {
  emitAsyncConsoleCall(expression, { locals, types }, fileName);
}

function emitAsyncConsoleCall(
  expression: CallExpression,
  plan: Pick<AsyncFunctionPlan, "locals" | "types">,
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
  return lines;
}

function emitAsyncConsoleValue(
  expression: Expression,
  stream: "stdout" | "stderr",
  plan: Pick<AsyncFunctionPlan, "locals" | "types">,
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
  plan: Pick<AsyncFunctionPlan, "locals" | "types">,
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
  if (type === "bool") return [`fputs((${value}) ? "true" : "false", ${stream});`];
  if (type === "cstring") return [`fputs((${value}) != NULL ? (${value}) : "null", ${stream});`];

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
  switch (expression.kind) {
    case "number":
      return expression.value;
    case "boolean":
      return expression.value ? "true" : "false";
    case "string":
      return JSON.stringify(expression.value);
    case "identifier":
      if (plan.bindings?.has(expression.name)) {
        return plan.bindings.get(expression.name)!;
      }
      if (!plan.locals.has(expression.name)) {
        unsupported(fileName, expression.location, "the first async lowering slice cannot reference this value");
      }
      {
        const value = `frame->${frameField(expression.name)}`;
        if (plan.types.semanticInfo.movedExpressions.has(expression.location.offset)) {
          return `(frame->${frameLiveField(expression.name)} = false, ${value})`;
        }
        const type = plan.locals.get(expression.name)!;
        if (
          plan.types.semanticInfo.managedCopies.has(expression.location.offset)
          && plan.types.structs.get(type)?.kind === "class"
        ) {
          return `Z_${type}_retain(${value})`;
        }
        return value;
      }
    case "unary":
      {
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
        if (!safeBinaryOperators.has(expression.operator)) {
          unsupported(fileName, expression.location, "this arithmetic expression is not executable in an async frame yet");
        }
        return `(${emitFrameExpression(expression.left, plan, fileName)} ${expression.operator} ${emitFrameExpression(expression.right, plan, fileName)})`;
      }
    case "conditional":
      return `(${emitFrameExpression(expression.condition, plan, fileName)} ? ${emitFrameExpression(expression.thenExpression, plan, fileName)} : ${emitFrameExpression(expression.elseExpression, plan, fileName)})`;
    case "member": {
      if (expression.object.kind === "identifier") {
        const enumeration = plan.types.enums.get(expression.object.name);
        const variant = enumeration?.variants.find((candidate) => candidate.name === expression.property);
        if (enumeration && variant && !variant.payload) {
          return `(${resultCName(enumeration.name)}){ .tag = ${resultTag(enumeration.name, variant.name)} }`;
        }
      }
      const ownerType = frameExpressionType(expression.object, plan);
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
      return `(${resultCName(expression.enumName)}){ .tag = ${resultTag(expression.enumName, expression.variantName)}, .data.${expression.variantName} = ${emitFrameExpression(expression.payload, plan, fileName)} }`;
    case "call": {
      const standard = plan.types.semanticInfo.standardFunctionReferences.get(expression.callee.location.offset);
      if (standard) {
        const signature = standardFunctionSignature(standard);
        if (signature.async) {
          unsupported(fileName, expression.location, "an async standard function must be lowered beneath await");
        }
        return `${signature.cName}(${emitSyncCallArguments(expression, plan, fileName).join(", ")})`;
      }
      if (expression.callee.kind === "member" && expression.callee.object.kind === "identifier") {
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
          const payload = variant.payload
            ? `, .data.${variant.name} = ${emitFrameExpression(expression.arguments[0], plan, fileName)}`
            : "";
          return `(${resultCName(enumeration.name)}){ .tag = ${resultTag(enumeration.name, variant.name)}${payload} }`;
        }
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
        if (declaration && !declaration.async && !declaration.errorType) {
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

function emitSyncCallArguments(
  expression: CallExpression,
  plan: Pick<AsyncFunctionPlan, "locals" | "types">,
  fileName: string,
): string[] {
  return expression.arguments.map((argument) => {
    const value = emitFrameExpression(argument, plan, fileName);
    const access = plan.types.semanticInfo.nativeArgumentAccesses.get(argument.location.offset);
    if (!access) return value;
    const type = frameExpressionType(argument, plan);
    if (access === "in" && plan.types.structs.get(type)?.kind === "class") return value;
    return `&(${value})`;
  });
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
  const aggregate = types.structs.get(type);
  if (aggregate) return aggregate.kind === "class" ? `Z_${type} *` : `Z_${type}`;
  if (types.enums.has(type)) return resultCName(type);
  throw new Error(`missing async aggregate ABI type ${JSON.stringify(type)}`);
}

function isSupportedFrameType(type: string, types: AsyncTypeContext, visiting = new Set<string>()): boolean {
  if (parseTaskType(type)) return true;
  if (scalarTypes.has(type)) return true;
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

function frameExpressionType(
  expression: Expression,
  plan: FrameExpressionContext,
): string {
  const analyzed = plan.types.semanticInfo.expressionTypes.get(expression.location.offset);
  if (analyzed) return analyzed;
  if (expression.kind === "identifier") return plan.locals.get(expression.name) ?? "i32";
  if (expression.kind === "new" || expression.kind === "structExpression") return expression.typeName;
  if (expression.kind === "boolean" || expression.kind === "binary" || expression.kind === "unary") return "bool";
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

function destinationLiveFlag(destination: string, plan: AsyncFunctionPlan): string {
  if (destination === "frame->result") return "frame->live_result";
  for (const name of plan.locals.keys()) {
    if (destination === `frame->${frameField(name)}`) return `frame->${frameLiveField(name)}`;
  }
  throw new Error(`missing async live flag destination for ${JSON.stringify(destination)}`);
}

function resultCName(type: string): string {
  return `Z_${nativePart(type.replace(/^__z_/, ""))}`;
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
