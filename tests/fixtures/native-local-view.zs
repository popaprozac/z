struct Node {
  text: String;
}

struct Tree {
  node: Node;
}

function observe(in node: Node): usize {
  return node.text.byteLength;
}

function main(): i32 {
  const tree = Tree({ node: Node({ text: "ready" }) });
  const node = view tree.node;
  return i32(observe(node)) - 5;
}
