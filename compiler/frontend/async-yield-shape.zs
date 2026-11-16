// Shared admission rule for the first general, executor-local yield frame.
// This is an implementation boundary, not a second set of ownership rules.
import {
  ExpressionKind, ExpressionTree, FunctionDeclaration, ParameterMode, Program,
  StatementArena, StatementKind,
} from "./parser.zs";

export function isFrameSchedulerYield(
  in program: Program, in arena: StatementArena, index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.expressionStatement) return false;
  return match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (tree.nodes[root].kind != ExpressionKind.awaitExpression
          || tree.nodes[root].children.length != 1) return false;
        const call = tree.nodes[root].children[0];
        if (tree.nodes[call].kind != ExpressionKind.callExpression
          || tree.nodes[call].children.length != 1) return false;
        const member = tree.nodes[call].children[0];
        if (tree.nodes[member].kind != ExpressionKind.memberExpression
          || tree.nodes[member].value != "yield"
          || tree.nodes[member].children.length != 1) return false;
        const receiver = tree.nodes[member].children[0];
        if (tree.nodes[receiver].kind != ExpressionKind.identifierExpression) return false;
        for (const imported of program.imports) {
          if (imported.header != "std/async") continue;
          for (const binding of imported.bindings) {
            if (binding.importedName == "scheduler"
              && binding.localName == tree.nodes[receiver].value) return true;
          }
        }
        select false;
      }
      none => false;
    }
    none => false;
  };
}

// `await delay(ms)` from std/time as a whole statement: one timer suspension.
export function isFrameDelay(
  in program: Program, in arena: StatementArena, index: usize
): boolean {
  if (arena.nodes[index].kind != StatementKind.expressionStatement) return false;
  return match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (tree.nodes[root].kind != ExpressionKind.awaitExpression
          || tree.nodes[root].children.length != 1) return false;
        const call = tree.nodes[root].children[0];
        if (tree.nodes[call].kind != ExpressionKind.callExpression
          || tree.nodes[call].children.length != 2) return false;
        const callee = tree.nodes[call].children[0];
        if (tree.nodes[callee].kind != ExpressionKind.identifierExpression) return false;
        if (!frameExpressionIsSynchronous(tree, tree.nodes[call].children[1])) return false;
        for (const imported of program.imports) {
          if (imported.header != "std/time") continue;
          for (const binding of imported.bindings) {
            if (binding.importedName == "delay"
              && binding.localName == tree.nodes[callee].value) return true;
          }
        }
        select false;
      }
      none => false;
    }
    none => false;
  };
}

function frameExpressionIsSynchronous(in tree: ExpressionTree, index: usize): boolean {
  const kind = tree.nodes[index].kind;
  if (kind == ExpressionKind.awaitExpression
    || kind == ExpressionKind.tryExpression
    || kind == ExpressionKind.spawnExpression
    || kind == ExpressionKind.executorPlacementExpression
    || kind == ExpressionKind.executorOnExpression
    || kind == ExpressionKind.matchExpression
    || kind == ExpressionKind.ifExpression
    || kind == ExpressionKind.unsafeExpression
    || kind == ExpressionKind.valueBlockExpression
    || kind == ExpressionKind.whileExpression
    || kind == ExpressionKind.forExpression) return false;
  // Nested callable bodies have their own lifetime and suspension analysis.
  if (kind == ExpressionKind.closureExpression) return true;
  for (const child of tree.nodes[index].children) {
    if (!frameExpressionIsSynchronous(tree, child)) return false;
  }
  return true;
}

// An await that a frame can run before its statement: a named call with
// synchronous arguments, or a task-local join.
function frameAwaitOperandIsSupported(in tree: ExpressionTree, index: usize): boolean {
  if (tree.nodes[index].children.length != 1) return false;
  const operand = tree.nodes[index].children[0];
  if (tree.nodes[operand].kind == ExpressionKind.identifierExpression) return true;
  if (frameTaskCancelReceiver(tree, operand) < tree.nodes.length) return false;
  if (tree.nodes[operand].kind != ExpressionKind.callExpression
    || tree.nodes[operand].children.length == 0) return false;
  if (tree.nodes[tree.nodes[operand].children[0]].kind != ExpressionKind.identifierExpression) return false;
  for (const child of tree.nodes[operand].children) {
    if (!frameExpressionIsSynchronous(tree, child)) return false;
  }
  return true;
}

function frameTreeContainsAwait(in tree: ExpressionTree, index: usize): boolean {
  if (tree.nodes[index].kind == ExpressionKind.closureExpression) return false;
  if (tree.nodes[index].kind == ExpressionKind.awaitExpression
    || tree.nodes[index].kind == ExpressionKind.spawnExpression) return true;
  for (const child of tree.nodes[index].children) {
    if (frameTreeContainsAwait(tree, child)) return true;
  }
  return false;
}

// Awaits nested in an expression run first, in evaluation order, into frame
// temporaries (Stage 0's nested await operations). Lazy and selected
// branches (`&&`, `||`, `?:`, value `if`, match arms) cannot hoist an await.
export function frameExpressionHoistsAwaits(in tree: ExpressionTree, index: usize): boolean {
  const node = view tree.nodes[index];
  if (node.kind == ExpressionKind.closureExpression) return true;
  if (node.kind == ExpressionKind.awaitExpression) return frameAwaitOperandIsSupported(tree, index);
  if (node.kind == ExpressionKind.attemptExpression && node.children.length == 1
    && tree.nodes[node.children[0]].kind == ExpressionKind.awaitExpression) {
    return frameAwaitOperandIsSupported(tree, node.children[0]);
  }
  if (node.kind == ExpressionKind.spawnExpression || node.kind == ExpressionKind.tryExpression
    || node.kind == ExpressionKind.attemptExpression
    || node.kind == ExpressionKind.executorPlacementExpression
    || node.kind == ExpressionKind.executorOnExpression) {
    return !frameTreeContainsAwait(tree, index) && frameExpressionIsSynchronous(tree, index);
  }
  const lazy = node.kind == ExpressionKind.ifExpression || node.kind == ExpressionKind.matchExpression
    || node.kind == ExpressionKind.conditionalExpression
    || node.kind == ExpressionKind.unsafeExpression || node.kind == ExpressionKind.valueBlockExpression
    || node.kind == ExpressionKind.whileExpression || node.kind == ExpressionKind.forExpression
    || (node.kind == ExpressionKind.binaryExpression && (node.value == "&&" || node.value == "||"));
  if (lazy) return !frameTreeContainsAwait(tree, index) && frameExpressionIsSynchronous(tree, index);
  for (const child of node.children) {
    if (!frameExpressionHoistsAwaits(tree, child)) return false;
  }
  return true;
}

// `task f(args)`: a named callee with synchronous arguments.
function frameSpawnIsSupported(in tree: ExpressionTree, index: usize): boolean {
  if (tree.nodes[index].children.length != 1) return false;
  const call = tree.nodes[index].children[0];
  if (tree.nodes[call].kind != ExpressionKind.callExpression
    || tree.nodes[call].children.length == 0) return false;
  const callee = tree.nodes[call].children[0];
  if (tree.nodes[callee].kind != ExpressionKind.identifierExpression) return false;
  for (const child of tree.nodes[call].children) {
    if (!frameExpressionIsSynchronous(tree, child)) return false;
  }
  return true;
}

// The receiver node of `t.cancel()`, or the tree length.
function frameTaskCancelReceiver(in tree: ExpressionTree, call: usize): usize {
  if (tree.nodes[call].kind != ExpressionKind.callExpression
    || tree.nodes[call].children.length != 1) return tree.nodes.length;
  const member = tree.nodes[call].children[0];
  if (tree.nodes[member].kind != ExpressionKind.memberExpression
    || tree.nodes[member].value != "cancel"
    || tree.nodes[member].children.length != 1) return tree.nodes.length;
  const receiver = tree.nodes[member].children[0];
  if (tree.nodes[receiver].kind != ExpressionKind.identifierExpression) return tree.nodes.length;
  return receiver;
}

function statementRootIsSpawn(in arena: StatementArena, index: usize): boolean {
  return match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => tree.nodes[tree.root].kind == ExpressionKind.spawnExpression;
      none => false;
    }
    none => false;
  };
}

function frameExpressionIsSupported(in tree: ExpressionTree, index: usize): boolean {
  let root = index;
  if ((tree.nodes[root].kind == ExpressionKind.tryExpression
    || tree.nodes[root].kind == ExpressionKind.attemptExpression)
    && tree.nodes[root].children.length == 1) root = tree.nodes[root].children[0];
  if (tree.nodes[root].kind == ExpressionKind.spawnExpression) {
    return frameSpawnIsSupported(tree, root);
  }
  if (tree.nodes[root].kind != ExpressionKind.awaitExpression) {
    return frameExpressionIsSynchronous(tree, root);
  }
  if (tree.nodes[root].children.length != 1) return false;
  const call = tree.nodes[root].children[0];
  // Joins of task locals: `await t` and `await t.cancel()`. The function's
  // task-local rule checks that `t` names a root spawn local.
  if (tree.nodes[call].kind == ExpressionKind.identifierExpression) return true;
  if (frameTaskCancelReceiver(tree, call) < tree.nodes.length) return true;
  if (tree.nodes[call].kind != ExpressionKind.callExpression
    || tree.nodes[call].children.length == 0) return false;
  const callee = tree.nodes[call].children[0];
  // First child tier: a named function, with already checked owned arguments.
  // Method/placed calls and arbitrary expression normalization remain separate.
  if (tree.nodes[callee].kind != ExpressionKind.identifierExpression) return false;
  for (const child of tree.nodes[call].children) {
    if (!frameExpressionIsSynchronous(tree, child)) return false;
  }
  return true;
}

function frameStatementIsSupported(
  in program: Program, in arena: StatementArena, index: usize,
  nested: boolean, synchronousOnly: boolean
): boolean {
  if (isFrameSchedulerYield(program, arena, index)
    || isFrameDelay(program, arena, index)) return !synchronousOnly;
  const kind = arena.nodes[index].kind;
  // Match-initialized root owners use the same non-suspending arm lowering as
  // statement matches. The selected value becomes live only after the match;
  // an arm that returns/throws never initializes the destination frame slot.
  let matchInitializer = false;
  if (kind == StatementKind.variableStatement && !nested) {
    match (in arena.nodes[index].expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => matchInitializer = tree.nodes[tree.root].kind == ExpressionKind.matchExpression;
        none => {}
      }
      none => {}
    }
  }
  if (kind == StatementKind.matchStatement || matchInitializer) {
    return match (in arena.nodes[index].expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          const root = tree.root;
          if (tree.nodes[root].kind != ExpressionKind.matchExpression
            || tree.nodes[root].children.length < 2) return false;
          const subject = tree.nodes[root].children[0];
          // A subject's awaits run just before the match, wherever it is.
          if (synchronousOnly) {
            if (!frameExpressionIsSynchronous(tree, subject)) return false;
          } else if (!frameExpressionHoistsAwaits(tree, subject)) return false;
          let armIndex: usize = 1;
          while (armIndex < tree.nodes[root].children.length) {
            const arm = tree.nodes[root].children[armIndex];
            if (tree.nodes[arm].kind != ExpressionKind.matchArmExpression
              || tree.nodes[arm].labels.length != 1) return false;
            // Payload bindings remain lexical C storage. Destructured payload
            // locals and payloads spanning suspension need their own frame tier.
            if (tree.nodes[arm].labels[0] != "none"
              && tree.nodes[arm].labels[0] != "binding") return false;
            for (const child of tree.nodes[arm].statements) {
              if (!frameStatementIsSupported(program, arena, child, true, true)) return false;
            }
            armIndex = armIndex + 1;
          }
          select true;
        }
        none => false;
      }
      none => false;
    };
  }
  // Spawn sites own one frame slot each: root statements, or `task f();`
  // directly in an unnamed `async scope`, which joins its slots on exit. A
  // loop therefore never restarts a slot whose child is still running.
  if (nested && statementRootIsSpawn(arena, index)) return false;
  if (kind == StatementKind.asyncScopeStatement) {
    if (synchronousOnly || arena.nodes[index].name.byteLength != 0
      || arena.nodes[index].children.length != 1) return false;
    const block = arena.nodes[index].children[0];
    if (arena.nodes[block].kind != StatementKind.blockStatement) return false;
    for (const child of arena.nodes[block].children) {
      if (statementRootIsSpawn(arena, child)) {
        if (arena.nodes[child].kind != StatementKind.expressionStatement
          || !frameStatementIsSupported(program, arena, child, false, false)) return false;
      } else if (!frameStatementIsSupported(program, arena, child, true, false)) return false;
    }
    return true;
  }
  if (kind == StatementKind.variableStatement
    || kind == StatementKind.destructureStatement) {
    // Keep lexical local storage expansion separate from root frame storage.
    if (nested || arena.nodes[index].arrayBindings.length != 0) return false;
    // `let x: T;` is zeroed frame storage whose live flag starts false.
    match (in arena.nodes[index].expression) {
      some(_) => {}
      none => return kind == StatementKind.variableStatement;
    }
  } else if (kind != StatementKind.returnStatement
    && !(kind == StatementKind.selectStatement && synchronousOnly)
    && kind != StatementKind.throwStatement
    && kind != StatementKind.expressionStatement
    && kind != StatementKind.assignmentStatement
    && kind != StatementKind.ifStatement
    && kind != StatementKind.whileStatement
    && kind != StatementKind.blockStatement
    && kind != StatementKind.breakStatement
    && kind != StatementKind.continueStatement) return false;
  match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (synchronousOnly) {
          let expression = root;
          if ((tree.nodes[root].kind == ExpressionKind.tryExpression
            || tree.nodes[root].kind == ExpressionKind.attemptExpression)
            && tree.nodes[root].children.length == 1) expression = tree.nodes[root].children[0];
          if (!frameExpressionIsSynchronous(tree, expression)) return false;
        } else if (kind == StatementKind.whileStatement || kind == StatementKind.destructureStatement) {
          // A loop condition re-runs each iteration: it cannot hoist an await.
          if (!frameExpressionIsSynchronous(tree, root)) return false;
        } else if (kind == StatementKind.ifStatement || kind == StatementKind.throwStatement) {
          if (!frameExpressionHoistsAwaits(tree, root)) return false;
        } else if (!frameExpressionIsSupported(tree, root)
          && !frameExpressionHoistsAwaits(tree, root)) return false;
      }
      none => return false;
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (synchronousOnly) {
          if (!frameExpressionIsSynchronous(tree, root)) return false;
        } else if (!frameExpressionHoistsAwaits(tree, root)) return false;
      }
      none => return false;
    }
    none => {}
  }
  for (const child of arena.nodes[index].children) {
    if (!frameStatementIsSupported(program, arena, child, true, synchronousOnly)) return false;
  }
  return true;
}

export function functionUsesYieldFrame(
  in program: Program, in declaration: FunctionDeclaration
): boolean {
  if (!declaration.asynchronous || declaration.executorAffinity.byteLength != 0) return false;
  for (const parameter of declaration.parameters) {
    // Owned inputs enter the cold frame. Borrowed inputs need parent loan
    // storage and join proof, and are a separate executable tier.
    if (parameter.mode != ParameterMode.value) return false;
  }
  if (declaration.returnType.name != "void"
    && declaration.returnType.name != "i32") return false;
  let yields = false;
  let index: usize = 0;
  while (index < declaration.body.nodes.length) {
    if (isFrameSchedulerYield(program, declaration.body, index)) yields = true;
    index = index + 1;
  }
  if (!yields) return false;
  for (const root of declaration.body.roots) {
    if (!frameStatementIsSupported(program, declaration.body, root, false, false)) return false;
  }
  return frameTaskLocalsAreJoinOnly(declaration);
}

function frameExpressionSuspends(in tree: ExpressionTree, index: usize): boolean {
  if (tree.nodes[index].kind == ExpressionKind.awaitExpression
    || tree.nodes[index].kind == ExpressionKind.spawnExpression) return true;
  if (tree.nodes[index].kind == ExpressionKind.closureExpression) return false;
  for (const child of tree.nodes[index].children) {
    if (frameExpressionSuspends(tree, child)) return true;
  }
  return false;
}

// The general native async frame: the yield frame's storage and resume model
// for a suspending function every shape tier rejects. It needs no
// scheduler.yield() and takes any result type; the lowerability pass checks
// that the result, parameters, and locals have supported frame storage.
export function functionUsesGeneralFrame(
  in program: Program, in declaration: FunctionDeclaration
): boolean {
  // Borrowed parameters are pointers into the caller's storage, which stays
  // in place while the caller is suspended on this frame.
  if (!declaration.asynchronous || declaration.executorAffinity.byteLength != 0) return false;
  let suspends = false;
  for (const statement of declaration.body.nodes) {
    match (in statement.expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          if (frameExpressionSuspends(tree, tree.root)) suspends = true;
        }
        none => {}
      }
      none => {}
    }
  }
  // A spawned child must not run its body at `task f()`: Stage 0 starts it
  // when the parent suspends. A non-suspending spawned function takes the
  // frame too, so starting it only creates the frame.
  if (!suspends && !programSpawnsFunction(program, declaration.name)) return false;
  for (const root of declaration.body.roots) {
    if (!frameStatementIsSupported(program, declaration.body, root, false, false)) return false;
  }
  return frameTaskLocalsAreJoinOnly(declaration);
}

function bodySpawnsFunction(in body: StatementArena, in name: String): boolean {
  for (const statement of body.nodes) {
    match (in statement.expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          for (const node of tree.nodes) {
            if (node.kind != ExpressionKind.spawnExpression || node.children.length != 1) continue;
            const call = node.children[0];
            if (tree.nodes[call].kind != ExpressionKind.callExpression
              || tree.nodes[call].children.length == 0) continue;
            const callee = tree.nodes[call].children[0];
            if (tree.nodes[callee].kind == ExpressionKind.identifierExpression
              && tree.nodes[callee].value == name) return true;
          }
        }
        none => {}
      }
      none => {}
    }
  }
  return false;
}

// `task name(...)` anywhere in this module.
function programSpawnsFunction(in program: Program, in name: String): boolean {
  for (const candidate of program.functions) {
    if (bodySpawnsFunction(candidate.body, name)) return true;
  }
  for (const aggregate of program.aggregates) {
    for (const method of aggregate.methods) {
      if (bodySpawnsFunction(method.body, name)) return true;
    }
  }
  return false;
}

function nameIsLocalBinding(in declaration: FunctionDeclaration, in name: String): boolean {
  for (const parameter of declaration.parameters) {
    if (parameter.name == name) return true;
  }
  for (const statement of declaration.body.nodes) {
    if (statement.kind == StatementKind.variableStatement && statement.name == name) return true;
  }
  return false;
}

function frameTaskJoinUses(in tree: ExpressionTree, in name: String): usize {
  let count: usize = 0;
  for (const node of tree.nodes) {
    if (node.kind != ExpressionKind.awaitExpression || node.children.length != 1) continue;
    const operand = node.children[0];
    if (tree.nodes[operand].kind == ExpressionKind.identifierExpression
      && tree.nodes[operand].value == name) count = count + 1;
    const receiver = frameTaskCancelReceiver(tree, operand);
    if (receiver < tree.nodes.length && tree.nodes[receiver].value == name) count = count + 1;
  }
  return count;
}

// A spawn's callee is a named function (not a local callable, which other
// tiers own), and a task local is used only by `await t` / `await t.cancel()`:
// its storage is the frame's invocation slot, not a thread-task handle.
function frameTaskLocalsAreJoinOnly(in declaration: FunctionDeclaration): boolean {
  let tasks = Array<String>();
  let spawnIndex: usize = 0;
  while (spawnIndex < declaration.body.nodes.length) {
    const statement = view declaration.body.nodes[spawnIndex];
    let root = false;
    for (const candidate of declaration.body.roots) { if (candidate == spawnIndex) root = true; }
    spawnIndex = spawnIndex + 1;
    match (in statement.expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          if (tree.nodes[tree.root].kind == ExpressionKind.spawnExpression) {
            const call = tree.nodes[tree.root].children[0];
            const callee = tree.nodes[call].children[0];
            if (nameIsLocalBinding(declaration, tree.nodes[callee].value)) return false;
            if (statement.kind == StatementKind.variableStatement) {
              if (!root) return false;
              for (const existing of tasks) { if (existing == statement.name) return false; }
              tasks.push(copy statement.name);
            } else if (statement.kind != StatementKind.expressionStatement) return false;
          }
        }
        none => {}
      }
      none => {}
    }
  }
  for (const statement of declaration.body.nodes) {
    match (in statement.expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          for (const node of tree.nodes) {
            if (node.kind != ExpressionKind.awaitExpression || node.children.length != 1) continue;
            const operand = node.children[0];
            let joined = "";
            if (tree.nodes[operand].kind == ExpressionKind.identifierExpression) joined = copy tree.nodes[operand].value;
            const receiver = frameTaskCancelReceiver(tree, operand);
            if (receiver < tree.nodes.length) joined = copy tree.nodes[receiver].value;
            if (joined.byteLength == 0) continue;
            let known = false;
            for (const task of tasks) { if (task == joined) known = true; }
            if (!known) return false;
          }
          for (const task of tasks) {
            let uses: usize = 0;
            for (const node of tree.nodes) {
              if (node.kind == ExpressionKind.identifierExpression && node.value == task) uses = uses + 1;
            }
            if (uses != frameTaskJoinUses(tree, task)) return false;
          }
        }
        none => {}
      }
      none => {}
    }
    // An assignment value may join a task (`x = await t`) too.
    match (in statement.secondExpression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          for (const node of tree.nodes) {
            if (node.kind != ExpressionKind.awaitExpression || node.children.length != 1) continue;
            const operand = node.children[0];
            if (tree.nodes[operand].kind != ExpressionKind.identifierExpression) continue;
            let known = false;
            for (const task of tasks) { if (task == tree.nodes[operand].value) known = true; }
            if (!known) return false;
          }
          for (const task of tasks) {
            let uses: usize = 0;
            for (const node of tree.nodes) {
              if (node.kind == ExpressionKind.identifierExpression && node.value == task) uses = uses + 1;
            }
            if (uses != frameTaskJoinUses(tree, task)) return false;
          }
        }
        none => {}
      }
      none => {}
    }
  }
  return true;
}

// A `task f(args)` statement anywhere in the body.
export function functionContainsFrameSpawn(in declaration: FunctionDeclaration): boolean {
  let index: usize = 0;
  while (index < declaration.body.nodes.length) {
    if (statementRootIsSpawn(declaration.body, index)) return true;
    index = index + 1;
  }
  return false;
}

// A direct `await delay(ms)` statement anywhere in the body. Native `main`
// has no resumable entry outside the general frame, so this selects it.
export function functionContainsFrameDelay(
  in program: Program, in declaration: FunctionDeclaration
): boolean {
  let index: usize = 0;
  while (index < declaration.body.nodes.length) {
    if (isFrameDelay(program, declaration.body, index)) return true;
    index = index + 1;
  }
  return false;
}
