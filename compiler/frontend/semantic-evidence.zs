import { NativeValueBinding } from "./semantic-flow-state.zs";
import {
  identifierLookupName,
} from "./semantic-expression-ownership.zs";
import {
  ModuleSymbolLocation,
  collectTypeIdentities,
} from "./semantic-type-identities.zs";
import { substituteGenericType } from "./semantic-type-ownership.zs";
import { moduleSymbolIndex } from "./module-symbols.zs";
import {
  ModuleBindingResolution,
  ModuleCallResolution,
  ModuleExpressionResolution,
  ModuleFunctionSignature,
  ModuleSemanticEvidence,
  ModuleSymbol,
  ModuleSymbolKind,
  ModuleTypeIdentity,
  ResolvedModule,
} from "./semantic-model.zs";
import { ExpressionKind, ExpressionTree } from "./parser.zs";

export function emptySemanticEvidence(): ModuleSemanticEvidence {
  return ModuleSemanticEvidence({
    callResolutions: Array<ModuleCallResolution>(),
    bindingResolutions: Array<ModuleBindingResolution>(),
    expressionResolutions: Array<ModuleExpressionResolution>(),
  });
}

function exportedFunctionLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): Option<ModuleSymbolLocation> {
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], name);
  if (
    symbolIndex < modules[moduleIndex].symbols.length
    && modules[moduleIndex].symbols[symbolIndex].exported
    && modules[moduleIndex].symbols[symbolIndex].kind
      == ModuleSymbolKind.functionSymbol
  ) return Option.some(ModuleSymbolLocation({ moduleIndex, symbolIndex }));
  return Option<ModuleSymbolLocation>.none;
}

export function callableSymbolLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  calleeIndex: usize
): Option<ModuleSymbolLocation> {
  if (tree.nodes[calleeIndex].kind == ExpressionKind.identifierExpression) {
    const sourceName = tree.nodes[calleeIndex].value.copyBytes(
      0,
      tree.nodes[calleeIndex].value.byteLength
    );
    const name = identifierLookupName(sourceName);
    const symbolIndex = moduleSymbolIndex(modules[moduleIndex], name);
    if (symbolIndex < modules[moduleIndex].symbols.length) {
      if (
        modules[moduleIndex].symbols[symbolIndex].kind
          == ModuleSymbolKind.functionSymbol
      ) {
        return Option.some(ModuleSymbolLocation({
          moduleIndex,
          symbolIndex,
        }));
      }
      if (
        modules[moduleIndex].symbols[symbolIndex].kind
          == ModuleSymbolKind.importedSymbol
      ) {
        const importedName = modules[moduleIndex]
          .symbols[symbolIndex]
          .importedName
          .copyBytes(
            0,
            modules[moduleIndex].symbols[symbolIndex].importedName.byteLength
          );
        const target = match (
          in modules[moduleIndex].symbols[symbolIndex].targetModule
        ) {
          some(target) => exportedFunctionLocation(
            modules,
            target,
            importedName
          );
          none => {
            return match (
              in modules[moduleIndex].symbols[symbolIndex].functionSignature
            ) {
              some(_) => Option<ModuleSymbolLocation>.some(ModuleSymbolLocation({
                moduleIndex,
                symbolIndex,
              }));
              none => Option<ModuleSymbolLocation>.none;
            };
          }
        };
        return target;
      }
    }
    return Option<ModuleSymbolLocation>.none;
  }
  if (
    tree.nodes[calleeIndex].kind == ExpressionKind.memberExpression
    && tree.nodes[calleeIndex].children.length == 1
  ) {
    const receiverIndex = tree.nodes[calleeIndex].children[0];
    if (
      tree.nodes[receiverIndex].kind != ExpressionKind.identifierExpression
    ) return Option<ModuleSymbolLocation>.none;
    const namespace = tree.nodes[receiverIndex].value.copyBytes(
      0,
      tree.nodes[receiverIndex].value.byteLength
    );
    const member = tree.nodes[calleeIndex].value.copyBytes(
      0,
      tree.nodes[calleeIndex].value.byteLength
    );
    const memberName = identifierLookupName(member);
    const symbolIndex = moduleSymbolIndex(modules[moduleIndex], namespace);
    if (
      symbolIndex < modules[moduleIndex].symbols.length
      && modules[moduleIndex].symbols[symbolIndex].kind
        == ModuleSymbolKind.namespaceSymbol
    ) {
      return match (
        in modules[moduleIndex].symbols[symbolIndex].targetModule
      ) {
        some(target) => exportedFunctionLocation(
          modules,
          target,
          memberName
        );
        none => {
          const qualified = `${namespace}.${memberName}`;
          const foreignIndex = moduleSymbolIndex(
            modules[moduleIndex],
            qualified
          );
          if (
            foreignIndex < modules[moduleIndex].symbols.length
            && modules[moduleIndex].symbols[foreignIndex].kind
              == ModuleSymbolKind.importedSymbol
          ) return match (
            in modules[moduleIndex].symbols[foreignIndex].functionSignature
          ) {
            some(_) => Option<ModuleSymbolLocation>.some(ModuleSymbolLocation({
              moduleIndex,
              symbolIndex: foreignIndex,
            }));
            none => Option<ModuleSymbolLocation>.none;
          };
          return Option<ModuleSymbolLocation>.none;
        }
      };
    }
  }
  return Option<ModuleSymbolLocation>.none;
}

export function foreignValueSymbolLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize
): Option<ModuleSymbolLocation> {
  let name = "";
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
    name = identifierLookupName(tree.nodes[index].value);
  } else if (
    tree.nodes[index].kind == ExpressionKind.memberExpression
    && tree.nodes[index].children.length == 1
  ) {
    const receiver = tree.nodes[index].children[0];
    if (
      tree.nodes[receiver].kind != ExpressionKind.identifierExpression
    ) return Option<ModuleSymbolLocation>.none;
    const namespace = identifierLookupName(tree.nodes[receiver].value);
    const member = identifierLookupName(tree.nodes[index].value);
    name = `${namespace}.${member}`;
  } else return Option<ModuleSymbolLocation>.none;
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], name);
  if (
    symbolIndex < modules[moduleIndex].symbols.length
    && modules[moduleIndex].symbols[symbolIndex].kind
      == ModuleSymbolKind.importedSymbol
    && modules[moduleIndex].symbols[symbolIndex].valueType.byteLength > 0
  ) return Option.some(ModuleSymbolLocation({ moduleIndex, symbolIndex }));
  return Option<ModuleSymbolLocation>.none;
}

export function recordCallResolution(
  in tree: ExpressionTree,
  callIndex: usize,
  targetModuleIndex: usize,
  targetSymbolIndex: usize,
  in callKind: String,
  in functionName: String,
  in signature: ModuleFunctionSignature,
  in substitutions: Array<NativeValueBinding>,
  in receiverMode: String,
  in returnType: String,
  in errorType: String,
  inout evidence: ModuleSemanticEvidence
): void {
  let typeParameters = Array<String>();
  let typeArguments = Array<String>();
  for (const substitution of substitutions) {
    typeParameters.push(substitution.name.copyBytes(
      0,
      substitution.name.byteLength
    ));
    typeArguments.push(substitution.typeName.copyBytes(
      0,
      substitution.typeName.byteLength
    ));
  }
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  let concreteIndex: usize = 0;
  while (concreteIndex < signature.parameterTypes.length) {
    parameterModes.push(signature.parameterModes[concreteIndex].copyBytes(
      0,
      signature.parameterModes[concreteIndex].byteLength
    ));
    parameterTypes.push(substituteGenericType(
      signature.parameterTypes[concreteIndex],
      substitutions
    ));
    concreteIndex = concreteIndex + 1;
  }
  evidence.callResolutions.push(ModuleCallResolution({
    offset: tree.nodes[callIndex].offset,
    line: tree.nodes[callIndex].line,
    column: tree.nodes[callIndex].column,
    targetModuleIndex,
    targetSymbolIndex,
    kind: callKind.copyBytes(0, callKind.byteLength),
    targetName: functionName.copyBytes(0, functionName.byteLength),
    asynchronous: signature.asynchronous,
    receiverMode: receiverMode.copyBytes(0, receiverMode.byteLength),
    typeParameters,
    typeArguments,
    parameterModes,
    parameterTypes,
    returnType: returnType.copyBytes(0, returnType.byteLength),
    errorType: errorType.copyBytes(0, errorType.byteLength),
    foreignHeader: "",
    foreignSuccessValues: Array<String>(),
  }));
}

export function recordForeignCallFacts(
  in tree: ExpressionTree,
  callIndex: usize,
  in symbol: ModuleSymbol,
  inout evidence: ModuleSemanticEvidence
): void {
  let resolutionIndex: usize = 0;
  while (resolutionIndex < evidence.callResolutions.length) {
    if (
      evidence.callResolutions[resolutionIndex].offset
        == tree.nodes[callIndex].offset
      && evidence.callResolutions[resolutionIndex].line
        == tree.nodes[callIndex].line
      && evidence.callResolutions[resolutionIndex].column
        == tree.nodes[callIndex].column
    ) {
      evidence.callResolutions[resolutionIndex].foreignHeader =
        symbol.foreignHeader.copyBytes(0, symbol.foreignHeader.byteLength);
      for (const successValue of symbol.foreignSuccessValues) {
        evidence.callResolutions[resolutionIndex].foreignSuccessValues.push(
          successValue.copyBytes(0, successValue.byteLength)
        );
      }
      return;
    }
    resolutionIndex = resolutionIndex + 1;
  }
}

export function recordExpressionResolution(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in typeName: String,
  inout evidence: ModuleSemanticEvidence
): void {
  if (typeName.byteLength == 0 || typeName == "__z_never") return;
  for (const existing of evidence.expressionResolutions) {
    if (
      existing.offset == tree.nodes[index].offset
      && existing.line == tree.nodes[index].line
      && existing.column == tree.nodes[index].column
    ) return;
  }
  let typeIdentities = Array<ModuleTypeIdentity>();
  collectTypeIdentities(
    modules,
    moduleIndex,
    typeName,
    "",
    inout typeIdentities
  );
  evidence.expressionResolutions.push(ModuleExpressionResolution({
    offset: tree.nodes[index].offset,
    line: tree.nodes[index].line,
    column: tree.nodes[index].column,
    typeName: typeName.copyBytes(0, typeName.byteLength),
    targetName: "",
    typeIdentities,
  }));
}

export function recordForeignValueResolution(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in typeName: String,
  in targetName: String,
  inout evidence: ModuleSemanticEvidence
): void {
  recordExpressionResolution(
    modules,
    moduleIndex,
    tree,
    index,
    typeName,
    inout evidence
  );
  let resolutionIndex: usize = 0;
  while (resolutionIndex < evidence.expressionResolutions.length) {
    if (
      evidence.expressionResolutions[resolutionIndex].offset
        == tree.nodes[index].offset
      && evidence.expressionResolutions[resolutionIndex].line
        == tree.nodes[index].line
      && evidence.expressionResolutions[resolutionIndex].column
        == tree.nodes[index].column
    ) {
      evidence.expressionResolutions[resolutionIndex].targetName =
        targetName.copyBytes(
        0,
        targetName.byteLength
      );
      return;
    }
    resolutionIndex = resolutionIndex + 1;
  }
}

export function recordBindingResolution(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  offset: usize,
  line: usize,
  column: usize,
  in name: String,
  mutableBinding: boolean,
  in typeName: String,
  inout evidence: ModuleSemanticEvidence
): void {
  let typeIdentities = Array<ModuleTypeIdentity>();
  collectTypeIdentities(
    modules,
    moduleIndex,
    typeName,
    "",
    inout typeIdentities
  );
  evidence.bindingResolutions.push(ModuleBindingResolution({
    offset,
    line,
    column,
    name: name.copyBytes(0, name.byteLength),
    mutableBinding,
    typeName: typeName.copyBytes(0, typeName.byteLength),
    typeIdentities,
  }));
}
