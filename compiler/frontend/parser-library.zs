// In-process stage-one parser root. A tiny generated-C wrapper exposes
// stage1Parse to the Bun host without making Z module exports imply a C ABI.

import { renderProgram } from "./parser-protocol.zs";
import {
  RenderedModuleGraph,
  emptyRenderedModuleGraph,
  renderModuleGraph,
} from "./module-resolver-protocol.zs";

struct Stage1ResolveResponse {
  success: boolean;
  graph: RenderedModuleGraph;
}

function stage1Parse(in path: String, in source: String): String {
  const outcome = attempt renderProgram(path, source);
  return match (outcome) {
    success(stream) => `ok\n${stream}`;
    failure(message) => `error\n${message}`;
  };
}

function stage1Resolve(
  in entryPath: String,
  in batch: String
): Stage1ResolveResponse {
  const outcome = attempt renderModuleGraph(entryPath, batch);
  return match (outcome) {
    success(graph) => Stage1ResolveResponse({
      success: true,
      graph: move graph,
    });
    failure(message) => Stage1ResolveResponse({
      success: false,
      graph: emptyRenderedModuleGraph(move message),
    });
  };
}

function main(): i32 {
  return 0;
}
