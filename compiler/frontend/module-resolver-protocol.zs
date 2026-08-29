// Temporary in-process framing for host-loaded module batches and resolved
// native graphs. Paths are canonicalized by the host; graph semantics stay in Z.

import { TextBuffer } from "std/text";
import {
  ModuleBindingResolution,
  ModuleCallResolution,
  ModuleExpressionResolution,
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleGraph,
  ModuleSource,
  ModuleSymbol,
  ResolvedModule,
} from "./semantic-model.zs";
import { resolveModules } from "./module-resolver.zs";
import { moduleSymbolKindName } from "./module-symbols.zs";
import { appendHexText, appendHexUsize } from "./parser-protocol.zs";

export struct Stage1ModuleGraphResult {
  entry: usize;
  moduleCount: usize;
  dependencyCount: usize;
  dependencyOrderCount: usize;
  symbolCount: usize;
  callResolutionCount: usize;
  bindingResolutionCount: usize;
  expressionResolutionCount: usize;
  resolved: ModuleGraph;
}

export function emptyStage1ModuleGraphResult(): Stage1ModuleGraphResult {
  return Stage1ModuleGraphResult({
    entry: 0,
    moduleCount: 0,
    dependencyCount: 0,
    dependencyOrderCount: 0,
    symbolCount: 0,
    callResolutionCount: 0,
    bindingResolutionCount: 0,
    expressionResolutionCount: 0,
    resolved: ModuleGraph({
      modules: Array<ResolvedModule>(),
      dependencyOrder: Array<usize>(),
      entry: 0,
    }),
  });
}

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

export function decodeModuleSources(in batch: String): Array<ModuleSource> throws String {
  let sources = Array<ModuleSource>();
  let offset: usize = 0;
  while (offset < batch.byteLength) {
    const pathLength = try readHexUsize(batch, offset);
    const sourceLength = try readHexUsize(batch, offset + 16);
    const packageIdentityLength = try readHexUsize(batch, offset + 32);
    const packageSpecifiersLength = try readHexUsize(batch, offset + 48);
    const pathStart = offset + 64;
    const sourceStart = pathStart + pathLength;
    const packageIdentityStart = sourceStart + sourceLength;
    const packageSpecifiersStart = packageIdentityStart + packageIdentityLength;
    const next = packageSpecifiersStart + packageSpecifiersLength;
    if (next > batch.byteLength) throw "module batch ended inside a source record";
    let packageSpecifiers = Array<String>();
    let specifierStart = packageSpecifiersStart;
    let specifierOffset = packageSpecifiersStart;
    while (specifierOffset <= next) {
      if (
        specifierOffset == next
        || batch.byteAt(specifierOffset) == 10
      ) {
        if (specifierOffset > specifierStart) {
          packageSpecifiers.push(batch.copyBytes(
            specifierStart,
            specifierOffset
          ));
        }
        specifierStart = specifierOffset + 1;
      }
      specifierOffset = specifierOffset + 1;
    }
    sources.push(ModuleSource({
      path: batch.copyBytes(pathStart, sourceStart),
      source: batch.copyBytes(sourceStart, packageIdentityStart),
      packageIdentity: batch.copyBytes(packageIdentityStart, packageSpecifiersStart),
      packageSpecifiers,
    }));
    offset = next;
  }
  if (sources.length == 0) throw "module batch does not contain any sources";
  return sources;
}

function resolverErrorKindName(kind: ModuleResolveErrorKind): String {
  return match (kind) {
    lexer => "lexer";
    parser => "parser";
    missingModule => "missingModule";
    circularImport => "circularImport";
    missingExport => "missingExport";
    duplicateBinding => "duplicateBinding";
    unknownName => "unknownName";
    unknownType => "unknownType";
    unknownMember => "unknownMember";
    typeMismatch => "typeMismatch";
    invalidOperator => "invalidOperator";
    invalidMatch => "invalidMatch";
    unsupportedLowering => "unsupportedLowering";
  };
}

export function resolverMessage(in error: ModuleResolveError): String {
  let output = TextBuffer();
  output.append(error.code.byteLength > 0 ? "diagnostic2" : "diagnostic");
  output.appendAscii(9);
  const kind = resolverErrorKindName(error.kind);
  output.append(kind);
  output.appendAscii(9);
  if (error.code.byteLength > 0) {
    appendHexText(inout output, error.code);
    output.appendAscii(9);
  }
  appendHexText(inout output, error.path);
  output.appendAscii(9);
  appendHexUsize(inout output, error.line);
  output.appendAscii(9);
  appendHexUsize(inout output, error.column);
  output.appendAscii(9);
  if (error.code.byteLength > 0) {
    appendHexUsize(inout output, error.length);
    output.appendAscii(9);
  }
  appendHexText(inout output, error.message);
  return output.finish();
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
  if (symbol.nativeCExport) output.appendAscii(49);
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
      appendHexText(inout output, signature.executorAffinity);
      output.appendAscii(9);
      appendHexText(inout output, signature.threadContract);
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
      for (const constraint of signature.typeParameterConstraints) {
        output.append("functionConstraint");
        output.appendAscii(9);
        appendHexUsize(inout output, moduleIndex);
        output.appendAscii(9);
        appendHexUsize(inout output, symbolIndex);
        output.appendAscii(9);
        appendHexText(inout output, constraint.parameter);
        output.appendAscii(9);
        appendHexText(inout output, constraint.traitName);
        output.appendAscii(10);
      }
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
      output.appendAscii(9);
      if (signature.customDeinit) output.appendAscii(49);
      else output.appendAscii(48);
      output.appendAscii(9);
      if (signature.customConstructor) output.appendAscii(49);
      else output.appendAscii(48);
      output.appendAscii(9);
      appendHexText(inout output, signature.executorAffinity);
      output.appendAscii(9);
      appendHexText(inout output, signature.nativeCName);
      output.appendAscii(9);
      appendHexText(inout output, signature.nativeCUnderlyingType);
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
        appendHexText(inout output, field.executorAffinity);
        output.appendAscii(9);
        appendHexText(inout output, field.visibility);
        output.appendAscii(9);
        if (field.readonlyField) output.appendAscii(49);
        else output.appendAscii(48);
        output.appendAscii(9);
        if (field.hasDefault) output.appendAscii(49);
        else output.appendAscii(48);
        output.appendAscii(9);
        if (field.optionalField) output.appendAscii(49);
        else output.appendAscii(48);
      }
      for (const variant of signature.variants) {
        output.appendAscii(9);
        appendHexText(inout output, variant.name);
        output.appendAscii(9);
        appendHexText(inout output, variant.payloadType);
      }
      output.appendAscii(10);
      for (const constraint of signature.typeParameterConstraints) {
        output.append("typeConstraint");
        output.appendAscii(9);
        appendHexUsize(inout output, moduleIndex);
        output.appendAscii(9);
        appendHexUsize(inout output, symbolIndex);
        output.appendAscii(9);
        appendHexText(inout output, constraint.parameter);
        output.appendAscii(9);
        appendHexText(inout output, constraint.traitName);
        output.appendAscii(10);
      }
      for (const implemented of signature.implementedTraits) {
        output.append("implements");
        output.appendAscii(9);
        appendHexUsize(inout output, moduleIndex);
        output.appendAscii(9);
        appendHexUsize(inout output, symbolIndex);
        output.appendAscii(9);
        appendHexText(inout output, implemented);
        output.appendAscii(10);
      }
    }
    none => {}
  }
}

function appendConstructorSignature(
  inout output: TextBuffer,
  moduleIndex: usize,
  symbolIndex: usize,
  in symbol: ModuleSymbol
): void {
  match (in symbol.typeSignature) {
    some(typeSignature) => {
      match (in typeSignature.constructorSignature) {
        some(signature) => {
          output.append("constructorSignature");
          output.appendAscii(9);
          appendHexUsize(inout output, moduleIndex);
          output.appendAscii(9);
          appendHexUsize(inout output, symbolIndex);
          output.appendAscii(9);
          appendHexText(inout output, typeSignature.constructorVisibility);
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
        appendHexText(inout output, method.signature.executorAffinity);
        output.appendAscii(9);
        appendHexText(inout output, method.signature.threadContract);
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
        for (const constraint of method.signature.typeParameterConstraints) {
          output.append("methodConstraint");
          output.appendAscii(9);
          appendHexUsize(inout output, moduleIndex);
          output.appendAscii(9);
          appendHexUsize(inout output, symbolIndex);
          output.appendAscii(9);
          appendHexText(inout output, method.name);
          output.appendAscii(9);
          appendHexText(inout output, constraint.parameter);
          output.appendAscii(9);
          appendHexText(inout output, constraint.traitName);
          output.appendAscii(10);
        }
      }
    }
    none => {}
  }
}

function appendCallResolution(
  inout output: TextBuffer,
  moduleIndex: usize,
  in resolution: ModuleCallResolution
): void {
  output.append("callResolution");
  output.appendAscii(9);
  appendHexUsize(inout output, moduleIndex);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.offset);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.line);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.column);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.targetModuleIndex);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.targetSymbolIndex);
  output.appendAscii(9);
  appendHexText(inout output, resolution.kind);
  output.appendAscii(9);
  appendHexText(inout output, resolution.targetName);
  output.appendAscii(9);
  if (resolution.asynchronous) output.appendAscii(49);
  else output.appendAscii(48);
  output.appendAscii(9);
  appendHexText(inout output, resolution.receiverMode);
  output.appendAscii(9);
  appendHexText(inout output, resolution.returnType);
  output.appendAscii(9);
  appendHexText(inout output, resolution.errorType);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.callableTypeParameterCount);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.typeParameters.length);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.parameterTypes.length);
  let typeIndex: usize = 0;
  while (typeIndex < resolution.typeParameters.length) {
    output.appendAscii(9);
    appendHexText(inout output, resolution.typeParameters[typeIndex]);
    output.appendAscii(9);
    appendHexText(inout output, resolution.typeArguments[typeIndex]);
    typeIndex = typeIndex + 1;
  }
  let parameterIndex: usize = 0;
  while (parameterIndex < resolution.parameterTypes.length) {
    output.appendAscii(9);
    appendHexText(inout output, resolution.parameterModes[parameterIndex]);
    output.appendAscii(9);
    appendHexText(inout output, resolution.parameterTypes[parameterIndex]);
    parameterIndex = parameterIndex + 1;
  }
  output.appendAscii(10);
}

function appendBindingResolution(
  inout output: TextBuffer,
  moduleIndex: usize,
  in resolution: ModuleBindingResolution
): void {
  output.append("bindingResolution");
  output.appendAscii(9);
  appendHexUsize(inout output, moduleIndex);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.offset);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.line);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.column);
  output.appendAscii(9);
  appendHexText(inout output, resolution.name);
  output.appendAscii(9);
  if (resolution.mutableBinding) output.appendAscii(49);
  else output.appendAscii(48);
  output.appendAscii(9);
  appendHexText(inout output, resolution.typeName);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.typeIdentities.length);
  for (const identity of resolution.typeIdentities) {
    output.appendAscii(9);
    appendHexText(inout output, identity.path);
    output.appendAscii(9);
    appendHexUsize(inout output, identity.targetModuleIndex);
    output.appendAscii(9);
    appendHexUsize(inout output, identity.targetSymbolIndex);
  }
  output.appendAscii(10);
}

function appendExpressionResolution(
  inout output: TextBuffer,
  moduleIndex: usize,
  in resolution: ModuleExpressionResolution
): void {
  output.append("expressionResolution");
  output.appendAscii(9);
  appendHexUsize(inout output, moduleIndex);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.offset);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.line);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.column);
  output.appendAscii(9);
  appendHexText(inout output, resolution.typeName);
  output.appendAscii(9);
  appendHexText(inout output, resolution.targetName);
  output.appendAscii(9);
  appendHexUsize(inout output, resolution.typeIdentities.length);
  for (const identity of resolution.typeIdentities) {
    output.appendAscii(9);
    appendHexText(inout output, identity.path);
    output.appendAscii(9);
    appendHexUsize(inout output, identity.targetModuleIndex);
    output.appendAscii(9);
    appendHexUsize(inout output, identity.targetSymbolIndex);
  }
  output.appendAscii(10);
}

export function renderResolvedModuleGraph(in graph: ModuleGraph): String {
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
      appendConstructorSignature(inout output, moduleIndex, symbolIndex, symbol);
      appendMethodSignatures(inout output, moduleIndex, symbolIndex, symbol);
      symbolIndex = symbolIndex + 1;
    }
    for (const resolution of module.semanticEvidence.callResolutions) {
      appendCallResolution(inout output, moduleIndex, resolution);
    }
    for (const resolution of module.semanticEvidence.bindingResolutions) {
      appendBindingResolution(inout output, moduleIndex, resolution);
    }
    for (const resolution of module.semanticEvidence.expressionResolutions) {
      appendExpressionResolution(inout output, moduleIndex, resolution);
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

export function resolveModuleGraphPhase(
  in entryPath: String,
  in batch: String
): Stage1ModuleGraphResult throws String {
  const sources = try decodeModuleSources(batch);
  const outcome = attempt resolveModules(sources, entryPath);
  const graph = match (outcome) {
    success(graph) => graph;
    failure(error) => throw resolverMessage(error);
  };

  let dependencyCount: usize = 0;
  let symbolCount: usize = 0;
  let callResolutionCount: usize = 0;
  let bindingResolutionCount: usize = 0;
  let expressionResolutionCount: usize = 0;
  for (const module of graph.modules) {
    dependencyCount = dependencyCount + module.dependencies.length;
    symbolCount = symbolCount + module.symbols.length;
    callResolutionCount = callResolutionCount
      + module.semanticEvidence.callResolutions.length;
    bindingResolutionCount = bindingResolutionCount
      + module.semanticEvidence.bindingResolutions.length;
    expressionResolutionCount = expressionResolutionCount
      + module.semanticEvidence.expressionResolutions.length;
  }
  return Stage1ModuleGraphResult({
    entry: graph.entry,
    moduleCount: graph.modules.length,
    dependencyCount,
    dependencyOrderCount: graph.dependencyOrder.length,
    symbolCount,
    callResolutionCount,
    bindingResolutionCount,
    expressionResolutionCount,
    resolved: move graph,
  });
}
