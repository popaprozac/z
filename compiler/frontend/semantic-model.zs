import { Map } from "std/collections";

export struct ModuleSource {
  path: String;
  source: String;
}

export enum ModuleResolveErrorKind {
  lexer,
  parser,
  missingModule,
  circularImport,
  missingExport,
  duplicateBinding,
  unknownName,
  unknownType,
  unknownMember,
  typeMismatch,
  invalidOperator,
  invalidMatch,
  unsupportedLowering,
}

export struct ModuleResolveError {
  kind: ModuleResolveErrorKind;
  code: String = "";
  path: String;
  message: String;
  line: usize;
  column: usize;
  length: usize = 1;
}

export function moduleResolutionError(
  kind: ModuleResolveErrorKind,
  in path: String,
  in message: String,
  line: usize,
  column: usize
): ModuleResolveError {
  return ModuleResolveError({
    kind,
    code: "",
    path: path.copyBytes(0, path.byteLength),
    message: message.copyBytes(0, message.byteLength),
    line,
    column,
    length: 1,
  });
}

export function codedModuleResolutionError(
  kind: ModuleResolveErrorKind,
  in code: String,
  in path: String,
  in message: String,
  line: usize,
  column: usize,
  length: usize
): ModuleResolveError {
  return ModuleResolveError({
    kind,
    code: code.copyBytes(0, code.byteLength),
    path: path.copyBytes(0, path.byteLength),
    message: message.copyBytes(0, message.byteLength),
    line,
    column,
    length,
  });
}

export struct ResolvedModule {
  path: String;
  dependencies: Array<usize>;
  symbols: Array<ModuleSymbol>;
  symbolIndices: Map<String, usize>;
  semanticEvidence: ModuleSemanticEvidence;
}

export struct ModuleSemanticEvidence {
  callResolutions: Array<ModuleCallResolution>;
  bindingResolutions: Array<ModuleBindingResolution>;
  expressionResolutions: Array<ModuleExpressionResolution>;
}

export struct ModuleExpressionResolution {
  offset: usize;
  line: usize;
  column: usize;
  typeName: String;
  targetName: String;
  typeIdentities: Array<ModuleTypeIdentity>;
}

export struct ModuleBindingResolution {
  offset: usize;
  line: usize;
  column: usize;
  name: String;
  mutableBinding: boolean;
  typeName: String;
  typeIdentities: Array<ModuleTypeIdentity>;
}

export struct ModuleTypeIdentity {
  path: String;
  targetModuleIndex: usize;
  targetSymbolIndex: usize;
}

export struct ModuleCallResolution {
  offset: usize;
  line: usize;
  column: usize;
  targetModuleIndex: usize;
  targetSymbolIndex: usize;
  kind: String;
  targetName: String;
  asynchronous: boolean;
  receiverMode: String;
  typeParameters: Array<String>;
  typeArguments: Array<String>;
  parameterModes: Array<String>;
  parameterTypes: Array<String>;
  returnType: String;
  errorType: String;
  foreignHeader: String;
  foreignSuccessValues: Array<String>;
  foreignArguments: Array<ModuleForeignArgument>;
}

export struct ModuleForeignArgument {
  kind: String;
  source: usize;
  value: String;
  mode: String;
}

export enum ModuleSymbolKind {
  constantSymbol,
  functionSymbol,
  structSymbol,
  classSymbol,
  traitSymbol,
  typeAliasSymbol,
  enumSymbol,
  namespaceSymbol,
  importedSymbol,
}

export struct ModuleSymbol {
  name: String;
  kind: ModuleSymbolKind;
  exported: boolean;
  nativeCExport: boolean;
  targetModule: Option<usize>;
  importedName: String;
  valueType: String;
  functionSignature: Option<ModuleFunctionSignature>;
  typeSignature: Option<ModuleTypeSignature>;
  foreignHeader: String;
  foreignSuccessValues: Array<String>;
  foreignArguments: Array<ModuleForeignArgument>;
  offset: usize;
  line: usize;
  column: usize;
}

export struct ModuleFieldSignature {
  name: String;
  typeName: String;
  executorAffinity: String;
  visibility: String;
  readonlyField: boolean;
  hasDefault: boolean;
  optionalField: boolean;
}

export struct ModuleVariantSignature {
  name: String;
  payloadType: String;
}

export struct ModuleMethodSignature {
  name: String;
  staticMethod: boolean;
  visibility: String;
  receiverMode: String;
  signature: ModuleFunctionSignature;
}

export struct ModuleTypeParameterConstraint {
  parameter: String;
  traitName: String;
}

export struct ModuleTypeSignature {
  nativeCName: String;
  nativeCUnderlyingType: String;
  typeParameters: Array<String>;
  typeParameterConstraints: Array<ModuleTypeParameterConstraint>;
  executorAffinity: String;
  implementedTraits: Array<String>;
  fields: Array<ModuleFieldSignature>;
  methods: Array<ModuleMethodSignature>;
  variants: Array<ModuleVariantSignature>;
  customDeinit: boolean;
  customConstructor: boolean;
  constructorSignature: Option<ModuleFunctionSignature>;
  foreignKind: String;
  foreignLayout: String;
  foreignNativeName: String;
  foreignUnderlyingType: String;
  foreignResourceRelease: String;
}

export struct ModuleFunctionSignature {
  asynchronous: boolean;
  executorAffinity: String;
  typeParameters: Array<String>;
  typeParameterConstraints: Array<ModuleTypeParameterConstraint>;
  parameterModes: Array<String>;
  parameterTypes: Array<String>;
  // A foreign view result borrows from this parameter when present.
  viewParameter: Option<usize>;
  // Foreign calls may invalidate outstanding views derived from these inputs.
  invalidatesParameters: Array<usize>;
  returnType: String;
  errorType: String;
}

export struct ModuleGraph {
  modules: Array<ResolvedModule>;
  dependencyOrder: Array<usize>;
  entry: usize;
}
