import { ExpressionKind, ExpressionTree, Program, StatementArena, StatementKind } from "./parser.zs";

// Native lowering may run before a spawned handle has exported type evidence.
// Preserve the constructor's imported identity; a method called `cancel` alone
// is never sufficient to classify a native-thread join.
export function isNativeThreadBinding(
  in program: Program, in arena: StatementArena, in tree: ExpressionTree, index: usize
): boolean {
  const receiver = view tree.nodes[index];
  if (receiver.kind != ExpressionKind.identifierExpression) return false;
  let found = arena.nodes.length;
  let position: usize = 0;
  while (position < arena.nodes.length) {
    const statement = view arena.nodes[position];
    if (statement.kind == StatementKind.variableStatement
      && statement.name == receiver.value && statement.nameOffset < receiver.offset
      && (found == arena.nodes.length || statement.nameOffset > arena.nodes[found].nameOffset)) found = position;
    position = position + 1;
  }
  if (found == arena.nodes.length) return false;
  return match (in arena.nodes[found].expression) {
    some(syntax) => match (in syntax.tree) {
      some(initializer) => {
        const call = view initializer.nodes[initializer.root];
        if (call.kind != ExpressionKind.callExpression || call.children.length != 2) return false;
        const callee = view initializer.nodes[call.children[0]];
        if (callee.kind != ExpressionKind.memberExpression || callee.value != "spawn"
          || callee.children.length != 1) return false;
        const namespace = view initializer.nodes[callee.children[0]];
        if (namespace.kind != ExpressionKind.identifierExpression) return false;
        for (const imported of program.imports) {
          if (imported.header != "std/thread") continue;
          for (const binding of imported.bindings) {
            if (binding.importedName == "thread" && binding.localName == namespace.value) return true;
          }
        }
        return false;
      }
      none => false;
    }
    none => false;
  };
}
