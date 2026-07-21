// Temporary in-process framing for host-loaded module batches and resolved
// native graphs. Paths are canonicalized by the host; graph semantics stay in Z.

import { TextBuffer } from "std/text";
import {
  ModuleResolveError,
  ModuleSource,
  ModuleSymbol,
  moduleSymbolKindName,
  resolveModules,
} from "./module-resolver.zs";
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

function appendTarget(inout output: TextBuffer, in target: Option<usize>): void {
  match (in target) {
    some(index) => appendHexUsize(inout output, index);
    none => output.append("-");
  }
}

function appendSymbol(
  inout output: TextBuffer,
  moduleIndex: usize,
  in symbol: ModuleSymbol
): void {
  output.append("symbol");
  output.appendAscii(9);
  appendHexUsize(inout output, moduleIndex);
  output.appendAscii(9);
  const kind = moduleSymbolKindName(symbol.kind);
  output.append(kind);
  output.appendAscii(9);
  appendHexText(inout output, symbol.name);
  output.appendAscii(9);
  if (symbol.exported) output.appendAscii(49);
  else output.appendAscii(48);
  output.appendAscii(9);
  appendTarget(inout output, symbol.targetModule);
  output.appendAscii(9);
  appendHexText(inout output, symbol.importedName);
  output.appendAscii(9);
  appendHexUsize(inout output, symbol.offset);
  output.appendAscii(9);
  appendHexUsize(inout output, symbol.line);
  output.appendAscii(9);
  appendHexUsize(inout output, symbol.column);
  output.appendAscii(10);
}

function appendFunctionSignature(
  inout output: TextBuffer,
  moduleIndex: usize,
  symbolIndex: usize,
  in symbol: ModuleSymbol
): void {
  match (in symbol.functionSignature) {
    some(signature) => {
      output.append("signature");
      output.appendAscii(9);
      appendHexUsize(inout output, moduleIndex);
      output.appendAscii(9);
      appendHexUsize(inout output, symbolIndex);
      output.appendAscii(9);
      if (signature.asynchronous) output.appendAscii(49);
      else output.appendAscii(48);
      output.appendAscii(9);
      appendHexText(inout output, signature.returnType);
      output.appendAscii(9);
      appendHexText(inout output, signature.errorType);
      output.appendAscii(9);
      appendHexUsize(inout output, signature.typeParameters.length);
      output.appendAscii(9);
      appendHexUsize(inout output, signature.parameterTypes.length);
      for (const typeParameter of signature.typeParameters) {
        output.appendAscii(9);
        appendHexText(inout output, typeParameter);
      }
      let parameterIndex: usize = 0;
      while (parameterIndex < signature.parameterTypes.length) {
        output.appendAscii(9);
        appendHexText(inout output, signature.parameterModes[parameterIndex]);
        output.appendAscii(9);
        appendHexText(inout output, signature.parameterTypes[parameterIndex]);
        parameterIndex = parameterIndex + 1;
      }
      output.appendAscii(10);
    }
    none => {}
  }
}

function appendTypeSignature(
  inout output: TextBuffer,
  moduleIndex: usize,
  symbolIndex: usize,
  in symbol: ModuleSymbol
): void {
  match (in symbol.typeSignature) {
    some(signature) => {
      output.append("typeSignature");
      output.appendAscii(9);
      appendHexUsize(inout output, moduleIndex);
      output.appendAscii(9);
      appendHexUsize(inout output, symbolIndex);
      output.appendAscii(9);
      appendHexUsize(inout output, signature.typeParameters.length);
      output.appendAscii(9);
      appendHexUsize(inout output, signature.fields.length);
      output.appendAscii(9);
      appendHexUsize(inout output, signature.variants.length);
      for (const typeParameter of signature.typeParameters) {
        output.appendAscii(9);
        appendHexText(inout output, typeParameter);
      }
      for (const field of signature.fields) {
        output.appendAscii(9);
        appendHexText(inout output, field.name);
        output.appendAscii(9);
        appendHexText(inout output, field.typeName);
        output.appendAscii(9);
        appendHexText(inout output, field.visibility);
        output.appendAscii(9);
        if (field.readonlyField) output.appendAscii(49);
        else output.appendAscii(48);
      }
      for (const variant of signature.variants) {
        output.appendAscii(9);
        appendHexText(inout output, variant.name);
        output.appendAscii(9);
        appendHexText(inout output, variant.payloadType);
      }
      output.appendAscii(10);
    }
    none => {}
  }
}

function appendMethodSignatures(
  inout output: TextBuffer,
  moduleIndex: usize,
  symbolIndex: usize,
  in symbol: ModuleSymbol
): void {
  match (in symbol.typeSignature) {
    some(typeSignature) => {
      for (const method of typeSignature.methods) {
        output.append("methodSignature");
        output.appendAscii(9);
        appendHexUsize(inout output, moduleIndex);
        output.appendAscii(9);
        appendHexUsize(inout output, symbolIndex);
        output.appendAscii(9);
        appendHexText(inout output, method.name);
        output.appendAscii(9);
        if (method.staticMethod) output.appendAscii(49);
        else output.appendAscii(48);
        output.appendAscii(9);
        appendHexText(inout output, method.visibility);
        output.appendAscii(9);
        appendHexText(inout output, method.receiverMode);
        output.appendAscii(9);
        if (method.signature.asynchronous) output.appendAscii(49);
        else output.appendAscii(48);
        output.appendAscii(9);
        appendHexText(inout output, method.signature.returnType);
        output.appendAscii(9);
        appendHexText(inout output, method.signature.errorType);
        output.appendAscii(9);
        appendHexUsize(inout output, method.signature.typeParameters.length);
        output.appendAscii(9);
        appendHexUsize(inout output, method.signature.parameterTypes.length);
        for (const typeParameter of method.signature.typeParameters) {
          output.appendAscii(9);
          appendHexText(inout output, typeParameter);
        }
        let parameterIndex: usize = 0;
        while (parameterIndex < method.signature.parameterTypes.length) {
          output.appendAscii(9);
          appendHexText(inout output, method.signature.parameterModes[parameterIndex]);
          output.appendAscii(9);
          appendHexText(inout output, method.signature.parameterTypes[parameterIndex]);
          parameterIndex = parameterIndex + 1;
        }
        output.appendAscii(10);
      }
    }
    none => {}
  }
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
  let moduleIndex: usize = 0;
  for (const module of graph.modules) {
    output.append("module");
    output.appendAscii(9);
    appendHexText(inout output, module.path);
    for (const dependency of module.dependencies) {
      output.appendAscii(9);
      appendHexUsize(inout output, dependency);
    }
    output.appendAscii(10);
    let symbolIndex: usize = 0;
    for (const symbol of module.symbols) {
      appendSymbol(inout output, moduleIndex, symbol);
      appendFunctionSignature(inout output, moduleIndex, symbolIndex, symbol);
      appendTypeSignature(inout output, moduleIndex, symbolIndex, symbol);
      appendMethodSignatures(inout output, moduleIndex, symbolIndex, symbol);
      symbolIndex = symbolIndex + 1;
    }
    moduleIndex = moduleIndex + 1;
  }
  output.append("order");
  for (const index of graph.dependencyOrder) {
    output.appendAscii(9);
    appendHexUsize(inout output, index);
  }
  output.appendAscii(10);
  return output.finish();
}
