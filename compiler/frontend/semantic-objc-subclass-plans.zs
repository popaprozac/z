import { ParsedModule } from "./module-symbols.zs";
import { ReceiverMode } from "./parser.zs";
import {
  ModuleObjCSubclassEntry, ModuleObjCSubclassPlan, ModuleObjCSubclassSuperCall, ModuleObjCSubclassField,
  ModuleResolveError, ModuleResolveErrorKind, ModuleSemanticEvidence,
  ResolvedModule, codedModuleResolutionError,
} from "./semantic-model.zs";
import { typeSymbolLocation, transparentTypeName } from "./semantic-type-identities.zs";
import { inspectNativeSubclassBodies } from "./semantic-objc-subclass-bodies.zs";
import { nativeObjCSubclassInheritedMethods, nativeObjCStoredObjectABI, nativeObjCObjectType, nativeObjCStoredWeak } from "./semantic-objc-subclasses.zs";
import { objcMethodLabelsMatch } from "./semantic-member-lookups.zs";

function sameNativeTypes(in left: Array<String>, in right: Array<String>): boolean {
  if (left.length != right.length) return false;
  let index: usize = 0;
  while (index < left.length) {
    if (left[index].byteLength == 0 || left[index] != right[index]) return false;
    index = index + 1;
  }
  return true;
}

function planError(in module: ParsedModule, in message: String): ModuleResolveError {
  return codedModuleResolutionError(ModuleResolveErrorKind.unsupportedLowering,
    "Z0814", module.path, message, 1, 1, 1);
}

// Constructor entry arguments have a Z signature, which need not be the same
// as the arguments passed to super.init. Never infer that ABI from the call.
function constructorNativeType(
  in module: ParsedModule, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in sourceName: String
): String throws ModuleResolveError {
  const name = transparentTypeName(modules, moduleIndex, sourceName);
  if (name == "boolean") return "bool";
  if (name == "i8") return "int8_t";
  if (name == "i16") return "int16_t";
  if (name == "i32") return "int32_t";
  if (name == "i64") return "int64_t";
  if (name == "u8") return "uint8_t";
  if (name == "u16") return "uint16_t";
  if (name == "u32") return "uint32_t";
  if (name == "u64") return "uint64_t";
  if (name == "isize") return "intptr_t";
  if (name == "usize") return "uintptr_t";
  if (name == "f32") return "float";
  if (name == "f64") return "double";
  const location = match (typeSymbolLocation(modules, moduleIndex, name)) {
    some(value) => value;
    none => throw planError(module, `native subclass constructor lost ABI for ${sourceName}`);
  };
  match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
    some(signature) => {
      if (signature.foreignNativeName.byteLength > 0
        && (signature.foreignKind == "enum" || signature.foreignKind == "scalar"
          || (signature.foreignKind == "record" && signature.foreignLayout == "struct"
            && signature.foreignResourceRelease.byteLength == 0))) {
        return copy signature.foreignNativeName;
      }
    }
    none => {}
  }
  throw planError(module, `unsupported native subclass constructor ABI for ${sourceName}`);
}

// Called only after declaration checking, nominal native-type preparation,
// and body typing. Missing/mismatched typed super-call evidence is an error,
// never permission to rediscover dispatch from a method name during emission.
export function planNativeObjCSubclasses(
  in module: ParsedModule, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in evidence: ModuleSemanticEvidence
): Array<ModuleObjCSubclassPlan> throws ModuleResolveError {
  let plans = Array<ModuleObjCSubclassPlan>();
  let aggregateIndex: usize = 0;
  for (const aggregate of module.program.aggregates) {
    const sourceIndex = aggregateIndex;
    aggregateIndex = aggregateIndex + 1;
    const base = match (in aggregate.nativeBase) {
      some(value) => copy value.name;
      none => "";
    };
    if (base.byteLength == 0) continue;
    const location = match (typeSymbolLocation(modules, moduleIndex, aggregate.name)) {
      some(value) => value;
      none => throw planError(module, "native subclass plan lost source identity");
    };
    const signature = match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
      some(value) => copy value;
      none => throw planError(module, "native subclass plan requires a checked native signature");
    };
    if (signature.foreignKind != "objcSubclass"
      || signature.foreignNativeName.byteLength == 0
      || signature.executorAffinity != "thread.main") {
      throw planError(module, "native subclass plan requires prepared native identity and main affinity");
    }
    const baseLocation = match (typeSymbolLocation(modules, moduleIndex, base)) {
      some(value) => value;
      none => throw planError(module, "native subclass plan lost imported superclass identity");
    };
    const superclassNativeName = match (in modules[baseLocation.moduleIndex].symbols[baseLocation.symbolIndex].typeSignature) {
      some(value) => value.foreignKind == "objcInterface" ? copy value.foreignNativeName : "";
      none => "";
    };
    if (superclassNativeName.byteLength == 0) throw planError(module,
      "native subclass plan requires an imported superclass ABI, not a Z class record");
    const header = copy modules[location.moduleIndex].symbols[location.symbolIndex].foreignHeader;
    if (header.byteLength == 0) throw planError(module, "native subclass plan requires attached superclass header evidence");
    const sourceConstructor = match (in aggregate.constructorDeclaration) {
      some(value) => copy value;
      none => throw planError(module, "native subclass plan requires a checked constructor");
    };
    let parameterTypes = Array<String>();
    let parameterNames = Array<String>();
    let initializerSelector = sourceConstructor.parameters.length == 0 ? "initZGenerated" : "";
    let parameterIndex: usize = 0;
    for (const parameter of sourceConstructor.parameters) {
      parameterTypes.push(try constructorNativeType(module, modules, moduleIndex, parameter.type.name));
      parameterNames.push(copy parameter.name);
      if (parameterIndex == 0) initializerSelector = "initZGeneratedWithArgument0:";
      else initializerSelector = `${initializerSelector}argument${parameterIndex}:`;
      parameterIndex = parameterIndex + 1;
    }
    const initializer = ModuleObjCSubclassEntry({
      sourceIndex: 0, offset: sourceConstructor.offset, sourceName: "constructor",
      selector: move initializerSelector, nativeReturnType: "instancetype",
      nativeParameterTypes: move parameterTypes, parameterNames: move parameterNames,
    });
    const inherited = try nativeObjCSubclassInheritedMethods(module, modules, moduleIndex, aggregate, base);
    let unavailableInitializers = Array<ModuleObjCSubclassEntry>();
    for (const method of inherited) {
      if (method.objectiveCSelector == initializer.selector) {
        throw planError(module, "generated native constructor selector collides with an inherited entry");
      }
      if (!method.objectiveCDesignatedInitializer) continue;
      let names = Array<String>();
      let index: usize = 0;
      while (index < method.objectiveCParameterNativeTypes.length) {
        names.push(`argument${index}`);
        index = index + 1;
      }
      unavailableInitializers.push(ModuleObjCSubclassEntry({
        sourceIndex: 0, offset: 0, sourceName: "",
        selector: copy method.objectiveCSelector,
        nativeReturnType: method.objectiveCReturnsInstanceType ? "instancetype" : copy method.objectiveCNativeReturnType,
        nativeParameterTypes: copy method.objectiveCParameterNativeTypes,
        parameterNames: move names,
      }));
    }
    let methods = Array<ModuleObjCSubclassEntry>();
    let methodIndex: usize = 0;
    for (const method of aggregate.methods) {
      const current = methodIndex;
      methodIndex = methodIndex + 1;
      let found = false;
      for (const checked of signature.methods) {
        if (checked.name != method.name) continue;
        if (found || checked.objectiveCSelector.byteLength == 0
          || checked.objectiveCSelector != checked.objectiveCImplementationSelector
          || checked.objectiveCNativeReturnType.byteLength == 0
          || checked.objectiveCParameterNativeTypes.length != method.parameters.length) {
          throw planError(module, `native subclass override ${method.name} lost checked selector/ABI evidence`);
        }
        const receiverMode = method.receiverMode == ReceiverMode.inputOutput ? "inout" : "in";
        if (checked.receiverMode != receiverMode) {
          throw planError(module, `native subclass override ${method.name} lost checked receiver access evidence`);
        }
        found = true;
        let names = Array<String>();
        for (const parameter of method.parameters) { names.push(copy parameter.name); }
        methods.push(ModuleObjCSubclassEntry({
          overridesInherited: method.overrideMethod,
          sourceIndex: current, offset: method.offset, sourceName: copy method.name,
          selector: copy checked.objectiveCSelector,
          nativeReturnType: copy checked.objectiveCNativeReturnType,
          nativeParameterTypes: copy checked.objectiveCParameterNativeTypes,
          parameterNames: move names,
          receiverMode: copy checked.receiverMode,
        }));
      }
      if (!found) throw planError(module, `native subclass override ${method.name} has no checked entry`);
    }
    // The structural pass identifies exact source offsets. Typed evidence must
    // agree at every one, including the exactly-once initializer operation.
    if (sourceConstructor.body.roots.length == 0) throw planError(module, "native subclass plan requires an initializer body");
    const first = view sourceConstructor.body.nodes[sourceConstructor.body.roots[0]];
    const initializerOffset = match (in first.expression) {
      some(expression) => {
        select match (in expression.tree) {
          some(tree) => tree.nodes[tree.root].offset;
          none => throw planError(module, "native subclass plan lost the initializer expression");
        };
      }
      none => throw planError(module, "native subclass plan lost the initializer statement");
    };
    let initializerCount: usize = 0;
    for (const call of evidence.callResolutions) {
      if (call.kind == "objcSuperInitializer" && call.offset == initializerOffset) {
        initializerCount = initializerCount + 1;
      }
    }
    if (initializerCount != 1) throw planError(module, "native subclass plan requires exactly one typed superclass initializer");
    const sites = try inspectNativeSubclassBodies(module, aggregate, initializerOffset);
    let superCalls = Array<ModuleObjCSubclassSuperCall>();
    for (const site of sites) {
      let found = false;
      for (const call of evidence.callResolutions) {
        if (call.offset != site.offset) continue;
        if (found || call.kind != (site.initializes ? "objcSuperInitializer" : "objcSuper")
          || call.objectiveCSelector.byteLength == 0
          || call.objectiveCNativeReturnType.byteLength == 0
          || call.objectiveCParameterNativeTypes.length != site.argumentCount) {
          throw planError(module, "native subclass plan lost typed superclass dispatch/ABI evidence");
        }
        found = true;
        let nativeMatches: usize = 0;
        for (const native of inherited) {
          if (native.name == site.name && native.objectiveCSelector == call.objectiveCSelector
            && objcMethodLabelsMatch(native, site.argumentLabels)
            && native.objectiveCNativeReturnType == call.objectiveCNativeReturnType
            && sameNativeTypes(native.objectiveCParameterNativeTypes, call.objectiveCParameterNativeTypes)) {
            nativeMatches = nativeMatches + 1;
            if (call.objectiveCReceiverHandoff) {
              if (call.objectiveCHandoffParameterObjects.length != native.signature.parameterTypes.length
                || call.parameterTypes.length != native.signature.parameterTypes.length) {
                throw planError(module, "native superclass handoff lost object lifetime evidence");
              }
              let parameter: usize = 0;
              while (parameter < native.signature.parameterTypes.length) {
                const object = nativeObjCObjectType(modules, moduleIndex, native.signature.parameterTypes[parameter]);
                if (call.objectiveCHandoffParameterObjects[parameter] != object
                  || nativeObjCObjectType(modules, moduleIndex, call.parameterTypes[parameter]) != object) {
                  throw planError(module, "native superclass handoff object lifetime evidence disagrees with the checked parameter type");
                }
                parameter = parameter + 1;
              }
            }
          }
        }
        if (nativeMatches != 1) throw planError(module,
          "typed superclass dispatch ABI does not match the inherited native declaration");
        superCalls.push(ModuleObjCSubclassSuperCall({
          offset: site.offset, initializesReceiver: site.initializes,
          selector: copy call.objectiveCSelector,
          nativeReturnType: copy call.objectiveCNativeReturnType,
          nativeParameterTypes: copy call.objectiveCParameterNativeTypes,
          receiverHandoff: call.objectiveCReceiverHandoff,
        }));
      }
      if (!found) throw planError(module, "native subclass plan requires typed evidence for every superclass call");
    }
    let fields = Array<ModuleObjCSubclassField>();
    for (const field of aggregate.fields) {
      let matchingFields: usize = 0;
      for (const checked of signature.fields) {
        if (checked.name != field.name) continue;
        // Inherited property metadata is not inline source storage, even if
        // the source uses the same private name.
        if (checked.objectiveCGetter.byteLength > 0 || checked.objectiveCSetter.byteLength > 0) continue;
        if (checked.typeName != field.type.name || checked.visibility != "private") {
          throw planError(module, "native subclass stored field lost checked type/visibility evidence");
        }
        matchingFields = matchingFields + 1;
      }
      if (matchingFields != 1) throw planError(module, "native subclass stored field requires one checked identity");
      const objectABI = nativeObjCStoredObjectABI(modules, moduleIndex, field.type.name);
      const managedWeak = nativeObjCStoredWeak(modules, moduleIndex, field.type.name);
      fields.push(ModuleObjCSubclassField({ name: copy field.name,
        nativeType: managedWeak ? "" : field.type.name == "String" ? "Z_String"
          : objectABI.byteLength > 0 ? copy objectABI
          : try constructorNativeType(module, modules, moduleIndex, field.type.name),
        ownedString: field.type.name == "String", strongObject: objectABI.byteLength > 0,
        managedSourceType: managedWeak ? copy field.type.name : "" }));
    }
    plans.push(ModuleObjCSubclassPlan({
      moduleIndex, aggregateIndex: sourceIndex, sourceName: copy aggregate.name,
      nativeName: `ZNative_${moduleIndex}_${aggregate.name}`,
      superclassNativeName: move superclassNativeName,
      executorAffinity: copy signature.executorAffinity, foreignHeader: move header,
      initializer: move initializer, unavailableInitializers: move unavailableInitializers,
      methods: move methods, superCalls: move superCalls, fields: move fields,
    }));
  }
  return plans;
}
