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
  foreignUnionMatches: Array<ModuleForeignUnionMatch> =
    Array<ModuleForeignUnionMatch>();
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
  callableTypeParameterCount: usize;
  typeParameters: Array<String>;
  typeArguments: Array<String>;
  parameterModes: Array<String>;
  parameterTypes: Array<String>;
  returnType: String;
  errorType: String;
  foreignHeader: String;
  foreignSuccessValues: Array<String>;
  foreignArguments: Array<ModuleForeignArgument>;
  objectiveCSelector: String = "";
  objectiveCReceiverNativeType: String = "";
  objectiveCNativeReturnType: String = "";
  objectiveCParameterNativeTypes: Array<String> = Array<String>();
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
  viewLifetime: String;
}

export struct ModuleVariantSignature {
  name: String;
  payloadType: String;
}

export struct ModuleForeignUnionVariantSignature {
  name: String;
  member: String;
  payloadType: String;
  values: Array<String>;
}

export struct ModuleForeignUnionMatchVariant {
  name: String;
  member: String;
  payloadType: String;
  values: Array<String>;
  fallback: boolean;
}

export struct ModuleForeignUnionMatch {
  offset: usize;
  line: usize;
  column: usize;
  unionType: String;
  discriminantMember: String;
  discriminantType: String;
  variants: Array<ModuleForeignUnionMatchVariant>;
}

export struct ModuleObjCParameterProtocolSignature {
  parameterIndex: usize;
  protocolName: String;
}

export struct ModuleObjCAvailabilitySignature {
  platform: String;
  introduced: String;
  deprecated: boolean;
  deprecatedVersion: String;
  obsoleted: String;
  unavailable: boolean;
  message: String;
}

export struct ModuleMethodSignature {
  name: String;
  staticMethod: boolean;
  visibility: String;
  receiverMode: String;
  signature: ModuleFunctionSignature;
  objectiveCSelector: String = "";
  objectiveCNativeReturnType: String = "";
  objectiveCParameterNativeTypes: Array<String> = Array<String>();
  objectiveCParameterProtocols: Array<ModuleObjCParameterProtocolSignature> =
    Array<ModuleObjCParameterProtocolSignature>();
  objectiveCRequired: boolean = true;
  objectiveCReturnsInstanceType: boolean = false;
  objectiveCAvailability: Array<ModuleObjCAvailabilitySignature> =
    Array<ModuleObjCAvailabilitySignature>();
  objectiveCAsyncCallbackParameter: Option<usize> = Option<usize>.none;
  objectiveCAsyncResultParameter: Option<usize> = Option<usize>.none;
  objectiveCAsyncErrorParameter: Option<usize> = Option<usize>.none;
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
  foreignDiscriminantMember: String = "";
  foreignDiscriminantType: String = "";
  foreignUnionVariants: Array<ModuleForeignUnionVariantSignature> =
    Array<ModuleForeignUnionVariantSignature>();
  foreignFallbackVariant: String = "";
  foreignObjCSuperName: String = "";
  foreignObjCProtocolName: String = "";
}

export struct ModuleFunctionSignature {
  asynchronous: boolean;
  executorAffinity: String;
  threadContract: String;
  typeParameters: Array<String>;
  typeParameterConstraints: Array<ModuleTypeParameterConstraint>;
  parameterModes: Array<String>;
  parameterTypes: Array<String>;
  // A foreign view result borrows from this parameter when present.
  viewParameter: Option<usize>;
  // Z view returns may conservatively borrow from several immutable inputs.
  viewParameters: Array<usize> = Array<usize>();
  // A transparent zero-argument accessor may return the ARC identity retained
  // by this Once<T> module cell in the signature's defining module.
  classIdentitySource: String = "";
  // A narrowly audited direct value-struct return may preserve which class
  // parameter supplied each direct class field.
  classIdentityFieldNames: Array<String> = Array<String>();
  classIdentityParameterIndices: Array<usize> = Array<usize>();
  // Foreign calls may invalidate outstanding views derived from these inputs.
  invalidatesParameters: Array<usize>;
  invalidatesLifetimes: Array<String>;
  returnType: String;
  errorType: String;
}

export struct ModuleGraph {
  modules: Array<ResolvedModule>;
  dependencyOrder: Array<usize>;
  entry: usize;
}
