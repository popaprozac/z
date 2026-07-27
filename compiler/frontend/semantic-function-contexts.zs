import {
  NativeValueBinding,
  addBorrowedValueBinding,
  addMutableValueBinding,
  addUninitializedMutableValueBinding,
  addValueBinding,
} from "./semantic-flow-state.zs";
import { addTypeParameterBindings } from "./semantic-member-lookups.zs";
import { genericTypeShape } from "./semantic-type-shapes.zs";
import {
  ExpressionTree,
  FunctionDeclaration,
  Parameter,
  ParameterMode,
  ReceiverMode,
  StatementArena,
  StatementKind,
  TypeParameter,
} from "./parser.zs";

export function functionValueBindings(
  in parameters: Array<Parameter>
): Array<NativeValueBinding> {
  let bindings = Array<NativeValueBinding>();
  for (const parameter of parameters) {
    if (parameter.mode == ParameterMode.inputOutput) {
      addBorrowedValueBinding(
        inout bindings,
        parameter.name,
        parameter.type.name,
        true
      );
    } else if (parameter.mode == ParameterMode.output) {
      addUninitializedMutableValueBinding(
        inout bindings,
        parameter.name,
        parameter.type.name,
        true
      );
    } else if (parameter.mode == ParameterMode.input) {
      addBorrowedValueBinding(
        inout bindings,
        parameter.name,
        parameter.type.name,
        false
      );
    } else {
      addValueBinding(inout bindings, parameter.name, parameter.type.name);
    }
  }
  return bindings;
}

function statementContainsYield(
  in arena: StatementArena,
  index: usize
): boolean {
  if (arena.nodes[index].kind == StatementKind.yieldStatement) return true;
  for (const child of arena.nodes[index].children) {
    if (statementContainsYield(arena, child)) return true;
  }
  match (in arena.nodes[index].expression) {
    some(expression) => {
      match (in expression.tree) {
        some(tree) => {
          const root = tree.root;
          if (expressionNodeContainsYield(arena, tree, root)) return true;
        }
        none => {}
      }
    }
    none => {}
  }
  match (in arena.nodes[index].secondExpression) {
    some(expression) => {
      match (in expression.tree) {
        some(tree) => {
          const root = tree.root;
          if (expressionNodeContainsYield(arena, tree, root)) return true;
        }
        none => {}
      }
    }
    none => {}
  }
  return false;
}

function expressionNodeContainsYield(
  in arena: StatementArena,
  in tree: ExpressionTree,
  index: usize
): boolean {
  for (const statement of tree.nodes[index].statements) {
    if (statementContainsYield(arena, statement)) return true;
  }
  for (const child of tree.nodes[index].children) {
    if (expressionNodeContainsYield(arena, tree, child)) return true;
  }
  return false;
}

function statementArenaContainsYield(in arena: StatementArena): boolean {
  for (const root of arena.roots) {
    if (statementContainsYield(arena, root)) return true;
  }
  return false;
}

export function prepareFunctionBindings(
  in declaration: FunctionDeclaration,
  in ownerType: String,
  in inheritedTypeParameters: Array<TypeParameter>,
  inout bindings: Array<NativeValueBinding>
): String {
  let bodyReturnType = declaration.returnType.name.copyBytes(
    0,
    declaration.returnType.name.byteLength
  );
  if (statementArenaContainsYield(declaration.body)) {
    match (genericTypeShape(declaration.returnType.name)) {
      some(generator) => {
        if (
          generator.base == "Generator"
          || generator.base == "AsyncGenerator"
        ) {
          if (generator.arguments.length > 0) {
            addValueBinding(
              inout bindings,
              "__z_native_yield_type",
              generator.arguments[0]
            );
          }
          if (
            generator.arguments.length >= 2
            && generator.arguments[1] != "void"
          ) {
            bodyReturnType = generator.arguments[1].copyBytes(
              0,
              generator.arguments[1].byteLength
            );
          } else {
            bodyReturnType = "void";
          }
        }
      }
      none => {}
    }
  }
  addTypeParameterBindings(inout bindings, inheritedTypeParameters);
  addTypeParameterBindings(inout bindings, declaration.typeParameters);
  addValueBinding(
    inout bindings,
    "__z_native_function_name",
    declaration.name
  );
  addValueBinding(
    inout bindings,
    "__z_native_return_type",
    declaration.returnType.name
  );
  if (declaration.asynchronous) {
    addValueBinding(inout bindings, "__z_native_async_context", "true");
  }
  match (in declaration.errorType) {
    some(error) => addValueBinding(
      inout bindings,
      "__z_native_error_type",
      error.name
    );
    none => {}
  }
  if (!declaration.staticMethod && ownerType.byteLength > 0) {
    if (declaration.receiverMode == ReceiverMode.inputOutput) {
      addBorrowedValueBinding(inout bindings, "this", ownerType, true);
    } else if (declaration.receiverMode == ReceiverMode.move) {
      addMutableValueBinding(inout bindings, "this", ownerType);
    } else {
      addBorrowedValueBinding(inout bindings, "this", ownerType, false);
    }
  }
  if (ownerType.byteLength > 0) {
    addValueBinding(inout bindings, "__z_native_owner_type", ownerType);
  }
  return bodyReturnType;
}
