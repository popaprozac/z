import type {
  CallExpression,
  Expression,
  FunctionDeclaration,
  Program,
  SourceLocation,
  Statement,
} from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { SemanticInfo } from "./sema.ts";

type AwaitSite = {
  readonly index: number;
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
  if (declaration.errorType) {
    unsupported(
      fileName,
      declaration.errorType.location,
      "typed async errors are not executable in the first Phase 1 slice",
      "use `z check`; Result-carrying task frames are the next async ABI step",
    );
  }
  requireScalar(declaration.returnType.name, declaration.returnType.location, fileName, "async return");
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
      requireScalar(type, statement.type?.location ?? statement.nameLocation, fileName, "async local");
      locals.set(statement.name, type);
      if (statement.initializer.kind === "await") {
        awaits.set(statement.initializer.location.offset, awaitSite(awaitIndex++, statement.initializer, functions, fileName));
      } else {
        validateScalarExpression(statement.initializer, locals, fileName);
      }
      continue;
    }
    if (statement.kind === "return") {
      if (statement.expression?.kind === "await") {
        awaits.set(statement.expression.location.offset, awaitSite(awaitIndex++, statement.expression, functions, fileName));
      } else if (statement.expression) {
        validateScalarExpression(statement.expression, locals, fileName);
      }
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
  return { index, expression, call, target };
}

function validateAsyncMain(declaration: FunctionDeclaration, fileName: string): void {
  if (declaration.parameters.length > 0 || declaration.returnType.name !== "i32" || declaration.errorType) {
    unsupported(
      fileName,
      declaration.location,
      "the first executable async main must have signature `async function main(): i32`",
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
    lines.push(`  ${cScalar(plan.declaration.returnType.name)} result;`);
  }
  for (const [name, type] of plan.locals) {
    lines.push(`  ${cScalar(type)} ${frameField(name)};`);
  }
  for (const site of plan.awaits.values()) {
    lines.push(`  ${planByName.get(site.target.name)!.frameName} *child_${site.index};`);
  }
  lines.push("};");
  return lines.join("\n");
}

function generateStartSignature(plan: AsyncFunctionPlan): string {
  const parameters = plan.declaration.parameters.map((parameter) => (
    `${cScalar(parameter.type.name)} ${frameField(parameter.name)}`
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
      if (initializer.kind === "await") {
        const site = plan.awaits.get(initializer.location.offset)!;
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
          caseBlock(state + 1, [
            `z_async_poll_task(&frame->child_${site.index}->task);`,
            `if (!frame->child_${site.index}->task.completed) return;`,
            ...(site.target.returnType.name === "void"
              ? []
              : [`frame->${frameField(statement.name)} = frame->child_${site.index}->result;`]),
            `free(frame->child_${site.index});`,
            `frame->child_${site.index} = NULL;`,
            `frame->state = ${state + 2};`,
            "continue;",
          ]),
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
      if (statement.expression?.kind === "await") {
        const site = plan.awaits.get(statement.expression.location.offset)!;
        const target = planByName.get(site.target.name)!;
        const arguments_ = site.call.arguments.map((argument) => emitScalarExpression(argument, plan.locals, fileName));
        cases.push(caseBlock(state, [
          `frame->child_${site.index} = ${target.startName}(${arguments_.join(", ")});`,
          `frame->state = ${state + 1};`,
          "return;",
        ]));
        cases.push(caseBlock(state + 1, [
          `z_async_poll_task(&frame->child_${site.index}->task);`,
          `if (!frame->child_${site.index}->task.completed) return;`,
          ...(plan.declaration.returnType.name === "void"
            ? []
            : [`frame->result = frame->child_${site.index}->result;`]),
          `free(frame->child_${site.index});`,
          `frame->child_${site.index} = NULL;`,
          "frame->task.completed = true;",
          "return;",
        ]));
      } else {
        const completion = statement.expression
          ? [`frame->result = ${emitScalarExpression(statement.expression, plan.locals, fileName)};`]
          : [];
        cases.push(caseBlock(state, [...completion, "frame->task.completed = true;", "return;"]));
      }
      state += statement.expression?.kind === "await" ? 2 : 1;
    }
  }
  if (plan.declaration.returnType.name === "void" && !endsWithReturn(plan.declaration.body)) {
    cases.push(caseBlock(state, ["frame->task.completed = true;", "return;"]));
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

function cScalar(type: string): string {
  const mapped = scalarTypes.get(type);
  if (!mapped) throw new Error(`missing async scalar ABI type ${JSON.stringify(type)}`);
  return mapped;
}

function endsWithReturn(statements: readonly Statement[]): boolean {
  return statements.at(-1)?.kind === "return";
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
    notes: ["Phase 1 currently executes top-level non-throwing scalar async functions with direct sequential awaits"],
    helps: [help],
  });
}
