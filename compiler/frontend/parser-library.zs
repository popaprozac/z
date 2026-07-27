// In-process stage-one parser root. A tiny generated-C wrapper exposes
// stage1Parse to the Bun host without making Z module exports imply a C ABI.

import { renderProgram } from "./parser-protocol.zs";
import {
  Stage1ModuleGraphResult,
  emptyStage1ModuleGraphResult,
  resolveModuleGraphPhase,
} from "./module-resolver-protocol.zs";
import {
  ModuleSymbol,
  ModuleSymbolKind,
} from "./semantic-model.zs";

struct Stage1ResolveResponse {
  success: boolean;
  error: String;
  graph: Stage1ModuleGraphResult;
}

function stage1SymbolKindCode(in symbol: ModuleSymbol): usize {
  if (symbol.kind == ModuleSymbolKind.functionSymbol) return 0;
  if (symbol.kind == ModuleSymbolKind.structSymbol) return 1;
  if (symbol.kind == ModuleSymbolKind.classSymbol) return 2;
  if (symbol.kind == ModuleSymbolKind.traitSymbol) return 3;
  if (symbol.kind == ModuleSymbolKind.typeAliasSymbol) return 4;
  if (symbol.kind == ModuleSymbolKind.enumSymbol) return 5;
  if (symbol.kind == ModuleSymbolKind.namespaceSymbol) return 6;
  return 7;
}

function stage1SymbolHasTarget(in symbol: ModuleSymbol): boolean {
  return match (in symbol.targetModule) {
    some(_) => true;
    none => false;
  };
}

function stage1SymbolTarget(in symbol: ModuleSymbol): usize {
  return match (in symbol.targetModule) {
    some(target) => target;
    none => 0;
  };
}

function stage1SymbolHasFunctionSignature(in symbol: ModuleSymbol): boolean {
  return match (in symbol.functionSignature) {
    some(_) => true;
    none => false;
  };
}

function stage1SymbolHasTypeSignature(in symbol: ModuleSymbol): boolean {
  return match (in symbol.typeSignature) {
    some(_) => true;
    none => false;
  };
}

function stage1TypeHasConstructorSignature(in symbol: ModuleSymbol): boolean {
  match (in symbol.typeSignature) {
    some(signature) => return match (in signature.constructorSignature) {
      some(_) => true;
      none => false;
    };
    none => return false;
  }
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
  const outcome = attempt resolveModuleGraphPhase(entryPath, batch);
  return match (outcome) {
    success(graph) => Stage1ResolveResponse({
      success: true,
      error: "",
      graph,
    });
    failure(message) => Stage1ResolveResponse({
      success: false,
      error: move message,
      graph: emptyStage1ModuleGraphResult(),
    });
  };
}

function main(): i32 {
  return 0;
}
