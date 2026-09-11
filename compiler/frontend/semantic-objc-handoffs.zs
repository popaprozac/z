import { ExpressionKind, ExpressionTree, StatementArena, StatementKind } from "./parser.zs";
import { ParsedModule } from "./module-symbols.zs";
import { ModuleCallResolution, ModuleResolveError, ModuleResolveErrorKind, ResolvedModule, codedModuleResolutionError } from "./semantic-model.zs";
import { NativeValueBinding, liveViewBindingForOwner, valueBindingType } from "./semantic-flow-state.zs";
import { transparentTypeName, typeSymbolLocation } from "./semantic-type-identities.zs";
import { nativeObjCObjectType } from "./semantic-objc-subclasses.zs";

function boundary(in arena: StatementArena, statement: usize, offset: usize): boolean {
  const node = view arena.nodes[statement];
  if (node.kind == StatementKind.variableStatement || node.kind == StatementKind.returnStatement
    || node.kind == StatementKind.expressionStatement) {
    match (in node.expression) {
      some(expression) => match (in expression.tree) {
        some(tree) => {
          if (tree.nodes[tree.root].kind == ExpressionKind.callExpression
            && tree.nodes[tree.root].offset == offset) return true;
        }
        none => {}
      }
      none => {}
    }
  }
  // Only descend through statement nesting, never a partially evaluated
  // enclosing expression or a closure's independently executed body.
  for (const child of node.children) { if (boundary(arena, child, offset)) return true; }
  return false;
}

function handoffValue(in modules: Array<ResolvedModule>, moduleIndex: usize, in sourceName: String): boolean {
  const name = transparentTypeName(modules, moduleIndex, sourceName);
  if (name == "void" || name == "boolean" || name == "i8" || name == "u8"
    || name == "i16" || name == "u16" || name == "i32" || name == "u32"
    || name == "i64" || name == "u64" || name == "isize" || name == "usize"
    || name == "f32" || name == "f64") return true;
  match (typeSymbolLocation(modules, moduleIndex, name)) {
    some(location) => match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
      some(signature) => return signature.foreignKind == "scalar" || signature.foreignKind == "enum"
        || (signature.foreignKind == "record" && signature.foreignLayout == "struct"
          && signature.foreignResourceRelease.byteLength == 0);
      none => {}
    }
    none => {}
  }
  return false;
}

// Typed, synchronous, nonconsuming superclass dispatch is checked by the caller.
// Object parameters cross as precisely scoped strong snapshots, not as loans
// into their source storage. Blocks, raw pointers, and writable arguments keep
// the guard; results remain POD. No partially evaluated enclosing expression.
export struct NativeSuperclassHandoff {
  eligible: boolean = false;
  parameterObjects: Array<boolean> = Array<boolean>();
}

export function checkedNativeSuperclassHandoff(
  in module: ParsedModule, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in arena: StatementArena, in tree: ExpressionTree, index: usize,
  in bindings: Array<NativeValueBinding>, in call: ModuleCallResolution
): NativeSuperclassHandoff throws ModuleResolveError {
  if (call.kind != "objcSuper" || valueBindingType(bindings, "__z_native_function_name") == "constructor") return NativeSuperclassHandoff();
  let atBoundary = false;
  for (const root of arena.roots) { if (boundary(arena, root, tree.nodes[index].offset)) atBoundary = true; }
  if (!atBoundary || !handoffValue(modules, moduleIndex, call.returnType)) return NativeSuperclassHandoff();
  if (call.parameterTypes.length + 1 != tree.nodes[index].children.length
    || call.parameterModes.length != call.parameterTypes.length) return NativeSuperclassHandoff();
  let objects = Array<boolean>();
  let argument: usize = 0;
  while (argument < call.parameterTypes.length) {
    const object = nativeObjCObjectType(modules, moduleIndex, call.parameterTypes[argument]);
    if (!object && !handoffValue(modules, moduleIndex, call.parameterTypes[argument])) return NativeSuperclassHandoff();
    if (call.parameterModes[argument] == "inout" || call.parameterModes[argument] == "out") return NativeSuperclassHandoff();
    objects.push(object);
    argument = argument + 1;
  }
  const liveView = liveViewBindingForOwner(bindings, "this");
  if (liveView.byteLength > 0) {
    throw codedModuleResolutionError(ModuleResolveErrorKind.typeMismatch, "Z0814", module.path,
      "cannot delegate a superclass call while receiver-field storage is borrowed; finish the borrow or use an owned snapshot",
      tree.nodes[index].line, tree.nodes[index].column, 1);
  }
  // Flow narrowing currently applies to named locals, not receiver fields.
  // Those locals are snapshots; fields must be freshly loaded after reentry.
  return NativeSuperclassHandoff({ eligible: true, parameterObjects: move objects });
}
