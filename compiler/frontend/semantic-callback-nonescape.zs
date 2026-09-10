import { Map } from "std/collections";
import { ParsedModule, moduleSymbolIndex } from "./module-symbols.zs";
import { ResolvedModule, ModuleSymbolKind, ModuleFunctionSignature, ModuleTypeSignature } from "./semantic-model.zs";
import { nativeFunctionSignature } from "./semantic-type-shapes.zs";
import { transparentTypeName } from "./semantic-type-identities.zs";
import {
  ExpressionKind, ExpressionTree, StatementArena, StatementKind,
  FunctionDeclaration, ParameterMode,
} from "./parser.zs";

struct CallbackTarget { moduleIndex: usize; functionIndex: usize; }

function plainCalleeName(in name: String): String {
  let position: usize = 0;
  while (position < name.byteLength) {
    if (name.byteAt(position) == 60) return name.copyBytes(0, position);
    position = position + 1;
  }
  return name.copyBytes(0, name.byteLength);
}

function functionTarget(
  in parsed: Array<ParsedModule>, in modules: Array<ResolvedModule>,
  moduleIndex: usize, in name: String, depth: usize
): Option<CallbackTarget> {
  if (depth > 64) return Option.none;
  const plain = plainCalleeName(name);
  const index = moduleSymbolIndex(modules[moduleIndex], plain);
  if (index >= modules[moduleIndex].symbols.length) return Option.none;
  const symbol = view modules[moduleIndex].symbols[index];
  match (in symbol.targetModule) {
    some(target) => return functionTarget(parsed, modules, target, symbol.importedName, depth + 1);
    none => {}
  }
  if (symbol.kind != ModuleSymbolKind.functionSymbol) return Option.none;
  let functionIndex: usize = 0;
  for (const declaration of parsed[moduleIndex].program.functions) {
    if (declaration.name == plain) return Option.some(CallbackTarget({ moduleIndex, functionIndex }));
    functionIndex = functionIndex + 1;
  }
  return Option.none;
}

function refers(
  in arena: StatementArena, in tree: ExpressionTree, index: usize, in name: String
): boolean {
  const node = view tree.nodes[index];
  if ((node.kind == ExpressionKind.identifierExpression
    || node.kind == ExpressionKind.argumentBindingExpression) && node.value == name) return true;
  if (node.kind == ExpressionKind.executorCaptureExpression) {
    for (const label of node.labels) { if (label == name) return true; }
  }
  for (const child of node.children) { if (refers(arena, tree, child, name)) return true; }
  for (const statement of node.statements) { if (statementRefers(arena, statement, name)) return true; }
  return false;
}

function statementRefers(in arena: StatementArena, index: usize, in name: String): boolean {
  const node = view arena.nodes[index];
  match (in node.expression) { some(expression) => match (in expression.tree) {
    some(tree) => { const root = tree.root; if (refers(arena, tree, root, name)) return true; } none => return true;
  } none => {} }
  match (in node.secondExpression) { some(expression) => match (in expression.tree) {
    some(tree) => { const root = tree.root; if (refers(arena, tree, root, name)) return true; } none => return true;
  } none => {} }
  for (const child of node.children) { if (statementRefers(arena, child, name)) return true; }
  return false;
}

function treeShadows(in tree: ExpressionTree, in name: String): boolean {
  for (const node of tree.nodes) {
    if ((node.kind == ExpressionKind.matchBindingExpression
      || node.kind == ExpressionKind.forBindingExpression
      || node.kind == ExpressionKind.closureParameterExpression) && node.value == name) return true;
  }
  return false;
}

function shadowed(in declaration: FunctionDeclaration, in name: String): boolean {
  for (const parameter of declaration.parameters) { if (parameter.name == name) return true; }
  for (const statement of declaration.body.nodes) {
    if (statement.name == name) return true;
    for (const binding of statement.objectBindings) { if (binding.bindingName == name) return true; }
    for (const binding of statement.arrayBindings) { if (binding.bindingName == name) return true; }
    match (in statement.expression) { some(expression) => match (in expression.tree) {
      some(tree) => { if (treeShadows(tree, name)) return true; } none => {}
    } none => {} }
    match (in statement.secondExpression) { some(expression) => match (in expression.tree) {
      some(tree) => { if (treeShadows(tree, name)) return true; } none => {}
    } none => {} }
  }
  return false;
}

function directReference(in tree: ExpressionTree, index: usize, in name: String): boolean {
  const node = view tree.nodes[index];
  if (node.kind == ExpressionKind.identifierExpression) return node.value == name;
  return node.kind == ExpressionKind.argumentReferenceExpression && node.value == "in"
    && node.children.length == 1 && tree.nodes[node.children[0]].kind == ExpressionKind.argumentBindingExpression
    && tree.nodes[node.children[0]].value == name;
}

function safeExpression(
  in parsed: Array<ParsedModule>, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in declaration: FunctionDeclaration, in tree: ExpressionTree, index: usize, in name: String,
  inout memo: Map<String, boolean>, depth: usize
): boolean {
  const node = view tree.nodes[index];
  if (node.kind == ExpressionKind.closureExpression
    || node.kind == ExpressionKind.spawnExpression
    || node.kind == ExpressionKind.executorPlacementExpression
    || node.kind == ExpressionKind.awaitExpression) return !refers(declaration.body, tree, index, name);
  if ((node.kind == ExpressionKind.identifierExpression
    || node.kind == ExpressionKind.argumentBindingExpression) && node.value == name) return false;
  if (node.kind == ExpressionKind.callExpression && node.children.length > 0) {
    const callee = node.children[0];
    const invocation = tree.nodes[callee].kind == ExpressionKind.identifierExpression
      && tree.nodes[callee].value == name;
    if (!invocation && !safeExpression(parsed, modules, moduleIndex, declaration, tree, callee, name, inout memo, depth)) return false;
    let target = Option<CallbackTarget>.none;
    const calleeName = plainCalleeName(tree.nodes[callee].value);
    if (!invocation && tree.nodes[callee].kind == ExpressionKind.identifierExpression
      && !shadowed(declaration, calleeName)) {
      target = functionTarget(parsed, modules, moduleIndex, tree.nodes[callee].value, 0);
    }
    let argument: usize = 1;
    while (argument < node.children.length) {
      const child = node.children[argument];
      if (!invocation && directReference(tree, child, name)) {
        match (in target) {
          some(calleeTarget) => {
            if (!parameterSafe(parsed, modules, calleeTarget.moduleIndex,
              parsed[calleeTarget.moduleIndex].program.functions[calleeTarget.functionIndex],
              argument - 1, inout memo, depth + 1)) return false;
          }
          none => return false;
        }
      } else if (!safeExpression(parsed, modules, moduleIndex, declaration, tree, child, name, inout memo, depth)) return false;
      argument = argument + 1;
    }
    return true;
  }
  for (const child of node.children) {
    if (!safeExpression(parsed, modules, moduleIndex, declaration, tree, child, name, inout memo, depth)) return false;
  }
  for (const statement of node.statements) {
    if (!safeStatement(parsed, modules, moduleIndex, declaration, statement, name, inout memo, depth)) return false;
  }
  return true;
}

function safeStatement(
  in parsed: Array<ParsedModule>, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in declaration: FunctionDeclaration, index: usize, in name: String,
  inout memo: Map<String, boolean>, depth: usize
): boolean {
  const node = view declaration.body.nodes[index];
  if (node.kind == StatementKind.yieldStatement) return false;
  match (in node.expression) { some(expression) => match (in expression.tree) {
    some(tree) => { const root = tree.root; if (!safeExpression(parsed, modules, moduleIndex, declaration, tree, root, name, inout memo, depth)) return false; }
    none => return false;
  } none => {} }
  match (in node.secondExpression) { some(expression) => match (in expression.tree) {
    some(tree) => { const root = tree.root; if (!safeExpression(parsed, modules, moduleIndex, declaration, tree, root, name, inout memo, depth)) return false; }
    none => return false;
  } none => {} }
  for (const child of node.children) {
    if (!safeStatement(parsed, modules, moduleIndex, declaration, child, name, inout memo, depth)) return false;
  }
  return true;
}

function parameterSafe(
  in parsed: Array<ParsedModule>, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in declaration: FunctionDeclaration, parameterIndex: usize,
  inout memo: Map<String, boolean>, depth: usize
): boolean {
  if (depth > 64 || declaration.asynchronous || declaration.rawLanguage.byteLength > 0
    || parameterIndex >= declaration.parameters.length
    || declaration.parameters[parameterIndex].mode != ParameterMode.input) return false;
  const key = `${moduleIndex}:${declaration.offset}:${parameterIndex}`;
  const cached = memo.get(key);
  match (in cached) { some(value) => return value; none => {} }
  // A recursive/unknown edge fails closed, never assumes the cycle is safe.
  memo.set(copy key, false);
  const name = declaration.parameters[parameterIndex].name.copyBytes(0, declaration.parameters[parameterIndex].name.byteLength);
  for (const statement of declaration.body.roots) {
    if (!safeStatement(parsed, modules, moduleIndex, declaration, statement, name, inout memo, depth)) return false;
  }
  memo.set(key, true);
  return true;
}

function provenParameters(
  in parsed: Array<ParsedModule>, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in declaration: FunctionDeclaration, inout memo: Map<String, boolean>
): Array<usize> {
  let result = Array<usize>();
  let index: usize = 0;
  for (const parameter of declaration.parameters) {
    if (parameter.mode == ParameterMode.input) {
      const typeName = transparentTypeName(modules, moduleIndex, parameter.type.name);
      match (nativeFunctionSignature(typeName)) {
        some(_) => { if (parameterSafe(parsed, modules, moduleIndex, declaration, index, inout memo, 0)) result.push(index); }
        none => {}
      }
    }
    index = index + 1;
  }
  return result;
}

export function inferCallbackNonescape(
  in parsed: Array<ParsedModule>, inout modules: Array<ResolvedModule>
): void {
  let memo = Map<String, boolean>();
  let moduleIndex: usize = 0;
  while (moduleIndex < parsed.length) {
    for (const declaration of parsed[moduleIndex].program.functions) {
      const proven = provenParameters(parsed, modules, moduleIndex, declaration, inout memo);
      if (proven.length == 0) continue;
      const symbolIndex = moduleSymbolIndex(modules[moduleIndex], declaration.name);
      let replacement = Option<ModuleFunctionSignature>.none;
      match (in modules[moduleIndex].symbols[symbolIndex].functionSignature) {
        some(signature) => {
          let updated = copy signature;
          updated.nonEscapingParameters = move proven;
          replacement = Option.some(move updated);
        }
        none => {}
      }
      modules[moduleIndex].symbols[symbolIndex].functionSignature = move replacement;
    }
    for (const aggregate of parsed[moduleIndex].program.aggregates) {
      const symbolIndex = moduleSymbolIndex(modules[moduleIndex], aggregate.name);
      for (const method of aggregate.methods) {
        const proven = provenParameters(parsed, modules, moduleIndex, method, inout memo);
        if (proven.length == 0) continue;
        let replacement = Option<ModuleTypeSignature>.none;
        match (in modules[moduleIndex].symbols[symbolIndex].typeSignature) {
          some(signature) => {
            let updated = copy signature;
            let index: usize = 0;
            while (index < updated.methods.length) {
              if (updated.methods[index].name == method.name) {
                updated.methods[index].signature.nonEscapingParameters = copy proven;
              }
              index = index + 1;
            }
            replacement = Option.some(move updated);
          }
          none => {}
        }
        modules[moduleIndex].symbols[symbolIndex].typeSignature = move replacement;
      }
    }
    moduleIndex = moduleIndex + 1;
  }
}
