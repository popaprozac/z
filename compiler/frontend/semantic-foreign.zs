import { Map } from "std/collections";
import {
  NativeForeignContractSet,
  NativeForeignFunctionContract,
  NativeForeignObjCAvailabilityContract,
  NativeForeignObjCInterfaceContract,
  NativeForeignObjCMethodContract,
  NativeForeignObjCProtocolContract,
  NativeForeignTypeContract,
} from "./foreign-contracts.zs";
import {
  ParsedModule,
  buildModuleSymbolIndices,
  moduleBindingName,
  moduleSymbolIndex,
} from "./module-symbols.zs";
import {
  ModuleForeignArgument,
  ModuleForeignUnionVariantSignature,
  ModuleFunctionSignature,
  ModuleFieldSignature,
  ModuleMethodSignature,
  ModuleObjCAvailabilitySignature,
  ModuleObjCParameterProtocolSignature,
  ModuleObjCSelectorCallbackSignature,
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSymbol,
  ModuleSymbolKind,
  ModuleTypeParameterConstraint,
  ModuleTypeSignature,
  ModuleVariantSignature,
  ResolvedModule,
  moduleResolutionError,
} from "./semantic-model.zs";
import {
  nativeFunctionSignature,
  nativeFunctionTypeName,
  nullableTargetType,
  stringStartsWith,
} from "./semantic-type-shapes.zs";

// Trusted native callable facts are attached only after raw declarations and
// .zd contracts have been normalized. The resolver never consumes ZFDCL wire
// records or unverified contract syntax directly.

export struct NativeForeignModuleContract {
  modulePath: String;
  cacheKey: String;
  dependencyPath: String;
  contracts: NativeForeignContractSet;
}

struct ForeignNameIndices {
  functions: Map<String, usize>;
  constants: Map<String, usize>;
  types: Map<String, usize>;
  objectiveCInterfaces: Map<String, usize>;
  objectiveCProtocols: Map<String, usize>;
}

// One immutable semantic projection per validated contract identity and local
// namespace. Different sidecars, aliases, and target facts must never merge.
// The cache lives only for one graph resolution; symbols keep their own source
// locations, headers, and visibility while retaining these shared signatures.
readonly class ForeignTypeSignatures {
  contracts: NativeForeignContractSet;
  namespace: String;
  indices: ForeignNameIndices;
  types: Array<ModuleTypeSignature>;
  interfaces: Array<ModuleTypeSignature>;
  protocols: Array<ModuleTypeSignature>;
}

function sharedForeignTypeSignatures(
  in contracts: NativeForeignContractSet,
  in namespace: String,
  inout cache: Array<ForeignTypeSignatures>
): ForeignTypeSignatures {
  for (const entry of cache) {
    if (entry.contracts == contracts && entry.namespace == namespace) return entry;
  }
  const indices = foreignNameIndices(contracts);
  let types = Array<ModuleTypeSignature>();
  for (const type of contracts.types) {
    types.push(foreignTypeSignature(type, indices, namespace));
  }
  let interfaces = Array<ModuleTypeSignature>();
  for (const interface_ of contracts.objectiveCInterfaces) {
    interfaces.push(objcInterfaceTypeSignature(interface_, contracts, indices, namespace));
  }
  let protocols = Array<ModuleTypeSignature>();
  for (const protocol of contracts.objectiveCProtocols) {
    protocols.push(objcProtocolTypeSignature(protocol, contracts, indices, namespace));
  }
  const signatures = new ForeignTypeSignatures({
    contracts,
    namespace: copy namespace,
    indices,
    types,
    interfaces,
    protocols,
  });
  cache.push(signatures);
  return signatures;
}

function foreignNameIndices(
  in contracts: NativeForeignContractSet
): ForeignNameIndices {
  let functions = Map<String, usize>();
  let index: usize = 0;
  while (index < contracts.functions.length) {
    functions.set(copy contracts.functions[index].name, index);
    index = index + 1;
  }
  let constants = Map<String, usize>();
  index = 0;
  while (index < contracts.constants.length) {
    constants.set(copy contracts.constants[index].name, index);
    index = index + 1;
  }
  let types = Map<String, usize>();
  index = 0;
  while (index < contracts.types.length) {
    types.set(copy contracts.types[index].name, index);
    index = index + 1;
  }
  let objectiveCInterfaces = Map<String, usize>();
  index = 0;
  while (index < contracts.objectiveCInterfaces.length) {
    objectiveCInterfaces.set(
      copy contracts.objectiveCInterfaces[index].name,
      index
    );
    index = index + 1;
  }
  let objectiveCProtocols = Map<String, usize>();
  index = 0;
  while (index < contracts.objectiveCProtocols.length) {
    objectiveCProtocols.set(
      copy contracts.objectiveCProtocols[index].name,
      index
    );
    index = index + 1;
  }
  return ForeignNameIndices({
    functions,
    constants,
    types,
    objectiveCInterfaces,
    objectiveCProtocols,
  });
}

function indexedForeignName(
  in names: Map<String, usize>,
  in name: String
): Option<usize> {
  const found = names.get(name);
  return match (in found) {
    some(index) => Option.some(index);
    none => Option<usize>.none;
  };
}

function localForeignTypeName(
  in indices: ForeignNameIndices,
  in namespace: String,
  in typeName: String
): String {
  const nullableTarget = nullableTargetType(typeName);
  if (nullableTarget.byteLength > 0) {
    const localized = localForeignTypeName(
      indices,
      namespace,
      nullableTarget
    );
    return `${localized} | null`;
  }
  if (stringStartsWith(typeName, "view ")) {
    const target = typeName.copyBytes(5, typeName.byteLength);
    const localized = localForeignTypeName(indices, namespace, target);
    return `view ${localized}`;
  }
  if (indices.types.has(typeName)) return `${namespace}.${typeName}`;
  return typeName.copyBytes(0, typeName.byteLength);
}

function localObjCTypeName(
  in contracts: NativeForeignContractSet,
  in indices: ForeignNameIndices,
  in namespace: String,
  in typeName: String
): String {
  // Native block signatures contain native names too. Rebind every nested
  // type into the importing namespace before contextual closure inference;
  // otherwise an inferred NSTimer parameter has no resolvable Z members.
  match (nativeFunctionSignature(typeName)) {
    some(signature) => {
      let localized = signature;
      let parameters = Array<String>();
      for (const parameter of localized.parameterTypes) {
        parameters.push(localObjCTypeName(contracts, indices, namespace, parameter));
      }
      localized.parameterTypes = move parameters;
      localized.returnType = localObjCTypeName(contracts, indices, namespace, localized.returnType);
      localized.errorType = localObjCTypeName(contracts, indices, namespace, localized.errorType);
      return nativeFunctionTypeName(localized);
    }
    none => {}
  }
  const nullableTarget = nullableTargetType(typeName);
  if (nullableTarget.byteLength > 0) {
    const localized = localObjCTypeName(
      contracts,
      indices,
      namespace,
      nullableTarget
    );
    return `${localized} | null`;
  }
  if (
    indices.objectiveCInterfaces.has(typeName)
    || indices.objectiveCProtocols.has(typeName)
  ) return `${namespace}.${typeName}`;
  return localForeignTypeName(indices, namespace, typeName);
}

function optionalTextOrEmpty(in value: Option<String>): String {
  return match (in value) {
    some(text) => text.copyBytes(0, text.byteLength);
    none => "";
  };
}

function objcAvailabilitySignature(
  in availability: NativeForeignObjCAvailabilityContract
): ModuleObjCAvailabilitySignature {
  return ModuleObjCAvailabilitySignature({
    platform: optionalTextOrEmpty(availability.platform),
    introduced: optionalTextOrEmpty(availability.introduced),
    deprecated: availability.deprecated,
    deprecatedVersion: optionalTextOrEmpty(availability.deprecatedVersion),
    obsoleted: optionalTextOrEmpty(availability.obsoleted),
    unavailable: availability.unavailable,
    message: optionalTextOrEmpty(availability.message),
  });
}

function objcMethodSignature(
  in method: NativeForeignObjCMethodContract,
  in contracts: NativeForeignContractSet,
  in indices: ForeignNameIndices,
  in namespace: String
): ModuleMethodSignature {
  let selectorCallbacks = Array<ModuleObjCSelectorCallbackSignature>();
  for (const callback of method.selectorCallbacks) {
    let rebound = copy callback;
    let types = Array<String>();
    for (const typeName of callback.signature.parameterTypes) {
      types.push(localObjCTypeName(contracts, indices, namespace, typeName));
    }
    rebound.signature.parameterTypes = move types;
    rebound.signature.returnType = localObjCTypeName(contracts, indices, namespace, callback.signature.returnType);
    selectorCallbacks.push(move rebound);
  }
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  let parameterNativeTypes = Array<String>();
  let parameterProtocols = Array<ModuleObjCParameterProtocolSignature>();
  let consumedParameters = Array<usize>();
  let parameterIndex: usize = 0;
  while (parameterIndex < method.parameters.length) {
    const parameter = view method.parameters[parameterIndex];
    if (parameter.consumed) consumedParameters.push(parameterIndex);
    let projectedCallback = false;
    match (method.asyncCallbackParameter) {
      some(index) => projectedCallback = index == parameterIndex;
      none => {}
    }
    if (!projectedCallback) {
      parameterModes.push(parameter.capability.copyBytes(
        0,
        parameter.capability.byteLength
      ));
      parameterTypes.push(localObjCTypeName(
        contracts,
        indices,
        namespace,
        parameter.typeName
      ));
    }
    parameterNativeTypes.push(parameter.nativeType.copyBytes(
      0,
      parameter.nativeType.byteLength
    ));
    for (const protocol of parameter.protocols) {
      parameterProtocols.push(ModuleObjCParameterProtocolSignature({
        parameterIndex,
        protocolName: `${namespace}.${protocol}`,
      }));
    }
    parameterIndex = parameterIndex + 1;
  }
  let availability = Array<ModuleObjCAvailabilitySignature>();
  for (const item of method.availability) {
    availability.push(objcAvailabilitySignature(item));
  }
  let asynchronous = false;
  let returnType = localObjCTypeName(
    contracts,
    indices,
    namespace,
    method.returnType
  );
  let errorType = "";
  match (method.asyncCallbackParameter) {
    some(callbackIndex) => {
      if (callbackIndex < method.parameters.length) {
        match (nativeFunctionSignature(
          method.parameters[callbackIndex].typeName
        )) {
          some(callback) => {
            asynchronous = true;
            returnType = "void";
            match (method.asyncResultParameter) {
              some(resultIndex) => if (
                resultIndex < callback.parameterTypes.length
              ) returnType = localObjCTypeName(
                contracts,
                indices,
                namespace,
                callback.parameterTypes[resultIndex]
              );
              none => {}
            }
            match (method.asyncErrorParameter) {
              some(errorIndex) => if (
                errorIndex < callback.parameterTypes.length
              ) {
                const nativeError = nullableTargetType(
                  callback.parameterTypes[errorIndex]
                );
                const projectedError = nativeError.byteLength > 0
                  ? nativeError.copyBytes(0, nativeError.byteLength)
                  : callback.parameterTypes[errorIndex].copyBytes(
                      0,
                      callback.parameterTypes[errorIndex].byteLength
                    );
                errorType = localObjCTypeName(
                  contracts,
                  indices,
                  namespace,
                  projectedError
                );
              }
              none => {}
            }
          }
          none => {}
        }
      }
    }
    none => {}
  }
  return ModuleMethodSignature({
    objectiveCSelectorCallbacks: selectorCallbacks,
    name: method.name.copyBytes(0, method.name.byteLength),
    staticMethod: !method.instance,
    visibility: "public",
    receiverMode: "in",
    signature: ModuleFunctionSignature({
      asynchronous,
      executorAffinity: method.executorAffinity.copyBytes(
        0,
        method.executorAffinity.byteLength
      ),
      threadContract: "",
      typeParameters: Array<String>(),
      typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
      parameterModes,
      parameterTypes,
      viewParameter: Option<usize>.none,
      invalidatesParameters: Array<usize>(),
      invalidatesLifetimes: Array<String>(),
      returnType,
      errorType,
    }),
    objectiveCSelector: method.selector.copyBytes(
      0,
      method.selector.byteLength
    ),
    objectiveCNativeReturnType: method.nativeReturnType.copyBytes(
      0,
      method.nativeReturnType.byteLength
    ),
    objectiveCNativeResultType: localObjCTypeName(
      contracts, indices, namespace, method.nativeResultType
    ),
    objectiveCParameterNativeTypes: parameterNativeTypes,
    objectiveCParameterProtocols: parameterProtocols,
    objectiveCRequired: method.required,
    objectiveCReturnsInstanceType: method.returnsInstanceType,
    objectiveCDesignatedInitializer: method.designatedInitializer,
    objectiveCRequiresSuper: method.requiresSuper,
    objectiveCDirect: method.direct,
    objectiveCConsumesSelf: method.consumesSelf,
    objectiveCVariadic: method.variadic,
    objectiveCConsumedParameters: consumedParameters,
    objectiveCAvailability: availability,
    objectiveCAsyncCallbackParameter: method.asyncCallbackParameter,
    objectiveCAsyncResultParameter: method.asyncResultParameter,
    objectiveCAsyncErrorParameter: method.asyncErrorParameter,
  });
}

function objcInterfaceTypeSignature(
  in interface_: NativeForeignObjCInterfaceContract,
  in contracts: NativeForeignContractSet,
  in indices: ForeignNameIndices,
  in namespace: String
): ModuleTypeSignature {
  let methods = Array<ModuleMethodSignature>();
  let unrepresentableMethods = Array<ModuleMethodSignature>();
  for (const method of interface_.methods) {
    const signature = objcMethodSignature(
      method,
      contracts,
      indices,
      namespace
    );
    if (method.representable) methods.push(move signature);
    else unrepresentableMethods.push(move signature);
  }
  let fields = Array<ModuleFieldSignature>();
  let hierarchy = Array<usize>();
  let currentName = interface_.name.copyBytes(0, interface_.name.byteLength);
  while (currentName.byteLength > 0) {
    let currentIndex = contracts.objectiveCInterfaces.length;
    match (indexedForeignName(indices.objectiveCInterfaces, currentName)) {
      some(index) => currentIndex = index;
      none => {}
    }
    if (currentIndex >= contracts.objectiveCInterfaces.length) break;
    let repeated = false;
    for (const existing of hierarchy) {
      if (existing == currentIndex) {
        repeated = true;
        break;
      }
    }
    if (repeated) break;
    hierarchy.push(currentIndex);
    currentName = contracts.objectiveCInterfaces[currentIndex]
      .superName.copyBytes(
        0,
        contracts.objectiveCInterfaces[currentIndex].superName.byteLength
      );
  }
  let hierarchyIndex = hierarchy.length;
  while (hierarchyIndex > 0) {
    hierarchyIndex = hierarchyIndex - 1;
    for (const property of contracts.objectiveCInterfaces[
      hierarchy[hierarchyIndex]
    ].properties) {
      if (!property.representable) continue;
      let protocols = Array<String>();
      for (const protocol of property.protocols) {
        protocols.push(`${namespace}.${protocol}`);
      }
      let availability = Array<ModuleObjCAvailabilitySignature>();
      for (const item of property.availability) {
        availability.push(objcAvailabilitySignature(item));
      }
      const field = ModuleFieldSignature({
        name: property.name.copyBytes(0, property.name.byteLength),
        typeName: localObjCTypeName(
          contracts,
          indices,
          namespace,
          property.typeName
        ),
        classProperty: !property.instance,
        executorAffinity: property.executorAffinity.copyBytes(
          0,
          property.executorAffinity.byteLength
        ),
        visibility: "public",
        readonlyField: property.readonlyProperty,
        hasDefault: false,
        optionalField: false,
        viewLifetime: "",
        objectiveCGetter: property.getter.copyBytes(
          0,
          property.getter.byteLength
        ),
        objectiveCSetter: property.setter.copyBytes(
          0,
          property.setter.byteLength
        ),
        objectiveCOwnership: property.ownership.copyBytes(
          0,
          property.ownership.byteLength
        ),
        objectiveCNativeType: property.nativeType.copyBytes(
          0,
          property.nativeType.byteLength
        ),
        objectiveCProtocols: protocols,
        objectiveCAvailability: availability,
      });
      let fieldIndex: usize = 0;
      while (
        fieldIndex < fields.length
        && (fields[fieldIndex].name != property.name
          || fields[fieldIndex].classProperty != !property.instance)
      ) {
        fieldIndex = fieldIndex + 1;
      }
      if (fieldIndex < fields.length) fields[fieldIndex] = move field;
      else fields.push(move field);
    }
  }
  let superName = "";
  if (interface_.superName.byteLength > 0) {
    superName = `${namespace}.${interface_.superName}`;
  }
  let availability = Array<ModuleObjCAvailabilitySignature>();
  for (const fact of interface_.availability) {
    availability.push(objcAvailabilitySignature(fact));
  }
  return new ModuleTypeSignature({
    nativeCName: "",
    nativeCUnderlyingType: "",
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    executorAffinity: interface_.executorAffinity.copyBytes(
      0,
      interface_.executorAffinity.byteLength
    ),
    implementedTraits: Array<String>(),
    fields,
    methods,
    variants: Array<ModuleVariantSignature>(),
    customDeinit: true,
    customConstructor: false,
    constructorSignature: Option<ModuleFunctionSignature>.none,
    foreignKind: "objcInterface",
    foreignLayout: "reference",
    foreignNativeName: interface_.nativeName.copyBytes(
      0,
      interface_.nativeName.byteLength
    ),
    foreignUnderlyingType: "",
    foreignResourceRelease: "",
    foreignObjCSuperName: superName,
    foreignObjCSubclassingRestricted: interface_.subclassingRestricted,
    foreignObjCAvailability: availability,
    foreignObjCUnrepresentableMethods: unrepresentableMethods,
    deinitThreadAny: false,
    constructorVisibility: "public",
    foreignCanonicalNativeName: "",
    foreignFlags: false,
    foreignDiscriminantMember: "",
    foreignDiscriminantType: "",
    foreignUnionVariants: Array<ModuleForeignUnionVariantSignature>(),
    foreignFallbackVariant: "",
    foreignObjCProtocolName: "",
  });
}

function objcProtocolTypeSignature(
  in protocol: NativeForeignObjCProtocolContract,
  in contracts: NativeForeignContractSet,
  in indices: ForeignNameIndices,
  in namespace: String
): ModuleTypeSignature {
  let methods = Array<ModuleMethodSignature>();
  let fields = Array<ModuleFieldSignature>();
  for (const method of protocol.methods) {
    if (!method.representable) continue;
    const signature = objcMethodSignature(method, contracts, indices, namespace);
    // Protocol properties are imported as accessor methods. Preserve the
    // readonly getter surface, including enough type evidence for inferred
    // native-object and record locals; optional getters are not promised.
    if (method.required && method.instance && method.parameters.length == 0
      && !signature.signature.asynchronous && signature.signature.returnType != "void") {
      fields.push(ModuleFieldSignature({
        name: copy method.name,
        typeName: copy signature.signature.returnType,
        executorAffinity: copy method.executorAffinity,
        visibility: "public", readonlyField: true, hasDefault: false,
        optionalField: false, viewLifetime: "",
        objectiveCGetter: copy method.selector,
        objectiveCOwnership: "unspecified",
        objectiveCNativeType: copy method.nativeReturnType,
        objectiveCAvailability: copy signature.objectiveCAvailability,
      }));
    }
    methods.push(move signature);
  }
  let inherited = Array<String>();
  for (const name of protocol.inherited) {
    inherited.push(`${namespace}.${name}`);
  }
  return new ModuleTypeSignature({
    nativeCName: "",
    nativeCUnderlyingType: "",
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    executorAffinity: protocol.executorAffinity.copyBytes(
      0,
      protocol.executorAffinity.byteLength
    ),
    implementedTraits: inherited,
    fields,
    methods,
    variants: Array<ModuleVariantSignature>(),
    customDeinit: false,
    customConstructor: false,
    constructorSignature: Option<ModuleFunctionSignature>.none,
    foreignKind: "objcProtocol",
    foreignLayout: "protocol",
    foreignNativeName: protocol.nativeName.copyBytes(
      0,
      protocol.nativeName.byteLength
    ),
    foreignUnderlyingType: "",
    foreignResourceRelease: "",
    foreignObjCProtocolName: protocol.nativeName.copyBytes(
      0,
      protocol.nativeName.byteLength
    ),
    deinitThreadAny: false,
    constructorVisibility: "public",
    foreignCanonicalNativeName: "",
    foreignFlags: false,
    foreignDiscriminantMember: "",
    foreignDiscriminantType: "",
    foreignUnionVariants: Array<ModuleForeignUnionVariantSignature>(),
    foreignFallbackVariant: "",
    foreignObjCSuperName: "",
    foreignObjCSubclassingRestricted: false,
    foreignObjCAvailability: Array<ModuleObjCAvailabilitySignature>(),
    foreignObjCUnrepresentableMethods: Array<ModuleMethodSignature>(),
  });
}

function foreignFunctionSignature(
  in contract: NativeForeignFunctionContract,
  in contracts: NativeForeignContractSet,
  in indices: ForeignNameIndices,
  in namespace: String
): ModuleFunctionSignature {
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  let nativeToVisible = Array<usize>();
  let visibleIndex: usize = 0;
  for (const parameter of contract.parameters) {
    if (
      parameter.fixedValue.byteLength > 0
      || parameter.abiMode == "callbackContext"
      || parameter.abiMode == "callbackRelease"
    ) {
      nativeToVisible.push(contract.parameters.length);
      continue;
    }
    nativeToVisible.push(visibleIndex);
    const parameterType = localObjCTypeName(
      contracts,
      indices,
      namespace,
      parameter.typeName
    );
    if (parameter.capability == "move") parameterModes.push("value");
    else if (
      parameter.capability == "value"
      && parameterType == "cstring"
    ) parameterModes.push("in");
    else parameterModes.push(parameter.capability.copyBytes(
      0,
      parameter.capability.byteLength
    ));
    parameterTypes.push(move parameterType);
    visibleIndex = visibleIndex + 1;
  }
  let errorType = "";
  match (in contract.errorType) {
    some(typeName) => {
      errorType = localObjCTypeName(
        contracts,
        indices,
        namespace,
        typeName
      );
    }
    none => {}
  }
  let invalidatesParameters = Array<usize>();
  for (const parameter of contract.invalidatesParameters) {
    if (parameter < nativeToVisible.length) {
      invalidatesParameters.push(nativeToVisible[parameter]);
    }
  }
  let invalidatesLifetimes = Array<String>();
  for (const lifetime of contract.invalidatesLifetimes) {
    invalidatesLifetimes.push(lifetime.copyBytes(0, lifetime.byteLength));
  }
  let viewParameter = Option<usize>.none;
  match (in contract.borrowedFromParameter) {
    some(parameter) => {
      if (parameter < nativeToVisible.length) {
        viewParameter = Option.some(nativeToVisible[parameter]);
      }
    }
    none => {}
  }
  return ModuleFunctionSignature({
    asynchronous: false,
    executorAffinity: "",
    threadContract: "",
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    parameterModes,
    parameterTypes,
    viewParameter,
    invalidatesParameters,
    invalidatesLifetimes,
    returnType: localObjCTypeName(
      contracts,
      indices,
      namespace,
      contract.returnType
    ),
    errorType,
    variadic: contract.variadic,
  });
}

function visibleSourceForNativeParameter(
  in contract: NativeForeignFunctionContract,
  nativeParameter: usize
): usize {
  let source: usize = 0;
  let index: usize = 0;
  while (index < nativeParameter && index < contract.parameters.length) {
    const parameter = view contract.parameters[index];
    if (
      parameter.fixedValue.byteLength == 0
      && parameter.abiMode != "callbackContext"
      && parameter.abiMode != "callbackRelease"
    ) source = source + 1;
    index = index + 1;
  }
  return source;
}

function callbackIndexForNativeParameter(
  in contract: NativeForeignFunctionContract,
  nativeParameter: usize,
  in role: String
): Option<usize> {
  let index: usize = 0;
  while (index < contract.callbacks.length) {
    if (
      role == "callbackContext"
      && contract.callbacks[index].contextIndex == nativeParameter
    ) return Option.some(index);
    if (role == "callbackRelease") {
      match (in contract.callbacks[index].releaseIndex) {
        some(releaseIndex) => {
          if (releaseIndex == nativeParameter) return Option.some(index);
        }
        none => {}
      }
    }
    index = index + 1;
  }
  return Option<usize>.none;
}

function foreignArgumentPlan(
  in contract: NativeForeignFunctionContract
): Array<ModuleForeignArgument> {
  let arguments = Array<ModuleForeignArgument>();
  let nativeIndex: usize = 0;
  while (nativeIndex < contract.parameters.length) {
    const parameter = view contract.parameters[nativeIndex];
    if (parameter.fixedValue.byteLength > 0) {
      arguments.push(ModuleForeignArgument({
        kind: "fixed",
        source: 0,
        value: parameter.fixedValue.copyBytes(
          0,
          parameter.fixedValue.byteLength
        ),
        mode: "value",
        thread: "",
      }));
      nativeIndex = nativeIndex + 1;
      continue;
    }
    if (
      parameter.abiMode == "callbackContext"
      || parameter.abiMode == "callbackRelease"
    ) {
      const callbackIndex = match (callbackIndexForNativeParameter(
        contract,
        nativeIndex,
        parameter.abiMode
      )) {
        some(index) => index;
        none => contract.callbacks.length;
      };
      if (callbackIndex < contract.callbacks.length) {
        const callback = view contract.callbacks[callbackIndex];
        arguments.push(ModuleForeignArgument({
          kind: parameter.abiMode.copyBytes(
            0,
            parameter.abiMode.byteLength
          ),
          source: visibleSourceForNativeParameter(
            contract,
            callback.parameterIndex
          ),
          value: callback.functionType.copyBytes(
            0,
            callback.functionType.byteLength
          ),
          mode: callback.lifetime.copyBytes(
            0,
            callback.lifetime.byteLength
          ),
          thread: callback.thread.copyBytes(
            0,
            callback.thread.byteLength
          ),
        }));
      }
      nativeIndex = nativeIndex + 1;
      continue;
    }
    let kind = "argument";
    let value = "";
    let mode = parameter.abiMode.copyBytes(0, parameter.abiMode.byteLength);
    let thread = "";
    if (parameter.abiMode == "callback") {
      kind = "callbackAdapter";
      value = parameter.typeName.copyBytes(0, parameter.typeName.byteLength);
      mode = "call";
      for (const callback of contract.callbacks) {
        if (callback.parameterIndex == nativeIndex) {
          mode = callback.lifetime.copyBytes(0, callback.lifetime.byteLength);
          thread = callback.thread.copyBytes(0, callback.thread.byteLength);
          break;
        }
      }
    } else if (parameter.abiMode == "callbackDirect") {
      kind = "callbackDirect";
      value = parameter.typeName.copyBytes(0, parameter.typeName.byteLength);
    }
    arguments.push(ModuleForeignArgument({
      kind,
      source: visibleSourceForNativeParameter(contract, nativeIndex),
      value,
      mode,
      thread,
    }));
    nativeIndex = nativeIndex + 1;
  }
  return arguments;
}

function missingContract(
  in module: ParsedModule,
  line: usize,
  column: usize,
  in header: String,
  in name: String
): ModuleResolveError {
  return moduleResolutionError(
    ModuleResolveErrorKind.missingExport,
    module.path,
    `native contract for "${header}" has no checked function "${name}"`,
    line,
    column
  );
}

function attachSelectiveFunction(
  in module: ParsedModule,
  moduleIndex: usize,
  inout modules: Array<ResolvedModule>,
  in contracts: NativeForeignContractSet,
  in indices: ForeignNameIndices,
  in namespace: String,
  in localName: String,
  in importedName: String,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  const contractIndex = match (indexedForeignName(
    indices.functions,
    importedName
  )) {
    some(index) => index;
    none => throw missingContract(
      module,
      line,
      column,
      contracts.moduleSpecifier,
      importedName
    );
  };
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], localName);
  if (symbolIndex >= modules[moduleIndex].symbols.length) {
    throw missingContract(
      module,
      line,
      column,
      contracts.moduleSpecifier,
      importedName
    );
  }
  modules[moduleIndex].symbols[symbolIndex].importedName =
    contracts.functions[contractIndex].nativeName.copyBytes(
      0,
      contracts.functions[contractIndex].nativeName.byteLength
    );
  modules[moduleIndex].symbols[symbolIndex].valueType = "";
  modules[moduleIndex].symbols[symbolIndex].functionSignature =
    Option<ModuleFunctionSignature>.some(
      foreignFunctionSignature(
        contracts.functions[contractIndex],
        contracts,
        indices,
        namespace
      )
    );
  modules[moduleIndex].symbols[symbolIndex].foreignHeader =
    contracts.moduleSpecifier.copyBytes(
      0,
      contracts.moduleSpecifier.byteLength
    );
  modules[moduleIndex].symbols[symbolIndex].foreignArguments =
    foreignArgumentPlan(contracts.functions[contractIndex]);
  for (const successValue of contracts.functions[contractIndex].successValues) {
    modules[moduleIndex].symbols[symbolIndex].foreignSuccessValues.push(
      successValue.copyBytes(0, successValue.byteLength)
    );
  }
}

function attachNamespaceFunctions(
  moduleIndex: usize,
  inout modules: Array<ResolvedModule>,
  in contracts: NativeForeignContractSet,
  in indices: ForeignNameIndices,
  in namespace: String,
  offset: usize,
  line: usize,
  column: usize
): void {
  for (const contract of contracts.functions) {
    const name = `${namespace}.${contract.name}`;
    const symbolIndex = modules[moduleIndex].symbols.length;
    let successValues = Array<String>();
    const foreignArguments = foreignArgumentPlan(contract);
    for (const successValue of contract.successValues) {
      successValues.push(
        successValue.copyBytes(0, successValue.byteLength)
      );
    }
    modules[moduleIndex].symbols.push(ModuleSymbol({
      name: name.copyBytes(0, name.byteLength),
      kind: ModuleSymbolKind.importedSymbol,
      exported: false,
      packageVisible: false,
      nativeCExport: false,
      targetModule: Option<usize>.none,
      importedName: contract.nativeName.copyBytes(
        0,
        contract.nativeName.byteLength
      ),
      valueType: "",
      functionSignature: Option<ModuleFunctionSignature>.some(
        foreignFunctionSignature(contract, contracts, indices, namespace)
      ),
      typeSignature: Option<ModuleTypeSignature>.none,
      foreignHeader: contracts.moduleSpecifier.copyBytes(
        0,
        contracts.moduleSpecifier.byteLength
      ),
      foreignSuccessValues: successValues,
      foreignArguments,
      offset,
      line,
      column,
    }));
  }
  modules[moduleIndex].symbolIndices = buildModuleSymbolIndices(
    modules[moduleIndex].symbols
  );
}

function attachNamespaceConstants(
  moduleIndex: usize,
  inout modules: Array<ResolvedModule>,
  in contracts: NativeForeignContractSet,
  in indices: ForeignNameIndices,
  in namespace: String,
  offset: usize,
  line: usize,
  column: usize
): void {
  for (const contract of contracts.constants) {
    const name = `${namespace}.${contract.name}`;
    modules[moduleIndex].symbols.push(ModuleSymbol({
      name,
      kind: ModuleSymbolKind.importedSymbol,
      exported: false,
      packageVisible: false,
      nativeCExport: false,
      targetModule: Option<usize>.none,
      importedName: contract.nativeName.copyBytes(
        0,
        contract.nativeName.byteLength
      ),
      valueType: localObjCTypeName(
        contracts,
        indices,
        namespace,
        contract.typeName
      ),
      functionSignature: Option<ModuleFunctionSignature>.none,
      typeSignature: Option<ModuleTypeSignature>.none,
      foreignHeader: contracts.moduleSpecifier.copyBytes(
        0,
        contracts.moduleSpecifier.byteLength
      ),
      foreignSuccessValues: Array<String>(),
      foreignArguments: Array<ModuleForeignArgument>(),
      offset,
      line,
      column,
    }));
  }
  modules[moduleIndex].symbolIndices = buildModuleSymbolIndices(
    modules[moduleIndex].symbols
  );
}

function foreignTypeSignature(
  in type: NativeForeignTypeContract,
  in indices: ForeignNameIndices,
  in namespace: String
): ModuleTypeSignature {
  let fields = Array<ModuleFieldSignature>();
  for (const field of type.fields) {
    fields.push(ModuleFieldSignature({
      name: field.name.copyBytes(0, field.name.byteLength),
      typeName: localForeignTypeName(indices, namespace, field.typeName),
      executorAffinity: "",
      visibility: "public",
      readonlyField: false,
      hasDefault: false,
      optionalField: false,
      viewLifetime: field.lifetime.copyBytes(0, field.lifetime.byteLength),
    }));
  }
  let variants = Array<ModuleVariantSignature>();
  let foreignUnionVariants = Array<ModuleForeignUnionVariantSignature>();
  let discriminantType = "";
  if (type.discriminantMember.byteLength > 0) {
    for (const field of type.fields) {
      if (field.name == type.discriminantMember) {
        discriminantType = localForeignTypeName(
          indices,
          namespace,
          field.typeName
        );
      }
    }
    for (const variant of type.variants) {
      let payloadType = "";
      if (variant.payloadType.byteLength > 0) {
        const localized = localForeignTypeName(
          indices,
          namespace,
          variant.payloadType
        );
        payloadType = `view ${localized}`;
      }
      variants.push(ModuleVariantSignature({
        name: variant.name.copyBytes(0, variant.name.byteLength),
        payloadType: payloadType.copyBytes(0, payloadType.byteLength),
      }));
      let values = Array<String>();
      for (const value of variant.values) {
        values.push(value.copyBytes(0, value.byteLength));
      }
      foreignUnionVariants.push(ModuleForeignUnionVariantSignature({
        name: variant.name.copyBytes(0, variant.name.byteLength),
        member: variant.member.copyBytes(0, variant.member.byteLength),
        payloadType: payloadType.copyBytes(0, payloadType.byteLength),
        values,
      }));
    }
    variants.push(ModuleVariantSignature({
      name: type.fallback.copyBytes(0, type.fallback.byteLength),
      payloadType: discriminantType.copyBytes(0, discriminantType.byteLength),
    }));
  }
  return new ModuleTypeSignature({
    nativeCName: "",
    nativeCUnderlyingType: "",
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    executorAffinity: type.executorAffinity.copyBytes(
      0,
      type.executorAffinity.byteLength
    ),
    implementedTraits: Array<String>(),
    fields,
    methods: Array<ModuleMethodSignature>(),
    variants,
    customDeinit: type.resourceRelease.byteLength > 0,
    customConstructor: type.resourceRelease.byteLength > 0,
    constructorSignature: Option<ModuleFunctionSignature>.none,
    foreignKind: type.layout == "union"
      ? "union"
      : type.viewOnly
        ? "viewRecord"
      : type.kind.copyBytes(0, type.kind.byteLength),
    foreignLayout: type.layout.copyBytes(0, type.layout.byteLength),
    foreignNativeName: type.nativeName.copyBytes(
      0,
      type.nativeName.byteLength
    ),
    foreignCanonicalNativeName: type.canonicalNativeName.copyBytes(
      0,
      type.canonicalNativeName.byteLength
    ),
    foreignUnderlyingType: type.underlyingType.copyBytes(
      0,
      type.underlyingType.byteLength
    ),
    foreignFlags: type.flags,
    foreignResourceRelease: type.resourceRelease.copyBytes(
      0,
      type.resourceRelease.byteLength
    ),
    foreignDiscriminantMember: type.discriminantMember.copyBytes(
      0,
      type.discriminantMember.byteLength
    ),
    foreignDiscriminantType: discriminantType,
    foreignUnionVariants,
    foreignFallbackVariant: type.fallback.copyBytes(
      0,
      type.fallback.byteLength
    ),
    deinitThreadAny: false,
    constructorVisibility: "public",
    foreignObjCSuperName: "",
    foreignObjCSubclassingRestricted: false,
    foreignObjCAvailability: Array<ModuleObjCAvailabilitySignature>(),
    foreignObjCUnrepresentableMethods: Array<ModuleMethodSignature>(),
    foreignObjCProtocolName: "",
  });
}

function attachForeignTypes(
  moduleIndex: usize,
  inout modules: Array<ResolvedModule>,
  in contracts: NativeForeignContractSet,
  in signatures: ForeignTypeSignatures,
  in namespace: String,
  offset: usize,
  line: usize,
  column: usize
): void {
  const namespaceIndex = moduleSymbolIndex(
    modules[moduleIndex],
    namespace
  );
  if (namespaceIndex >= modules[moduleIndex].symbols.length) {
    modules[moduleIndex].symbols.push(ModuleSymbol({
      name: namespace.copyBytes(0, namespace.byteLength),
      kind: ModuleSymbolKind.namespaceSymbol,
      exported: false,
      packageVisible: false,
      nativeCExport: false,
      targetModule: Option<usize>.none,
      importedName: contracts.moduleSpecifier.copyBytes(
        0,
        contracts.moduleSpecifier.byteLength
      ),
      valueType: "",
      functionSignature: Option<ModuleFunctionSignature>.none,
      typeSignature: Option<ModuleTypeSignature>.none,
      foreignHeader: contracts.moduleSpecifier.copyBytes(
        0,
        contracts.moduleSpecifier.byteLength
      ),
      foreignSuccessValues: Array<String>(),
      foreignArguments: Array<ModuleForeignArgument>(),
      offset,
      line,
      column,
    }));
  } else {
    modules[moduleIndex].symbols[namespaceIndex].importedName =
      contracts.moduleSpecifier.copyBytes(
        0,
        contracts.moduleSpecifier.byteLength
      );
    modules[moduleIndex].symbols[namespaceIndex].foreignHeader =
      contracts.moduleSpecifier.copyBytes(
        0,
        contracts.moduleSpecifier.byteLength
      );
  }
  let typeIndex: usize = 0;
  for (const type of contracts.types) {
    const signature = signatures.types[typeIndex];
    typeIndex = typeIndex + 1;
    const name = `${namespace}.${type.name}`;
    if (moduleSymbolIndex(modules[moduleIndex], name) < modules[moduleIndex].symbols.length) {
      continue;
    }
    modules[moduleIndex].symbols.push(ModuleSymbol({
      name,
      kind: type.kind == "enum"
        ? ModuleSymbolKind.enumSymbol
        : ModuleSymbolKind.structSymbol,
      exported: false,
      packageVisible: false,
      nativeCExport: false,
      targetModule: Option<usize>.none,
      importedName: type.nativeName.copyBytes(0, type.nativeName.byteLength),
      valueType: "",
      functionSignature: Option<ModuleFunctionSignature>.none,
      typeSignature: Option<ModuleTypeSignature>.some(
        signature
      ),
      foreignHeader: contracts.moduleSpecifier.copyBytes(
        0,
        contracts.moduleSpecifier.byteLength
      ),
      foreignSuccessValues: Array<String>(),
      foreignArguments: Array<ModuleForeignArgument>(),
      offset,
      line,
      column,
    }));
  }
  modules[moduleIndex].symbolIndices = buildModuleSymbolIndices(
    modules[moduleIndex].symbols
  );
}

function attachForeignObjCTypes(
  moduleIndex: usize,
  inout modules: Array<ResolvedModule>,
  in contracts: NativeForeignContractSet,
  in signatures: ForeignTypeSignatures,
  in namespace: String,
  offset: usize,
  line: usize,
  column: usize
): void {
  let protocolIndex: usize = 0;
  for (const protocol of contracts.objectiveCProtocols) {
    const signature = signatures.protocols[protocolIndex];
    protocolIndex = protocolIndex + 1;
    const name = `${namespace}.${protocol.name}`;
    const existingProtocol = moduleSymbolIndex(modules[moduleIndex], name);
    if (existingProtocol < modules[moduleIndex].symbols.length) {
      modules[moduleIndex].symbols[existingProtocol].kind =
        ModuleSymbolKind.traitSymbol;
      modules[moduleIndex].symbols[existingProtocol].importedName =
        protocol.nativeName.copyBytes(0, protocol.nativeName.byteLength);
      modules[moduleIndex].symbols[existingProtocol].valueType = "";
      modules[moduleIndex].symbols[existingProtocol].typeSignature =
        Option<ModuleTypeSignature>.some(signature);
      modules[moduleIndex].symbols[existingProtocol].foreignHeader =
        contracts.moduleSpecifier.copyBytes(
          0,
          contracts.moduleSpecifier.byteLength
        );
      continue;
    }
    modules[moduleIndex].symbols.push(ModuleSymbol({
      name,
      kind: ModuleSymbolKind.traitSymbol,
      exported: false,
      packageVisible: false,
      nativeCExport: false,
      targetModule: Option<usize>.none,
      importedName: protocol.nativeName.copyBytes(
        0,
        protocol.nativeName.byteLength
      ),
      valueType: "",
      functionSignature: Option<ModuleFunctionSignature>.none,
      typeSignature: Option<ModuleTypeSignature>.some(signature),
      foreignHeader: contracts.moduleSpecifier.copyBytes(
        0,
        contracts.moduleSpecifier.byteLength
      ),
      foreignSuccessValues: Array<String>(),
      foreignArguments: Array<ModuleForeignArgument>(),
      offset,
      line,
      column,
    }));
  }
  let interfaceIndex: usize = 0;
  for (const interface_ of contracts.objectiveCInterfaces) {
    const signature = signatures.interfaces[interfaceIndex];
    interfaceIndex = interfaceIndex + 1;
    const name = `${namespace}.${interface_.name}`;
    const existingInterface = moduleSymbolIndex(modules[moduleIndex], name);
    if (existingInterface < modules[moduleIndex].symbols.length) {
      // Preserve every protocol until concrete interfaces are attached. When
      // an SDK retains a legacy protocol with the same public spelling as a
      // modern class, the later interface owns ordinary Z type positions.
      modules[moduleIndex].symbols[existingInterface].kind =
        ModuleSymbolKind.classSymbol;
      modules[moduleIndex].symbols[existingInterface].importedName =
        interface_.nativeName.copyBytes(
          0,
          interface_.nativeName.byteLength
        );
      modules[moduleIndex].symbols[existingInterface].valueType = "";
      modules[moduleIndex].symbols[existingInterface].typeSignature =
        Option<ModuleTypeSignature>.some(signature);
      modules[moduleIndex].symbols[existingInterface].foreignHeader =
        contracts.moduleSpecifier.copyBytes(
          0,
          contracts.moduleSpecifier.byteLength
        );
      continue;
    }
    modules[moduleIndex].symbols.push(ModuleSymbol({
      name,
      kind: ModuleSymbolKind.classSymbol,
      exported: false,
      packageVisible: false,
      nativeCExport: false,
      targetModule: Option<usize>.none,
      importedName: interface_.nativeName.copyBytes(
        0,
        interface_.nativeName.byteLength
      ),
      valueType: "",
      functionSignature: Option<ModuleFunctionSignature>.none,
      typeSignature: Option<ModuleTypeSignature>.some(signature),
      foreignHeader: contracts.moduleSpecifier.copyBytes(
        0,
        contracts.moduleSpecifier.byteLength
      ),
      foreignSuccessValues: Array<String>(),
      foreignArguments: Array<ModuleForeignArgument>(),
      offset,
      line,
      column,
    }));
  }
  modules[moduleIndex].symbolIndices = buildModuleSymbolIndices(
    modules[moduleIndex].symbols
  );
}

function attachSelectiveConstant(
  moduleIndex: usize,
  inout modules: Array<ResolvedModule>,
  in contracts: NativeForeignContractSet,
  in indices: ForeignNameIndices,
  in namespace: String,
  in localName: String,
  constantIndex: usize
): void {
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], localName);
  modules[moduleIndex].symbols[symbolIndex].importedName =
    contracts.constants[constantIndex].nativeName.copyBytes(
      0,
      contracts.constants[constantIndex].nativeName.byteLength
    );
  modules[moduleIndex].symbols[symbolIndex].valueType = localObjCTypeName(
    contracts,
    indices,
    namespace,
    contracts.constants[constantIndex].typeName
  );
  modules[moduleIndex].symbols[symbolIndex].foreignHeader =
    contracts.moduleSpecifier.copyBytes(
      0,
      contracts.moduleSpecifier.byteLength
    );
}

function attachSelectiveType(
  moduleIndex: usize,
  inout modules: Array<ResolvedModule>,
  in contracts: NativeForeignContractSet,
  in signatures: ForeignTypeSignatures,
  in namespace: String,
  in localName: String,
  typeIndex: usize
): void {
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], localName);
  modules[moduleIndex].symbols[symbolIndex].kind =
    contracts.types[typeIndex].kind == "enum"
      ? ModuleSymbolKind.enumSymbol
      : ModuleSymbolKind.structSymbol;
  modules[moduleIndex].symbols[symbolIndex].importedName =
    contracts.types[typeIndex].nativeName.copyBytes(
      0,
      contracts.types[typeIndex].nativeName.byteLength
    );
  modules[moduleIndex].symbols[symbolIndex].valueType = "";
  modules[moduleIndex].symbols[symbolIndex].typeSignature =
    Option<ModuleTypeSignature>.some(
      signatures.types[typeIndex]
    );
  modules[moduleIndex].symbols[symbolIndex].foreignHeader =
    contracts.moduleSpecifier.copyBytes(
      0,
      contracts.moduleSpecifier.byteLength
    );
}

function attachSelectiveObjCInterface(
  moduleIndex: usize,
  inout modules: Array<ResolvedModule>,
  in contracts: NativeForeignContractSet,
  in signatures: ForeignTypeSignatures,
  in namespace: String,
  in localName: String,
  typeIndex: usize
): void {
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], localName);
  const interface_ = view contracts.objectiveCInterfaces[typeIndex];
  modules[moduleIndex].symbols[symbolIndex].kind = ModuleSymbolKind.classSymbol;
  modules[moduleIndex].symbols[symbolIndex].importedName =
    interface_.nativeName.copyBytes(0, interface_.nativeName.byteLength);
  modules[moduleIndex].symbols[symbolIndex].valueType = "";
  modules[moduleIndex].symbols[symbolIndex].typeSignature = Option<ModuleTypeSignature>.some(
    signatures.interfaces[typeIndex]
  );
  modules[moduleIndex].symbols[symbolIndex].foreignHeader =
    contracts.moduleSpecifier.copyBytes(
      0,
      contracts.moduleSpecifier.byteLength
    );
}

function attachSelectiveObjCProtocol(
  moduleIndex: usize,
  inout modules: Array<ResolvedModule>,
  in contracts: NativeForeignContractSet,
  in signatures: ForeignTypeSignatures,
  in namespace: String,
  in localName: String,
  typeIndex: usize
): void {
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], localName);
  const protocol = view contracts.objectiveCProtocols[typeIndex];
  modules[moduleIndex].symbols[symbolIndex].kind = ModuleSymbolKind.traitSymbol;
  modules[moduleIndex].symbols[symbolIndex].importedName =
    protocol.nativeName.copyBytes(0, protocol.nativeName.byteLength);
  modules[moduleIndex].symbols[symbolIndex].valueType = "";
  modules[moduleIndex].symbols[symbolIndex].typeSignature = Option<ModuleTypeSignature>.some(
    signatures.protocols[typeIndex]
  );
  modules[moduleIndex].symbols[symbolIndex].foreignHeader =
    contracts.moduleSpecifier.copyBytes(
      0,
      contracts.moduleSpecifier.byteLength
    );
}

function attachModuleContract(
  in parsed: Array<ParsedModule>,
  in binding: NativeForeignModuleContract,
  inout modules: Array<ResolvedModule>,
  inout cache: Array<ForeignTypeSignatures>
): void throws ModuleResolveError {
  let moduleIndex: usize = 0;
  while (moduleIndex < parsed.length) {
    if (parsed[moduleIndex].path == binding.modulePath) break;
    moduleIndex = moduleIndex + 1;
  }
  if (moduleIndex >= parsed.length) {
    throw moduleResolutionError(
      ModuleResolveErrorKind.missingModule,
      binding.modulePath,
      "native contract targets a module outside the resolved graph",
      1,
      1
    );
  }
  let matched = false;
  for (const declaration of parsed[moduleIndex].program.imports) {
    if (declaration.header != binding.contracts.moduleSpecifier) continue;
    matched = true;
    const namespace = moduleBindingName(declaration);
    const signatures = sharedForeignTypeSignatures(binding.contracts, namespace, inout cache);
    const indices = view signatures.indices;
    attachForeignTypes(
      moduleIndex,
      inout modules,
      binding.contracts,
      signatures,
      namespace,
      declaration.offset,
      declaration.line,
      declaration.column
    );
    attachForeignObjCTypes(
      moduleIndex,
      inout modules,
      binding.contracts,
      signatures,
      namespace,
      declaration.offset,
      declaration.line,
      declaration.column
    );
    if (declaration.selective) {
      for (const importBinding of declaration.bindings) {
        const localName = importBinding.localName.copyBytes(
          0,
          importBinding.localName.byteLength
        );
        const importedName = importBinding.importedName.copyBytes(
          0,
          importBinding.importedName.byteLength
        );
        const line = importBinding.line;
        const column = importBinding.column;
        match (indexedForeignName(indices.functions, importedName)) {
          some(_) => try attachSelectiveFunction(
            parsed[moduleIndex],
            moduleIndex,
            inout modules,
            binding.contracts,
            indices,
            namespace,
            localName,
            importedName,
            line,
            column
          );
          none => match (indexedForeignName(indices.constants, importedName)) {
            some(index) => attachSelectiveConstant(
              moduleIndex,
              inout modules,
              binding.contracts,
              indices,
              namespace,
              localName,
              index
            );
            none => match (indexedForeignName(indices.types, importedName)) {
              some(index) => attachSelectiveType(
                moduleIndex,
                inout modules,
                binding.contracts,
                signatures,
                namespace,
                localName,
                index
              );
              none => match (indexedForeignName(
                indices.objectiveCInterfaces,
                importedName
              )) {
                some(index) => attachSelectiveObjCInterface(
                  moduleIndex,
                  inout modules,
                  binding.contracts,
                  signatures,
                  namespace,
                  localName,
                  index
                );
                none => match (indexedForeignName(
                  indices.objectiveCProtocols,
                  importedName
                )) {
                  some(index) => attachSelectiveObjCProtocol(
                    moduleIndex,
                    inout modules,
                    binding.contracts,
                    signatures,
                    namespace,
                    localName,
                    index
                  );
                  none => throw missingContract(
                    parsed[moduleIndex],
                    line,
                    column,
                    binding.contracts.moduleSpecifier,
                    importedName
                  );
                }
              }
            }
          }
        }
      }
    } else {
      attachNamespaceFunctions(
        moduleIndex,
        inout modules,
        binding.contracts,
        indices,
        namespace,
        declaration.offset,
        declaration.line,
        declaration.column
      );
      attachNamespaceConstants(
        moduleIndex,
        inout modules,
        binding.contracts,
        indices,
        namespace,
        declaration.offset,
        declaration.line,
        declaration.column
      );
    }
  }
  if (!matched) {
    throw moduleResolutionError(
      ModuleResolveErrorKind.missingModule,
      parsed[moduleIndex].path,
      `native contract for "${binding.contracts.moduleSpecifier}" has no matching import`,
      1,
      1
    );
  }
}

export function attachForeignContracts(
  in parsed: Array<ParsedModule>,
  in contracts: Array<NativeForeignModuleContract>,
  inout modules: Array<ResolvedModule>
): void throws ModuleResolveError {
  let cache = Array<ForeignTypeSignatures>();
  for (const binding of contracts) {
    try attachModuleContract(parsed, binding, inout modules, inout cache);
  }
}
