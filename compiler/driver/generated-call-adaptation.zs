import fs from "std/fs";
import { Set } from "std/collections";
import {
  Declaration,
  DeclarationKind,
  AggregateDeclaration,
  ConstructorDeclaration,
  DeinitDeclaration,
  ExpressionKind,
  ExpressionNode,
  ExpressionSyntax,
  ExpressionTree,
  ImportBinding,
  ImportDeclaration,
  Program,
  StatementArena,
  Statement,
  TypeReference,
} from "../frontend/parser.zs";
import { ParsedModule } from "../frontend/module-symbols.zs";
import { ModuleGraph } from "../frontend/semantic-model.zs";
import {
  NativeGeneratedCallAdapter,
  NativeProjectConfig,
} from "./project-manifest.zs";
import { sha256 } from "./content-hash.zs";

function sourceError(
  in path: String,
  line: usize,
  column: usize,
  in message: String
): String {
  return `${path}:${line}:${column}: error[Z0840]: ${message}`;
}

function stringBytes(in value: String): Array<u8> {
  let bytes = Array<u8>();
  let index: usize = 0;
  while (index < value.byteLength) {
    bytes.push(value.byteAt(index));
    index = index + 1;
  }
  return bytes;
}

function qualifiedOwner(in symbol: String): String {
  let dot: usize = symbol.byteLength;
  let index: usize = 0;
  while (index < symbol.byteLength) {
    if (symbol.byteAt(index) == 46) dot = index;
    index = index + 1;
  }
  return symbol.copyBytes(0, dot);
}

function qualifiedMember(in symbol: String): String {
  let dot: usize = symbol.byteLength;
  let index: usize = 0;
  while (index < symbol.byteLength) {
    if (symbol.byteAt(index) == 46) dot = index;
    index = index + 1;
  }
  return symbol.copyBytes(dot + 1, symbol.byteLength);
}

function adaptExpression(
  inout syntax: ExpressionSyntax,
  offset: usize,
  argument: usize,
  in replacementMethod: String,
  in adapterName: String,
  adapterIdentifierOffset: usize,
  adapterCallOffset: usize
): boolean throws String {
  let tree = match (in syntax.tree) {
    some(tree) => copy tree;
    none => return false;
  };
  let found = false;
  let index: usize = 0;
  while (index < tree.nodes.length) {
    if (
      tree.nodes[index].kind == ExpressionKind.callExpression
      && tree.nodes[index].offset == offset
    ) {
      if (found) throw "generated call adaptation offset is ambiguous";
      if (tree.nodes[index].children.length == 0) {
        throw "generated call adaptation target has no callee";
      }
      const memberIndex = tree.nodes[index].children[0];
      if (tree.nodes[memberIndex].kind != ExpressionKind.memberExpression) {
        throw "generated call adaptation target is not a method call";
      }
      if (argument + 1 >= tree.nodes[index].children.length) {
        throw "generated call adaptation argument is outside this call";
      }
      const argumentIndex = tree.nodes[index].children[argument + 1];
      const argumentOffset = tree.nodes[argumentIndex].offset;
      const argumentLine = tree.nodes[argumentIndex].line;
      const argumentColumn = tree.nodes[argumentIndex].column;
      tree.nodes[memberIndex].value = copy replacementMethod;

      const adapterIdentifier = tree.nodes.length;
      tree.nodes.push(ExpressionNode({
        kind: ExpressionKind.identifierExpression,
        value: copy adapterName,
        optionalAccess: false,
        children: Array<usize>(),
        statements: Array<usize>(),
        labels: Array<String>(),
        typeReferences: Array<TypeReference>(),
        offset: adapterIdentifierOffset,
        line: argumentLine,
        column: argumentColumn,
      }));
      let adapterChildren = Array<usize>();
      adapterChildren.push(adapterIdentifier);
      adapterChildren.push(argumentIndex);
      let adapterLabels = Array<String>();
      adapterLabels.push("");
      const adapterCall = tree.nodes.length;
      tree.nodes.push(ExpressionNode({
        kind: ExpressionKind.callExpression,
        value: "",
        optionalAccess: false,
        children: adapterChildren,
        statements: Array<usize>(),
        labels: adapterLabels,
        typeReferences: Array<TypeReference>(),
        offset: adapterCallOffset,
        line: argumentLine,
        column: argumentColumn,
      }));
      tree.nodes[index].children[argument + 1] = adapterCall;
      found = true;
    }
    index = index + 1;
  }
  syntax.tree = Option.some(tree);
  return found;
}

function expressionContainsCall(in syntax: ExpressionSyntax, offset: usize): boolean {
  return match (in syntax.tree) {
    some(tree) => {
      for (const node of tree.nodes) {
        if (
          node.kind == ExpressionKind.callExpression
          && node.offset == offset
        ) return true;
      }
      return false;
    }
    none => false;
  };
}

function adaptOptionalExpression(
  inout value: Option<ExpressionSyntax>,
  offset: usize,
  argument: usize,
  in replacementMethod: String,
  in adapterName: String,
  adapterIdentifierOffset: usize,
  adapterCallOffset: usize
): boolean throws String {
  const present = match (in value) {
    some(expression) => expressionContainsCall(expression, offset);
    none => false;
  };
  if (!present) return false;
  let expression = match (in value) {
    some(expression) => copy expression;
    none => return false;
  };
  const changed = try adaptExpression(
    inout expression,
    offset,
    argument,
    replacementMethod,
    adapterName,
    adapterIdentifierOffset,
    adapterCallOffset
  );
  value = Option.some(expression);
  return changed;
}

function adaptStatements(
  inout arena: StatementArena,
  offset: usize,
  argument: usize,
  in replacementMethod: String,
  in adapterName: String,
  adapterIdentifierOffset: usize,
  adapterCallOffset: usize
): usize throws String {
  let found: usize = 0;
  let index: usize = 0;
  while (index < arena.nodes.length) {
    let statement = copy arena.nodes[index];
    let expression = copy statement.expression;
    const changed = try adaptOptionalExpression(
      inout expression,
      offset,
      argument,
      replacementMethod,
      adapterName,
      adapterIdentifierOffset,
      adapterCallOffset
    );
    if (changed) found = found + 1;
    statement.expression = expression;
    let secondExpression = copy statement.secondExpression;
    const secondChanged = try adaptOptionalExpression(
      inout secondExpression,
      offset,
      argument,
      replacementMethod,
      adapterName,
      adapterIdentifierOffset,
      adapterCallOffset
    );
    if (secondChanged) found = found + 1;
    statement.secondExpression = secondExpression;
    arena.nodes[index] = statement;
    index = index + 1;
  }
  return found;
}

function adaptProgramCall(
  inout program: Program,
  offset: usize,
  argument: usize,
  in replacementMethod: String,
  in adapterName: String,
  adapterIdentifierOffset: usize,
  adapterCallOffset: usize
): usize throws String {
  let found: usize = 0;
  let constantIndex: usize = 0;
  while (constantIndex < program.constants.length) {
    let initializer = copy program.constants[constantIndex].initializer;
    if (expressionContainsCall(initializer, offset)) {
      const changed = try adaptExpression(
        inout initializer,
        offset,
        argument,
        replacementMethod,
        adapterName,
        adapterIdentifierOffset,
        adapterCallOffset
      );
      if (changed) found = found + 1;
      program.constants[constantIndex].initializer = initializer;
    }
    constantIndex = constantIndex + 1;
  }
  let functionIndex: usize = 0;
  while (functionIndex < program.functions.length) {
    let body = copy program.functions[functionIndex].body;
    const functionFound = try adaptStatements(
      inout body,
      offset,
      argument,
      replacementMethod,
      adapterName,
      adapterIdentifierOffset,
      adapterCallOffset
    );
    found = found + functionFound;
    program.functions[functionIndex].body = body;
    functionIndex = functionIndex + 1;
  }
  let aggregateIndex: usize = 0;
  while (aggregateIndex < program.aggregates.length) {
    let aggregate = copy program.aggregates[aggregateIndex];
    let fieldIndex: usize = 0;
    while (fieldIndex < aggregate.fields.length) {
      let defaultValue = copy aggregate.fields[fieldIndex].defaultValue;
      const defaultFound = try adaptOptionalExpression(
        inout defaultValue,
        offset,
        argument,
        replacementMethod,
        adapterName,
        adapterIdentifierOffset,
        adapterCallOffset
      );
      if (defaultFound) found = found + 1;
      aggregate.fields[fieldIndex].defaultValue = defaultValue;
      let defaultStatements = copy aggregate.fields[fieldIndex].defaultStatements;
      const fieldFound = try adaptStatements(
        inout defaultStatements,
        offset,
        argument,
        replacementMethod,
        adapterName,
        adapterIdentifierOffset,
        adapterCallOffset
      );
      found = found + fieldFound;
      aggregate.fields[fieldIndex].defaultStatements = defaultStatements;
      fieldIndex = fieldIndex + 1;
    }
    let adaptedConstructor = Option<ConstructorDeclaration>.none;
    match (in aggregate.constructorDeclaration) {
      some(initializer) => {
        let copied = copy initializer;
        let body = copy copied.body;
        const initializerFound = try adaptStatements(
          inout body,
          offset,
          argument,
          replacementMethod,
          adapterName,
          adapterIdentifierOffset,
          adapterCallOffset
        );
        found = found + initializerFound;
        copied.body = body;
        adaptedConstructor = Option.some(copied);
      }
      none => {}
    }
    match (adaptedConstructor) {
      some(initializer) => aggregate.constructorDeclaration = Option.some(initializer);
      none => {}
    }
    let methodIndex: usize = 0;
    while (methodIndex < aggregate.methods.length) {
      let body = copy aggregate.methods[methodIndex].body;
      const methodFound = try adaptStatements(
        inout body,
        offset,
        argument,
        replacementMethod,
        adapterName,
        adapterIdentifierOffset,
        adapterCallOffset
      );
      found = found + methodFound;
      aggregate.methods[methodIndex].body = body;
      methodIndex = methodIndex + 1;
    }
    let adaptedDeinitializer = Option<DeinitDeclaration>.none;
    match (in aggregate.deinitializer) {
      some(deinitializer) => {
        let copied = copy deinitializer;
        let body = copy copied.body;
        const deinitFound = try adaptStatements(
          inout body,
          offset,
          argument,
          replacementMethod,
          adapterName,
          adapterIdentifierOffset,
          adapterCallOffset
        );
        found = found + deinitFound;
        copied.body = body;
        adaptedDeinitializer = Option.some(copied);
      }
      none => {}
    }
    match (adaptedDeinitializer) {
      some(deinitializer) => aggregate.deinitializer = Option.some(deinitializer);
      none => {}
    }
    program.aggregates[aggregateIndex] = aggregate;
    aggregateIndex = aggregateIndex + 1;
  }
  return found;
}

function nameIsUsed(
  in graph: ModuleGraph,
  moduleIndex: usize,
  in name: String
): boolean {
  for (const symbol of graph.modules[moduleIndex].symbols) {
    if (symbol.name == name) return true;
  }
  for (const binding of graph.modules[moduleIndex].semanticEvidence.bindingResolutions) {
    if (binding.name == name) return true;
  }
  return false;
}

function generatedAdapterName(
  in graph: ModuleGraph,
  moduleIndex: usize,
  index: usize
): String {
  let name = `__z_generated_call_adapter_${index}`;
  while (nameIsUsed(graph, moduleIndex, name)) {
    name = `${name}_`;
  }
  return name;
}

function moduleIndexForPath(
  in modules: Array<ParsedModule>,
  in path: String
): Option<usize> {
  let index: usize = 0;
  while (index < modules.length) {
    if (modules[index].path == path) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function appendAdapterImport(
  inout program: Program,
  offset: usize,
  index: usize,
  in moduleName: String,
  in exportName: String,
  in localName: String
): void {
  let bindings = Array<ImportBinding>();
  bindings.push(ImportBinding({
    importedName: copy exportName,
    localName: copy localName,
    offset,
    line: 1,
    column: 1,
  }));
  program.imports.push(ImportDeclaration({
    moduleName: `__z_generated_call_module_${index}`,
    bindings,
    selective: true,
    header: copy moduleName,
    offset,
    line: 1,
    column: 1,
  }));
  program.declarations.push(Declaration({
    kind: DeclarationKind.importDeclaration,
    name: copy moduleName,
    exported: false,
    packageVisible: false,
    asynchronous: false,
    offset,
    line: 1,
    column: 1,
  }));
}

function adapterModulePath(
  in config: NativeProjectConfig,
  in specifier: String
): Option<String> {
  for (const module of config.generatedModules) {
    if (module.specifier == specifier) return Option.some(copy module.path);
  }
  return Option<String>.none;
}

export function applyGeneratedCallAdapters(
  inout modules: Array<ParsedModule>,
  in graph: ModuleGraph,
  in config: NativeProjectConfig
): Array<String> throws String {
  let generatedPaths = Array<String>();
  let seenCalls = Set<String>();
  let adapterIndex: usize = 0;
  while (adapterIndex < config.generatedCallAdapters.length) {
    const adapter = view config.generatedCallAdapters[adapterIndex];
    const moduleIndex = match (moduleIndexForPath(modules, adapter.sourcePath)) {
      some(index) => index;
      none => throw sourceError(
        adapter.sourcePath,
        1,
        1,
        "generated call adaptation source is not part of the checked module graph"
      );
    };
    const source = try fs.readText(adapter.sourcePath);
    const sourceBytes = stringBytes(source);
    const actualHash = sha256(sourceBytes);
    if (actualHash != adapter.sourceHash) {
      throw sourceError(
        adapter.sourcePath,
        1,
        1,
        `generated call adaptation source hash is stale; expected ${adapter.sourceHash}, found ${actualHash}`
      );
    }
    const callKey = `${adapter.sourcePath}:${adapter.offset}`;
    if (seenCalls.has(callKey)) {
      throw sourceError(
        adapter.sourcePath,
        1,
        1,
        "multiple generated call adaptations target the same call"
      );
    }
    seenCalls.add(move callKey);

    let foundResolution = false;
    let line: usize = 1;
    let column: usize = 1;
    for (const resolution of graph.modules[moduleIndex].semanticEvidence.callResolutions) {
      if (resolution.offset != adapter.offset) continue;
      line = resolution.line;
      column = resolution.column;
      if (resolution.kind != "method") {
        throw sourceError(
          adapter.sourcePath,
          line,
          column,
          "generated call adaptation target is not a checked method call"
        );
      }
      if (resolution.targetName != adapter.target) {
        throw sourceError(
          adapter.sourcePath,
          line,
          column,
          `generated call adaptation expected "${adapter.target}" but resolved "${resolution.targetName}"`
        );
      }
      foundResolution = true;
    }
    if (!foundResolution) {
      throw sourceError(
        adapter.sourcePath,
        line,
        column,
        `generated call adaptation offset ${adapter.offset} does not identify a checked method call`
      );
    }
    const targetOwner = qualifiedOwner(adapter.target);
    const replacementOwner = qualifiedOwner(adapter.replacement);
    if (targetOwner != replacementOwner) {
      throw sourceError(
        adapter.sourcePath,
        line,
        column,
        "generated call adaptation replacement must be a method on the original receiver type"
      );
    }
    const replacementMethod = qualifiedMember(adapter.replacement);
    const localName = generatedAdapterName(graph, moduleIndex, adapterIndex);
    let program = copy modules[moduleIndex].program;
    const syntheticOffset = source.byteLength + adapterIndex * 3 + 1;
    const foundExpressions = try adaptProgramCall(
      inout program,
      adapter.offset,
      adapter.argument,
      replacementMethod,
      localName,
      syntheticOffset + 1,
      syntheticOffset + 2
    );
    if (foundExpressions != 1) {
      const expressionError = foundExpressions == 0
        ? "generated call adaptation offset does not identify an expression-tree call"
        : "generated call adaptation offset is ambiguous";
      throw sourceError(
        adapter.sourcePath,
        line,
        column,
        expressionError
      );
    }
    appendAdapterImport(
      inout program,
      syntheticOffset,
      adapterIndex,
      adapter.adapterModule,
      adapter.adapterExport,
      localName
    );
    modules[moduleIndex].program = program;
    const generatedPath = match (adapterModulePath(config, adapter.adapterModule)) {
      some(path) => path;
      none => throw sourceError(
        adapter.sourcePath,
        line,
        column,
        `generated adapter module "${adapter.adapterModule}" is unavailable`
      );
    };
    let pathSeen = false;
    for (const existing of generatedPaths) {
      if (existing == generatedPath) pathSeen = true;
    }
    if (!pathSeen) generatedPaths.push(generatedPath);
    adapterIndex = adapterIndex + 1;
  }
  return generatedPaths;
}
