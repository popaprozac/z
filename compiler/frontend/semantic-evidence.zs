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
  ModuleForeignUnionMatch,
  ModuleForeignArgument,
  ModuleFunctionSignature,
  ModuleObjCRegistrationResolution,
  ModuleObjCAdapterResolution,
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
    foreignUnionMatches: Array<ModuleForeignUnionMatch>(),
    objectiveCRegistrations: Array<ModuleObjCRegistrationResolution>(),
    objectiveCAdapters: Array<ModuleObjCAdapterResolution>(),
  });
}

function symbolVisibleToModule(
  in modules: Array<ResolvedModule>,
  ownerModuleIndex: usize,
  requesterModuleIndex: usize,
  in symbol: ModuleSymbol
): boolean {
  if (symbol.exported) return true;
  return symbol.packageVisible
    && modules[ownerModuleIndex].packageIdentity.byteLength > 0
    && modules[ownerModuleIndex].packageIdentity
      == modules[requesterModuleIndex].packageIdentity;
}

function visibleFunctionLocation(
  in modules: Array<ResolvedModule>,
  ownerModuleIndex: usize,
  requesterModuleIndex: usize,
  in name: String
): Option<ModuleSymbolLocation> {
  const symbolIndex = moduleSymbolIndex(modules[ownerModuleIndex], name);
  if (
    symbolIndex < modules[ownerModuleIndex].symbols.length
    && symbolVisibleToModule(
      modules,
      ownerModuleIndex,
      requesterModuleIndex,
      modules[ownerModuleIndex].symbols[symbolIndex]
    )
    && modules[ownerModuleIndex].symbols[symbolIndex].kind
      == ModuleSymbolKind.functionSymbol
  ) return Option.some(ModuleSymbolLocation({
    moduleIndex: ownerModuleIndex,
    symbolIndex,
  }));
  return Option<ModuleSymbolLocation>.none;
}

function visibleValueLocation(
  in modules: Array<ResolvedModule>,
  ownerModuleIndex: usize,
  requesterModuleIndex: usize,
  in name: String
): Option<ModuleSymbolLocation> {
  const symbolIndex = moduleSymbolIndex(modules[ownerModuleIndex], name);
  if (
    symbolIndex < modules[ownerModuleIndex].symbols.length
    && symbolVisibleToModule(
      modules,
      ownerModuleIndex,
      requesterModuleIndex,
      modules[ownerModuleIndex].symbols[symbolIndex]
    )
    && modules[ownerModuleIndex].symbols[symbolIndex].kind
      == ModuleSymbolKind.constantSymbol
  ) return Option.some(ModuleSymbolLocation({
    moduleIndex: ownerModuleIndex,
    symbolIndex,
  }));
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
          some(target) => visibleFunctionLocation(
            modules,
            target,
            moduleIndex,
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
        some(target) => visibleFunctionLocation(
          modules,
          target,
          moduleIndex,
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
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
    const name = identifierLookupName(tree.nodes[index].value);
    const symbolIndex = moduleSymbolIndex(modules[moduleIndex], name);
    if (symbolIndex >= modules[moduleIndex].symbols.length) {
      return Option<ModuleSymbolLocation>.none;
    }
    const symbol = view modules[moduleIndex].symbols[symbolIndex];
    if (
      symbol.kind == ModuleSymbolKind.constantSymbol
      && symbol.valueType.byteLength > 0
    ) return Option.some(ModuleSymbolLocation({ moduleIndex, symbolIndex }));
    if (symbol.kind != ModuleSymbolKind.importedSymbol) {
      return Option<ModuleSymbolLocation>.none;
    }
    return match (in symbol.targetModule) {
      some(target) => visibleValueLocation(
        modules,
        target,
        moduleIndex,
        symbol.importedName
      );
      none => {
        if (symbol.valueType.byteLength > 0) {
          return Option.some(ModuleSymbolLocation({
            moduleIndex,
            symbolIndex,
          }));
        }
        return Option<ModuleSymbolLocation>.none;
      }
    };
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
    const namespaceIndex = moduleSymbolIndex(
      modules[moduleIndex],
      namespace
    );
    if (
      namespaceIndex < modules[moduleIndex].symbols.length
      && modules[moduleIndex].symbols[namespaceIndex].kind
        == ModuleSymbolKind.namespaceSymbol
    ) return match (
      in modules[moduleIndex].symbols[namespaceIndex].targetModule
    ) {
      some(target) => visibleValueLocation(
        modules,
        target,
        moduleIndex,
        member
      );
      none => {
        const qualified = `${namespace}.${member}`;
        const foreignIndex = moduleSymbolIndex(
          modules[moduleIndex],
          qualified
        );
        if (
          foreignIndex < modules[moduleIndex].symbols.length
          && modules[moduleIndex].symbols[foreignIndex].kind
            == ModuleSymbolKind.importedSymbol
          && modules[moduleIndex].symbols[foreignIndex].valueType.byteLength > 0
        ) return Option.some(ModuleSymbolLocation({
          moduleIndex,
          symbolIndex: foreignIndex,
        }));
        return Option<ModuleSymbolLocation>.none;
      }
    };
  } else return Option<ModuleSymbolLocation>.none;
  return Option<ModuleSymbolLocation>.none;
}

export function valueSymbolTargetName(
  in modules: Array<ResolvedModule>,
  in location: ModuleSymbolLocation
): String {
  const symbol = view modules[location.moduleIndex].symbols[location.symbolIndex];
  if (symbol.kind == ModuleSymbolKind.constantSymbol) {
    return `__z_module_${location.moduleIndex}_${symbol.name}`;
  }
  return symbol.importedName.copyBytes(0, symbol.importedName.byteLength);
}

export function recordCallResolution(
  in tree: ExpressionTree,
  callIndex: usize,
  targetModuleIndex: usize,
  targetSymbolIndex: usize,
  in callKind: String,
  in functionName: String,
  in signature: ModuleFunctionSignature,
  callableTypeParameterCount: usize,
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
  const offset = tree.nodes[callIndex].offset;
  const resolutionIndex = evidence.callResolutions.length;
  evidence.callResolutions.push(ModuleCallResolution({
    offset,
    line: tree.nodes[callIndex].line,
    column: tree.nodes[callIndex].column,
    targetModuleIndex,
    targetSymbolIndex,
    kind: callKind.copyBytes(0, callKind.byteLength),
    targetName: functionName.copyBytes(0, functionName.byteLength),
    asynchronous: signature.asynchronous,
    receiverMode: receiverMode.copyBytes(0, receiverMode.byteLength),
    callableTypeParameterCount,
    typeParameters,
    typeArguments,
    parameterModes,
    parameterTypes,
    returnType: returnType.copyBytes(0, returnType.byteLength),
    errorType: errorType.copyBytes(0, errorType.byteLength),
    foreignHeader: "",
    foreignSuccessValues: Array<String>(),
    foreignArguments: Array<ModuleForeignArgument>(),
  }));
  if (!evidence.callResolutionIndices.has(offset)) {
    evidence.callResolutionIndices.set(offset, resolutionIndex);
  }
}

function callResolutionIndex(
  in evidence: ModuleSemanticEvidence,
  offset: usize
): usize {
  const found = evidence.callResolutionIndices.get(offset);
  return match (in found) {
    some(index) => index;
    none => evidence.callResolutions.length;
  };
}

export function recordForeignCallFacts(
  in tree: ExpressionTree,
  callIndex: usize,
  in symbol: ModuleSymbol,
  inout evidence: ModuleSemanticEvidence
): void {
  const resolutionIndex = callResolutionIndex(
    evidence,
    tree.nodes[callIndex].offset
  );
  if (resolutionIndex < evidence.callResolutions.length) {
    if (
      evidence.callResolutions[resolutionIndex].line
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
      for (const argument of symbol.foreignArguments) {
        evidence.callResolutions[resolutionIndex].foreignArguments.push(
          ModuleForeignArgument({
            kind: argument.kind.copyBytes(0, argument.kind.byteLength),
            source: argument.source,
            value: argument.value.copyBytes(0, argument.value.byteLength),
            mode: argument.mode.copyBytes(0, argument.mode.byteLength),
            thread: argument.thread.copyBytes(0, argument.thread.byteLength),
          })
        );
        if (
          argument.kind == "argument"
          && argument.source
            < evidence.callResolutions[resolutionIndex].parameterModes.length
        ) {
          const intrinsicCStringBorrow =
            argument.source
              < evidence.callResolutions[resolutionIndex].parameterTypes.length
            && evidence.callResolutions[resolutionIndex].parameterTypes[
              argument.source
            ] == "cstring"
            && evidence.callResolutions[resolutionIndex].parameterModes[
              argument.source
            ] == "in"
            && argument.mode == "value";
          if (!intrinsicCStringBorrow) {
            evidence.callResolutions[resolutionIndex].parameterModes[
              argument.source
            ] = argument.mode.copyBytes(0, argument.mode.byteLength);
          }
        }
      }
      return;
    }
  }
}

export function recordObjCCallFacts(
  in tree: ExpressionTree,
  callIndex: usize,
  in header: String,
  in selector: String,
  in receiverNativeType: String,
  in returnNativeType: String,
  in parameterNativeTypes: Array<String>,
  asyncCallbackParameter: Option<usize>,
  asyncResultParameter: Option<usize>,
  asyncErrorParameter: Option<usize>,
  inout evidence: ModuleSemanticEvidence
): void {
  const resolutionIndex = callResolutionIndex(
    evidence,
    tree.nodes[callIndex].offset
  );
  if (resolutionIndex < evidence.callResolutions.length) {
    if (
      evidence.callResolutions[resolutionIndex].line
        == tree.nodes[callIndex].line
      && evidence.callResolutions[resolutionIndex].column
        == tree.nodes[callIndex].column
    ) {
      evidence.callResolutions[resolutionIndex].foreignHeader =
        header.copyBytes(0, header.byteLength);
      evidence.callResolutions[resolutionIndex].objectiveCSelector =
        selector.copyBytes(0, selector.byteLength);
      evidence.callResolutions[resolutionIndex].objectiveCReceiverNativeType =
        receiverNativeType.copyBytes(0, receiverNativeType.byteLength);
      evidence.callResolutions[resolutionIndex].objectiveCNativeReturnType =
        returnNativeType.copyBytes(0, returnNativeType.byteLength);
      for (const typeName of parameterNativeTypes) {
        evidence.callResolutions[resolutionIndex]
          .objectiveCParameterNativeTypes.push(typeName.copyBytes(
            0,
            typeName.byteLength
          ));
      }
      evidence.callResolutions[resolutionIndex]
        .objectiveCAsyncCallbackParameter = asyncCallbackParameter;
      evidence.callResolutions[resolutionIndex]
        .objectiveCAsyncResultParameter = asyncResultParameter;
      evidence.callResolutions[resolutionIndex]
        .objectiveCAsyncErrorParameter = asyncErrorParameter;
      return;
    }
  }
}

function expressionResolutionIndex(
  in evidence: ModuleSemanticEvidence,
  offset: usize
): usize {
  const found = evidence.expressionResolutionIndices.get(offset);
  match (in found) {
    some(index) => return index;
    none => return evidence.expressionResolutions.length;
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
  const offset = tree.nodes[index].offset;
  if (evidence.expressionResolutionIndices.has(offset)) return;
  let typeIdentities = Array<ModuleTypeIdentity>();
  collectTypeIdentities(
    modules,
    moduleIndex,
    typeName,
    "",
    inout typeIdentities
  );
  const resolutionIndex = evidence.expressionResolutions.length;
  evidence.expressionResolutions.push(ModuleExpressionResolution({
    offset,
    line: tree.nodes[index].line,
    column: tree.nodes[index].column,
    typeName: typeName.copyBytes(0, typeName.byteLength),
    targetName: "",
    typeIdentities,
  }));
  evidence.expressionResolutionIndices.set(offset, resolutionIndex);
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
  const resolutionIndex = expressionResolutionIndex(
    evidence,
    tree.nodes[index].offset
  );
  if (resolutionIndex >= evidence.expressionResolutions.length) return;
  evidence.expressionResolutions[resolutionIndex].targetName =
    targetName.copyBytes(
      0,
      targetName.byteLength
    );
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
