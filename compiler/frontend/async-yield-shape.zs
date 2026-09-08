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

function frameExpressionIsSupported(in tree: ExpressionTree, index: usize): boolean {
  let root = index;
  if ((tree.nodes[root].kind == ExpressionKind.tryExpression
    || tree.nodes[root].kind == ExpressionKind.attemptExpression)
    && tree.nodes[root].children.length == 1) root = tree.nodes[root].children[0];
  if (tree.nodes[root].kind != ExpressionKind.awaitExpression) {
    return frameExpressionIsSynchronous(tree, root);
  }
  if (tree.nodes[root].children.length != 1) return false;
  const call = tree.nodes[root].children[0];
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
  if (isFrameSchedulerYield(program, arena, index)) return !synchronousOnly;
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
          if (!frameExpressionIsSynchronous(tree, subject)) return false;
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
  if (kind == StatementKind.variableStatement
    || kind == StatementKind.destructureStatement) {
    // Keep lexical local storage expansion separate from root frame storage.
    if (nested || arena.nodes[index].arrayBindings.length != 0) return false;
    match (in arena.nodes[index].expression) { some(_) => {} none => return false; }
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
        } else if (kind == StatementKind.ifStatement || kind == StatementKind.whileStatement
          || kind == StatementKind.throwStatement || kind == StatementKind.destructureStatement) {
          if (!frameExpressionIsSynchronous(tree, root)) return false;
        } else if (!frameExpressionIsSupported(tree, root)) return false;
      }
      none => return false;
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (!frameExpressionIsSynchronous(tree, root)) return false;
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
  return true;
}
