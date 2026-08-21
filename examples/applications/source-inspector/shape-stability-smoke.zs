import console from "std/console";

struct SourceSpan {
  start: usize;
  end: usize;
}

struct NodeMetadata {
  name: String;
  span: SourceSpan;
}

struct AnalysisState {
  visits: i32;
  errors: i32;
}

// Recursive compiler storage remains owned. Array holds child nodes without
// placing reference or lifetime syntax on the source model.
struct SyntaxNode {
  metadata: NodeMetadata;
  analysis: AnalysisState;
  children: Array<SyntaxNode>;
}

function increment(inout value: i32): void {
  value = value + 1;
}

function advance(inout value: usize): void {
  value = value + 1;
}

function main(): i32 {
  let node = SyntaxNode({
    metadata: NodeMetadata({
      name: "functionDeclaration",
      span: SourceSpan({ start: 0, end: 19 }),
    }),
    analysis: AnalysisState({ visits: 0, errors: 0 }),
    children: Array<SyntaxNode>(),
  });

  // The name view loans node.metadata.name, not the complete node. Analysis
  // counters and the sibling source span remain independently mutable.
  const name = view node.metadata.name;
  increment(inout node.analysis.visits);
  advance(inout node.metadata.span.end);

  console.log(
    `${name} visits=${node.analysis.visits} bytes=${node.metadata.span.end}`
  );

  // The name loan ended at the interpolation. Replacing that field and then
  // transferring the complete recursive node are both safe.
  node.metadata.name = "checked";
  const nodes = Array<SyntaxNode>(node);
  return i32(nodes.length) - 1;
}
