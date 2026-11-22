// Shared admission rule for the first general, executor-local yield frame.
// This is an implementation boundary, not a second set of ownership rules.
import {
  ExpressionKind, ExpressionNode, ExpressionTree, FunctionDeclaration, ParameterMode, Program,
  ExpressionSyntax, StatementArena, StatementKind, TypeReference,
} from "./parser.zs";

// Statements of closure bodies and hopped placement blocks: they run in their
// own invocation (a worker thread, a callback, the main executor), not in the
// enclosing function's frame.
export function closureOwnedStatements(in arena: StatementArena): Array<boolean> {
  let pending = Array<usize>();
  for (const statement of arena.nodes) {
    match (in statement.expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => for (const node of tree.nodes) {
          if (node.kind != ExpressionKind.closureExpression && !isMainHopNode(node)) continue;
          for (const owned of node.statements) {
            pending.push(owned);
          }
        }
        none => {}
      }
      none => {}
    }
  }
  let owned = Array<boolean>();
  while (owned.length < arena.nodes.length) {
    owned.push(false);
  }
  let cursor: usize = 0;
  while (cursor < pending.length) {
    const statement = pending[cursor];
    cursor = cursor + 1;
    if (statement >= owned.length || owned[statement]) continue;
    owned[statement] = true;
    for (const child of arena.nodes[statement].children) {
      pending.push(child);
    }
  }
  return owned;
}

// Local names of `thread` imported from std/thread.
export function mainPlacementThreadNames(in program: Program): Array<String> {
  let names = Array<String>();
  for (const imported of program.imports) {
    if (imported.header != "std/thread") continue;
    for (const binding of imported.bindings) {
      if (binding.importedName == "thread") names.push(copy binding.localName);
    }
  }
  return names;
}

// The call of `await|task on thread.main call(...)`, or the tree length.
function mainPlacementCall(in tree: ExpressionTree, index: usize, in threadNames: Array<String>): usize {
  const node = view tree.nodes[index];
  if (node.kind != ExpressionKind.executorPlacementExpression || node.labels.length < 3
    || node.labels[2] != "call" || node.children.length != 3) return tree.nodes.length;
  const executor = node.children[1];
  if (tree.nodes[executor].kind != ExpressionKind.memberExpression || tree.nodes[executor].value != "main"
    || tree.nodes[executor].children.length != 1) return tree.nodes.length;
  const namespace = tree.nodes[executor].children[0];
  if (tree.nodes[namespace].kind != ExpressionKind.identifierExpression) return tree.nodes.length;
  let threadBinding = false;
  for (const name of threadNames) {
    if (name == tree.nodes[namespace].value) threadBinding = true;
  }
  if (!threadBinding) return tree.nodes.length;
  const call = node.children[2];
  if (tree.nodes[call].kind != ExpressionKind.callExpression) return tree.nodes.length;
  return call;
}

// `await on thread.main using (...) { ... }`: a synchronous placed block.
function mainPlacementBlock(in tree: ExpressionTree, index: usize, in threadNames: Array<String>): boolean {
  return mainPlacementBlockOf(tree, index, threadNames, "await");
}

// `await|task on thread.main { ... }` with the given mode.
function mainPlacementBlockOf(
  in tree: ExpressionTree, index: usize, in threadNames: Array<String>, in mode: String
): boolean {
  const node = view tree.nodes[index];
  if (node.kind != ExpressionKind.executorPlacementExpression || node.value != mode
    || node.labels.length < 3 || node.labels[2] != "" || node.children.length < 2) return false;
  const executor = node.children[1];
  if (tree.nodes[executor].kind != ExpressionKind.memberExpression || tree.nodes[executor].value != "main"
    || tree.nodes[executor].children.length != 1) return false;
  const namespace = tree.nodes[executor].children[0];
  if (tree.nodes[namespace].kind != ExpressionKind.identifierExpression) return false;
  for (const name of threadNames) {
    if (name == tree.nodes[namespace].value) return true;
  }
  return false;
}

// A tree with its main placements replaced by the placed operations; none
// when it has none. Nodes inside closures keep their placements. A placed
// block becomes `inline` (it runs where it is); its statements are reported.
function normalizedPlacementTree(
  in tree: ExpressionTree, in threadNames: Array<String>, in asyncCallOffsets: Array<usize>,
  inout inlineStatements: Array<usize>
): Option<ExpressionTree> {
  let reachable = Array<usize>();
  reachable.push(tree.root);
  let cursor: usize = 0;
  while (cursor < reachable.length) {
    const index = reachable[cursor];
    cursor = cursor + 1;
    if (tree.nodes[index].kind == ExpressionKind.closureExpression) continue;
    for (const child of tree.nodes[index].children) {
      reachable.push(child);
    }
  }
  let updated = copy tree;
  let changed = false;
  for (const index of reachable) {
    if (mainPlacementBlock(tree, index, threadNames)) {
      updated.nodes[index].value = "inline";
      for (const statement of tree.nodes[index].statements) {
        inlineStatements.push(statement);
      }
      changed = true;
      continue;
    }
    const call = mainPlacementCall(tree, index, threadNames);
    if (call >= tree.nodes.length) continue;
    let asyncCall = false;
    for (const offset of asyncCallOffsets) {
      if (offset == tree.nodes[call].offset) asyncCall = true;
    }
    if (asyncCall) {
      // `await f()` / `task f()`, keeping the placement's position and type.
      updated.nodes[index].kind = tree.nodes[index].value == "spawn"
        ? ExpressionKind.spawnExpression
        : ExpressionKind.awaitExpression;
      updated.nodes[index].value = "";
      updated.nodes[index].children = Array<usize>(call);
      updated.nodes[index].labels = Array<String>();
      updated.nodes[index].statements = Array<usize>();
      updated.nodes[index].typeReferences = Array<TypeReference>();
      changed = true;
    } else if (tree.nodes[index].value == "await") {
      // A synchronous function placed where it already runs is a plain call.
      updated.nodes[index] = copy tree.nodes[call];
      changed = true;
    }
  }
  if (!changed) return Option<ExpressionTree>.none;
  return Option.some(updated);
}

function collectForeignStatements(in tree: ExpressionTree, inout pending: Array<usize>): void {
  for (const node of tree.nodes) {
    // Closure bodies may run on another thread; a placed block is 3b's tier.
    if (node.kind == ExpressionKind.closureExpression || node.kind == ExpressionKind.executorPlacementExpression) {
      for (const statement of node.statements) {
        pending.push(statement);
      }
    }
  }
}

// `await on thread.main { ... }` or `await on thread.main f(...)` outside
// `main`: the operand of an `await` that runs the block or call on the main
// executor (a lifted function hopped there).
export function isMainHopNode(in node: ExpressionNode): boolean {
  return node.kind == ExpressionKind.executorPlacementExpression && node.value == "hop";
}

// Rewrites each placed block `await on thread.main { ... }` and placed call
// `await on thread.main f(...)` into `await <hop>`, and the `task` forms into
// `task <hop>`: the hop node keeps the placement's offset, labels, children,
// and statements, so its checked type, captures, and body (or call) stay
// attached. Code
// outside `main` may run on any executor; the hop is correct on each (on the
// main executor it awaits the block's frame directly). Closure bodies keep
// their placements: they are lowered as their own functions.
export function normalizeMainHops(inout body: StatementArena, in threadNames: Array<String>): boolean {
  if (threadNames.length == 0) return false;
  const owned = closureOwnedStatements(body);
  let changed = false;
  let index: usize = 0;
  while (index < body.nodes.length) {
    if (owned[index]) {
      index = index + 1;
      continue;
    }
    let expression = Option<ExpressionSyntax>.none;
    match (in body.nodes[index].expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => match (hoppedPlacementTree(tree, threadNames)) {
          some(updated) => {
            let replaced = copy syntax;
            replaced.tree = Option.some(updated);
            expression = Option.some(replaced);
          }
          none => {}
        }
        none => {}
      }
      none => {}
    }
    match (expression) {
      some(replaced) => {
        body.nodes[index].expression = Option.some(replaced);
        changed = true;
      }
      none => {}
    }
    index = index + 1;
  }
  return changed;
}

function hoppedPlacementTree(in tree: ExpressionTree, in threadNames: Array<String>): Option<ExpressionTree> {
  let reachable = Array<usize>();
  reachable.push(tree.root);
  let cursor: usize = 0;
  while (cursor < reachable.length) {
    const index = reachable[cursor];
    cursor = cursor + 1;
    if (tree.nodes[index].kind == ExpressionKind.closureExpression) continue;
    for (const child of tree.nodes[index].children) {
      reachable.push(child);
    }
  }
  let updated = copy tree;
  let changed = false;
  for (const index of reachable) {
    const spawned = tree.nodes[index].value == "spawn";
    if (!spawned && tree.nodes[index].value != "await") continue;
    const placedCall = mainPlacementCall(tree, index, threadNames) < tree.nodes.length;
    if (!mainPlacementBlockOf(tree, index, threadNames, tree.nodes[index].value) && !placedCall) continue;
    let hop = copy tree.nodes[index];
    hop.value = "hop";
    const hopIndex = updated.nodes.length;
    updated.nodes.push(move hop);
    // `task on thread.main ...` spawns the hopped work as a child.
    updated.nodes[index].kind = spawned ? ExpressionKind.spawnExpression : ExpressionKind.awaitExpression;
    updated.nodes[index].value = "";
    updated.nodes[index].children = Array<usize>(hopIndex);
    updated.nodes[index].labels = Array<String>();
    updated.nodes[index].statements = Array<usize>();
    updated.nodes[index].typeReferences = Array<TypeReference>();
    changed = true;
  }
  if (!changed) return Option<ExpressionTree>.none;
  return Option.some(updated);
}

// An async `thread.spawn` worker body runs as a lifted general frame unless it
// is one terminal `return await f()`.
export function threadWorkerNeedsFrame(in arena: StatementArena, in statements: Array<usize>): boolean {
  if (statements.length != 1) return true;
  const only = view arena.nodes[statements[0]];
  if (only.kind != StatementKind.returnStatement) return true;
  return match (in only.expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => tree.nodes[tree.root].kind != ExpressionKind.awaitExpression;
      none => true;
    }
    none => true;
  };
}

// A statement suspends somewhere in it: its expressions, the statements its
// expressions own (value blocks, match arms), or its child statements.
function statementTreeSuspends(in arena: StatementArena, index: usize): boolean {
  const kind = arena.nodes[index].kind;
  if (kind == StatementKind.yieldStatement || kind == StatementKind.forAwaitStatement
    || kind == StatementKind.forTryAwaitStatement || kind == StatementKind.asyncScopeStatement) return true;
  match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        if (frameExpressionSuspends(tree, tree.root)) return true;
        for (const node of tree.nodes) {
          if (node.kind == ExpressionKind.closureExpression) continue;
          for (const owned of node.statements) {
            if (statementTreeSuspends(arena, owned)) return true;
          }
        }
      }
      none => {}
    }
    none => {}
  }
  for (const child of arena.nodes[index].children) {
    if (statementTreeSuspends(arena, child)) return true;
  }
  return false;
}

// A main-affine async function whose suspensions are all top-level delays
// with only plain statements ahead of them keeps its linear delay-segment
// tier, which both main callers and the worker-to-main bridge run. Any other
// suspending shape takes the general frame when it fits; the bridge's
// loop/if/match segments remain only for bodies the general frame does not
// take yet.
export function mainAffineUsesGeneralFrame(in program: Program, in declaration: FunctionDeclaration): boolean {
  if (!declaration.asynchronous || declaration.executorAffinity != "thread.main") return false;
  if (functionContainsFrameDelay(program, declaration)) {
    let linear = true;
    let structured = false;
    for (const root of declaration.body.roots) {
      const kind = declaration.body.nodes[root].kind;
      const control = kind == StatementKind.whileStatement || kind == StatementKind.ifStatement
        || kind == StatementKind.matchStatement;
      // The delay tier resumes neither into control flow nor past it.
      if ((control || structured) && statementTreeSuspends(declaration.body, root)) linear = false;
      if (kind != StatementKind.expressionStatement && kind != StatementKind.variableStatement
        && kind != StatementKind.assignmentStatement) structured = true;
    }
    if (linear) return false;
  }
  return functionUsesGeneralFrame(program, declaration);
}

// A synchronous worker body that spawns work onto main (`task on thread.main
// ...` directly in the closure, as Stage 0 allows) runs as a lifted frame
// too: the frame joins that child before the worker completes.
export function workerBodySpawnsOnMain(
  in arena: StatementArena, in statements: Array<usize>, in threadNames: Array<String>
): boolean {
  for (const statement of statements) {
    const spawns = match (in arena.nodes[statement].expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => tree.nodes[tree.root].kind == ExpressionKind.executorPlacementExpression
          && tree.nodes[tree.root].value == "spawn"
          && (mainPlacementBlockOf(tree, tree.root, threadNames, "spawn")
            || mainPlacementCall(tree, tree.root, threadNames) < tree.nodes.length);
        none => false;
      }
      none => false;
    };
    if (spawns) return true;
  }
  return false;
}

// A `task on thread.main ...` statement owned by a closure that is not itself
// a `thread.spawn` worker body (a closure nested in one): the statement's
// index, or the arena's length. Such a closure runs as a plain function,
// which has no frame to own the child.
export function nestedClosureMainTask(in arena: StatementArena, in threadNames: Array<String>): usize {
  for (const statement of arena.nodes) {
    const found = match (in statement.expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          let workers = Array<usize>();
          let index: usize = 0;
          while (index < tree.nodes.length) {
            if (isThreadSpawnCall(tree, index, threadNames) && tree.nodes[index].children.length == 2) {
              workers.push(tree.nodes[index].children[1]);
            }
            index = index + 1;
          }
          let offender = arena.nodes.length;
          index = 0;
          while (index < tree.nodes.length) {
            let worker = false;
            for (const candidate of workers) {
              if (candidate == index) worker = true;
            }
            if (tree.nodes[index].kind == ExpressionKind.closureExpression && !worker) {
              let pending = copy tree.nodes[index].statements;
              let cursor: usize = 0;
              while (cursor < pending.length) {
                const owned = pending[cursor];
                cursor = cursor + 1;
                const spawns = match (in arena.nodes[owned].expression) {
                  some(ownedSyntax) => match (in ownedSyntax.tree) {
                    some(ownedTree) => ownedTree.nodes[ownedTree.root].kind == ExpressionKind.executorPlacementExpression
                      && ownedTree.nodes[ownedTree.root].value == "spawn";
                    none => false;
                  }
                  none => false;
                };
                if (spawns) offender = owned;
                for (const child of arena.nodes[owned].children) {
                  pending.push(child);
                }
              }
            }
            index = index + 1;
          }
          select offender;
        }
        none => arena.nodes.length;
      }
      none => arena.nodes.length;
    };
    if (found < arena.nodes.length) return found;
  }
  return arena.nodes.length;
}

// Whether a `thread.spawn` block closure's body runs as a lifted frame.
export function workerClosureLifts(
  in arena: StatementArena, in tree: ExpressionTree, closure: usize, in threadNames: Array<String>
): boolean {
  if (tree.nodes[closure].kind != ExpressionKind.closureExpression
    || tree.nodes[closure].labels.length < 3 || tree.nodes[closure].labels[2] != "block") return false;
  const asynchronous = tree.nodes[closure].labels.length >= 4 && tree.nodes[closure].labels[3] == "async";
  if (asynchronous) return threadWorkerNeedsFrame(arena, tree.nodes[closure].statements);
  return workerBodySpawnsOnMain(arena, tree.nodes[closure].statements, threadNames);
}

// The statements of async worker bodies that run as lifted frames, where
// lowering hops their placements: rewrites those placements as
// normalizeMainHops does for a whole function.
// `keptClosures` are closure offsets lowering does not lift (a worker that
// captures a `TaskScope` keeps its own tier).
export function normalizeWorkerHops(
  inout body: StatementArena, in threadNames: Array<String>, in keptClosures: Array<usize>
): boolean {
  if (threadNames.length == 0) return false;
  let pending = Array<usize>();
  for (const statement of body.nodes) {
    match (in statement.expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          let index: usize = 0;
          while (index < tree.nodes.length) {
            if (isThreadSpawnCall(tree, index, threadNames) && tree.nodes[index].children.length == 2) {
              const closure = tree.nodes[index].children[1];
              let kept = false;
              for (const offset of keptClosures) {
                if (offset == tree.nodes[closure].offset) kept = true;
              }
              if (!kept && workerClosureLifts(body, tree, closure, threadNames)) {
                for (const owned of tree.nodes[closure].statements) {
                  pending.push(owned);
                }
              }
            }
            index = index + 1;
          }
        }
        none => {}
      }
      none => {}
    }
  }
  let changed = false;
  let seen = Array<boolean>();
  while (seen.length < body.nodes.length) {
    seen.push(false);
  }
  let cursor: usize = 0;
  while (cursor < pending.length) {
    const statement = pending[cursor];
    cursor = cursor + 1;
    if (statement >= seen.length || seen[statement]) continue;
    seen[statement] = true;
    for (const child of body.nodes[statement].children) {
      pending.push(child);
    }
    let expression = Option<ExpressionSyntax>.none;
    match (in body.nodes[statement].expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => match (hoppedPlacementTree(tree, threadNames)) {
          some(updated) => {
            let replaced = copy syntax;
            replaced.tree = Option.some(updated);
            expression = Option.some(replaced);
          }
          none => {}
        }
        none => {}
      }
      none => {}
    }
    match (expression) {
      some(replaced) => {
        body.nodes[statement].expression = Option.some(replaced);
        changed = true;
      }
      none => {}
    }
  }
  return changed;
}

// Placement onto `thread.main` from code already on the main executor is the
// placed operation itself, as in Stage 0: `await on thread.main f()` awaits
// `f` (or calls it when `f` is synchronous) and `task on thread.main f()`
// spawns it. Statements in closure bodies keep their placements: a closure
// may run on a worker thread.
export function normalizeMainPlacements(
  inout body: StatementArena, in threadNames: Array<String>, in asyncCallOffsets: Array<usize>
): void {
  if (threadNames.length == 0) return;
  let pending = Array<usize>();
  for (const statement of body.nodes) {
    match (in statement.expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => collectForeignStatements(tree, inout pending);
        none => {}
      }
      none => {}
    }
    match (in statement.secondExpression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => collectForeignStatements(tree, inout pending);
        none => {}
      }
      none => {}
    }
  }
  let foreign = Array<boolean>();
  while (foreign.length < body.nodes.length) {
    foreign.push(false);
  }
  let cursor: usize = 0;
  while (cursor < pending.length) {
    const statement = pending[cursor];
    cursor = cursor + 1;
    if (statement >= foreign.length || foreign[statement]) continue;
    foreign[statement] = true;
    for (const child of body.nodes[statement].children) {
      pending.push(child);
    }
  }
  let inlineStatements = Array<usize>();
  let index: usize = 0;
  while (index < body.nodes.length) {
    if (!foreign[index]) {
      let expression = Option<ExpressionSyntax>.none;
      match (in body.nodes[index].expression) {
        some(syntax) => match (in syntax.tree) {
          some(tree) => match (normalizedPlacementTree(tree, threadNames, asyncCallOffsets, inout inlineStatements)) {
            some(updated) => {
              let replaced = copy syntax;
              replaced.tree = Option.some(updated);
              expression = Option.some(replaced);
            }
            none => {}
          }
          none => {}
        }
        none => {}
      }
      match (expression) {
        some(replaced) => body.nodes[index].expression = Option.some(replaced);
        none => {}
      }
      let second = Option<ExpressionSyntax>.none;
      match (in body.nodes[index].secondExpression) {
        some(syntax) => match (in syntax.tree) {
          some(tree) => match (normalizedPlacementTree(tree, threadNames, asyncCallOffsets, inout inlineStatements)) {
            some(updated) => {
              let replaced = copy syntax;
              replaced.tree = Option.some(updated);
              second = Option.some(replaced);
            }
            none => {}
          }
          none => {}
        }
        none => {}
      }
      match (second) {
        some(replaced) => body.nodes[index].secondExpression = Option.some(replaced);
        none => {}
      }
    }
    index = index + 1;
  }
  // An inline block's helper returns the value its own `select` produces
  // (selects inside its match arms still select arm values).
  let blockCursor: usize = 0;
  while (blockCursor < inlineStatements.length) {
    const statement = inlineStatements[blockCursor];
    blockCursor = blockCursor + 1;
    if (body.nodes[statement].kind == StatementKind.selectStatement) {
      body.nodes[statement].kind = StatementKind.returnStatement;
    }
    for (const child of body.nodes[statement].children) {
      inlineStatements.push(child);
    }
  }
}

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
  // A placed block `main` runs where it is: a synchronous helper call.
  if (kind == ExpressionKind.executorPlacementExpression && tree.nodes[index].value == "inline") return true;
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

// A child's callee: a named function, or a method on a synchronous receiver.
function frameCalleeIsSupported(in tree: ExpressionTree, callee: usize): boolean {
  if (tree.nodes[callee].kind == ExpressionKind.identifierExpression) return true;
  return tree.nodes[callee].kind == ExpressionKind.memberExpression
    && tree.nodes[callee].children.length == 1
    && frameExpressionIsSynchronous(tree, tree.nodes[callee].children[0]);
}

// An await that a frame can run before its statement: a named call with
// synchronous arguments, or a task-local join.
function frameAwaitOperandIsSupported(in tree: ExpressionTree, index: usize): boolean {
  if (tree.nodes[index].children.length != 1) return false;
  const operand = tree.nodes[index].children[0];
  if (tree.nodes[operand].kind == ExpressionKind.identifierExpression) return true;
  if (isMainHopNode(tree.nodes[operand])) return true;
  if (frameTaskCancelReceiver(tree, operand) < tree.nodes.length) return false;
  if (tree.nodes[operand].kind != ExpressionKind.callExpression
    || tree.nodes[operand].children.length == 0) return false;
  if (!frameCalleeIsSupported(tree, tree.nodes[operand].children[0])) return false;
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
  if (isMainHopNode(tree.nodes[call])) return true;
  if (tree.nodes[call].kind != ExpressionKind.callExpression
    || tree.nodes[call].children.length == 0) return false;
  const callee = tree.nodes[call].children[0];
  if (!frameCalleeIsSupported(tree, callee)) return false;
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
  if (isMainHopNode(tree.nodes[call])) return true;
  if (frameTaskCancelReceiver(tree, call) < tree.nodes.length) return true;
  if (tree.nodes[call].kind != ExpressionKind.callExpression
    || tree.nodes[call].children.length == 0) return false;
  const callee = tree.nodes[call].children[0];
  // A named function or a method, with already checked arguments.
  if (!frameCalleeIsSupported(tree, callee)) return false;
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
  // An async generator's `yield` completes the current advancement and
  // suspends the frame until the next `next()`.
  // `for await` suspends on each step; its iterable is evaluated once, before.
  if (kind == StatementKind.forAwaitStatement || kind == StatementKind.forTryAwaitStatement) {
    if (synchronousOnly || arena.nodes[index].objectBindings.length > 0) return false;
    const iterableIsSynchronous = match (in arena.nodes[index].expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => frameExpressionIsSynchronous(tree, tree.root);
        none => false;
      }
      none => false;
    };
    if (!iterableIsSynchronous) return false;
    for (const child of arena.nodes[index].children) {
      if (!frameStatementIsSupported(program, arena, child, true, false)) return false;
    }
    return true;
  }
  if (kind == StatementKind.yieldStatement) {
    if (synchronousOnly) return false;
    return match (in arena.nodes[index].expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => frameExpressionIsSynchronous(tree, tree.root);
        none => false;
      }
      none => false;
    };
  }
  // Match-initialized root owners use the same non-suspending arm lowering as
  // statement matches. The selected value becomes live only after the match;
  // an arm that returns/throws never initializes the destination frame slot.
  let matchInitializer = false;
  // `return match (...) { ... }` selects into the frame result the same way.
  if ((kind == StatementKind.variableStatement && !nested) || kind == StatementKind.returnStatement) {
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
            // Destructured payload patterns need their own frame tier.
            if (tree.nodes[arm].labels[0] != "none"
              && tree.nodes[arm].labels[0] != "binding") return false;
            // Arms may suspend: a suspending arm's payload lives in the frame.
            for (const child of tree.nodes[arm].statements) {
              if (!frameStatementIsSupported(program, arena, child, true, synchronousOnly)) return false;
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
    // A scope's own statements are frame-level: its locals (including task
    // locals) live in the frame and are released when the scope exits, after
    // its children are joined.
    for (const child of arena.nodes[block].children) {
      const local = arena.nodes[child].kind == StatementKind.variableStatement;
      if (statementRootIsSpawn(arena, child) || local) {
        if (!frameStatementIsSupported(program, arena, child, false, false)) return false;
      } else if (!frameStatementIsSupported(program, arena, child, true, false)) return false;
    }
    return true;
  }
  if (kind == StatementKind.variableStatement
    || kind == StatementKind.destructureStatement) {
    // A nested local takes a frame slot like a root one; its live flag and
    // lexical cleanup carry it across suspensions inside its block.
    // Destructuring stays root-only.
    if ((nested && kind == StatementKind.destructureStatement)
      || arena.nodes[index].arrayBindings.length != 0) return false;
    // `let x: T;` is zeroed frame storage whose live flag starts false.
    match (in arena.nodes[index].expression) {
      some(_) => {}
      none => return kind == StatementKind.variableStatement;
    }
  } else if (kind != StatementKind.returnStatement
    && kind != StatementKind.selectStatement
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
        // A whole assigned value's synchronous `try`/`attempt` propagates as
        // an initializer's does.
        let value = root;
        if (kind == StatementKind.assignmentStatement
          && (tree.nodes[root].kind == ExpressionKind.tryExpression
            || tree.nodes[root].kind == ExpressionKind.attemptExpression)
          && tree.nodes[root].children.length == 1
          && frameExpressionIsSynchronous(tree, tree.nodes[root].children[0])) {
          value = tree.nodes[root].children[0];
        }
        if (synchronousOnly) {
          if (!frameExpressionIsSynchronous(tree, value)) return false;
        } else if (!frameExpressionHoistsAwaits(tree, value)) return false;
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
  const threadNames = mainPlacementThreadNames(program);
  return frameTaskLocalsAreJoinOnly(declaration, threadNames);
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
  // A main-affine function's frame runs on the main executor: its callers are
  // there, or hop there.
  if (!declaration.asynchronous || (declaration.executorAffinity.byteLength != 0
    && declaration.executorAffinity != "thread.main")) return false;
  const closureOwned = closureOwnedStatements(declaration.body);
  let suspends = false;
  let suspendIndex: usize = 0;
  for (const statement of declaration.body.nodes) {
    suspendIndex = suspendIndex + 1;
    if (closureOwned[suspendIndex - 1]) continue;
    if (statement.kind == StatementKind.yieldStatement || statement.kind == StatementKind.forAwaitStatement
      || statement.kind == StatementKind.forTryAwaitStatement) suspends = true;
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
  // A lifted body (a worker, a hopped block) is started on one thread and
  // run on another: starting it must only create the frame.
  if (!suspends && !programSpawnsFunction(program, declaration.name)
    && declaration.liftedFromOffset == 0) return false;
  if (!frameLocalNamesAreUnique(declaration)) return false;
  for (const root of declaration.body.roots) {
    if (!frameStatementIsSupported(program, declaration.body, root, false, false)) return false;
  }
  const threadNames = mainPlacementThreadNames(program);
  return frameTaskLocalsAreJoinOnly(declaration, threadNames);
}

// Frame storage is named by binding: locals and parameters must not repeat.
function frameLocalNamesAreUnique(in declaration: FunctionDeclaration): boolean {
  let names = Array<String>();
  for (const parameter of declaration.parameters) { names.push(copy parameter.name); }
  // A `for await` binding lives in the frame too; loops may share one.
  let loopNames = Array<String>();
  const closureOwned = closureOwnedStatements(declaration.body);
  let statementIndex: usize = 0;
  for (const statement of declaration.body.nodes) {
    statementIndex = statementIndex + 1;
    if (closureOwned[statementIndex - 1]) continue;
    if (statement.kind == StatementKind.forAwaitStatement || statement.kind == StatementKind.forTryAwaitStatement) {
      let seen = false;
      for (const name of loopNames) { if (name == statement.name) seen = true; }
      if (!seen) loopNames.push(copy statement.name);
      continue;
    }
    if (statement.kind != StatementKind.variableStatement) continue;
    for (const name of names) { if (name == statement.name) return false; }
    names.push(copy statement.name);
  }
  for (const loopName of loopNames) {
    for (const name of names) { if (name == loopName) return false; }
  }
  return true;
}

function bodySpawnsFunction(in body: StatementArena, in name: String): boolean {
  for (const statement of body.nodes) {
    match (in statement.expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          for (const node of tree.nodes) {
            // `task on thread.main f()` spawns `f` too.
            let call = tree.nodes.length;
            if (node.kind == ExpressionKind.spawnExpression && node.children.length == 1) call = node.children[0];
            if (node.kind == ExpressionKind.executorPlacementExpression && node.value == "spawn"
              && node.children.length == 3) call = node.children[2];
            if (call >= tree.nodes.length) continue;
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
// `const t = thread.spawn(...)`: a worker the frame joins like a child.
function isThreadSpawnCall(in tree: ExpressionTree, index: usize, in threadNames: Array<String>): boolean {
  if (tree.nodes[index].kind != ExpressionKind.callExpression || tree.nodes[index].children.length == 0) return false;
  const callee = tree.nodes[index].children[0];
  if (tree.nodes[callee].kind != ExpressionKind.memberExpression || tree.nodes[callee].value != "spawn"
    || tree.nodes[callee].children.length != 1) return false;
  const namespace = tree.nodes[callee].children[0];
  if (tree.nodes[namespace].kind != ExpressionKind.identifierExpression) return false;
  for (const name of threadNames) {
    if (name == tree.nodes[namespace].value) return true;
  }
  return false;
}

function frameTaskLocalsAreJoinOnly(in declaration: FunctionDeclaration, in threadNames: Array<String>): boolean {
  let tasks = Array<String>();
  // Frame-level statements: roots and the direct statements of unnamed scopes.
  let frameLevel = copy declaration.body.roots;
  for (const statement of declaration.body.nodes) {
    if (statement.kind != StatementKind.asyncScopeStatement || statement.children.length != 1) continue;
    for (const child of declaration.body.nodes[statement.children[0]].children) { frameLevel.push(child); }
  }
  const closureOwned = closureOwnedStatements(declaration.body);
  let spawnIndex: usize = 0;
  while (spawnIndex < declaration.body.nodes.length) {
    const statement = view declaration.body.nodes[spawnIndex];
    let root = false;
    for (const candidate of frameLevel) { if (candidate == spawnIndex) root = true; }
    spawnIndex = spawnIndex + 1;
    if (closureOwned[spawnIndex - 1]) continue;
    match (in statement.expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          // A root worker local is joined like a spawn local.
          if (root && statement.kind == StatementKind.variableStatement
            && isThreadSpawnCall(tree, tree.root, threadNames)) {
            for (const existing of tasks) { if (existing == statement.name) return false; }
            tasks.push(copy statement.name);
          }
          if (tree.nodes[tree.root].kind == ExpressionKind.spawnExpression) {
            const call = tree.nodes[tree.root].children[0];
            const callee = tree.nodes[call].children[0];
            if (tree.nodes[callee].kind == ExpressionKind.identifierExpression
              && nameIsLocalBinding(declaration, tree.nodes[callee].value)) return false;
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
  let joinIndex: usize = 0;
  for (const statement of declaration.body.nodes) {
    joinIndex = joinIndex + 1;
    if (closureOwned[joinIndex - 1]) continue;
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
// `await stream.next()` or `for await`: only the general frame resumes an
// async generator's stream (any `.next()` await counts; a class method named
// `next` also runs there).
export function functionAwaitsStreamStep(in declaration: FunctionDeclaration): boolean {
  if (!declaration.asynchronous) return false;
  for (const statement of declaration.body.nodes) {
    if (statement.kind == StatementKind.forAwaitStatement
      || statement.kind == StatementKind.forTryAwaitStatement) return true;
    match (in statement.expression) {
      some(syntax) => match (in syntax.tree) {
        some(tree) => {
          for (const node of tree.nodes) {
            if (node.kind != ExpressionKind.awaitExpression || node.children.length != 1) continue;
            const call = view tree.nodes[node.children[0]];
            if (call.kind != ExpressionKind.callExpression || call.children.length != 1) continue;
            const callee = view tree.nodes[call.children[0]];
            if (callee.kind == ExpressionKind.memberExpression && callee.value == "next") return true;
          }
        }
        none => {}
      }
      none => {}
    }
  }
  return false;
}

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
