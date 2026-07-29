import { expect } from "std/test";

struct SyntaxNode {
  kind: i32;
  text: String;
}

struct SyntaxTree {
  nodes: Array<SyntaxNode>;

  function append(inout this, node: SyntaxNode): void {
    this.nodes.push(node);
  }
}

struct Evidence {
  observedKind: i32;

  function record(inout this, kind: i32): void {
    this.observedKind = kind;
  }
}

function inspectNode(
  in tree: SyntaxTree,
  index: usize,
  inout evidence: Evidence
): usize {
  const node = view tree.nodes[index];
  evidence.record(node.kind);
  return node.text.byteLength;
}

function exerciseLocalView(): i32 {
  let tree = SyntaxTree({ nodes: Array<SyntaxNode>() });
  tree.append(SyntaxNode({ kind: 42, text: "identifier" }));

  let evidence = Evidence({ observedKind: 0 });
  const byteLength = inspectNode(tree, 0, inout evidence);

  // The view inside inspectNode ended at its last use, so growth is safe.
  tree.append(SyntaxNode({ kind: 7, text: "number" }));
  return evidence.observedKind + i32(byteLength) + i32(tree.nodes.length);
}

test "local views project borrowed aggregate storage" {
  expect(exerciseLocalView()).toEqual(54);
}

function main(): i32 {
  return exerciseLocalView() - 54;
}
