import { JsonValue, stringify } from "std/json";
import { TextBuffer } from "std/text";
import {
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  Program,
  StatementArena,
} from "./parser.zs";
import {
  ModuleCallResolution,
  ModuleFunctionSignature,
  ModuleGraph,
  ModuleSymbol,
  ModuleTypeSignature,
} from "./semantic-model.zs";
import { ParsedModule, moduleSymbolKindName } from "./module-symbols.zs";

function appendQuoted(inout output: TextBuffer, in value: String): void {
  const json = JsonValue.string(copy value);
  output.append(stringify(in json));
}

function appendBoolean(inout output: TextBuffer, value: boolean): void {
  output.append(value ? "true" : "false");
}

function appendNullableString(inout output: TextBuffer, in value: String): void {
  if (value.byteLength == 0) output.append("null");
  else appendQuoted(inout output, in value);
}

function appendStringArray(
  inout output: TextBuffer,
  in values: Array<String>
): void {
  output.append("[");
  let index: usize = 0;
  while (index < values.length) {
    if (index > 0) output.append(",");
    appendQuoted(inout output, values[index]);
    index = index + 1;
  }
  output.append("]");
}

function appendConstraints(
  inout output: TextBuffer,
  in signature: ModuleFunctionSignature
): void {
  output.append("[");
  let index: usize = 0;
  while (index < signature.typeParameterConstraints.length) {
    if (index > 0) output.append(",");
    const constraint = view signature.typeParameterConstraints[index];
    output.append("{\"parameter\":");
    appendQuoted(inout output, constraint.parameter);
    output.append(",\"traitName\":");
    appendQuoted(inout output, constraint.traitName);
    output.append("}");
    index = index + 1;
  }
  output.append("]");
}

function appendFunctionSignature(
  inout output: TextBuffer,
  in signature: ModuleFunctionSignature
): void {
  output.append("{\"asynchronous\":");
  appendBoolean(inout output, signature.asynchronous);
  output.append(",\"executorAffinity\":");
  appendNullableString(inout output, signature.executorAffinity);
  output.append(",\"threadContract\":");
  appendNullableString(inout output, signature.threadContract);
  output.append(",\"returnType\":");
  appendQuoted(inout output, signature.returnType);
  output.append(",\"errorType\":");
  appendNullableString(inout output, signature.errorType);
  output.append(",\"typeParameters\":");
  appendStringArray(inout output, signature.typeParameters);
  output.append(",\"typeParameterConstraints\":");
  appendConstraints(inout output, signature);
  output.append(",\"parameterModes\":");
  appendStringArray(inout output, signature.parameterModes);
  output.append(",\"parameterTypes\":");
  appendStringArray(inout output, signature.parameterTypes);
  output.append("}");
}

function appendTypeConstraints(
  inout output: TextBuffer,
  in signature: ModuleTypeSignature
): void {
  output.append("[");
  let index: usize = 0;
  while (index < signature.typeParameterConstraints.length) {
    if (index > 0) output.append(",");
    const constraint = view signature.typeParameterConstraints[index];
    output.append("{\"parameter\":");
    appendQuoted(inout output, constraint.parameter);
    output.append(",\"traitName\":");
    appendQuoted(inout output, constraint.traitName);
    output.append("}");
    index = index + 1;
  }
  output.append("]");
}

function appendTypeSignature(
  inout output: TextBuffer,
  in signature: ModuleTypeSignature
): void {
  output.append("{\"nativeCName\":");
  appendQuoted(inout output, signature.nativeCName);
  output.append(",\"nativeCUnderlyingType\":");
  appendQuoted(inout output, signature.nativeCUnderlyingType);
  output.append(",\"typeParameters\":");
  appendStringArray(inout output, signature.typeParameters);
  output.append(",\"typeParameterConstraints\":");
  appendTypeConstraints(inout output, signature);
  output.append(",\"executorAffinity\":");
  appendNullableString(inout output, signature.executorAffinity);
  output.append(",\"implementedTraits\":");
  appendStringArray(inout output, signature.implementedTraits);
  output.append(",\"fields\":[");
  let fieldIndex: usize = 0;
  while (fieldIndex < signature.fields.length) {
    if (fieldIndex > 0) output.append(",");
    const field = view signature.fields[fieldIndex];
    output.append("{\"name\":");
    appendQuoted(inout output, field.name);
    output.append(",\"typeName\":");
    appendQuoted(inout output, field.typeName);
    output.append(",\"executorAffinity\":");
    appendNullableString(inout output, field.executorAffinity);
    output.append(",\"visibility\":");
    appendQuoted(inout output, field.visibility);
    output.append(",\"readonlyField\":");
    appendBoolean(inout output, field.readonlyField);
    output.append(",\"hasDefault\":");
    appendBoolean(inout output, field.hasDefault);
    output.append(",\"optionalField\":");
    appendBoolean(inout output, field.optionalField);
    output.append("}");
    fieldIndex = fieldIndex + 1;
  }
  output.append("],\"methods\":[");
  let methodIndex: usize = 0;
  while (methodIndex < signature.methods.length) {
    if (methodIndex > 0) output.append(",");
    const method = view signature.methods[methodIndex];
    output.append("{\"name\":");
    appendQuoted(inout output, method.name);
    output.append(",\"staticMethod\":");
    appendBoolean(inout output, method.staticMethod);
    output.append(",\"visibility\":");
    appendQuoted(inout output, method.visibility);
    output.append(",\"receiverMode\":");
    appendQuoted(inout output, method.receiverMode);
    output.append(",\"signature\":");
    appendFunctionSignature(inout output, method.signature);
    output.append("}");
    methodIndex = methodIndex + 1;
  }
  output.append("],\"variants\":[");
  let variantIndex: usize = 0;
  while (variantIndex < signature.variants.length) {
    if (variantIndex > 0) output.append(",");
    const variant = view signature.variants[variantIndex];
    output.append("{\"name\":");
    appendQuoted(inout output, variant.name);
    output.append(",\"payloadType\":");
    appendNullableString(inout output, variant.payloadType);
    output.append("}");
    variantIndex = variantIndex + 1;
  }
  output.append("],\"customDeinit\":");
  appendBoolean(inout output, signature.customDeinit);
  output.append(",\"customConstructor\":");
  appendBoolean(inout output, signature.customConstructor);
  output.append(",\"constructorSignature\":");
  match (in signature.constructorSignature) {
    some(constructorSignature) => appendFunctionSignature(
      inout output,
      constructorSignature
    );
    none => output.append("null");
  }
  output.append("}");
}

function appendSymbol(inout output: TextBuffer, in symbol: ModuleSymbol): void {
  output.append("{\"name\":");
  appendQuoted(inout output, symbol.name);
  output.append(",\"kind\":");
  const kind = moduleSymbolKindName(symbol.kind);
  appendQuoted(inout output, kind);
  output.append(",\"exported\":true,\"nativeCExport\":");
  appendBoolean(inout output, symbol.nativeCExport);
  output.append(",\"targetModule\":null,\"importedName\":");
  appendQuoted(inout output, symbol.importedName);
  output.append(",\"functionSignature\":");
  match (in symbol.functionSignature) {
    some(signature) => appendFunctionSignature(inout output, signature);
    none => output.append("null");
  }
  output.append(",\"typeSignature\":");
  match (in symbol.typeSignature) {
    some(signature) => appendTypeSignature(inout output, signature);
    none => output.append("null");
  }
  output.append(`,"location":{"offset":${symbol.offset},"line":${symbol.line},"column":${symbol.column}}}`);
}

function appendArgument(
  inout output: TextBuffer,
  in tree: ExpressionTree,
  nodeIndex: usize,
  in typeName: String
): void {
  const node = view tree.nodes[nodeIndex];
  output.append("{\"kind\":");
  if (node.kind == ExpressionKind.stringExpression) {
    appendQuoted(inout output, "string");
    output.append(",\"type\":");
    appendQuoted(inout output, typeName);
    output.append(",\"value\":");
    appendQuoted(inout output, node.value);
  } else if (node.kind == ExpressionKind.numberExpression) {
    appendQuoted(inout output, "number");
    output.append(",\"type\":");
    appendQuoted(inout output, typeName);
    output.append(",\"value\":");
    appendQuoted(inout output, node.value);
  } else if (node.kind == ExpressionKind.booleanExpression) {
    appendQuoted(inout output, "boolean");
    output.append(",\"type\":");
    appendQuoted(inout output, typeName);
    output.append(",\"value\":");
    appendBoolean(inout output, node.value == "true");
  } else if (node.kind == ExpressionKind.nullExpression) {
    appendQuoted(inout output, "null");
    output.append(",\"type\":");
    appendQuoted(inout output, typeName);
    output.append(",\"value\":null");
  } else {
    appendQuoted(inout output, "other");
    output.append(",\"type\":");
    appendQuoted(inout output, typeName);
  }
  output.append("}");
}

function callArgumentsInTree(
  in tree: ExpressionTree,
  offset: usize,
  in parameterTypes: Array<String>
): Option<String> {
  for (const node of tree.nodes) {
    if (node.kind != ExpressionKind.callExpression || node.offset != offset) continue;
    let output = TextBuffer();
    output.append("[");
    let childIndex: usize = 1;
    while (childIndex < node.children.length) {
      if (childIndex > 1) output.append(",");
      let typeName = "";
      if (childIndex - 1 < parameterTypes.length) {
        typeName = copy parameterTypes[childIndex - 1];
      }
      appendArgument(
        inout output,
        tree,
        node.children[childIndex],
        typeName
      );
      childIndex = childIndex + 1;
    }
    output.append("]");
    return Option.some(output.finish());
  }
  return Option<String>.none;
}

function callArgumentsInSyntax(
  in syntax: ExpressionSyntax,
  offset: usize,
  in parameterTypes: Array<String>
): Option<String> {
  return match (in syntax.tree) {
    some(tree) => callArgumentsInTree(tree, offset, parameterTypes);
    none => Option<String>.none;
  };
}

function callArgumentsInStatements(
  in arena: StatementArena,
  offset: usize,
  in parameterTypes: Array<String>
): Option<String> {
  for (const statement of arena.nodes) {
    match (in statement.expression) {
      some(expression) => match (
        callArgumentsInSyntax(expression, offset, parameterTypes)
      ) {
        some(arguments) => return Option.some(arguments);
        none => {}
      }
      none => {}
    }
    match (in statement.secondExpression) {
      some(expression) => match (
        callArgumentsInSyntax(expression, offset, parameterTypes)
      ) {
        some(arguments) => return Option.some(arguments);
        none => {}
      }
      none => {}
    }
  }
  return Option<String>.none;
}

function callArgumentsInProgram(
  in program: Program,
  offset: usize,
  in parameterTypes: Array<String>
): Option<String> {
  for (const constant of program.constants) {
    match (callArgumentsInSyntax(constant.initializer, offset, parameterTypes)) {
      some(arguments) => return Option.some(arguments);
      none => {}
    }
  }
  for (const declaration of program.functions) {
    match (callArgumentsInStatements(declaration.body, offset, parameterTypes)) {
      some(arguments) => return Option.some(arguments);
      none => {}
    }
  }
  for (const aggregate of program.aggregates) {
    for (const field of aggregate.fields) {
      match (in field.defaultValue) {
        some(value) => match (callArgumentsInSyntax(value, offset, parameterTypes)) {
          some(arguments) => return Option.some(arguments);
          none => {}
        }
        none => {}
      }
      match (callArgumentsInStatements(field.defaultStatements, offset, parameterTypes)) {
        some(arguments) => return Option.some(arguments);
        none => {}
      }
    }
    match (in aggregate.constructorDeclaration) {
      some(constructorDeclaration) => match (
        callArgumentsInStatements(
          constructorDeclaration.body,
          offset,
          parameterTypes
        )
      ) {
        some(arguments) => return Option.some(arguments);
        none => {}
      }
      none => {}
    }
    for (const method of aggregate.methods) {
      match (callArgumentsInStatements(method.body, offset, parameterTypes)) {
        some(arguments) => return Option.some(arguments);
        none => {}
      }
    }
    match (in aggregate.deinitializer) {
      some(deinitializer) => match (
        callArgumentsInStatements(deinitializer.body, offset, parameterTypes)
      ) {
        some(arguments) => return Option.some(arguments);
        none => {}
      }
      none => {}
    }
  }
  return Option<String>.none;
}

function appendCall(
  inout output: TextBuffer,
  in module: ParsedModule,
  in targetPath: String,
  in targetSymbol: ModuleSymbol,
  in resolution: ModuleCallResolution
): void throws String {
  const arguments = match (
    callArgumentsInProgram(
      module.program,
      resolution.offset,
      resolution.parameterTypes
    )
  ) {
    some(arguments) => arguments;
    none => throw `program metadata could not find resolved call "${resolution.targetName}" at ${module.path}:${resolution.line}:${resolution.column}`;
  };
  output.append(`{"offset":${resolution.offset},"line":${resolution.line},"column":${resolution.column},"target":{"module":`);
  appendQuoted(inout output, targetPath);
  output.append(",\"symbol\":");
  appendQuoted(inout output, targetSymbol.name);
  output.append(",\"kind\":");
  appendQuoted(inout output, resolution.kind);
  output.append(",\"name\":");
  appendQuoted(inout output, resolution.targetName);
  output.append("},\"asynchronous\":");
  appendBoolean(inout output, resolution.asynchronous);
  output.append(",\"receiverMode\":");
  appendQuoted(inout output, resolution.receiverMode);
  output.append(`,"callableTypeParameterCount":${resolution.callableTypeParameterCount},"typeParameters":`);
  appendStringArray(inout output, resolution.typeParameters);
  output.append(",\"typeArguments\":");
  appendStringArray(inout output, resolution.typeArguments);
  output.append(",\"parameterModes\":");
  appendStringArray(inout output, resolution.parameterModes);
  output.append(",\"parameterTypes\":");
  appendStringArray(inout output, resolution.parameterTypes);
  output.append(",\"returnType\":");
  appendQuoted(inout output, resolution.returnType);
  output.append(",\"errorType\":");
  appendNullableString(inout output, resolution.errorType);
  output.append(",\"arguments\":");
  output.append(arguments);
  output.append("}");
}

export function emitProgramMetadata(
  in modules: Array<ParsedModule>,
  in graph: ModuleGraph
): String throws String {
  let output = TextBuffer();
  output.append(`{"schemaVersion":1,"entry":${graph.entry},"modules":[`);
  let moduleIndex: usize = 0;
  while (moduleIndex < graph.modules.length) {
    if (moduleIndex > 0) output.append(",");
    const resolved = view graph.modules[moduleIndex];
    const parsed = view modules[moduleIndex];
    if (resolved.path != parsed.path) {
      throw `program metadata module order mismatch for "${resolved.path}"`;
    }
    output.append("{\"path\":");
    appendQuoted(inout output, resolved.path);
    output.append(",\"dependencies\":[");
    let dependencyIndex: usize = 0;
    while (dependencyIndex < resolved.dependencies.length) {
      if (dependencyIndex > 0) output.append(",");
      output.append(`${resolved.dependencies[dependencyIndex]}`);
      dependencyIndex = dependencyIndex + 1;
    }
    output.append("],\"symbols\":[");
    let emittedSymbols: usize = 0;
    for (const symbol of resolved.symbols) {
      if (!symbol.exported) continue;
      if (emittedSymbols > 0) output.append(",");
      appendSymbol(inout output, symbol);
      emittedSymbols = emittedSymbols + 1;
    }
    output.append("],\"calls\":[");
    let emittedCalls: usize = 0;
    for (const resolution of resolved.semanticEvidence.callResolutions) {
      if (resolution.targetModuleIndex >= graph.modules.length) continue;
      const targetModule = view graph.modules[resolution.targetModuleIndex];
      if (resolution.targetSymbolIndex >= targetModule.symbols.length) continue;
      const targetSymbol = view targetModule.symbols[resolution.targetSymbolIndex];
      if (!targetSymbol.exported) continue;
      if (emittedCalls > 0) output.append(",");
      try appendCall(
        inout output,
        parsed,
        targetModule.path,
        targetSymbol,
        resolution
      );
      emittedCalls = emittedCalls + 1;
    }
    output.append("]}");
    moduleIndex = moduleIndex + 1;
  }
  output.append("]}\n");
  return output.finish();
}
