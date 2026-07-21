// Temporary in-process framing for host-loaded module batches and resolved
// native graphs. Paths are canonicalized by the host; graph semantics stay in Z.

import { TextBuffer } from "std/text";
import { ModuleResolveError, ModuleSource, resolveModules } from "./module-resolver.zs";
import { appendHexText, appendHexUsize } from "./parser-protocol.zs";

function hexValue(byte: u8): usize throws String {
  if (byte == 48) return 0;
  if (byte == 49) return 1;
  if (byte == 50) return 2;
  if (byte == 51) return 3;
  if (byte == 52) return 4;
  if (byte == 53) return 5;
  if (byte == 54) return 6;
  if (byte == 55) return 7;
  if (byte == 56) return 8;
  if (byte == 57) return 9;
  if (byte == 97) return 10;
  if (byte == 98) return 11;
  if (byte == 99) return 12;
  if (byte == 100) return 13;
  if (byte == 101) return 14;
  if (byte == 102) return 15;
  throw "module batch contains an invalid hexadecimal length";
}

function readHexUsize(in batch: String, offset: usize): usize throws String {
  if (offset + 16 > batch.byteLength) throw "module batch ended inside a length header";
  let value: usize = 0;
  let index: usize = 0;
  while (index < 16) {
    const digit = try hexValue(batch.byteAt(offset + index));
    value = (value << 4) | digit;
    index = index + 1;
  }
  return value;
}

function decodeModuleSources(in batch: String): Array<ModuleSource> throws String {
  let sources = Array<ModuleSource>();
  let offset: usize = 0;
  while (offset < batch.byteLength) {
    const pathLength = try readHexUsize(batch, offset);
    const sourceLength = try readHexUsize(batch, offset + 16);
    const pathStart = offset + 32;
    const sourceStart = pathStart + pathLength;
    const next = sourceStart + sourceLength;
    if (next > batch.byteLength) throw "module batch ended inside a source record";
    sources.push(ModuleSource({
      path: batch.copyBytes(pathStart, sourceStart),
      source: batch.copyBytes(sourceStart, next),
    }));
    offset = next;
  }
  if (sources.length == 0) throw "module batch does not contain any sources";
  return sources;
}

function resolverMessage(in error: ModuleResolveError): String {
  return `${error.path}:${error.line}:${error.column}: ${error.message}`;
}

export function renderModuleGraph(
  in entryPath: String,
  in batch: String
): String throws String {
  const sources = try decodeModuleSources(batch);
  const outcome = attempt resolveModules(sources, entryPath);
  const graph = match (outcome) {
    success(graph) => graph;
    failure(error) => throw resolverMessage(error);
  };

  let output = TextBuffer();
  output.append("entry");
  output.appendAscii(9);
  appendHexUsize(inout output, graph.entry);
  output.appendAscii(10);
  for (const module of graph.modules) {
    output.append("module");
    output.appendAscii(9);
    appendHexText(inout output, module.path);
    for (const dependency of module.dependencies) {
      output.appendAscii(9);
      appendHexUsize(inout output, dependency);
    }
    output.appendAscii(10);
  }
  output.append("order");
  for (const index of graph.dependencyOrder) {
    output.appendAscii(9);
    appendHexUsize(inout output, index);
  }
  output.appendAscii(10);
  return output.finish();
}
