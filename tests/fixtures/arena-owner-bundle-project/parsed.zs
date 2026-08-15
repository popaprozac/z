import { Arena } from "std/memory";

struct SyntaxNode {
  value: i32;
}

struct NodeRef {
  node: view SyntaxNode;
}

export readonly struct ParsedFile {
  arena: Arena;
  roots: Array<NodeRef>;
}

export function parseValue(value: i32): ParsedFile {
  let arena = Arena();
  const node = arena.create(SyntaxNode({ value }));
  const roots = Array<NodeRef>(NodeRef({ node }));
  return ParsedFile({ arena: move arena, roots: move roots });
}

export function inspect(in parsed: ParsedFile): i32 {
  const root = parsed.roots[0];
  const node = root.node;
  return node.value;
}
