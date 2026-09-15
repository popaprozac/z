import {
  AggregateDeclaration, ExpressionKind, ExpressionSyntax, ExpressionTree,
  Parameter, StatementArena, StatementKind,
} from "./parser.zs";
import { ParsedModule } from "./module-symbols.zs";
import {
  ModuleResolveError, ModuleResolveErrorKind, codedModuleResolutionError,
} from "./semantic-model.zs";
import { stringStartsWith } from "./semantic-type-shapes.zs";

// These are syntactic call sites, not executable semantic evidence. Full
// receiver/argument typing and ownership must precede lowering their dispatch.
export struct NativeSuperclassCallSite {
  name: String;
  argumentLabels: Array<String>;
  argumentCount: usize;
  initializes: boolean;
  offset: usize;
  line: usize;
  column: usize;
}

struct BodyContext {
  constructorBody: boolean;
  insideClosure: boolean;
  beforeInitialization: boolean;
  initializerOffset: usize;
  dying: boolean = false;
  helper: boolean = false;
  fields: Array<String> = Array<String>();
}

function bodyError(
  in module: ParsedModule, in message: String, line: usize, column: usize
): ModuleResolveError {
  return codedModuleResolutionError(
    ModuleResolveErrorKind.typeMismatch, "Z0814", module.path,
    message, line, column, 1
  );
}

export function nativeInitializerSelector(in name: String): boolean {
  if (!stringStartsWith(name, "init")) return false;
  if (name.byteLength == 4) return true;
  const next = name.byteAt(4);
  return next < 97 || next > 122;
}

function nativeLifecycleSelector(in name: String): boolean {
  return name == "dealloc" || name == "retain" || name == "release"
    || name == "autorelease" || name == "retainCount";
}

function checkBinding(
  in module: ParsedModule, in name: String, line: usize, column: usize
): void throws ModuleResolveError {
  if (stringStartsWith(name, "_z_")) throw bodyError(module,
    "names beginning with `_z_` are reserved for compiler-generated storage",
    line, column);
  if (name == "self" || name == "_cmd") throw bodyError(module,
    "native implicit receiver names `self` and `_cmd` cannot be shadowed in a native subclass",
    line, column);
}

function checkParameters(
  in module: ParsedModule, in parameters: Array<Parameter>
): void throws ModuleResolveError {
  for (const parameter of parameters) {
    try checkBinding(module, parameter.name, parameter.line, parameter.column);
  }
}

function visitExpression(
  in module: ParsedModule, in arena: StatementArena, in tree: ExpressionTree,
  index: usize, in context: BodyContext, inout calls: Array<NativeSuperclassCallSite>
): void throws ModuleResolveError {
  const node = view tree.nodes[index];
  if (context.dying && node.kind == ExpressionKind.memberExpression && node.children.length == 1) {
    const receiver = view tree.nodes[node.children[0]];
    if (receiver.kind == ExpressionKind.identifierExpression && receiver.value == "this" && !context.insideClosure) {
      for (const field of context.fields) { if (field == node.value) return; }
    }
  }
  if (node.kind == ExpressionKind.identifierExpression) {
    if (context.dying && (node.value == "this" || node.value == "super")) throw bodyError(module,
      "native subclass deinit cannot publish or call through the dying receiver; use its stored fields", node.line, node.column);
    if (context.beforeInitialization && (node.value == "this" || node.value == "super")) {
      throw bodyError(module,
        "the native receiver cannot be used before superclass initialization succeeds", node.line, node.column);
    }
    if (context.insideClosure && node.value == "this") throw bodyError(module,
      "capturing `this` is not implemented in the initial closure tier", node.line, node.column);
    if (node.value == "super") throw bodyError(module,
      "`super` may only be the direct receiver of a native superclass call", node.line, node.column);
  }
  if (node.kind == ExpressionKind.closureParameterExpression
    || node.kind == ExpressionKind.matchBindingExpression) {
    try checkBinding(module, node.value, node.line, node.column);
  }
  if (node.kind == ExpressionKind.executorCaptureExpression && node.labels.length > 0) {
    const name = view node.labels[0];
    if (name == "super") throw bodyError(module,
      "`super` cannot be captured by a closure", node.line, node.column);
    if (context.beforeInitialization && name == "this") throw bodyError(module,
      "the native receiver cannot be used before superclass initialization succeeds", node.line, node.column);
    if (name == "this") throw bodyError(module,
      "capturing `this` is not implemented in the initial closure tier", node.line, node.column);
  }
  if (node.kind == ExpressionKind.callExpression && node.children.length > 0) {
    const callee = view tree.nodes[node.children[0]];
    if (callee.kind == ExpressionKind.memberExpression && callee.children.length == 1) {
      const receiver = view tree.nodes[callee.children[0]];
      if (receiver.kind == ExpressionKind.identifierExpression && receiver.value == "super") {
        if (context.helper) throw bodyError(module,
          "superclass dispatch belongs in an explicit native entry, not a Z-only method", node.line, node.column);
        if (context.dying) throw bodyError(module,
          "native subclass deinit cannot publish or call through the dying receiver; use its stored fields", node.line, node.column);
        if (context.beforeInitialization) throw bodyError(module,
          "the native receiver cannot be used before superclass initialization succeeds", receiver.line, receiver.column);
        if (context.insideClosure) throw bodyError(module,
          "`super` cannot be captured by a closure", receiver.line, receiver.column);
        const initializes = context.constructorBody && node.offset == context.initializerOffset;
        if (!initializes && nativeInitializerSelector(callee.value)) throw bodyError(module,
          "superclass initialization must occur exactly once, as the first constructor statement", node.line, node.column);
        if (nativeLifecycleSelector(callee.value)) throw bodyError(module,
          "native ARC lifecycle methods cannot be called through `super`", node.line, node.column);
        calls.push(NativeSuperclassCallSite({
          name: copy callee.value,
          argumentLabels: copy node.labels,
          argumentCount: node.children.length - 1,
          initializes,
          offset: node.offset, line: node.line, column: node.column,
        }));
        let argumentContext = copy context;
        if (initializes) argumentContext.beforeInitialization = true;
        let argument: usize = 1;
        while (argument < node.children.length) {
          try visitExpression(module, arena, tree, node.children[argument], argumentContext, inout calls);
          argument = argument + 1;
        }
        // The direct receiver has been checked. Visiting it again as a value
        // would incorrectly reject every valid `super.method(...)` call.
        return;
      }
    }
  }
  let nested = copy context;
  if (node.kind == ExpressionKind.closureExpression) {
    nested.constructorBody = false;
    nested.insideClosure = true;
  }
  for (const child of node.children) {
    try visitExpression(module, arena, tree, child, nested, inout calls);
  }
  for (const statement of node.statements) {
    try visitStatement(module, arena, statement, nested, inout calls);
  }
}

function visitSyntax(
  in module: ParsedModule, in arena: StatementArena, in expression: ExpressionSyntax,
  in context: BodyContext, inout calls: Array<NativeSuperclassCallSite>
): void throws ModuleResolveError {
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      try visitExpression(module, arena, tree, root, context, inout calls);
    }
    none => {}
  }
}

function visitStatement(
  in module: ParsedModule, in arena: StatementArena, index: usize,
  in context: BodyContext, inout calls: Array<NativeSuperclassCallSite>
): void throws ModuleResolveError {
  const statement = view arena.nodes[index];
  if (context.dying && !context.insideClosure && (statement.kind == StatementKind.returnStatement || statement.kind == StatementKind.throwStatement)) {
    throw bodyError(module, "native subclass deinit must finish synchronously without return or throw", statement.line, statement.column);
  }
  if (context.constructorBody && statement.kind == StatementKind.returnStatement) {
    throw bodyError(module,
      "native subclass constructors must fall through after initialization in the first tier",
      statement.line, statement.column);
  }
  try checkBinding(module, statement.name, statement.nameLine, statement.nameColumn);
  for (const binding of statement.objectBindings) {
    try checkBinding(module, binding.bindingName, binding.bindingLine, binding.bindingColumn);
  }
  for (const binding of statement.arrayBindings) {
    try checkBinding(module, binding.bindingName, binding.bindingLine, binding.bindingColumn);
  }
  match (in statement.expression) {
    some(expression) => try visitSyntax(module, arena, expression, context, inout calls);
    none => {}
  }
  match (in statement.secondExpression) {
    some(expression) => try visitSyntax(module, arena, expression, context, inout calls);
    none => {}
  }
  for (const child of statement.children) {
    try visitStatement(module, arena, child, context, inout calls);
  }
}

export function inspectNativeSubclassBodies(
  in module: ParsedModule, in aggregate: AggregateDeclaration, initializerOffset: usize
): Array<NativeSuperclassCallSite> throws ModuleResolveError {
  let calls = Array<NativeSuperclassCallSite>();
  match (in aggregate.constructorDeclaration) {
    some(initializer) => {
      // Match the first storage tier's straight-line initialization prefix.
      let pending = Array<String>();
      for (const field of aggregate.fields) { pending.push(copy field.name); }
      let next: usize = 1;
      while (pending.length > 0 && next < initializer.body.roots.length) {
        const statement = view initializer.body.nodes[initializer.body.roots[next]];
        let initialized = "";
        if (statement.kind == StatementKind.assignmentStatement) {
          match (in statement.expression) {
            some(expression) => match (in expression.tree) {
              some(tree) => {
                const target = view tree.nodes[tree.root];
                if (target.kind == ExpressionKind.memberExpression && target.children.length == 1) {
                  const receiver = view tree.nodes[target.children[0]];
                  if (receiver.kind == ExpressionKind.identifierExpression && receiver.value == "this") initialized = copy target.value;
                }
              }
              none => {}
            }
            none => {}
          }
        }
        let remaining = Array<String>();
        let found = false;
        for (const name of pending) {
          if (name == initialized) found = true;
          else remaining.push(copy name);
        }
        if (!found) throw bodyError(module,
          "initialize every native stored field directly after super.init before other receiver use or control flow", statement.line, statement.column);
        const initializationContext = BodyContext({ constructorBody: true,
          insideClosure: false, beforeInitialization: true, initializerOffset });
        match (in statement.secondExpression) {
          some(expression) => try visitSyntax(module, initializer.body, expression,
            initializationContext, inout calls);
          none => {}
        }
        pending = move remaining;
        next = next + 1;
      }
      if (pending.length > 0) throw bodyError(module,
        "native stored fields are not initialized", initializer.line, initializer.column);
      try checkParameters(module, initializer.parameters);
      const context = BodyContext({
        constructorBody: true, insideClosure: false, beforeInitialization: false,
        initializerOffset,
      });
      for (const root of initializer.body.roots) {
        try visitStatement(module, initializer.body, root, context, inout calls);
      }
    }
    none => {}
  }
  for (const method of aggregate.methods) {
    try checkParameters(module, method.parameters);
    const context = BodyContext({
      constructorBody: false, insideClosure: false, beforeInitialization: false,
      initializerOffset, helper: method.objectiveCSelector.byteLength == 0,
    });
    for (const root of method.body.roots) {
      try visitStatement(module, method.body, root, context, inout calls);
    }
  }
  match (in aggregate.deinitializer) {
    some(deinitializer) => {
      let fields = Array<String>();
      for (const field of aggregate.fields) { fields.push(copy field.name); }
      const context = BodyContext({ constructorBody: false, insideClosure: false,
        beforeInitialization: false, initializerOffset, dying: true, fields: move fields });
      for (const root of deinitializer.body.roots) {
        try visitStatement(module, deinitializer.body, root, context, inout calls);
      }
    }
    none => {}
  }
  return calls;
}
