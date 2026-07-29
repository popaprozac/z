struct Node {
  text: String;
}

struct Tree {
  node: Node;
  values: Array<i32>;
  label: String;
}

function observe(in node: Node): usize {
  return node.text.byteLength;
}

function main(): i32 {
  let values = Array<i32>();
  values.push(20);
  values.push(22);
  const tree = Tree({
    node: Node({ text: "ready" }),
    values,
    label: "ready",
  });
  const node = view tree.node;
  const numbers = view tree.values;
  const label = view tree.label;
  let total = 0;
  for (const value of numbers) {
    total = total + value;
  }
  const copied = label.copyBytes(0, label.byteLength);
  const rendered = `${label}`;
  if (
    label == "ready"
    && copied == "ready"
    && rendered == "ready"
    && total == 42
  ) return i32(observe(node)) - 5;
  return 1;
}
