import { TextBuffer } from "std/text";
import { moduleSymbolIndex } from "./module-symbols.zs";
import {
  fixedArrayShape,
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

function exportedTypeLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): Option<ModuleSymbolLocation> {
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], name);
  if (
    symbolIndex < modules[moduleIndex].symbols.length
    && modules[moduleIndex].symbols[symbolIndex].exported
    && isTypeSymbolKind(modules[moduleIndex].symbols[symbolIndex].kind)
  ) return Option.some(ModuleSymbolLocation({ moduleIndex, symbolIndex }));
  return Option<ModuleSymbolLocation>.none;
}

export function typeSymbolLocation(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in sourceType: String
): Option<ModuleSymbolLocation> {
  let typeName = sourceType.copyBytes(0, sourceType.byteLength);
  match (genericTypeShape(sourceType)) {
    some(generic) => typeName = generic.base.copyBytes(0, generic.base.byteLength);
    none => {}
  }
  const base = qualifiedTypeBase(typeName);
  const member = qualifiedTypeMember(typeName);
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], base);
  if (symbolIndex < modules[moduleIndex].symbols.length) {
    if (member.byteLength > 0) {
      if (modules[moduleIndex].symbols[symbolIndex].kind != ModuleSymbolKind.namespaceSymbol) {
        return Option<ModuleSymbolLocation>.none;
      }
      return match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
        some(target) => exportedTypeLocation(modules, target, member);
        none => Option<ModuleSymbolLocation>.none;
      };
    }
    if (isTypeSymbolKind(modules[moduleIndex].symbols[symbolIndex].kind)) {
      return Option.some(ModuleSymbolLocation({ moduleIndex, symbolIndex }));
    }
    if (modules[moduleIndex].symbols[symbolIndex].kind == ModuleSymbolKind.importedSymbol) {
      const importedName = modules[moduleIndex].symbols[symbolIndex].importedName.copyBytes(
        0,
        modules[moduleIndex].symbols[symbolIndex].importedName.byteLength
      );
      return match (in modules[moduleIndex].symbols[symbolIndex].targetModule) {
        some(target) => exportedTypeLocation(modules, target, importedName);
        none => Option<ModuleSymbolLocation>.none;
      };
    }
    return Option<ModuleSymbolLocation>.none;
  }
  return Option<ModuleSymbolLocation>.none;
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
  match (genericTypeShape(typeName)) {
    some(generic) => {
      match (typeSymbolLocation(modules, moduleIndex, generic.base)) {
        some(location) => identities.push(ModuleTypeIdentity({
          path: path.copyBytes(0, path.byteLength),
          targetModuleIndex: location.moduleIndex,
          targetSymbolIndex: location.symbolIndex,
        }));
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
      return;
    }
    none => {}
  }
  match (typeSymbolLocation(modules, moduleIndex, typeName)) {
    some(location) => identities.push(ModuleTypeIdentity({
      path: path.copyBytes(0, path.byteLength),
      targetModuleIndex: location.moduleIndex,
      targetSymbolIndex: location.symbolIndex,
    }));
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
  return targetName;
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

export function transparentTypeName(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in name: String
): String {
  return match (typeSymbolLocation(modules, moduleIndex, name)) {
    some(location) => {
      if (
        modules[location.moduleIndex].symbols[location.symbolIndex].kind
        != ModuleSymbolKind.typeAliasSymbol
      ) {
        return name.copyBytes(0, name.byteLength);
      }
      const target = rebaseTypeName(
        modules,
        location.moduleIndex,
        moduleIndex,
        modules[location.moduleIndex].symbols[location.symbolIndex].importedName
      );
      if (target == name) return target;
      return transparentTypeName(modules, moduleIndex, target);
    }
    none => name.copyBytes(0, name.byteLength);
  };
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
  match (fixedArrayShape(name)) {
    some(array) => {
      const identity = semanticTypeIdentity(modules, moduleIndex, array.elementType);
      return `${identity}[${array.length}]`;
    }
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      let base = generic.base.copyBytes(0, generic.base.byteLength);
      match (typeSymbolLocation(modules, moduleIndex, generic.base)) {
        some(location) => base = `@${location.moduleIndex}:${location.symbolIndex}`;
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
    some(location) => `@${location.moduleIndex}:${location.symbolIndex}`;
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
  const concreteLocation = match (typeSymbolLocation(modules, moduleIndex, concreteType)) {
    some(location) => location;
    none => return false;
  };
  const traitLocation = match (typeSymbolLocation(modules, moduleIndex, requiredTrait)) {
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
              location.moduleIndex == traitLocation.moduleIndex
              && location.symbolIndex == traitLocation.symbolIndex
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
