// Dependent comparisons are checked once their concrete callable demand is
// known. Use the ordinary operator checker and nominal type identities, not
// the eventual C representation, to decide whether an operand is comparable.
import { ExpressionKind, ExpressionSyntax, ExpressionTree, FunctionDeclaration } from "./parser.zs";
import { ParsedModule } from "./module-symbols.zs";
import { ModuleResolveError, ModuleSemanticEvidence, ResolvedModule } from "./semantic-model.zs";
import { binaryOperatorType } from "./semantic-operators.zs";

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

export function validateSpecializedComparisons(
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
    try validateSyntax(module, modules, moduleIndex, statement.expression,
      modules[moduleIndex].semanticEvidence, parameters, arguments, argumentModules, argumentSymbols);
    try validateSyntax(module, modules, moduleIndex, statement.secondExpression,
      modules[moduleIndex].semanticEvidence, parameters, arguments, argumentModules, argumentSymbols);
  }
}
