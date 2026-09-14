import { requireNativeAvailability } from "./semantic-native-availability.zs";
import {
  AggregateDeclaration, DeclarationKind, ExpressionKind, ExpressionTree,
  FunctionDeclaration, ParameterMode, ReceiverMode, StatementKind, Visibility,
} from "./parser.zs";
import { ParsedModule } from "./module-symbols.zs";
import {
  ModuleMethodSignature, ModuleResolveError, ModuleResolveErrorKind, ModuleSymbolKind,
  ResolvedModule, codedModuleResolutionError,
} from "./semantic-model.zs";
import {
  ModuleSymbolLocation, equivalentTypes, isUnresolvedExternalType, rebaseTypeName,
  sourceTypeDisplayName, transparentTypeName, typeSymbolLocation,
} from "./semantic-type-identities.zs";
import { objcMethodLabelsMatch, rebaseModuleFunctionSignature } from "./semantic-member-lookups.zs";
import {
  NativeSuperclassCallSite, inspectNativeSubclassBodies, nativeInitializerSelector,
} from "./semantic-objc-subclass-bodies.zs";
import {
  isNumericTypeName, nativeFunctionSignature, nativeObjCObjectTypeName, nullableTargetType,
  stringStartsWith, genericTypeShape,
} from "./semantic-type-shapes.zs";

// Declaration validation is separate from body ownership and native emission.
// No successful declaration check may turn a native subclass into a Z ARC
// record. Dedicated checked plans and native entry lowering preserve that split.
function subclassError(
  in module: ParsedModule, in message: String, line: usize, column: usize
): ModuleResolveError {
  return codedModuleResolutionError(
    ModuleResolveErrorKind.typeMismatch, "Z0814", module.path,
    message, line, column, 1
  );
}

function runtimeSelector(in name: String): boolean {
  return nativeInitializerSelector(name) || name == "dealloc" || name == "retain"
    || name == "release" || name == "autorelease" || name == "retainCount"
    || name == "class" || stringStartsWith(name, "isKindOfClass:")
    || stringStartsWith(name, "forward")
    || stringStartsWith(name, "methodSignatureForSelector:")
    || stringStartsWith(name, "respondsToSelector:");
}

function plainNativeValue(
  in modules: Array<ResolvedModule>, moduleIndex: usize, in name: String
): boolean {
  const typeName = transparentTypeName(modules, moduleIndex, name);
  if (typeName == "boolean" || isNumericTypeName(typeName)) return true;
  const location = match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(value) => value;
    none => return false;
  };
  return match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
    some(signature) => signature.foreignKind == "enum"
      || signature.foreignKind == "scalar"
      || (signature.foreignKind == "record"
        && signature.foreignResourceRelease.byteLength == 0
        && signature.foreignLayout == "struct");
    none => false;
  };
}

export function nativeObjCObjectType(
  in modules: Array<ResolvedModule>, moduleIndex: usize, in name: String
): boolean {
  const nullable = nullableTargetType(name);
  if (nullable.byteLength > 0) return nativeObjCObjectType(modules, moduleIndex, nullable);
  if (transparentTypeName(modules, moduleIndex, name) == nativeObjCObjectTypeName) return true;
  if (stringStartsWith(name, "__z_objc:")) return true;
  const location = match (typeSymbolLocation(modules, moduleIndex, name)) {
    some(value) => value;
    none => return false;
  };
  return match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
    some(signature) => signature.foreignKind == "objcInterface";
    none => false;
  };
}

// Inline strong storage needs a concrete imported class ABI, not an opaque
// object spelling or an ordinary Z ARC class. Nullability changes checking,
// not the native pointer layout or ownership.
export function nativeObjCStoredObjectABI(
  in modules: Array<ResolvedModule>, moduleIndex: usize, in sourceName: String
): String {
  const name = transparentTypeName(modules, moduleIndex, sourceName);
  const nullable = nullableTargetType(name);
  if (nullable.byteLength > 0) return nativeObjCStoredObjectABI(modules, moduleIndex, nullable);
  const location = match (typeSymbolLocation(modules, moduleIndex, name)) {
    some(value) => value;
    none => return "";
  };
  return match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
    some(signature) => signature.foreignKind == "objcInterface"
      && signature.foreignNativeName.byteLength > 0 ? `${signature.foreignNativeName} *` : "";
    none => "";
  };
}

// Admit only a weak handle (optionally empty) to an ordinary Z ARC class.
// Native weak references and arbitrary managed aggregates remain separate tiers.
export function nativeObjCStoredWeak(
  in modules: Array<ResolvedModule>, moduleIndex: usize, in sourceName: String
): boolean {
  const name = transparentTypeName(modules, moduleIndex, sourceName);
  let shape = match (genericTypeShape(name)) {
    some(value) => value;
    none => return false;
  };
  if (shape.base == "Option" && shape.arguments.length == 1) {
    const payload = transparentTypeName(modules, moduleIndex, shape.arguments[0]);
    shape = match (genericTypeShape(payload)) {
      some(value) => value;
      none => return false;
    };
  }
  if (shape.base != "Weak" || shape.arguments.length != 1) return false;
  const location = match (typeSymbolLocation(modules, moduleIndex, shape.arguments[0])) {
    some(value) => value;
    none => return false;
  };
  const symbol = view modules[location.moduleIndex].symbols[location.symbolIndex];
  if (symbol.kind != ModuleSymbolKind.classSymbol) return false;
  return match (in symbol.typeSignature) {
    some(signature) => signature.foreignKind.byteLength == 0;
    none => false;
  };
}

function appendInheritedMethod(
  in modules: Array<ResolvedModule>, sourceIndex: usize, targetIndex: usize,
  in method: ModuleMethodSignature, inout methods: Array<ModuleMethodSignature>
): void {
  if (method.staticMethod) return;
  // The nearest declaration of a selector wins, including an unrepresentable
  // declaration that shadows an otherwise callable ancestor.
  for (const existing of methods) {
    if (existing.objectiveCSelector == method.objectiveCSelector) return;
  }
  let rebound = copy method;
  rebound.signature = rebaseModuleFunctionSignature(modules, sourceIndex, targetIndex, method.signature);
  let callbackIndex: usize = 0;
  while (callbackIndex < rebound.objectiveCSelectorCallbacks.length) {
    rebound.objectiveCSelectorCallbacks[callbackIndex].signature = rebaseModuleFunctionSignature(
      modules, sourceIndex, targetIndex, method.objectiveCSelectorCallbacks[callbackIndex].signature
    );
    callbackIndex = callbackIndex + 1;
  }
  rebound.objectiveCNativeResultType = rebaseTypeName(
    modules, sourceIndex, targetIndex, method.objectiveCNativeResultType
  );
  methods.push(move rebound);
}

export function nativeObjCSubclassInheritedMethods(
  in module: ParsedModule, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in aggregate: AggregateDeclaration, in baseName: String
): Array<ModuleMethodSignature> throws ModuleResolveError {
  let methods = Array<ModuleMethodSignature>();
  let visited = Array<String>();
  let current = copy baseName;
  let mainIsolated = false;
  while (current.byteLength > 0) {
    const location = match (typeSymbolLocation(modules, moduleIndex, current)) {
      some(value) => value;
      none => ModuleSymbolLocation({ moduleIndex: modules.length, symbolIndex: 0 });
    };
    if (location.moduleIndex >= modules.length) break;
    const key = `${location.moduleIndex}:${location.symbolIndex}`;
    for (const previous of visited) {
      if (previous == key) throw subclassError(module,
        "cyclic imported Objective-C superclass metadata", aggregate.line, aggregate.column);
    }
    visited.push(key);
    match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
      some(signature) => {
        try requireNativeAvailability(module, signature.foreignObjCAvailability, current, aggregate.line, aggregate.column);
        if (signature.executorAffinity == "thread.main") mainIsolated = true;
        for (const method of signature.methods) {
          appendInheritedMethod(modules, location.moduleIndex, moduleIndex, method, inout methods);
        }
        for (const method of signature.foreignObjCUnrepresentableMethods) {
          appendInheritedMethod(modules, location.moduleIndex, moduleIndex, method, inout methods);
        }
        current = rebaseTypeName(modules, location.moduleIndex, moduleIndex, signature.foreignObjCSuperName);
      }
      none => break;
    }
  }
  if (!mainIsolated) throw subclassError(module,
    "the first native subclass tier requires a superclass with a main-executor contract",
    aggregate.line, aggregate.column);
  return methods;
}

function validateOverrideShape(
  in module: ParsedModule, in method: FunctionDeclaration
): void throws ModuleResolveError {
  if (method.objectiveCSelector.byteLength == 0) {
    throw subclassError(module,
      "a native subclass method requires an explicit `as \"selector:\"`",
      method.line, method.column);
  }
  if (stringStartsWith(method.objectiveCSelector, "_z_")) throw subclassError(module,
    "compiler-owned native selectors beginning with `_z_` cannot be declared", method.line, method.column);
  let throwing = false;
  match (in method.errorType) { some(_) => throwing = true; none => {} }
  if (method.staticMethod || method.asynchronous || throwing
    || method.rawLanguage.byteLength > 0 || method.receiverMode == ReceiverMode.move
    || method.typeParameters.length > 0) {
    throw subclassError(module,
      "a native override must be a synchronous, non-throwing, non-consuming instance method",
      method.line, method.column);
  }
  if (runtimeSelector(method.objectiveCSelector)) throw subclassError(module,
    `native lifecycle or runtime selector "${method.objectiveCSelector}" cannot be overridden in the first tier`,
    method.line, method.column);
}

function newEntryABI(
  in module: ParsedModule, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in sourceName: String, result: boolean, line: usize, column: usize
): String throws ModuleResolveError {
  const name = transparentTypeName(modules, moduleIndex, sourceName);
  if (name == "void" && result) return "void";
  if (name == "boolean") return "bool";
  if (name == "i8") return "int8_t";
  if (name == "u8") return "uint8_t";
  if (name == "i16") return "int16_t";
  if (name == "u16") return "uint16_t";
  if (name == "i32") return "int32_t";
  if (name == "u32") return "uint32_t";
  if (name == "i64") return "int64_t";
  if (name == "u64") return "uint64_t";
  if (name == "isize") return "intptr_t";
  if (name == "usize") return "uintptr_t";
  if (name == "f32") return "float";
  if (name == "f64") return "double";
  const nullable = nullableTargetType(name);
  const location = match (typeSymbolLocation(modules, moduleIndex, name)) {
    some(value) => value;
    none => ModuleSymbolLocation({ moduleIndex: modules.length, symbolIndex: 0 });
  };
  if (location.moduleIndex < modules.length) {
    match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
      some(signature) => {
        if (signature.foreignKind == "enum" || signature.foreignKind == "scalar") return copy signature.foreignNativeName;
        if (!result && signature.foreignKind == "objcInterface"
          && signature.foreignNativeName.byteLength > 0 && nullable.byteLength == 0) {
          return `${signature.foreignNativeName} *`;
        }
      }
      none => {}
    }
  }
  throw subclassError(module,
    "new native entries support scalar/native-enum values, borrowed concrete imported object parameters, and void returns", line, column);
}

function validateNewEntry(
  in module: ParsedModule, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in method: FunctionDeclaration
): void throws ModuleResolveError {
  let labels: usize = 0;
  let labelLength: usize = 0;
  let index: usize = 0;
  while (index < method.objectiveCSelector.byteLength) {
    const byte = method.objectiveCSelector.byteAt(index);
    if (byte == 58) {
      if (labelLength == 0) throw subclassError(module, "new native selector labels must match the declared parameter count", method.line, method.column);
      labels = labels + 1;
      labelLength = 0;
    } else {
      const valid = (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || byte == 95
        || (labelLength > 0 && byte >= 48 && byte <= 57);
      if (!valid) throw subclassError(module, "new native selector labels must match the declared parameter count", method.line, method.column);
      labelLength = labelLength + 1;
    }
    index = index + 1;
  }
  if (labels != method.parameters.length || (labels > 0 && labelLength > 0) || index == 0) {
    throw subclassError(module, "new native selector labels must match the declared parameter count", method.line, method.column);
  }
  const result = try newEntryABI(module, modules, moduleIndex, method.returnType.name, true, method.returnType.line, method.returnType.column);
  for (const parameter of method.parameters) {
    const abi = try newEntryABI(module, modules, moduleIndex, parameter.type.name, false, parameter.line, parameter.column);
    const typeName = transparentTypeName(modules, moduleIndex, parameter.type.name);
    const object = nativeObjCObjectType(modules, moduleIndex, typeName);
    if ((object && parameter.mode != ParameterMode.input) || (!object && parameter.mode != ParameterMode.value)) {
      throw subclassError(module, "new native entry parameter has incompatible passing capability; objects require in and scalar values require value passing", parameter.line, parameter.column);
    }
  }
}

function validateOverrideContract(
  in module: ParsedModule, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in method: FunctionDeclaration, in native: ModuleMethodSignature
): void throws ModuleResolveError {
  try requireNativeAvailability(module, native.objectiveCAvailability, native.objectiveCSelector, method.line, method.column);
  if (native.objectiveCDirect) throw subclassError(module,
    "a direct Objective-C method cannot be overridden", method.line, method.column);
  if (native.objectiveCConsumesSelf || native.objectiveCConsumedParameters.length > 0) {
    throw subclassError(module, "consuming native override ownership requires a later tier", method.line, method.column);
  }
  let blockParameter = false;
  for (const parameter of native.signature.parameterTypes) {
    match (nativeFunctionSignature(parameter)) { some(_) => blockParameter = true; none => {} }
  }
  if (native.objectiveCVariadic || blockParameter || native.signature.asynchronous) {
    throw subclassError(module,
      "variadic and block-receiving native overrides are not supported in the first tier",
      method.line, method.column);
  }
  let blockResult = false;
  match (nativeFunctionSignature(native.objectiveCNativeResultType)) { some(_) => blockResult = true; none => {} }
  if (blockResult || nativeObjCObjectType(modules, moduleIndex, native.objectiveCNativeResultType)) {
    throw subclassError(module,
      "object- or block-returning native overrides require the later return-ownership tier",
      method.line, method.column);
  }
  if (native.objectiveCRequiresSuper) throw subclassError(module,
    "this override requires superclass-call path validation, which is not implemented in the first tier",
    method.line, method.column);
  if (native.signature.returnType.byteLength == 0) throw subclassError(module,
    "unsupported native override return ABI", method.line, method.column);
  if (!equivalentTypes(modules, moduleIndex, method.returnType.name, native.signature.returnType)) {
    throw subclassError(module,
      `Objective-C selector "${native.objectiveCSelector}" returns ${native.signature.returnType}, but the override returns ${method.returnType.name}`,
      method.returnType.line, method.returnType.column);
  }
  if (method.parameters.length != native.signature.parameterTypes.length) throw subclassError(module,
    `Objective-C selector "${native.objectiveCSelector}" expects ${native.signature.parameterTypes.length} parameter(s), but the override declares ${method.parameters.length}`,
    method.line, method.column);
  let index: usize = 0;
  while (index < method.parameters.length) {
    const parameter = view method.parameters[index];
    const expected = view native.signature.parameterTypes[index];
    if (expected.byteLength == 0 || !equivalentTypes(modules, moduleIndex, parameter.type.name, expected)) {
      const expectedDisplay = sourceTypeDisplayName(modules, moduleIndex, expected);
      const actualDisplay = sourceTypeDisplayName(modules, moduleIndex, parameter.type.name);
      throw subclassError(module,
        `Objective-C selector "${native.objectiveCSelector}" parameter ${index + 1} expects ${expectedDisplay}, found ${actualDisplay}`,
        parameter.line, parameter.column);
    }
    const borrowed = nativeObjCObjectType(modules, moduleIndex, expected);
    if ((borrowed && parameter.mode != ParameterMode.input)
      || (!borrowed && parameter.mode != ParameterMode.value)) throw subclassError(module,
      `Objective-C override parameter "${parameter.name}" has incompatible passing capability`,
      parameter.line, parameter.column);
    index = index + 1;
  }
}

function firstSuperclassCall(
  in module: ParsedModule, in aggregate: AggregateDeclaration
): ExpressionTree throws ModuleResolveError {
  const message = "a native subclass constructor must begin with exactly one `super.init...(...)` call";
  match (in aggregate.constructorDeclaration) {
    some(initializer) => {
      if (initializer.body.roots.length > 0) {
        const first = view initializer.body.nodes[initializer.body.roots[0]];
        if (first.kind == StatementKind.expressionStatement) {
          match (in first.expression) {
            some(expression) => match (in expression.tree) {
              some(tree) => {
                const call = view tree.nodes[tree.root];
                if (call.kind == ExpressionKind.callExpression && call.children.length > 0) {
                  const callee = view tree.nodes[call.children[0]];
                  if (callee.kind == ExpressionKind.memberExpression && callee.children.length == 1) {
                    const receiver = view tree.nodes[callee.children[0]];
                    if (receiver.kind == ExpressionKind.identifierExpression && receiver.value == "super") return copy tree;
                  }
                }
              }
              none => {}
            }
            none => {}
          }
        }
        throw subclassError(module, message, first.line, first.column);
      }
      throw subclassError(module, message, initializer.line, initializer.column);
    }
    none => throw subclassError(module,
      "a native subclass requires an explicit constructor and superclass initializer",
      aggregate.line, aggregate.column);
  }
}

function validateSuperclassCallContract(
  in module: ParsedModule, in call: NativeSuperclassCallSite, in methods: Array<ModuleMethodSignature>
): void throws ModuleResolveError {
  let selected = methods.length;
  let count: usize = 0;
  let index: usize = 0;
  while (index < methods.length) {
    const method = view methods[index];
    if (method.name == call.name && method.objectiveCParameterNativeTypes.length == call.argumentCount
      && objcMethodLabelsMatch(method, call.argumentLabels)) {
      selected = index;
      count = count + 1;
    }
    index = index + 1;
  }
  if (count != 1) throw subclassError(module,
    "superclass call must resolve to one imported Objective-C instance selector",
    call.line, call.column);
  const method = view methods[selected];
  try requireNativeAvailability(module, method.objectiveCAvailability, method.objectiveCSelector, call.line, call.column);
  if (call.initializes) {
    if (!nativeInitializerSelector(method.objectiveCSelector) || !method.objectiveCDesignatedInitializer
      || !method.objectiveCReturnsInstanceType) throw subclassError(module,
      "superclass construction requires an imported designated `init` method returning instancetype",
      call.line, call.column);
    const nullableResult = nullableTargetType(method.objectiveCNativeResultType);
    if (nullableResult.byteLength > 0) throw subclassError(module,
      "nullable superclass initializers require the later fallible-construction tier",
      call.line, call.column);
  } else if (nativeInitializerSelector(method.objectiveCSelector)) throw subclassError(module,
    "superclass initialization must occur exactly once, as the first constructor statement", call.line, call.column);
  if ((!call.initializes && method.objectiveCConsumesSelf) || method.objectiveCConsumedParameters.length > 0) throw subclassError(module,
    "consuming superclass calls require a later ownership tier", call.line, call.column);
  if (method.signature.asynchronous || method.objectiveCVariadic) throw subclassError(module,
    "superclass calls must use a synchronous, non-variadic native ABI", call.line, call.column);
  if (method.signature.returnType.byteLength == 0) throw subclassError(module,
    "unsupported superclass return ABI", call.line, call.column);
  for (const parameter of method.signature.parameterTypes) {
    if (parameter.byteLength == 0) throw subclassError(module,
      "unsupported superclass parameter ABI", call.line, call.column);
  }
}

function validateNativeObjCSubclassDeclaration(
  in module: ParsedModule, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in aggregate: AggregateDeclaration
): void throws ModuleResolveError {
  const base = match (in aggregate.nativeBase) {
    some(value) => copy value;
    none => {
      for (const method of aggregate.methods) {
        if (method.overrideMethod) throw subclassError(module,
          "`override` requires an imported Objective-C superclass", method.line, method.column);
      }
      return;
    }
  };
  if (aggregate.kind != DeclarationKind.classDeclaration || aggregate.nativeCLayout) throw subclassError(module,
    "`extends` requires a native Objective-C class declaration", aggregate.line, aggregate.column);
  if (aggregate.typeParameters.length > 0) throw subclassError(module,
    "generic native subclasses are not supported in the first tier", aggregate.line, aggregate.column);
  if (aggregate.executorAffinity != "thread.main") throw subclassError(module,
    "a native subclass must declare `on thread.main`", aggregate.line, aggregate.column);
  for (const field of aggregate.fields) {
    if (field.visibility != Visibility.privateVisibility) throw subclassError(module,
      "native subclass stored fields must be private; expose state through guarded overrides", field.line, field.column);
    let hasDefault = false;
    match (in field.defaultValue) { some(_) => hasDefault = true; none => {} }
    if (field.optionalField || hasDefault) throw subclassError(module,
      "native stored fields require explicit constructor initialization, without defaults or optional fields", field.line, field.column);
    if (field.type.name != "String" && !plainNativeValue(modules, moduleIndex, field.type.name)
      && !nativeObjCStoredWeak(modules, moduleIndex, field.type.name)) {
      const objectABI = nativeObjCStoredObjectABI(modules, moduleIndex, field.type.name);
      if (objectABI.byteLength == 0) throw subclassError(module,
          "native stored fields currently support owned String, scalars, plain native value records, strong imported Objective-C references, and Weak<T> or Option<Weak<T>> for ordinary Z classes", field.line, field.column);
    }
  }
  if (aggregate.implementedTraits.length > 0) throw subclassError(module,
    "native subclass protocol and trait conformance is not supported in the first tier",
    aggregate.line, aggregate.column);
  const initializer = try firstSuperclassCall(module, aggregate);
  match (in aggregate.constructorDeclaration) {
    some(declaration) => {
      match (in declaration.errorType) {
        some(_) => throw subclassError(module,
          "fallible native subclass construction is not supported in the first tier", declaration.line, declaration.column);
        none => {}
      }
      for (const parameter of declaration.parameters) {
        if (parameter.mode != ParameterMode.value
          || !plainNativeValue(modules, moduleIndex, parameter.type.name)) throw subclassError(module,
          "native subclass constructor parameters must be scalar or plain native value parameters in the first tier",
          parameter.line, parameter.column);
      }
    }
    none => {}
  }
  let selectors = Array<String>();
  for (const method of aggregate.methods) {
    try validateOverrideShape(module, method);
    for (const selector of selectors) {
      if (selector == method.objectiveCSelector) throw subclassError(module,
        `duplicate native override selector "${selector}"`, method.line, method.column);
    }
    selectors.push(copy method.objectiveCSelector);
  }
  const superclassCalls = try inspectNativeSubclassBodies(
    module, aggregate, initializer.nodes[initializer.root].offset
  );
  // Source-only probes may not have attached Clang metadata. They still
  // hit the execution gate; never invent a superclass signature here.
  const location = match (typeSymbolLocation(modules, moduleIndex, base.name)) {
    some(value) => value;
    none => {
      if (isUnresolvedExternalType(modules, moduleIndex, base.name)) return;
      throw subclassError(module,
        "`extends` must name an imported Objective-C class; ordinary Z inheritance is not supported",
        base.line, base.column);
    }
  };
  match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
    some(signature) => {
      if (signature.foreignKind != "objcInterface") throw subclassError(module,
        "`extends` must name an imported Objective-C class; ordinary Z inheritance is not supported", base.line, base.column);
      if (signature.foreignObjCSubclassingRestricted) throw subclassError(module,
        `Objective-C class ${signature.foreignNativeName} forbids subclassing`, base.line, base.column);
    }
    none => throw subclassError(module,
      "`extends` must name an imported Objective-C class; ordinary Z inheritance is not supported", base.line, base.column);
  }
  const methods = try nativeObjCSubclassInheritedMethods(module, modules, moduleIndex, aggregate, base.name);
  for (const method of aggregate.methods) {
    let found = false;
    for (const native of methods) {
      if (native.objectiveCSelector != method.objectiveCSelector) continue;
      found = true;
      if (!method.overrideMethod) throw subclassError(module,
        `inherited selector "${method.objectiveCSelector}" requires \`override function\``, method.line, method.column);
      try validateOverrideContract(module, modules, moduleIndex, method, native);
    }
    if (!found) {
      if (method.overrideMethod) throw subclassError(module,
        `no inherited Objective-C instance selector "${method.objectiveCSelector}"`, method.line, method.column);
      try validateNewEntry(module, modules, moduleIndex, method);
    }
  }
  for (const call of superclassCalls) {
    try validateSuperclassCallContract(module, call, methods);
  }
}

export function validateNativeObjCSubclassDeclarations(
  in parsed: Array<ParsedModule>, in modules: Array<ResolvedModule>
): void throws ModuleResolveError {
  let moduleIndex: usize = 0;
  while (moduleIndex < parsed.length) {
    const module = view parsed[moduleIndex];
    for (const aggregate of module.program.aggregates) {
      try validateNativeObjCSubclassDeclaration(module, modules, moduleIndex, aggregate);
    }
    moduleIndex = moduleIndex + 1;
  }
}

// Recheck weak targets after all native identities are prepared, including a
// later declaration or imported subclass that initially looked like a Z class.
export function validateNativeObjCSubclassStorage(
  in parsed: Array<ParsedModule>, in modules: Array<ResolvedModule>
): void throws ModuleResolveError {
  let moduleIndex: usize = 0;
  for (const module of parsed) {
    for (const aggregate of module.program.aggregates) {
      match (in aggregate.nativeBase) { some(_) => {} none => continue; }
      for (const field of aggregate.fields) {
        const name = transparentTypeName(modules, moduleIndex, field.type.name);
        if (field.type.name == "String" || plainNativeValue(modules, moduleIndex, name)) continue;
        const objectABI = nativeObjCStoredObjectABI(modules, moduleIndex, name);
        if (objectABI.byteLength > 0 || nativeObjCStoredWeak(modules, moduleIndex, name)) continue;
        throw subclassError(module,
          "native stored Weak<T> and Option<Weak<T>> require ordinary Z classes, not native subclass identities",
          field.line, field.column);
      }
    }
    moduleIndex = moduleIndex + 1;
  }
}

// This source-owned reference has nominal Z identity and an imported native
// base ABI. It is deliberately not an ordinary Z ARC record or an alias of the
// imported class. Declaration validation must run before preparing its identity.
export function prepareNativeObjCSubclassTypes(
  in parsed: Array<ParsedModule>, inout modules: Array<ResolvedModule>
): void throws ModuleResolveError {
  let moduleIndex: usize = 0;
  while (moduleIndex < parsed.length) {
    const module = view parsed[moduleIndex];
    for (const aggregate of module.program.aggregates) {
      const baseName = match (in aggregate.nativeBase) {
        some(base) => copy base.name;
        none => "";
      };
      if (baseName.byteLength == 0) continue;
      const baseLocation = match (typeSymbolLocation(modules, moduleIndex, baseName)) {
        some(location) => location;
        none => throw subclassError(module,
          "native subclass body checking requires attached Objective-C superclass ABI evidence",
          aggregate.line, aggregate.column);
      };
      const location = match (typeSymbolLocation(modules, moduleIndex, aggregate.name)) {
        some(value) => value;
        none => throw subclassError(module, "missing native subclass type identity", aggregate.line, aggregate.column);
      };
      const methods = try nativeObjCSubclassInheritedMethods(module, modules, moduleIndex, aggregate, baseName);
      let signature = match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(value) => copy value;
        none => throw subclassError(module, "missing native subclass signature", aggregate.line, aggregate.column);
      };
      signature.foreignKind = "objcSubclass";
      signature.foreignLayout = "reference";
      signature.foreignObjCSuperName = copy baseName;
      signature.customDeinit = true;
      // Native allocation and owned storage name the generated Objective-C
      // class, while the base identity remains available for checked conversion.
      const baseSignature = match (in modules[baseLocation.moduleIndex].symbols[baseLocation.symbolIndex].typeSignature) {
        some(value) => copy value;
        none => throw subclassError(module, "missing imported superclass signature", aggregate.line, aggregate.column);
      };
      signature.foreignNativeName = `ZNative_${moduleIndex}_${aggregate.name}`;
      for (const field of baseSignature.fields) {
        let property = copy field;
        property.typeName = rebaseTypeName(modules, baseLocation.moduleIndex, moduleIndex, field.typeName);
        property.objectiveCProtocols = Array<String>();
        for (const protocol of field.objectiveCProtocols) {
          property.objectiveCProtocols.push(rebaseTypeName(modules, baseLocation.moduleIndex, moduleIndex, protocol));
        }
        signature.fields.push(move property);
      }
      let methodIndex: usize = 0;
      while (methodIndex < signature.methods.length) {
        const selector = copy signature.methods[methodIndex].objectiveCImplementationSelector;
        let inherited = false;
        for (const native of methods) {
          if (native.objectiveCSelector != selector) continue;
          inherited = true;
          let method = copy native;
          method.name = copy signature.methods[methodIndex].name;
          method.receiverMode = copy signature.methods[methodIndex].receiverMode;
          method.signature = copy signature.methods[methodIndex].signature;
          method.objectiveCImplementationSelector = copy selector;
          signature.methods[methodIndex] = move method;
          break;
        }
        if (!inherited) {
          let method = copy signature.methods[methodIndex];
          method.objectiveCSelector = copy selector;
          method.objectiveCNativeReturnType = try newEntryABI(module, modules, moduleIndex,
            method.signature.returnType, true, aggregate.line, aggregate.column);
          method.objectiveCNativeResultType = copy method.signature.returnType;
          method.objectiveCParameterNativeTypes = Array<String>();
          for (const sourceMethod of aggregate.methods) {
            if (sourceMethod.name != method.name) continue;
            for (const parameter of sourceMethod.parameters) {
              method.objectiveCParameterNativeTypes.push(try newEntryABI(module, modules, moduleIndex,
                parameter.type.name, false, parameter.line, parameter.column));
            }
          }
          signature.methods[methodIndex] = move method;
        }
        methodIndex = methodIndex + 1;
      }
      const header = copy modules[baseLocation.moduleIndex].symbols[baseLocation.symbolIndex].foreignHeader;
      modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature = Option.some(move signature);
      modules[location.moduleIndex].symbols[location.symbolIndex].foreignHeader = move header;
    }
    moduleIndex = moduleIndex + 1;
  }
}

export function nativeObjCSubclassBase(
  in modules: Array<ResolvedModule>, moduleIndex: usize, in name: String
): String {
  if (name.byteLength == 0) return "";
  return match (typeSymbolLocation(modules, moduleIndex, name)) {
    some(location) => {
      return match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => signature.foreignKind == "objcSubclass"
          ? rebaseTypeName(modules, location.moduleIndex, moduleIndex, signature.foreignObjCSuperName) : "";
        none => "";
      };
    }
    none => "";
  };
}
