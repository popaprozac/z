import { Arena as Region } from "std/memory";

struct SyntaxNode {
  value: i32;
}

struct NodeRef {
  node: view SyntaxNode;
}

readonly struct ParsedFile {
  arena: Region;
  roots: Array<NodeRef>;
}

function parseValue(value: i32): ParsedFile {
  let arena = Region({ initialCapacity: 256 });
  const node = arena.create(SyntaxNode({ value }));
  const root = NodeRef({ node });
  const roots = Array<NodeRef>(root);
  return ParsedFile({ arena: move arena, roots: move roots });
}

function inspect(in parsed: ParsedFile): i32 {
  const root = parsed.roots[0];
  const node = root.node;
  return node.value;
}

function consume(parsed: ParsedFile): i32 {
  return inspect(in parsed);
}

function main(): i32 {
  const parsed = parseValue(42);
  return consume(move parsed) - 42;
}
