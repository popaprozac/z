import {
  NativeValueBinding,
  addMatchBorrowedValueBinding,
  addViewValueBinding,
  addValueBinding,
  valueBindingViewOwner,
  viewOwnerIsOwnerless,
} from "./semantic-flow-state.zs";
import {
  NativeFieldShape,
  NativeMatchVariant,
  activeOwnerMatches,
  aggregateFieldShape,
  hasKnownAggregate,
} from "./semantic-member-lookups.zs";
import { transparentTypeName, typeSymbolLocation } from "./semantic-type-identities.zs";
import {
  typeContainsOpaqueCleanupStorage,
  typeContainsStoredView,
  typeHasCleanup,
} from "./semantic-type-ownership.zs";
import {
  arrayElementType,
  isNumericTypeName,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import {
  ModuleSemanticEvidence,
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSymbolKind,
  ResolvedModule,
  codedModuleResolutionError,
  moduleResolutionError,
} from "./semantic-model.zs";
import { recordBindingResolution } from "./semantic-evidence.zs";
import { ParsedModule } from "./module-symbols.zs";
import { ExpressionTree } from "./parser.zs";

export function requireObjectDestructureCleanup(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in sourceType: String,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  const actual = transparentTypeName(modules, moduleIndex, sourceType);
  match (typeSymbolLocation(modules, moduleIndex, actual)) {
    some(location) => {
      const symbol = view modules[location.moduleIndex].symbols[location.symbolIndex];
      if (symbol.kind == ModuleSymbolKind.structSymbol) {
        match (in symbol.typeSignature) {
          some(signature) => if (signature.customDeinit) {
            throw codedModuleResolutionError(
              ModuleResolveErrorKind.typeMismatch, "Z0220", module.path,
              `cannot destructure ${sourceType} because it defines deinit`,
              line, column, 1
            );
          }
          none => {}
        }
      }
    }
    none => {}
  }
  const visiting = Array<String>();
  if (typeContainsOpaqueCleanupStorage(modules, moduleIndex, actual, visiting)) {
    throw codedModuleResolutionError(
      ModuleResolveErrorKind.typeMismatch, "Z0220", module.path,
      `cannot destructure ${sourceType} while it contains custom or foreign cleanup storage`,
      line, column, 1
    );
  }
}

function copyIndices(in indices: Array<usize>): Array<usize> {
  let copied = Array<usize>();
  for (const index of indices) {
    copied.push(index);
  }
  return copied;
}

function containsString(in values: Array<String>, in value: String): boolean {
  for (const candidate of values) {
    if (candidate == value) return true;
  }
  return false;
}

export function matchError(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in message: String
): ModuleResolveError {
  return moduleResolutionError(
    ModuleResolveErrorKind.invalidMatch,
    module.path,
    message,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
}

export function isDefinitelyNonMatchable(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in subjectType: String
): boolean {
  if (subjectType == "OnceState") return false;
  if (stringStartsWith(subjectType, "view ") && subjectType.byteLength > 5) {
    const target = subjectType.copyBytes(5, subjectType.byteLength);
    return isDefinitelyNonMatchable(modules, moduleIndex, target);
  }
  const elementType = arrayElementType(subjectType);
  if (
    isNumericTypeName(subjectType)
    || subjectType == "boolean"
    || subjectType == "String"
    || subjectType == "cstring"
    || subjectType == "null"
    || elementType.byteLength > 0
  ) return true;
  match (typeSymbolLocation(modules, moduleIndex, subjectType)) {
    some(location) => {
      const kind = modules[location.moduleIndex].symbols[location.symbolIndex].kind;
      if (
        kind == ModuleSymbolKind.structSymbol
        || kind == ModuleSymbolKind.classSymbol
        || kind == ModuleSymbolKind.traitSymbol
      ) return true;
    }
    none => {}
  }
  return false;
}

export function requireVisibleField(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  index: usize,
  in bindings: Array<NativeValueBinding>,
  in field: NativeFieldShape
): void throws ModuleResolveError {
  if (field.visibility == "public") return;
  if (field.visibility == "private" && activeOwnerMatches(modules, moduleIndex, bindings, field)) return;
  if (
    field.visibility == "internal"
    && modules[moduleIndex].packageIdentity.byteLength > 0
    && modules[moduleIndex].packageIdentity
      == modules[field.ownerModuleIndex].packageIdentity
  ) return;
  let ownerKind = "struct";
  if (
    modules[field.ownerModuleIndex].symbols[field.ownerSymbolIndex].kind
    == ModuleSymbolKind.classSymbol
  ) ownerKind = "class";
  if (field.visibility == "internal") {
    throw moduleResolutionError(
      ModuleResolveErrorKind.unknownMember,
      module.path,
      `field "${field.name}" is internal to its package`,
      tree.nodes[index].line,
      tree.nodes[index].column
    );
  }
  throw moduleResolutionError(
    ModuleResolveErrorKind.unknownMember,
    module.path,
    `field "${field.name}" is private to ${ownerKind} "${field.ownerName}"`,
    tree.nodes[index].line,
    tree.nodes[index].column
  );
}

export function addMatchArmValueBindings(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in tree: ExpressionTree,
  armIndex: usize,
  in variant: NativeMatchVariant,
  borrowedMatch: boolean,
  in subjectRoot: String,
  inout bindings: Array<NativeValueBinding>,
  inout evidence: ModuleSemanticEvidence
): void throws ModuleResolveError {
  let patternKind = "none";
  if (tree.nodes[armIndex].labels.length > 0) {
    patternKind = tree.nodes[armIndex].labels[0].copyBytes(
      0,
      tree.nodes[armIndex].labels[0].byteLength
    );
  }
  const hasPattern = patternKind != "none";
  const hasPayload = variant.payloadType.byteLength > 0;
  if (hasPayload != hasPattern) {
    const message = hasPayload
      ? "payload variant requires a binding"
      : "payloadless variant cannot bind a value";
    throw matchError(
      module,
      tree,
      armIndex,
      message
    );
  }
  if (!hasPattern) return;
  const patterns = copyIndices(tree.nodes[armIndex].children);
  if (patternKind == "binding" && patterns.length == 1) {
    let visiting = Array<String>();
    const storedViewPayload = typeContainsStoredView(
      modules,
      moduleIndex,
      variant.payloadType,
      visiting
    );
    if (stringStartsWith(variant.payloadType, "view ")) {
      let payloadOwner = valueBindingViewOwner(bindings, subjectRoot);
      if (payloadOwner.byteLength == 0 || viewOwnerIsOwnerless(payloadOwner)) {
        payloadOwner = subjectRoot.copyBytes(0, subjectRoot.byteLength);
      }
      addViewValueBinding(
        inout bindings,
        tree.nodes[patterns[0]].value,
        variant.payloadType,
        payloadOwner,
        ""
      );
    } else if (borrowedMatch && storedViewPayload) {
      let payloadOwner = valueBindingViewOwner(bindings, subjectRoot);
      if (payloadOwner.byteLength == 0 || viewOwnerIsOwnerless(payloadOwner)) {
        payloadOwner = subjectRoot.copyBytes(0, subjectRoot.byteLength);
      }
      addViewValueBinding(
        inout bindings,
        tree.nodes[patterns[0]].value,
        variant.payloadType,
        payloadOwner,
        ""
      );
    } else if (
      borrowedMatch
      && typeHasCleanup(modules, moduleIndex, variant.payloadType, visiting)
    ) {
      addMatchBorrowedValueBinding(
        inout bindings,
        tree.nodes[patterns[0]].value,
        variant.payloadType,
        subjectRoot
      );
    } else {
      addValueBinding(
        inout bindings,
        tree.nodes[patterns[0]].value,
        variant.payloadType
      );
    }
    const bindingOffset = tree.nodes[patterns[0]].offset;
    const bindingLine = tree.nodes[patterns[0]].line;
    const bindingColumn = tree.nodes[patterns[0]].column;
    const bindingName = tree.nodes[patterns[0]].value.copyBytes(
      0,
      tree.nodes[patterns[0]].value.byteLength
    );
    recordBindingResolution(
      modules,
      moduleIndex,
      bindingOffset,
      bindingLine,
      bindingColumn,
      bindingName,
      false,
      variant.payloadType,
      inout evidence
    );
    return;
  }
  if (patternKind != "object") return;
  const payloadModuleIndex = variant.payloadModuleIndex;
  const payloadType = variant.payloadType.copyBytes(0, variant.payloadType.byteLength);
  let payloadViewVisiting = Array<String>();
  if (typeContainsStoredView(
    modules,
    moduleIndex,
    payloadType,
    payloadViewVisiting
  )) {
    throw matchError(
      module,
      tree,
      armIndex,
      "a view-bearing enum payload requires one direct binding in the first stored-provenance tier"
    );
  }
  const knownAggregate = hasKnownAggregate(
    modules,
    payloadModuleIndex,
    payloadType
  );
  if (
    !knownAggregate
    && isDefinitelyNonMatchable(modules, payloadModuleIndex, payloadType)
  ) {
    throw matchError(module, tree, armIndex, "an object pattern requires a struct or class payload");
  }
  let coveredFields = Array<String>();
  for (const pattern of patterns) {
    const fieldName = tree.nodes[pattern].value.copyBytes(
      0,
      tree.nodes[pattern].value.byteLength
    );
    if (containsString(coveredFields, fieldName)) {
      throw matchError(module, tree, pattern, `duplicate object pattern field ${fieldName}`);
    }
    coveredFields.push(fieldName.copyBytes(0, fieldName.byteLength));
    let fieldType = "";
    match (aggregateFieldShape(
      modules,
      payloadModuleIndex,
      payloadType,
      fieldName
    )) {
      some(field) => {
        try requireVisibleField(
          module,
          modules,
          moduleIndex,
          tree,
          pattern,
          bindings,
          field
        );
        fieldType = field.typeName.copyBytes(0, field.typeName.byteLength);
      }
      none => {}
    }
    if (knownAggregate && fieldType.byteLength == 0) {
      throw matchError(
        module,
        tree,
        pattern,
        `payload ${payloadType} has no field ${fieldName}`
      );
    }
    const fieldChildren = copyIndices(tree.nodes[pattern].children);
    if (fieldChildren.length == 1) {
      let visiting = Array<String>();
      if (typeHasCleanup(modules, moduleIndex, fieldType, visiting)) {
        let fieldBorrowRoot = "";
        if (borrowedMatch) {
          fieldBorrowRoot = subjectRoot.copyBytes(0, subjectRoot.byteLength);
        }
        addMatchBorrowedValueBinding(
          inout bindings,
          tree.nodes[fieldChildren[0]].value,
          fieldType,
          fieldBorrowRoot
        );
      } else {
        addValueBinding(
          inout bindings,
          tree.nodes[fieldChildren[0]].value,
          fieldType
        );
      }
      const bindingOffset = tree.nodes[fieldChildren[0]].offset;
      const bindingLine = tree.nodes[fieldChildren[0]].line;
      const bindingColumn = tree.nodes[fieldChildren[0]].column;
      const bindingName = tree.nodes[fieldChildren[0]].value.copyBytes(
        0,
        tree.nodes[fieldChildren[0]].value.byteLength
      );
      recordBindingResolution(
        modules,
        moduleIndex,
        bindingOffset,
        bindingLine,
        bindingColumn,
        bindingName,
        false,
        fieldType,
        inout evidence
      );
    }
  }
}
