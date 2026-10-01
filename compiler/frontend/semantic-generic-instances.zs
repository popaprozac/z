// A concrete instance of a generic declaration, spelled out as an ordinary
// one: every type parameter replaced by its type argument wherever the source
// names a type. Checking that copy is how a generic body meets each instance's
// real types, as DESIGN.md's monomorphize-before-checking model asks.
import { TextBuffer } from "std/text";
import {
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  FunctionDeclaration,
  StatementArena,
  TypeParameter,
  TypeReference,
} from "./parser.zs";

function isTypeNameByte(byte: u8): boolean {
  return (byte >= 97 && byte <= 122)
    || (byte >= 65 && byte <= 90)
    || (byte >= 48 && byte <= 57)
    || byte == 95;
}

// `text` with each whole name that is a type parameter replaced by its type
// argument; `Array<T>` becomes `Array<String>`, while `Tail` is left alone.
export function substituteTypeParameterNames(
  in text: String,
  in parameters: Array<String>,
  in arguments: Array<String>
): String {
  let output = TextBuffer();
  let index: usize = 0;
  while (index < text.byteLength) {
    if (!isTypeNameByte(text.byteAt(index))) {
      const start = index;
      while (index < text.byteLength && !isTypeNameByte(text.byteAt(index))) {
        index = index + 1;
      }
      output.append(text.copyBytes(start, index));
      continue;
    }
    const start = index;
    while (index < text.byteLength && isTypeNameByte(text.byteAt(index))) {
      index = index + 1;
    }
    const word = text.copyBytes(start, index);
    let replaced = false;
    let parameter: usize = 0;
    while (parameter < parameters.length && parameter < arguments.length) {
      if (word == parameters[parameter]) {
        output.append(arguments[parameter]);
        replaced = true;
        break;
      }
      parameter = parameter + 1;
    }
    if (!replaced) output.append(word);
  }
  return output.finish();
}

function substituteTypeReference(
  in type: TypeReference,
  in parameters: Array<String>,
  in arguments: Array<String>
): TypeReference {
  let substituted = copy type;
  substituted.name = substituteTypeParameterNames(type.name, parameters, arguments);
  return substituted;
}

// Literal text is not a type: a string, a template's text, a number.
function nodeValueNamesTypes(kind: ExpressionKind): boolean {
  return kind != ExpressionKind.stringExpression
    && kind != ExpressionKind.templateTextExpression
    && kind != ExpressionKind.numberExpression
    && kind != ExpressionKind.booleanExpression
    && kind != ExpressionKind.nullExpression;
}

function substituteExpressionTree(
  in tree: ExpressionTree,
  in parameters: Array<String>,
  in arguments: Array<String>
): ExpressionTree {
  let substituted = copy tree;
  let index: usize = 0;
  while (index < substituted.nodes.length) {
    const namesTypes = nodeValueNamesTypes(substituted.nodes[index].kind);
    if (namesTypes) {
      substituted.nodes[index].value = substituteTypeParameterNames(tree.nodes[index].value, parameters, arguments);
      let label: usize = 0;
      while (label < substituted.nodes[index].labels.length) {
        substituted.nodes[index].labels[label] = substituteTypeParameterNames(
          tree.nodes[index].labels[label], parameters, arguments);
        label = label + 1;
      }
    }
    let reference: usize = 0;
    while (reference < substituted.nodes[index].typeReferences.length) {
      substituted.nodes[index].typeReferences[reference] = substituteTypeReference(
        tree.nodes[index].typeReferences[reference], parameters, arguments);
      reference = reference + 1;
    }
    index = index + 1;
  }
  return substituted;
}

function substituteExpressionSyntax(
  in syntax: Option<ExpressionSyntax>,
  in parameters: Array<String>,
  in arguments: Array<String>
): Option<ExpressionSyntax> {
  match (in syntax) {
    some(expression) => {
      let substituted = copy expression;
      match (in expression.tree) {
        some(tree) => substituted.tree = Option.some(substituteExpressionTree(tree, parameters, arguments));
        none => {}
      }
      return Option.some(substituted);
    }
    none => {}
  }
  return Option<ExpressionSyntax>.none;
}

function substituteStatementArena(
  in arena: StatementArena,
  in parameters: Array<String>,
  in arguments: Array<String>
): StatementArena {
  let substituted = copy arena;
  let index: usize = 0;
  while (index < substituted.nodes.length) {
    match (in arena.nodes[index].typeAnnotation) {
      some(type) => substituted.nodes[index].typeAnnotation = Option.some(substituteTypeReference(type, parameters, arguments));
      none => {}
    }
    substituted.nodes[index].expression = substituteExpressionSyntax(arena.nodes[index].expression, parameters, arguments);
    substituted.nodes[index].secondExpression = substituteExpressionSyntax(
      arena.nodes[index].secondExpression, parameters, arguments);
    index = index + 1;
  }
  return substituted;
}

// `declaration` as the instance with `arguments` for `parameters`: no type
// parameters of its own, every named type concrete. Source positions are
// kept, so a diagnostic in the instance points into the generic body.
export function substituteFunctionDeclaration(
  in declaration: FunctionDeclaration,
  in parameters: Array<String>,
  in arguments: Array<String>
): FunctionDeclaration {
  let substituted = copy declaration;
  substituted.typeParameters = Array<TypeParameter>();
  let parameterIndex: usize = 0;
  while (parameterIndex < substituted.parameters.length) {
    substituted.parameters[parameterIndex].type = substituteTypeReference(
      declaration.parameters[parameterIndex].type, parameters, arguments);
    parameterIndex = parameterIndex + 1;
  }
  substituted.returnType = substituteTypeReference(declaration.returnType, parameters, arguments);
  match (in declaration.errorType) {
    some(error) => substituted.errorType = Option.some(substituteTypeReference(error, parameters, arguments));
    none => {}
  }
  substituted.body = substituteStatementArena(declaration.body, parameters, arguments);
  return substituted;
}
