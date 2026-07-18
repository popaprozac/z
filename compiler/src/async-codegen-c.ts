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
  readonly destroyName: string;
  readonly locals: ReadonlyMap<string, string>;
  readonly awaits: ReadonlyMap<number, AwaitSite>;
  readonly types: AsyncTypeContext;
};

type AsyncTypeContext = {
  readonly structs: ReadonlyMap<string, StructDeclaration>;
  readonly enums: ReadonlyMap<string, EnumDeclaration>;
  readonly semanticInfo: SemanticInfo;
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
  const types: AsyncTypeContext = {
    structs: new Map(program.structs.map((declaration) => [declaration.name, declaration])),
    enums: new Map(program.enums.map((declaration) => [declaration.name, declaration])),
    semanticInfo,
  };
  const plans = declarations.map((declaration) => planFunction(declaration, functions, fileName, semanticInfo, types));
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
  types: AsyncTypeContext,
): AsyncFunctionPlan {
  requireFrameType(declaration.returnType.name, declaration.returnType.location, fileName, "async return", types);
  if (declaration.errorType) {
    requireFrameType(declaration.errorType.name, declaration.errorType.location, fileName, "async error", types);
  }
  const locals = new Map<string, string>();
  for (const parameter of declaration.parameters) {
    if (parameter.mode !== "value") {
      unsupported(fileName, parameter.location, "borrowed async parameters are not executable yet");
    }
    requireFrameType(parameter.type.name, parameter.type.location, fileName, "async parameter", types);
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
      requireFrameType(type, statement.type?.location ?? statement.nameLocation, fileName, "async local", types);
      locals.set(statement.name, type);
      const operation = awaitOperation(statement.initializer);
      if (operation) {
        awaits.set(
          operation.expression.location.offset,
          awaitSite(awaitIndex++, operation.mode, operation.expression, functions, fileName),
        );
      } else {
        validateFrameExpression(statement.initializer, locals, fileName, types);
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
        validateFrameExpression(statement.expression, locals, fileName, types);
      }
      continue;
    }
    if (statement.kind === "throw") {
      validateFrameExpression(statement.expression, locals, fileName, types);
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
      "the current state-machine lowering supports owned bindings, direct sequential await, throw, and return",
    );
  }

  const part = nativePart(declaration.name);
  return {
    declaration,
    frameName: `Z_AsyncFrame_${part}`,
    pollName: `z_async_poll_${part}`,
    startName: `z_async_start_${part}`,
    destroyName: `z_async_destroy_${part}`,
    locals,
    awaits,
    types,
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
    "/* Z async Phase 1: stackless ownership-aware task frames. */",
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
  for (const plan of plans) lines.push(`static void ${plan.destroyName}(${plan.frameName} *frame);`);
  for (const plan of plans) lines.push(`${generateStartSignature(plan)};`);
  if (plans.length > 0) lines.push("");
  for (const plan of plans) lines.push(generateDestroy(plan, planByName), "");
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
  planByName: ReadonlyMap<string, AsyncFunctionPlan>,
): string {
  const lines = [
    `struct ${plan.frameName} {`,
    "  Z_AsyncTask task;",
    "  uint32_t state;",
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
  for (const site of plan.awaits.values()) {
    lines.push(`  ${planByName.get(site.target.name)!.frameName} *child_${site.index};`);
  }
  lines.push("};");
  return lines.join("\n");
}

function generateDestroy(
  plan: AsyncFunctionPlan,
  planByName: ReadonlyMap<string, AsyncFunctionPlan>,
): string {
  const lines = [
    `static void ${plan.destroyName}(${plan.frameName} *frame) {`,
    "  if (frame == NULL) return;",
  ];
  for (const site of [...plan.awaits.values()].reverse()) {
    const child = planByName.get(site.target.name)!;
    lines.push(
      `  if (frame->child_${site.index} != NULL) {`,
      `    ${child.destroyName}(frame->child_${site.index});`,
      `    free(frame->child_${site.index});`,
      `    frame->child_${site.index} = NULL;`,
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
  const parameters = plan.declaration.parameters.map((parameter) => (
    `${cFrameType(parameter.type.name, plan.types)} ${frameField(parameter.name)}`
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
  if (
    plan.declaration.returnType.name !== "void"
    && hasFrameCleanup(plan.declaration.returnType.name, plan.types)
  ) lines.push("  frame->live_result = false;");
  const parameters = new Set(plan.declaration.parameters.map((parameter) => parameter.name));
  for (const [name, type] of plan.locals) {
    if (hasFrameCleanup(type, plan.types)) {
      lines.push(`  frame->${frameLiveField(name)} = ${parameters.has(name) ? "true" : "false"};`);
    }
  }
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
        const arguments_ = site.call.arguments.map((argument) => emitFrameExpression(argument, plan, fileName));
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
            awaitCompletion(
              site,
              plan,
              `frame->${frameField(statement.name)}`,
              plan.locals.get(statement.name)!,
              false,
              state + 2,
            ),
          ),
        );
        state += 2;
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
        const target = planByName.get(site.target.name)!;
        const arguments_ = site.call.arguments.map((argument) => emitFrameExpression(argument, plan, fileName));
        cases.push(caseBlock(state, [
          `frame->child_${site.index} = ${target.startName}(${arguments_.join(", ")});`,
          `frame->state = ${state + 1};`,
          "return;",
        ]));
        cases.push(caseBlock(state + 1, awaitCompletion(
          site,
          plan,
          "frame->result",
          plan.declaration.returnType.name,
          true,
          state + 2,
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
          "frame->task.completed = true;",
          "return;",
        ]));
      }
      state += operation ? 2 : 1;
      continue;
    }
    if (statement.kind === "throw") {
      cases.push(caseBlock(state, [
        `frame->error = ${emitFrameExpression(statement.expression, plan, fileName)};`,
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
      const arguments_ = site.call.arguments.map((argument) => emitFrameExpression(argument, plan, fileName));
      cases.push(caseBlock(state, [
        `frame->child_${site.index} = ${target.startName}(${arguments_.join(", ")});`,
        `frame->state = ${state + 1};`,
        "return;",
      ]));
      cases.push(caseBlock(state + 1, awaitCompletion(site, plan, null, null, false, state + 2)));
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
  destinationType: string | null,
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
      `  z_async_destroy_${nativePart(site.target.name)}(${child});`,
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
    if (hasFrameCleanup(site.target.returnType.name, parent.types)) {
      lines.push(`  ${child}->live_result = false;`);
    }
    lines.push("}");
  }

  if (site.mode !== "attempt" && destination && site.target.returnType.name !== "void") {
    lines.push(`${destination} = ${child}->result;`);
    if (hasFrameCleanup(site.target.returnType.name, parent.types)) {
      lines.push(`${child}->live_result = false;`);
    }
  }
  if (destination && destinationType && hasFrameCleanup(destinationType, parent.types)) {
    lines.push(`${destinationLiveFlag(destination, parent)} = true;`);
  }
  lines.push(
    `z_async_destroy_${nativePart(site.target.name)}(${child});`,
    `free(${child});`,
    `frame->child_${site.index} = NULL;`,
  );
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

function validateFrameExpression(
  expression: Expression,
  locals: ReadonlyMap<string, string>,
  fileName: string,
  types: AsyncTypeContext,
): void {
  emitFrameExpression(expression, { locals, types }, fileName);
}

function emitFrameExpression(
  expression: Expression,
  plan: Pick<AsyncFunctionPlan, "locals" | "types">,
  fileName: string,
): string {
  switch (expression.kind) {
    case "number":
      return expression.value;
    case "boolean":
      return expression.value ? "true" : "false";
    case "identifier":
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
      if (expression.operator !== "!") {
        unsupported(fileName, expression.location, "overflow-aware async arithmetic lowering has not landed yet");
      }
      return `(!${emitFrameExpression(expression.operand, plan, fileName)})`;
    case "binary":
      if (!safeBinaryOperators.has(expression.operator)) {
        unsupported(fileName, expression.location, "overflow-aware async arithmetic lowering has not landed yet");
      }
      return `(${emitFrameExpression(expression.left, plan, fileName)} ${expression.operator} ${emitFrameExpression(expression.right, plan, fileName)})`;
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
      if (expression.callee.kind === "member" && expression.callee.object.kind === "identifier") {
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
  if (scalarTypes.has(type)) return cScalar(type);
  const aggregate = types.structs.get(type);
  if (aggregate) return aggregate.kind === "class" ? `Z_${type} *` : `Z_${type}`;
  if (types.enums.has(type)) return resultCName(type);
  throw new Error(`missing async aggregate ABI type ${JSON.stringify(type)}`);
}

function isSupportedFrameType(type: string, types: AsyncTypeContext, visiting = new Set<string>()): boolean {
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
  plan: Pick<AsyncFunctionPlan, "locals" | "types">,
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

function resultTag(type: string, variant: "success" | "failure"): string {
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
    notes: ["Phase 1 currently executes top-level ownership-aware task frames and direct sequential awaits"],
    helps: [help],
  });
}
