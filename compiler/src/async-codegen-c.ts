import type {
  CallExpression,
  Expression,
  FunctionDeclaration,
  Program,
  SourceLocation,
  Statement,
} from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { resultTypeName } from "./results.ts";
import type { SemanticInfo } from "./sema.ts";

type AwaitSite = {
  readonly index: number;
  readonly mode: "await" | "try" | "attempt";
  readonly expression: Extract<Expression, { kind: "await" }>;
  readonly call: CallExpression;
  readonly target: FunctionDeclaration;
};

type AsyncFunctionPlan = {
  readonly declaration: FunctionDeclaration;
  readonly frameName: string;
  readonly pollName: string;
  readonly startName: string;
  readonly locals: ReadonlyMap<string, string>;
  readonly awaits: ReadonlyMap<number, AwaitSite>;
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
]);

const safeBinaryOperators = new Set([
  "==", "!=", "<", "<=", ">", ">=", "&&", "||",
]);

export function generateAsyncC(
  program: Program,
  fileName: string,
  semanticInfo: SemanticInfo,
): AsyncCGeneration {
  const asyncMethods = program.structs.flatMap((owner) => (
    owner.methods.filter((method) => method.async).map((method) => ({ owner: owner.name, method }))
  ));
  if (asyncMethods.length > 0) {
    const first = asyncMethods[0];
    unsupported(
      fileName,
      first.method.location,
      `async method ${JSON.stringify(`${first.owner}.${first.method.name}`)} is not executable in the first Phase 1 slice`,
      "use `z check` for async methods until receiver-aware task frames land",
    );
  }

  const declarations = program.functions.filter((declaration) => declaration.async);
  const functions = new Map(program.functions.map((declaration) => [declaration.name, declaration]));
  const plans = declarations.map((declaration) => planFunction(declaration, functions, fileName, semanticInfo));
  const planByName = new Map(plans.map((plan) => [plan.declaration.name, plan]));
  const main = planByName.get("main");
  if (main) validateAsyncMain(main.declaration, fileName);

  const synchronousProgram: Program = {
    ...program,
    functions: program.functions.filter((declaration) => !declaration.async),
  };

  return {
    synchronousProgram,
    source: generateRuntime(plans, planByName, main, fileName),
  };
}

function planFunction(
  declaration: FunctionDeclaration,
  functions: ReadonlyMap<string, FunctionDeclaration>,
  fileName: string,
  semanticInfo: SemanticInfo,
): AsyncFunctionPlan {
  requireScalar(declaration.returnType.name, declaration.returnType.location, fileName, "async return");
  if (declaration.errorType) {
    requireScalar(declaration.errorType.name, declaration.errorType.location, fileName, "async error");
  }
  const locals = new Map<string, string>();
  for (const parameter of declaration.parameters) {
    if (parameter.mode !== "value") {
      unsupported(fileName, parameter.location, "borrowed async parameters are not executable yet");
    }
    requireScalar(parameter.type.name, parameter.type.location, fileName, "async parameter");
    locals.set(parameter.name, parameter.type.name);
  }

  const awaits = new Map<number, AwaitSite>();
  let awaitIndex = 0;
  for (const statement of declaration.body) {
    if (statement.kind === "variable") {
      if (!statement.initializer) {
        unsupported(fileName, statement.location, "uninitialized async frame locals are not executable yet");
      }
      const type = statement.type?.name ?? semanticInfo.bindingTypes.get(statement.nameLocation.offset);
      if (!type) unsupported(fileName, statement.location, `could not determine async frame type for ${JSON.stringify(statement.name)}`);
      requireFrameType(type, statement.type?.location ?? statement.nameLocation, fileName, "async local");
      locals.set(statement.name, type);
      const operation = awaitOperation(statement.initializer);
      if (operation) {
        awaits.set(
          operation.expression.location.offset,
          awaitSite(awaitIndex++, operation.mode, operation.expression, functions, fileName),
        );
      } else {
        validateScalarExpression(statement.initializer, locals, fileName);
      }
      continue;
    }
    if (statement.kind === "return") {
      const operation = statement.expression ? awaitOperation(statement.expression) : null;
      if (operation) {
        awaits.set(
          operation.expression.location.offset,
          awaitSite(awaitIndex++, operation.mode, operation.expression, functions, fileName),
        );
      } else if (statement.expression) {
        validateScalarExpression(statement.expression, locals, fileName);
      }
      continue;
    }
    if (statement.kind === "throw") {
      validateScalarExpression(statement.expression, locals, fileName);
      continue;
    }
    if (statement.kind === "expressionStatement") {
      const operation = awaitOperation(statement.expression);
      if (!operation) {
        unsupported(fileName, statement.location, "only awaited async calls are executable as async expression statements yet");
      }
      awaits.set(
        operation.expression.location.offset,
        awaitSite(awaitIndex++, operation.mode, operation.expression, functions, fileName),
      );
      continue;
    }
    unsupported(
      fileName,
      statement.location,
      `statement ${JSON.stringify(statement.kind)} is not executable in the first Phase 1 async slice`,
      "the initial state-machine lowering supports scalar bindings, direct sequential await, and return",
    );
  }

  const part = nativePart(declaration.name);
  return {
    declaration,
    frameName: `Z_AsyncFrame_${part}`,
    pollName: `z_async_poll_${part}`,
    startName: `z_async_start_${part}`,
    locals,
    awaits,
  };
}

function awaitSite(
  index: number,
  mode: AwaitSite["mode"],
  expression: Extract<Expression, { kind: "await" }>,
  functions: ReadonlyMap<string, FunctionDeclaration>,
  fileName: string,
): AwaitSite {
  if (expression.expression.kind !== "call" || expression.expression.callee.kind !== "identifier") {
    unsupported(
      fileName,
      expression.location,
      "the first Phase 1 slice awaits direct top-level async calls only",
    );
  }
  const call = expression.expression;
  const target = functions.get(call.callee.name);
  if (!target?.async) {
    unsupported(fileName, expression.location, "async lowering could not resolve the awaited async function");
  }
  return { index, mode, expression, call, target };
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
  planByName: ReadonlyMap<string, AsyncFunctionPlan>,
  main: AsyncFunctionPlan | undefined,
  fileName: string,
): string {
  const lines = [
    "/* Z async Phase 1: stackless scalar task frames. */",
    "typedef struct Z_AsyncTask Z_AsyncTask;",
    "struct Z_AsyncTask {",
    "  void (*poll)(Z_AsyncTask *task);",
    "  bool completed;",
    "};",
    "",
    "static __attribute__((unused)) void z_async_poll_task(Z_AsyncTask *task) {",
    "  if (!task->completed) task->poll(task);",
    "}",
    "",
    "static __attribute__((unused)) void z_async_run(Z_AsyncTask *root) {",
    "  while (!root->completed) z_async_poll_task(root);",
    "}",
    "",
  ];

  for (const plan of plans) lines.push(`typedef struct ${plan.frameName} ${plan.frameName};`);
  if (plans.length > 0) lines.push("");
  for (const plan of plans) lines.push(generateFrame(plan, planByName), "");
  for (const plan of plans) lines.push(`static void ${plan.pollName}(Z_AsyncTask *task);`);
  for (const plan of plans) lines.push(`${generateStartSignature(plan)};`);
  if (plans.length > 0) lines.push("");
  for (const plan of plans) lines.push(generateStart(plan), "");
  for (const plan of plans) lines.push(generatePoll(plan, planByName, fileName), "");

  if (main) {
    lines.push(
      "int32_t main(void) {",
      `  ${main.frameName} *root = ${main.startName}();`,
      "  z_async_run(&root->task);",
      ...(main.declaration.errorType
        ? [
            "  if (root->failed) {",
            "    free(root);",
            "    return 1;",
            "  }",
          ]
        : []),
      "  int32_t result = root->result;",
      "  free(root);",
      "  return result;",
      "}",
    );
  }
  return lines.join("\n");
}

function generateFrame(
  plan: AsyncFunctionPlan,
  planByName: ReadonlyMap<string, AsyncFunctionPlan>,
): string {
  const lines = [
    `struct ${plan.frameName} {`,
    "  Z_AsyncTask task;",
    "  uint32_t state;",
  ];
  if (plan.declaration.returnType.name !== "void") {
    lines.push(`  ${cFrameType(plan.declaration.returnType.name)} result;`);
  }
  if (plan.declaration.errorType) {
    lines.push("  bool failed;");
    lines.push(`  ${cFrameType(plan.declaration.errorType.name)} error;`);
  }
  for (const [name, type] of plan.locals) {
    lines.push(`  ${cFrameType(type)} ${frameField(name)};`);
  }
  for (const site of plan.awaits.values()) {
    lines.push(`  ${planByName.get(site.target.name)!.frameName} *child_${site.index};`);
  }
  lines.push("};");
  return lines.join("\n");
}

function generateStartSignature(plan: AsyncFunctionPlan): string {
  const parameters = plan.declaration.parameters.map((parameter) => (
    `${cFrameType(parameter.type.name)} ${frameField(parameter.name)}`
  ));
  return `static __attribute__((unused)) ${plan.frameName} *${plan.startName}(${parameters.join(", ") || "void"})`;
}

function generateStart(plan: AsyncFunctionPlan): string {
  const lines = [
    `${generateStartSignature(plan)} {`,
    `  ${plan.frameName} *frame = (${plan.frameName} *)malloc(sizeof(${plan.frameName}));`,
    "  if (frame == NULL) abort();",
    `  frame->task.poll = ${plan.pollName};`,
    "  frame->task.completed = false;",
    "  frame->state = 0;",
  ];
  if (plan.declaration.errorType) lines.push("  frame->failed = false;");
  for (const parameter of plan.declaration.parameters) {
    const name = frameField(parameter.name);
    lines.push(`  frame->${name} = ${name};`);
  }
  for (const site of plan.awaits.values()) lines.push(`  frame->child_${site.index} = NULL;`);
  lines.push("  return frame;", "}");
  return lines.join("\n");
}

function generatePoll(
  plan: AsyncFunctionPlan,
  planByName: ReadonlyMap<string, AsyncFunctionPlan>,
  fileName: string,
): string {
  const cases: string[] = [];
  let state = 0;
  for (const statement of plan.declaration.body) {
    if (statement.kind === "variable") {
      const initializer = statement.initializer!;
      const operation = awaitOperation(initializer);
      if (operation) {
        const site = plan.awaits.get(operation.expression.location.offset)!;
        const target = planByName.get(site.target.name)!;
        const arguments_ = site.call.arguments.map((argument) => emitScalarExpression(argument, plan.locals, fileName));
        cases.push(
          caseBlock(state, [
            `frame->child_${site.index} = ${target.startName}(${arguments_.join(", ")});`,
            `frame->state = ${state + 1};`,
            "return;",
          ]),
        );
        cases.push(
          caseBlock(
            state + 1,
            awaitCompletion(site, plan, `frame->${frameField(statement.name)}`, false, state + 2),
          ),
        );
        state += 2;
      } else {
        cases.push(caseBlock(state, [
          `frame->${frameField(statement.name)} = ${emitScalarExpression(initializer, plan.locals, fileName)};`,
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
        const target = planByName.get(site.target.name)!;
        const arguments_ = site.call.arguments.map((argument) => emitScalarExpression(argument, plan.locals, fileName));
        cases.push(caseBlock(state, [
          `frame->child_${site.index} = ${target.startName}(${arguments_.join(", ")});`,
          `frame->state = ${state + 1};`,
          "return;",
        ]));
        cases.push(caseBlock(state + 1, awaitCompletion(site, plan, "frame->result", true, state + 2)));
      } else {
        const completion = statement.expression
          ? [`frame->result = ${emitScalarExpression(statement.expression, plan.locals, fileName)};`]
          : [];
        cases.push(caseBlock(state, [
          ...completion,
          ...(plan.declaration.errorType ? ["frame->failed = false;"] : []),
          "frame->task.completed = true;",
          "return;",
        ]));
      }
      state += operation ? 2 : 1;
      continue;
    }
    if (statement.kind === "throw") {
      cases.push(caseBlock(state, [
        `frame->error = ${emitScalarExpression(statement.expression, plan.locals, fileName)};`,
        "frame->failed = true;",
        "frame->task.completed = true;",
        "return;",
      ]));
      state += 1;
      continue;
    }
    if (statement.kind === "expressionStatement") {
      const operation = awaitOperation(statement.expression)!;
      const site = plan.awaits.get(operation.expression.location.offset)!;
      const target = planByName.get(site.target.name)!;
      const arguments_ = site.call.arguments.map((argument) => emitScalarExpression(argument, plan.locals, fileName));
      cases.push(caseBlock(state, [
        `frame->child_${site.index} = ${target.startName}(${arguments_.join(", ")});`,
        `frame->state = ${state + 1};`,
        "return;",
      ]));
      cases.push(caseBlock(state + 1, awaitCompletion(site, plan, null, false, state + 2)));
      state += 2;
    }
  }
  if (plan.declaration.returnType.name === "void" && !endsWithTermination(plan.declaration.body)) {
    cases.push(caseBlock(state, [
      ...(plan.declaration.errorType ? ["frame->failed = false;"] : []),
      "frame->task.completed = true;",
      "return;",
    ]));
  }
  return `static void ${plan.pollName}(Z_AsyncTask *task) {
  ${plan.frameName} *frame = (${plan.frameName} *)task;
  for (;;) {
    switch (frame->state) {
${cases.map((item) => indent(item, 6)).join("\n")}
      default:
        abort();
    }
  }
}`;
}

function awaitCompletion(
  site: AwaitSite,
  parent: AsyncFunctionPlan,
  destination: string | null,
  terminal: boolean,
  nextState: number,
): string[] {
  const child = `frame->child_${site.index}`;
  const lines = [
    `z_async_poll_task(&${child}->task);`,
    `if (!${child}->task.completed) return;`,
  ];
  if (site.mode === "try") {
    lines.push(
      `if (${child}->failed) {`,
      `  frame->error = ${child}->error;`,
      `  free(${child});`,
      `  frame->child_${site.index} = NULL;`,
      "  frame->failed = true;",
      "  frame->task.completed = true;",
      "  return;",
      "}",
    );
  } else if (site.mode === "attempt" && destination) {
    const result = resultTypeName(site.target.returnType.name, site.target.errorType!.name);
    const cResult = resultCName(result);
    lines.push(`if (${child}->failed) {`);
    lines.push(
      `  ${destination} = (${cResult}){ .tag = ${resultTag(result, "failure")}, .data.failure = ${child}->error };`,
      "} else {",
    );
    const successPayload = site.target.returnType.name === "void"
      ? ""
      : `, .data.success = ${child}->result`;
    lines.push(`  ${destination} = (${cResult}){ .tag = ${resultTag(result, "success")}${successPayload} };`);
    lines.push("}");
  }

  if (site.mode !== "attempt" && destination && site.target.returnType.name !== "void") {
    lines.push(`${destination} = ${child}->result;`);
  }
  lines.push(`free(${child});`, `frame->child_${site.index} = NULL;`);
  if (terminal) {
    if (parent.declaration.errorType) lines.push("frame->failed = false;");
    lines.push("frame->task.completed = true;", "return;");
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

function validateScalarExpression(
  expression: Expression,
  locals: ReadonlyMap<string, string>,
  fileName: string,
): void {
  emitScalarExpression(expression, locals, fileName);
}

function emitScalarExpression(
  expression: Expression,
  locals: ReadonlyMap<string, string>,
  fileName: string,
): string {
  switch (expression.kind) {
    case "number":
      return expression.value;
    case "boolean":
      return expression.value ? "true" : "false";
    case "identifier":
      if (!locals.has(expression.name)) {
        unsupported(fileName, expression.location, "the first async lowering slice cannot reference this value");
      }
      return `frame->${frameField(expression.name)}`;
    case "unary":
      if (expression.operator !== "!") {
        unsupported(fileName, expression.location, "overflow-aware async arithmetic lowering has not landed yet");
      }
      return `(!${emitScalarExpression(expression.operand, locals, fileName)})`;
    case "binary":
      if (!safeBinaryOperators.has(expression.operator)) {
        unsupported(fileName, expression.location, "overflow-aware async arithmetic lowering has not landed yet");
      }
      return `(${emitScalarExpression(expression.left, locals, fileName)} ${expression.operator} ${emitScalarExpression(expression.right, locals, fileName)})`;
    case "conditional":
      return `(${emitScalarExpression(expression.condition, locals, fileName)} ? ${emitScalarExpression(expression.thenExpression, locals, fileName)} : ${emitScalarExpression(expression.elseExpression, locals, fileName)})`;
    default:
      unsupported(
        fileName,
        expression.location,
        `expression ${JSON.stringify(expression.kind)} is not executable in the first Phase 1 async slice`,
      );
  }
}

function requireScalar(type: string, location: SourceLocation, fileName: string, role: string): void {
  if (!scalarTypes.has(type)) {
    unsupported(fileName, location, `${role} type ${JSON.stringify(type)} needs owned task-frame lowering`);
  }
}

function requireFrameType(type: string, location: SourceLocation, fileName: string, role: string): void {
  if (!scalarTypes.has(type) && !type.startsWith("__z_Result_")) {
    unsupported(fileName, location, `${role} type ${JSON.stringify(type)} needs owned task-frame lowering`);
  }
}

function cScalar(type: string): string {
  const mapped = scalarTypes.get(type);
  if (!mapped) throw new Error(`missing async scalar ABI type ${JSON.stringify(type)}`);
  return mapped;
}

function cFrameType(type: string): string {
  if (type.startsWith("__z_Result_")) return resultCName(type);
  return cScalar(type);
}

function resultCName(type: string): string {
  return `Z_${nativePart(type.replace(/^__z_/, ""))}`;
}

function resultTag(type: string, variant: "success" | "failure"): string {
  return `${resultCName(type)}_${variant}`;
}

function endsWithTermination(statements: readonly Statement[]): boolean {
  return statements.at(-1)?.kind === "return" || statements.at(-1)?.kind === "throw";
}

function frameField(name: string): string {
  return `value_${nativePart(name)}`;
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
    notes: ["Phase 1 currently executes top-level scalar async functions, typed scalar errors, and direct sequential awaits"],
    helps: [help],
  });
}
