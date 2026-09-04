import { TextBuffer } from "std/text";
import { moduleSymbolIndex } from "./module-symbols.zs";
import {
  fixedArrayShape,
  genericTypeBaseName,
  genericTypeShape,
  isTypeSymbolKind,
  nativeFunctionSignature,
  nullableTargetType,
  qualifiedTypeBase,
  qualifiedTypeMember,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import {
  ModuleTypeIdentity,
  ModuleSymbolKind,
  ResolvedModule,
} from "./semantic-model.zs";

export struct ModuleSymbolLocation {
  moduleIndex: usize;
  symbolIndex: usize;
}

function unresolvedExternalTypeBase(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): boolean {
  const base = qualifiedTypeBase(name);
  const member = qualifiedTypeMember(name);
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], base);
  if (symbolIndex >= modules[moduleIndex].symbols.length) return false;
  if (member.byteLength > 0) {
    if (
      modules[moduleIndex].symbols[symbolIndex].kind
      != ModuleSymbolKind.namespaceSymbol
    ) return false;
    return match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
      some(target) => false;
      none => true;
    };
  }
  if (
    modules[moduleIndex].symbols[symbolIndex].kind
    != ModuleSymbolKind.importedSymbol
  ) return false;
  return match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
    some(target) => false;
    none => true;
  };
}

export function isUnresolvedExternalType(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): boolean {
  const nullableTarget = nullableTargetType(name);
  if (nullableTarget.byteLength > 0) {
    return isUnresolvedExternalType(modules, moduleIndex, nullableTarget);
  }
  if (stringStartsWith(name, "view ")) {
    const target = name.copyBytes(5, name.byteLength);
    return isUnresolvedExternalType(modules, moduleIndex, target);
  }
  match (fixedArrayShape(name)) {
    some(array) => return isUnresolvedExternalType(
      modules,
      moduleIndex,
      array.elementType
    );
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      if (unresolvedExternalTypeBase(modules, moduleIndex, generic.base)) {
        return true;
      }
      for (const argument of generic.arguments) {
        if (isUnresolvedExternalType(modules, moduleIndex, argument)) return true;
      }
      return false;
    }
    none => {}
  }
  return unresolvedExternalTypeBase(modules, moduleIndex, name);
}

function visibleTypeLocation(
  in modules: Array<ResolvedModule>,
  ownerModuleIndex: usize,
  requesterModuleIndex: usize,
  in name: String
): Option<ModuleSymbolLocation> {
  const symbolIndex = moduleSymbolIndex(modules[ownerModuleIndex], name);
  if (
    symbolIndex < modules[ownerModuleIndex].symbols.length
    && (
      modules[ownerModuleIndex].symbols[symbolIndex].exported
      || (
        modules[ownerModuleIndex].symbols[symbolIndex].packageVisible
        && modules[ownerModuleIndex].packageIdentity.byteLength > 0
        && modules[ownerModuleIndex].packageIdentity
          == modules[requesterModuleIndex].packageIdentity
      )
    )
    && isTypeSymbolKind(modules[ownerModuleIndex].symbols[symbolIndex].kind)
  ) return Option.some(ModuleSymbolLocation({
    moduleIndex: ownerModuleIndex,
    symbolIndex,
  }));
  return Option<ModuleSymbolLocation>.none;
}

export function transparentTypeLocation(
  in modules: Array<ResolvedModule>,
  in location: ModuleSymbolLocation
): ModuleSymbolLocation {
  const symbol = view modules[location.moduleIndex].symbols[
    location.symbolIndex
  ];
  if (symbol.kind != ModuleSymbolKind.typeAliasSymbol) return location;
  match (typeSymbolLocation(
    modules,
    location.moduleIndex,
    symbol.importedName
  )) {
    some(target) => {
      if (
        target.moduleIndex == location.moduleIndex
        && target.symbolIndex == location.symbolIndex
      ) return location;
      return transparentTypeLocation(modules, target);
    }
    none => return location;
  }
}

function unqualifiedTypeSymbolLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): Option<ModuleSymbolLocation> {
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], typeName);
  if (symbolIndex < modules[moduleIndex].symbols.length) {
    if (isTypeSymbolKind(modules[moduleIndex].symbols[symbolIndex].kind)) {
      return Option.some(ModuleSymbolLocation({ moduleIndex, symbolIndex }));
    }
    if (modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.importedSymbol) {
      return match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
        some(target) => visibleTypeLocation(
          modules,
          target,
          moduleIndex,
          modules[moduleIndex].symbols[symbolIndex].importedName
        );
        none => Option<ModuleSymbolLocation>.none;
      };
    }
    return Option<ModuleSymbolLocation>.none;
  }
  return Option<ModuleSymbolLocation>.none;
}

function inferredHiddenTypeSymbolLocation(
  in modules: Array<ResolvedModule>,
  in typeName: String
): Option<ModuleSymbolLocation> {
  if (!stringStartsWith(typeName, "__z_module_")) {
    return Option<ModuleSymbolLocation>.none;
  }
  let candidateModuleIndex: usize = 0;
  while (candidateModuleIndex < modules.length) {
    let candidateSymbolIndex: usize = 0;
    while (
      candidateSymbolIndex < modules[candidateModuleIndex].symbols.length
    ) {
      const symbol = view modules[candidateModuleIndex].symbols[
        candidateSymbolIndex
      ];
      if (
        isTypeSymbolKind(symbol.kind)
        && typeName == `__z_module_${candidateModuleIndex}_${symbol.name}`
      ) return Option.some(ModuleSymbolLocation({
        moduleIndex: candidateModuleIndex,
        symbolIndex: candidateSymbolIndex,
      }));
      candidateSymbolIndex = candidateSymbolIndex + 1;
    }
    candidateModuleIndex = candidateModuleIndex + 1;
  }
  return Option<ModuleSymbolLocation>.none;
}

function typeSymbolLocationForName(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): Option<ModuleSymbolLocation> {
  match (inferredHiddenTypeSymbolLocation(modules, typeName)) {
    some(location) => return Option.some(location);
    none => {}
  }
  const member = qualifiedTypeMember(typeName);
  if (member.byteLength == 0) {
    return unqualifiedTypeSymbolLocation(modules, moduleIndex, typeName);
  }
  const base = qualifiedTypeBase(typeName);
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], base);
  if (symbolIndex >= modules[moduleIndex].symbols.length) {
    return Option<ModuleSymbolLocation>.none;
  }
  if (
    modules[moduleIndex].symbols[symbolIndex].kind
    != ModuleSymbolKind.namespaceSymbol
  ) return Option<ModuleSymbolLocation>.none;
  return match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
    some(target) => visibleTypeLocation(
      modules,
      target,
      moduleIndex,
      member
    );
    none => {
      const exact = moduleSymbolIndex(modules[moduleIndex], typeName);
      if (
        exact < modules[moduleIndex].symbols.length
        && isTypeSymbolKind(modules[moduleIndex].symbols[exact].kind)
      ) return Option.some(ModuleSymbolLocation({
        moduleIndex,
        symbolIndex: exact,
      }));
      return Option<ModuleSymbolLocation>.none;
    }
  };
}

export function typeSymbolLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in sourceType: String
): Option<ModuleSymbolLocation> {
  return match (genericTypeBaseName(sourceType)) {
    some(base) => typeSymbolLocationForName(modules, moduleIndex, base);
    none => typeSymbolLocationForName(modules, moduleIndex, sourceType);
  };
}

export function sourceTypeDisplayName(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): String {
  const nullable = nullableTargetType(name);
  if (nullable.byteLength > 0) {
    const displayed = sourceTypeDisplayName(modules, moduleIndex, nullable);
    return `${displayed} | null`;
  }
  if (stringStartsWith(name, "view ")) {
    const target = name.copyBytes(5, name.byteLength);
    const displayed = sourceTypeDisplayName(modules, moduleIndex, target);
    return `view ${displayed}`;
  }
  if (stringStartsWith(name, "readonly ")) {
    const target = name.copyBytes(9, name.byteLength);
    const displayed = sourceTypeDisplayName(modules, moduleIndex, target);
    return `readonly ${displayed}`;
  }
  match (fixedArrayShape(name)) {
    some(array) => {
      const element = sourceTypeDisplayName(
        modules,
        moduleIndex,
        array.elementType
      );
      return `${element}[${array.length}]`;
    }
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      let output = TextBuffer();
      const base = sourceTypeDisplayName(
        modules,
        moduleIndex,
        generic.base
      );
      output.append(base);
      output.append("<");
      let index: usize = 0;
      while (index < generic.arguments.length) {
        if (index > 0) output.append(", ");
        const argument = sourceTypeDisplayName(
          modules,
          moduleIndex,
          generic.arguments[index]
        );
        output.append(argument);
        index = index + 1;
      }
      output.append(">");
      return output.finish();
    }
    none => {}
  }
  return match (inferredHiddenTypeSymbolLocation(modules, name)) {
    some(location) => modules[location.moduleIndex].symbols[
      location.symbolIndex
    ].name.copyBytes(
      0,
      modules[location.moduleIndex].symbols[location.symbolIndex]
        .name.byteLength
    );
    none => name.copyBytes(0, name.byteLength);
  };
}

function inferredTypeSymbolLocationForName(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): Option<ModuleSymbolLocation> {
  const qualifiedMember = qualifiedTypeMember(typeName);
  if (qualifiedMember.byteLength > 0) {
    return Option<ModuleSymbolLocation>.none;
  }
  let found = Option<ModuleSymbolLocation>.none;
  let candidateModuleIndex: usize = 0;
  while (candidateModuleIndex < modules.length) {
    const candidateSymbolIndex = moduleSymbolIndex(
      modules[candidateModuleIndex],
      typeName
    );
    if (
      candidateSymbolIndex < modules[candidateModuleIndex].symbols.length
      && (
        modules[candidateModuleIndex].symbols[candidateSymbolIndex].exported
        || (
          modules[candidateModuleIndex].symbols[candidateSymbolIndex].packageVisible
          && modules[candidateModuleIndex].packageIdentity.byteLength > 0
          && modules[candidateModuleIndex].packageIdentity
            == modules[moduleIndex].packageIdentity
        )
      )
      && isTypeSymbolKind(
        modules[candidateModuleIndex].symbols[candidateSymbolIndex].kind
      )
    ) {
      const candidate = transparentTypeLocation(
        modules,
        ModuleSymbolLocation({
          moduleIndex: candidateModuleIndex,
          symbolIndex: candidateSymbolIndex,
        })
      );
      match (found) {
        some(existing) => {
          if (
            existing.moduleIndex != candidate.moduleIndex
            || existing.symbolIndex != candidate.symbolIndex
          ) return Option<ModuleSymbolLocation>.none;
        }
        none => found = Option.some(candidate);
      }
    }
    candidateModuleIndex = candidateModuleIndex + 1;
  }
  return found;
}

export function inferredTypeSymbolLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in sourceType: String
): Option<ModuleSymbolLocation> {
  const transparent = transparentTypeName(modules, moduleIndex, sourceType);
  if (transparent != sourceType) {
    return inferredTypeSymbolLocation(modules, moduleIndex, transparent);
  }
  match (typeSymbolLocation(modules, moduleIndex, sourceType)) {
    some(location) => return Option.some(transparentTypeLocation(
      modules,
      location
    ));
    none => {}
  }
  return match (genericTypeBaseName(sourceType)) {
    some(base) => inferredTypeSymbolLocationForName(
      modules,
      moduleIndex,
      base
    );
    none => inferredTypeSymbolLocationForName(
      modules,
      moduleIndex,
      sourceType
    );
  };
}

function childTypeIdentityPath(in path: String, in segment: String): String {
  if (path.byteLength == 0) return segment.copyBytes(0, segment.byteLength);
  return `${path}/${segment}`;
}

export function collectTypeIdentities(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String,
  in path: String,
  inout identities: Array<ModuleTypeIdentity>
): void {
  const transparent = transparentTypeName(modules, moduleIndex, typeName);
  if (transparent != typeName) {
    collectTypeIdentities(
      modules,
      moduleIndex,
      transparent,
      path,
      inout identities
    );
    return;
  }
  match (genericTypeShape(typeName)) {
    some(generic) => {
      match (typeSymbolLocation(modules, moduleIndex, generic.base)) {
        some(location) => {
          const target = transparentTypeLocation(modules, location);
          identities.push(ModuleTypeIdentity({
            path: path.copyBytes(0, path.byteLength),
            targetModuleIndex: target.moduleIndex,
            targetSymbolIndex: target.symbolIndex,
          }));
        }
        none => {}
      }
      let index: usize = 0;
      while (index < generic.arguments.length) {
        const segment = `${index}`;
        const childPath = childTypeIdentityPath(path, segment);
        collectTypeIdentities(
          modules,
          moduleIndex,
          generic.arguments[index],
          childPath,
          inout identities
        );
        index = index + 1;
      }
      return;
    }
    none => {}
  }
  const nullable = nullableTargetType(typeName);
  if (nullable.byteLength > 0) {
    const childPath = childTypeIdentityPath(path, "0");
    collectTypeIdentities(modules, moduleIndex, nullable, childPath, inout identities);
    return;
  }
  if (stringStartsWith(typeName, "view ")) {
    const target = typeName.copyBytes(5, typeName.byteLength);
    const childPath = childTypeIdentityPath(path, "0");
    collectTypeIdentities(modules, moduleIndex, target, childPath, inout identities);
    return;
  }
  if (stringStartsWith(typeName, "readonly ")) {
    const target = typeName.copyBytes(9, typeName.byteLength);
    const childPath = childTypeIdentityPath(path, "0");
    collectTypeIdentities(modules, moduleIndex, target, childPath, inout identities);
    return;
  }
  match (fixedArrayShape(typeName)) {
    some(array) => {
      const childPath = childTypeIdentityPath(path, "0");
      collectTypeIdentities(modules, moduleIndex, array.elementType, childPath, inout identities);
      return;
    }
    none => {}
  }
  match (nativeFunctionSignature(typeName)) {
    some(signature) => {
      let index: usize = 0;
      while (index < signature.parameterTypes.length) {
        const segment = `p${index}`;
        const childPath = childTypeIdentityPath(path, segment);
        collectTypeIdentities(
          modules,
          moduleIndex,
          signature.parameterTypes[index],
          childPath,
          inout identities
        );
        index = index + 1;
      }
      const returnPath = childTypeIdentityPath(path, "r");
      collectTypeIdentities(modules, moduleIndex, signature.returnType, returnPath, inout identities);
      if (signature.errorType.byteLength > 0) {
        const errorPath = childTypeIdentityPath(path, "e");
        collectTypeIdentities(
          modules,
          moduleIndex,
          signature.errorType,
          errorPath,
          inout identities
        );
      }
      return;
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => {
      const target = transparentTypeLocation(modules, location);
      identities.push(ModuleTypeIdentity({
        path: path.copyBytes(0, path.byteLength),
        targetModuleIndex: target.moduleIndex,
        targetSymbolIndex: target.symbolIndex,
      }));
    }
    none => {}
  }
}

function localTypeSpelling(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in location: ModuleSymbolLocation
): String {
  const targetName = modules[location.moduleIndex].symbols[location.symbolIndex].name.copyBytes(
    0,
    modules[location.moduleIndex].symbols[location.symbolIndex].name.byteLength
  );
  const targetNameLength = targetName.byteLength;
  let symbolIndex: usize = 0;
  while (symbolIndex < modules[moduleIndex].symbols.length) {
    if (
      moduleIndex == location.moduleIndex
      && symbolIndex == location.symbolIndex
    ) return targetName.copyBytes(0, targetNameLength);
    if (modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.importedSymbol) {
      match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
        some(target) => {
          if (
            target == location.moduleIndex
            && modules[moduleIndex].symbols[symbolIndex].importedName == targetName
          ) return modules[moduleIndex].symbols[symbolIndex].name.copyBytes(
            0,
            modules[moduleIndex].symbols[symbolIndex].name.byteLength
          );
        }
        none => {}
      }
    }
    symbolIndex = symbolIndex + 1;
  }
  symbolIndex = 0;
  while (symbolIndex < modules[moduleIndex].symbols.length) {
    if (modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.namespaceSymbol) {
      match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
        some(target) => {
          if (target == location.moduleIndex) {
            return `${modules[moduleIndex].symbols[symbolIndex].name}.${targetName}`;
          }
        }
        none => {}
      }
    }
    symbolIndex = symbolIndex + 1;
  }
  return `__z_module_${location.moduleIndex}_${targetName}`;
}

export function rebaseTypeName(
  in modules: Array<ResolvedModule>,
  fromModuleIndex: usize,
  toModuleIndex: usize,
  in name: String
): String {
  const nullableTarget = nullableTargetType(name);
  if (nullableTarget.byteLength > 0) {
    const rebased = rebaseTypeName(modules, fromModuleIndex, toModuleIndex, nullableTarget);
    return `${rebased} | null`;
  }
  if (stringStartsWith(name, "view ")) {
    const target = name.copyBytes(5, name.byteLength);
    const rebased = rebaseTypeName(modules, fromModuleIndex, toModuleIndex, target);
    return `view ${rebased}`;
  }
  if (stringStartsWith(name, "readonly ")) {
    const target = name.copyBytes(9, name.byteLength);
    const rebased = rebaseTypeName(modules, fromModuleIndex, toModuleIndex, target);
    return `readonly ${rebased}`;
  }
  match (fixedArrayShape(name)) {
    some(array) => {
      const element = rebaseTypeName(modules, fromModuleIndex, toModuleIndex, array.elementType);
      return `${element}[${array.length}]`;
    }
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      let base = generic.base.copyBytes(0, generic.base.byteLength);
      match (typeSymbolLocation(modules, fromModuleIndex, generic.base)) {
        some(location) => base = localTypeSpelling(modules, toModuleIndex, location);
        none => {}
      }
      let output = TextBuffer();
      output.append(base);
      output.append("<");
      let index: usize = 0;
      while (index < generic.arguments.length) {
        if (index > 0) output.append(", ");
        const argument = rebaseTypeName(
          modules,
          fromModuleIndex,
          toModuleIndex,
          generic.arguments[index]
        );
        output.append(argument);
        index = index + 1;
      }
      output.append(">");
      return output.finish();
    }
    none => {}
  }
  return match (typeSymbolLocation(modules, fromModuleIndex, name)) {
    some(location) => localTypeSpelling(modules, toModuleIndex, location);
    none => name.copyBytes(0, name.byteLength);
  };
}

function transparentTypeNameAtDepth(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String,
  depth: usize
): String {
  if (depth >= 64) return name.copyBytes(0, name.byteLength);
  return match (typeSymbolLocation(modules, moduleIndex, name)) {
    some(location) => {
      if (
        modules[location.moduleIndex].symbols[location.symbolIndex].kind
        != ModuleSymbolKind.typeAliasSymbol
      ) {
        return name.copyBytes(0, name.byteLength);
      }
      const declaredTargetLength = modules[location.moduleIndex].symbols[
        location.symbolIndex
      ].importedName.byteLength;
      const declaredTarget = modules[location.moduleIndex].symbols[
        location.symbolIndex
      ].importedName.copyBytes(0, declaredTargetLength);
      if (
        location.moduleIndex == moduleIndex
        && declaredTarget == name
      ) return name.copyBytes(0, name.byteLength);
      const expandedTarget = transparentTypeNameAtDepth(
        modules,
        location.moduleIndex,
        declaredTarget,
        depth + 1
      );
      const target = rebaseTypeName(
        modules,
        location.moduleIndex,
        moduleIndex,
        expandedTarget
      );
      return target;
    }
    none => name.copyBytes(0, name.byteLength);
  };
}

export function transparentTypeName(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): String {
  return transparentTypeNameAtDepth(modules, moduleIndex, name, 0);
}

function symbolTypeIdentity(
  in modules: Array<ResolvedModule>,
  in location: ModuleSymbolLocation
): String {
  match (
    in modules[location.moduleIndex].symbols[
      location.symbolIndex
    ].typeSignature
  ) {
    some(signature) => {
      if (
        signature.foreignNativeName.byteLength > 0
        && modules[location.moduleIndex].symbols[
          location.symbolIndex
        ].foreignHeader.byteLength > 0
      ) {
        if (
          signature.foreignKind == "objcInterface"
          || signature.foreignKind == "objcProtocol"
        ) {
          let objectiveCName = signature.foreignNativeName.copyBytes(
            0,
            signature.foreignNativeName.byteLength
          );
          if (signature.foreignCanonicalNativeName.byteLength > 0) {
            objectiveCName = signature.foreignCanonicalNativeName.copyBytes(
              0,
              signature.foreignCanonicalNativeName.byteLength
            );
          }
          return `@objc:${signature.foreignKind}:${objectiveCName}`;
        }
        if (signature.foreignCanonicalNativeName.byteLength > 0) {
          return `@foreign:${modules[location.moduleIndex].symbols[location.symbolIndex].foreignHeader}:${signature.foreignCanonicalNativeName}`;
        }
        return `@foreign:${modules[location.moduleIndex].symbols[location.symbolIndex].foreignHeader}:${signature.foreignNativeName}`;
      }
    }
    none => {}
  }
  return `@${location.moduleIndex}:${location.symbolIndex}`;
}

export function semanticTypeIdentity(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): String {
  const nullableTarget = nullableTargetType(name);
  if (nullableTarget.byteLength > 0) {
    const identity = semanticTypeIdentity(modules, moduleIndex, nullableTarget);
    return `${identity} | null`;
  }
  if (stringStartsWith(name, "view ")) {
    const target = name.copyBytes(5, name.byteLength);
    const identity = semanticTypeIdentity(modules, moduleIndex, target);
    return `view ${identity}`;
  }
  if (stringStartsWith(name, "readonly ")) {
    const target = name.copyBytes(9, name.byteLength);
    const identity = semanticTypeIdentity(modules, moduleIndex, target);
    return `readonly ${identity}`;
  }
  match (fixedArrayShape(name)) {
    some(array) => {
      const identity = semanticTypeIdentity(modules, moduleIndex, array.elementType);
      return `${identity}[${array.length}]`;
    }
    none => {}
  }
  match (nativeFunctionSignature(name)) {
    some(signature) => {
      let output = TextBuffer();
      output.append("@function:");
      if (signature.asynchronous) output.append("async:");
      output.append("(");
      let index: usize = 0;
      while (index < signature.parameterTypes.length) {
        if (index > 0) output.append(",");
        output.append(signature.parameterModes[index]);
        output.append(":");
        const parameter = semanticTypeIdentity(
          modules,
          moduleIndex,
          signature.parameterTypes[index]
        );
        output.append(parameter);
        index = index + 1;
      }
      output.append(")=>");
      const returned = semanticTypeIdentity(
        modules,
        moduleIndex,
        signature.returnType
      );
      output.append(returned);
      if (signature.errorType.byteLength > 0) {
        output.append(":throws:");
        const error = semanticTypeIdentity(
          modules,
          moduleIndex,
          signature.errorType
        );
        output.append(error);
      }
      if (signature.threadContract.byteLength > 0) {
        output.append(":on:");
        output.append(signature.threadContract);
      }
      return output.finish();
    }
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      let base = generic.base.copyBytes(0, generic.base.byteLength);
      match (typeSymbolLocation(modules, moduleIndex, generic.base)) {
        some(location) => base = symbolTypeIdentity(modules, location);
        none => {}
      }
      let output = TextBuffer();
      output.append(base);
      output.append("<");
      let index: usize = 0;
      while (index < generic.arguments.length) {
        if (index > 0) output.append(",");
        const argument = semanticTypeIdentity(modules, moduleIndex, generic.arguments[index]);
        output.append(argument);
        index = index + 1;
      }
      output.append(">");
      return output.finish();
    }
    none => {}
  }
  return match (typeSymbolLocation(modules, moduleIndex, name)) {
    some(location) => {
      if (
        modules[location.moduleIndex].symbols[location.symbolIndex].kind
        == ModuleSymbolKind.typeAliasSymbol
      ) {
        const transparent = transparentTypeName(modules, moduleIndex, name);
        if (transparent != name) {
          return semanticTypeIdentity(modules, moduleIndex, transparent);
        }
      }
      return symbolTypeIdentity(modules, location);
    }
    none => name.copyBytes(0, name.byteLength);
  };
}

export function equivalentTypes(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in left: String,
  in right: String
): boolean {
  if (left == right) return true;
  return semanticTypeIdentity(modules, moduleIndex, left)
    == semanticTypeIdentity(modules, moduleIndex, right);
}

export function typeSatisfiesTrait(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in concreteType: String,
  in requiredTrait: String
): boolean {
  const concreteLocation = match (
    inferredTypeSymbolLocation(modules, moduleIndex, concreteType)
  ) {
    some(location) => location;
    none => return false;
  };
  const traitLocation = match (
    inferredTypeSymbolLocation(modules, moduleIndex, requiredTrait)
  ) {
    some(location) => location;
    none => return false;
  };
  if (
    modules[traitLocation.moduleIndex].symbols[traitLocation.symbolIndex].kind
    != ModuleSymbolKind.traitSymbol
  ) return false;
  return match (
    in modules[concreteLocation.moduleIndex].symbols[concreteLocation.symbolIndex].typeSignature
  ) {
    some(signature) => {
      let satisfied = false;
      for (const implemented of signature.implementedTraits) {
        match (typeSymbolLocation(modules, concreteLocation.moduleIndex, implemented)) {
          some(location) => {
            if (
              symbolTypeIdentity(modules, location)
              == symbolTypeIdentity(modules, traitLocation)
            ) satisfied = true;
          }
          none => {}
        }
      }
      select satisfied;
    }
    none => false;
  };
}
