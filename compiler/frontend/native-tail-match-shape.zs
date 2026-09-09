import { ExpressionKind, ExpressionTree, FunctionDeclaration, StatementArena, StatementKind } from "./parser.zs";

function treeSuspends(in arena: StatementArena, in tree: ExpressionTree, index: usize): boolean {
  const node = view tree.nodes[index];
  if (node.kind == ExpressionKind.closureExpression) return false;
  if (node.kind == ExpressionKind.awaitExpression || node.kind == ExpressionKind.executorPlacementExpression) return true;
  for (const child of node.children) {
    if (treeSuspends(arena, tree, child)) return true;
  }
  for (const statement of node.statements) {
    if (statementSuspends(arena, statement)) return true;
  }
  return false;
}

function statementSuspends(in arena: StatementArena, index: usize): boolean {
  if (arena.nodes[index].kind == StatementKind.asyncScopeStatement
    || arena.nodes[index].kind == StatementKind.forAwaitStatement
    || arena.nodes[index].kind == StatementKind.forTryAwaitStatement) return true;
  match (in arena.nodes[index].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (treeSuspends(arena, tree, root)) return true;
      }
      none => {}
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (treeSuspends(arena, tree, root)) return true;
      }
      none => {}
    }
    none => {}
  }
  for (const child of arena.nodes[index].children) {
    if (statementSuspends(arena, child)) return true;
  }
  return false;
}

// These arms already lower to ordinary returns. Recognize that same value
// destination before lowering instead of requiring redundant source `return`s.
// None means the suspension needs a broader continuation, not zero awaits.
function terminalAwaitCount(in arena: StatementArena, index: usize, propagating: boolean): Option<usize> {
  if (!statementSuspends(arena, index)) return Option.some(0);
  const statement = view arena.nodes[index];
  if (statement.kind == StatementKind.blockStatement) {
    if (statement.children.length != 1) return Option<usize>.none;
    return terminalAwaitCount(arena, statement.children[0], propagating);
  }
  if (statement.kind != StatementKind.returnStatement
    && statement.kind != StatementKind.expressionStatement
    && statement.kind != StatementKind.selectStatement
    && statement.kind != StatementKind.matchStatement) return Option<usize>.none;
  return match (in statement.expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        select terminalTreeAwaitCount(arena, tree, root, propagating);
      }
      none => Option<usize>.none;
    }
    none => Option<usize>.none;
  };
}

function terminalTreeAwaitCount(in arena: StatementArena, in tree: ExpressionTree, index: usize, propagating: boolean): Option<usize> {
  const node = view tree.nodes[index];
  if (node.kind == ExpressionKind.matchExpression) {
    if (node.value == "in" || node.children.length < 2) return Option<usize>.none;
    if (treeSuspends(arena, tree, node.children[0])) return Option<usize>.none;
    let total: usize = 0;
    let position: usize = 1;
    while (position < node.children.length) {
      const arm = view tree.nodes[node.children[position]];
      if (arm.statements.length != 1 || arm.children.length > 1) return Option<usize>.none;
      if (arm.children.length == 1 && tree.nodes[arm.children[0]].kind != ExpressionKind.matchBindingExpression) return Option<usize>.none;
      const body = arm.statements[0];
      const count = match (terminalAwaitCount(arena, body, propagating)) {
        some(count) => count;
        none => return Option<usize>.none;
      };
      total = total + count;
      position = position + 1;
    }
    return Option.some(total);
  }
  let awaited = index;
  if (propagating && node.kind != ExpressionKind.tryExpression) return Option<usize>.none;
  if (node.kind == ExpressionKind.tryExpression && node.children.length == 1) awaited = node.children[0];
  if (tree.nodes[awaited].kind != ExpressionKind.awaitExpression || tree.nodes[awaited].children.length != 1) return Option<usize>.none;
  const call = view tree.nodes[tree.nodes[awaited].children[0]];
  if (call.kind != ExpressionKind.callExpression || call.children.length == 0) return Option<usize>.none;
  const callee = view tree.nodes[call.children[0]];
  if (callee.kind != ExpressionKind.identifierExpression && callee.kind != ExpressionKind.memberExpression) return Option<usize>.none;
  for (const child of call.children) {
    if (treeSuspends(arena, tree, child)) return Option<usize>.none;
  }
  return Option.some(1);
}

export function functionUsesReturnedMatchTailAwait(in declaration: FunctionDeclaration): boolean {
  if (declaration.body.roots.length != 1) return false;
  const statementRoot = declaration.body.roots[0];
  if (declaration.body.nodes[statementRoot].kind != StatementKind.returnStatement) return false;
  const propagating = match (in declaration.errorType) { some(_) => true; none => false; };
  return match (in declaration.body.nodes[statementRoot].expression) {
    some(syntax) => match (in syntax.tree) {
      some(tree) => {
        const root = tree.root;
        if (tree.nodes[root].kind != ExpressionKind.matchExpression) return false;
        select match (terminalTreeAwaitCount(declaration.body, tree, root, propagating)) {
          some(count) => count == 1;
          none => false;
        };
      }
      none => false;
    }
    none => false;
  };
}
