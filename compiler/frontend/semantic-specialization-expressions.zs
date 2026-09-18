// Dependent expressions are checked once their concrete callable demand is
// known. Preserve ordinary literal ranges and nominal operator rules rather
// than relying on the eventual C representation or implicit conversions.
import { ExpressionKind, ExpressionSyntax, ExpressionTree, FunctionDeclaration } from "./parser.zs";
import { ParsedModule } from "./module-symbols.zs";
import { ModuleResolveError, ModuleResolveErrorKind, ModuleSemanticEvidence, ResolvedModule, moduleResolutionError } from "./semantic-model.zs";
import { binaryOperatorType } from "./semantic-operators.zs";
import { isContextualNumericLiteral, requireNumericLiteralRange } from "./semantic-expression-types.zs";
import { isNumericTypeName } from "./semantic-type-shapes.zs";
import { transparentTypeName } from "./semantic-type-identities.zs";

function operandType(in tree: ExpressionTree, index: usize, in evidence: ModuleSemanticEvidence): String {
  const node = view tree.nodes[index];
  const found = evidence.expressionResolutionIndices.get(node.offset);
  const resolutionIndex: usize = match (in found) {
    some(foundIndex) => foundIndex;
    none => evidence.expressionResolutions.length;
  };
  if (resolutionIndex >= evidence.expressionResolutions.length) return "";
  const resolution = view evidence.expressionResolutions[resolutionIndex];
  if (resolution.line != node.line || resolution.column != node.column) return "";
  return copy resolution.typeName;
}

function validateSyntax(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in callableName: String,
  in syntax: Option<ExpressionSyntax>,
  in evidence: ModuleSemanticEvidence,
  in parameters: Array<String>,
  in arguments: Array<String>,
  in argumentModules: Array<usize>,
  in argumentSymbols: Array<usize>
): void throws ModuleResolveError {
  match (in syntax) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        let index: usize = 0;
        while (index < tree.nodes.length) {
          const node = view tree.nodes[index];
          if (isContextualNumericLiteral(tree, index)) {
            const expected = operandType(tree, index, evidence);
            let parameterIndex: usize = 0;
            while (parameterIndex < parameters.length && parameterIndex < arguments.length) {
              if (expected == parameters[parameterIndex]) {
                const concrete = transparentTypeName(modules, moduleIndex, arguments[parameterIndex]);
                if (!isNumericTypeName(concrete)) throw moduleResolutionError(
                  ModuleResolveErrorKind.typeMismatch, module.path,
                  `numeric literal requires a numeric type, found ${concrete} (in specialization ${callableName}<${expected} = ${concrete}>)`,
                  node.line, node.column);
                const range = attempt requireNumericLiteralRange(module, tree, index, concrete);
                match (range) {
                  success => {}
                  failure(error) => throw moduleResolutionError(error.kind, error.path,
                    `${error.message} (in specialization ${callableName}<${expected} = ${concrete}>)`, error.line, error.column);
                }
              }
              parameterIndex = parameterIndex + 1;
            }
          }
          if (node.kind == ExpressionKind.binaryExpression && node.children.length == 2
            && (node.value == "==" || node.value == "!=" || node.value == "<"
              || node.value == "<=" || node.value == ">" || node.value == ">=")) {
            const left = operandType(tree, node.children[0], evidence);
            const right = operandType(tree, node.children[1], evidence);
            if (left == right && left.byteLength > 0) {
              let parameterIndex: usize = 0;
              while (parameterIndex < parameters.length && parameterIndex < arguments.length) {
                if (left == parameters[parameterIndex]) {
                  let context = moduleIndex;
                  let concrete = copy arguments[parameterIndex];
                  if (parameterIndex < argumentModules.length
                    && argumentModules[parameterIndex] < modules.length) {
                    context = argumentModules[parameterIndex];
                    concrete = copy modules[context].symbols[argumentSymbols[parameterIndex]].name;
                  }
                  const checked = try binaryOperatorType(module, modules, context, tree, index,
                    node.value, concrete, concrete);
                }
                parameterIndex = parameterIndex + 1;
              }
            }
          }
          index = index + 1;
        }
      }
      none => {}
    }
    none => {}
  }
}

export function validateSpecializedExpressions(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in declaration: FunctionDeclaration,
  in parameters: Array<String>,
  in arguments: Array<String>,
  in argumentModules: Array<usize>,
  in argumentSymbols: Array<usize>
): void throws ModuleResolveError {
  for (const statement of declaration.body.nodes) {
    try validateSyntax(module, modules, moduleIndex, declaration.name, statement.expression,
      modules[moduleIndex].semanticEvidence, parameters, arguments, argumentModules, argumentSymbols);
    try validateSyntax(module, modules, moduleIndex, declaration.name, statement.secondExpression,
      modules[moduleIndex].semanticEvidence, parameters, arguments, argumentModules, argumentSymbols);
  }
}
