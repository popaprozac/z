import { ParsedModule } from "./module-symbols.zs";
import { ExpressionKind, ExpressionTree } from "./parser.zs";
import { ModuleResolveError, ModuleResolveErrorKind, ModuleSemanticEvidence, ModuleObjCSelectorResolution, ResolvedModule, codedModuleResolutionError } from "./semantic-model.zs";
import { NativeValueBinding, valueBindingType, valueBindingClassAlias } from "./semantic-flow-state.zs";
import { NativeMethodCallShape, callableMethodCallShape, activeOwnerMatchesMethod, typeExpressionName } from "./semantic-member-lookups.zs";
import { typeSymbolLocation, equivalentTypes } from "./semantic-type-identities.zs";
import { nativeObjCSubclassBase } from "./semantic-objc-subclasses.zs";
import { expressionStorageRootName } from "./semantic-expression-ownership.zs";
import { requireNativeAvailability } from "./semantic-native-availability.zs";

function selectorError(in module: ParsedModule, in tree: ExpressionTree, index: usize, in message: String): ModuleResolveError {
  return codedModuleResolutionError(ModuleResolveErrorKind.typeMismatch, "Z0814", module.path, message, tree.nodes[index].line, tree.nodes[index].column, 1);
}

function sameType(in modules: Array<ResolvedModule>, moduleIndex: usize, in leftSource: String, in rightSource: String): boolean {
  // One Objective-C class can be visible through several header imports.
  // Compare native identity, preserving nullability and source-subclass identity,
  // rather than requiring both names to occupy the same module symbol slot.
  return equivalentTypes(modules, moduleIndex, leftSource, rightSource);
}

// Only an inline declaration reference gets evidence. Ordinary SEL values and
// bound methods cannot impersonate one; no closure is synthesized.
export function prepareObjCSelectorReferences(
  in module: ParsedModule, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in tree: ExpressionTree, in arguments: Array<usize>, in method: NativeMethodCallShape,
  in bindings: Array<NativeValueBinding>, inout evidence: ModuleSemanticEvidence
): void throws ModuleResolveError {
  for (const callback of method.objectiveCSelectorCallbacks) {
    if (callback.selectorParameter >= arguments.length || callback.targetParameter >= arguments.length) {
      const root = tree.root;
      throw selectorError(module, tree, root, "selector registration lost its target/selector arguments");
    }
    const index = arguments[callback.selectorParameter];
    const targetRoot = expressionStorageRootName(tree, arguments[callback.targetParameter]);
    const phase = valueBindingType(bindings, "__z_native_function_name");
    const identity = valueBindingClassAlias(bindings, targetRoot);
    if ((phase == "constructor" || phase == "deinit") && (targetRoot == "this" || (identity > 0 && identity == valueBindingClassAlias(bindings, "this")))) {
      const targetIndex = arguments[callback.targetParameter];
      throw selectorError(module, tree, targetIndex, "cannot register the constructing or dying native receiver as a selector target; register after new returns");
    }
    const call = view tree.nodes[index];
    if (call.kind != ExpressionKind.callExpression || call.children.length != 2) {
      throw selectorError(module, tree, index, "selector registration requires checked objc.selector(Type.method) evidence, not a bare SEL");
    }
    const callee = view tree.nodes[call.children[0]];
    if (callee.kind != ExpressionKind.memberExpression || callee.value != "selector" || callee.children.length != 1) {
      throw selectorError(module, tree, index, "selector registration requires checked objc.selector(Type.method) evidence");
    }
    const namespace = view tree.nodes[callee.children[0]];
    let imported = false;
    const shadow = valueBindingType(bindings, namespace.value);
    if (namespace.kind == ExpressionKind.identifierExpression && shadow.byteLength == 0) {
      for (const declaration of module.program.imports) {
        if (!declaration.selective && declaration.header == "std/objc" && declaration.moduleName == namespace.value) imported = true;
      }
    }
    if (!imported) throw selectorError(module, tree, index, "selector registration requires objc.selector from std/objc");
    for (const label of call.labels) {
      if (label.byteLength > 0) throw selectorError(module, tree, index, "objc.selector does not accept argument labels");
    }
    const reference = view tree.nodes[call.children[1]];
    if (reference.kind != ExpressionKind.memberExpression || reference.children.length != 1 || reference.optionalAccess) {
      throw selectorError(module, tree, index, "objc.selector expects a native subclass method declaration, Type.method, not a bound method or call");
    }
    const ownerNode = reference.children[0];
    const ownerType = typeExpressionName(tree, ownerNode);
    const root = expressionStorageRootName(tree, ownerNode);
    const bound = valueBindingType(bindings, root);
    const base = nativeObjCSubclassBase(modules, moduleIndex, ownerType);
    if (bound.byteLength > 0 || base.byteLength == 0) {
      throw selectorError(module, tree, index, "objc.selector requires an explicitly declared native subclass method with an as selector");
    }
    const location = match (typeSymbolLocation(modules, moduleIndex, ownerType)) { some(value) => value; none => throw selectorError(module, tree, index, "unknown selector owner type"); };
    let declared = false;
    match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
      some(signature) => for (const candidate of signature.methods) {
        if (candidate.name == reference.value && candidate.objectiveCImplementationSelector.byteLength > 0 && !candidate.staticMethod) declared = true;
      }
      none => {}
    }
    if (!declared) throw selectorError(module, tree, index, "objc.selector requires an explicitly declared native subclass method with an as selector");
    const selected = match (callableMethodCallShape(modules, moduleIndex, bindings, ownerType, reference.value, false, callback.signature.parameterTypes.length, Array<String>())) {
      some(value) => value;
      none => throw selectorError(module, tree, index, "objc.selector method does not match the registration callback signature");
    };
    if (selected.visibility == "private" && !activeOwnerMatchesMethod(modules, moduleIndex, bindings, selected)) throw selectorError(module, tree, index, "selector method is private to its type");
    if (selected.visibility == "internal" && (modules[moduleIndex].packageIdentity.byteLength == 0 || modules[moduleIndex].packageIdentity != modules[selected.ownerModuleIndex].packageIdentity)) throw selectorError(module, tree, index, "selector method is internal to its package");
    try requireNativeAvailability(module, selected.objectiveCAvailability, selected.objectiveCSelector, reference.line, reference.column);
    let matches = sameType(modules, moduleIndex, selected.signature.returnType, callback.signature.returnType);
    let parameter: usize = 0;
    while (parameter < callback.signature.parameterTypes.length) {
      if (!sameType(modules, moduleIndex, selected.signature.parameterTypes[parameter], callback.signature.parameterTypes[parameter])
        || selected.signature.parameterModes[parameter] != callback.signature.parameterModes[parameter]) matches = false;
      parameter = parameter + 1;
    }
    if (!matches) throw selectorError(module, tree, index, "objc.selector method does not match the registration callback signature");
    if (valueBindingType(bindings, "__z_native_executor_context") != "thread.main") throw selectorError(module, tree, index, "native selector registration requires thread.main");
    evidence.objectiveCSelectors.push(ModuleObjCSelectorResolution({ offset: call.offset, line: call.line, column: call.column,
      targetOffset: tree.nodes[arguments[callback.targetParameter]].offset, ownerType, selector: copy selected.objectiveCSelector }));
  }
}

export function validateObjCSelectorTargets(
  in module: ParsedModule, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in tree: ExpressionTree, in arguments: Array<usize>, in method: NativeMethodCallShape,
  in bindings: Array<NativeValueBinding>, in evidence: ModuleSemanticEvidence
): void throws ModuleResolveError {
  for (const callback of method.objectiveCSelectorCallbacks) {
    const index = arguments[callback.targetParameter];
    const offset = tree.nodes[arguments[callback.selectorParameter]].offset;
    for (const plan of evidence.objectiveCSelectors) {
      if (plan.offset != offset) continue;
      const position = selectorExpressionIndex(evidence, tree.nodes[index].offset);
      const actual = position < evidence.expressionResolutions.length ? copy evidence.expressionResolutions[position].typeName : "";
      if (!sameType(modules, moduleIndex, actual, plan.ownerType)) throw selectorError(module, tree, index, `selector target must be a non-null ${plan.ownerType}, found ${actual}`);
      const phase = valueBindingType(bindings, "__z_native_function_name");
      const root = expressionStorageRootName(tree, index);
      const identity = valueBindingClassAlias(bindings, root);
      if ((phase == "constructor" || phase == "deinit") && (root == "this" || (identity > 0 && identity == valueBindingClassAlias(bindings, "this")))) {
        throw selectorError(module, tree, index, "cannot register the constructing or dying native receiver as a selector target; register after new returns");
      }
    }
  }
}

function selectorExpressionIndex(in evidence: ModuleSemanticEvidence, offset: usize): usize {
  const found = evidence.expressionResolutionIndices.get(offset);
  match (in found) { some(index) => return index; none => return evidence.expressionResolutions.length; }
}
