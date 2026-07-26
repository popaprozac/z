import { Map, Set } from "std/collections";
import {
  Declaration,
  DeclarationKind,
  ImportDeclaration,
  Program,
} from "./parser.zs";
import {
  importedModulePath,
  isLocalModuleHeader,
} from "./module-paths.zs";
import {
  declarationSymbolKind,
  programFunctionSignature,
  programTypeSignature,
} from "./module-signatures.zs";
import {
  ModuleFunctionSignature,
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSymbol,
  ModuleSymbolKind,
  ModuleTypeSignature,
  ResolvedModule,
  moduleResolutionError,
} from "./semantic-model.zs";

export struct ParsedModule {
  path: String;
  program: Program;
}

export function findModule(
  in modules: Array<ParsedModule>,
  in path: String
): Option<usize> {
  let index: usize = 0;
  while (index < modules.length) {
    if (modules[index].path == path) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function hasExport(in declaration: Declaration, in name: String): boolean {
  return declaration.exported && declaration.name == name;
}

export function moduleExports(in module: ParsedModule, in name: String): boolean {
  for (const declaration of module.program.declarations) {
    if (hasExport(declaration, name)) return true;
  }
  return false;
}

function ownSymbol(in module: ParsedModule, in declaration: Declaration): ModuleSymbol {
  let importedName = declaration.name.copyBytes(0, declaration.name.byteLength);
  if (declaration.kind == DeclarationKind.typeAliasDeclaration) {
    for (const alias of module.program.typeAliases) {
      if (alias.name != declaration.name) continue;
      importedName = alias.target.name.copyBytes(0, alias.target.name.byteLength);
    }
  }
  return ModuleSymbol({
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
    kind: declarationSymbolKind(declaration.kind),
    exported: declaration.exported,
    targetModule: Option<usize>.none,
    importedName,
    functionSignature: programFunctionSignature(module.program, declaration),
    typeSignature: programTypeSignature(module.program, declaration),
    offset: declaration.offset,
    line: declaration.line,
    column: declaration.column,
  });
}

function importedSymbol(
  in name: String,
  in importedName: String,
  kind: ModuleSymbolKind,
  targetModule: Option<usize>,
  offset: usize,
  line: usize,
  column: usize
): ModuleSymbol {
  return ModuleSymbol({
    name: name.copyBytes(0, name.byteLength),
    kind,
    exported: false,
    targetModule,
    importedName: importedName.copyBytes(0, importedName.byteLength),
    functionSignature: Option<ModuleFunctionSignature>.none,
    typeSignature: Option<ModuleTypeSignature>.none,
    offset,
    line,
    column,
  });
}

function importTarget(
  in modules: Array<ParsedModule>,
  in module: ParsedModule,
  in declaration: ImportDeclaration
): Option<usize> {
  if (!isLocalModuleHeader(declaration.header)) return Option<usize>.none;
  const targetPath = importedModulePath(module.path, declaration.header);
  return findModule(modules, targetPath);
}

export function buildModuleSymbols(
  in modules: Array<ParsedModule>,
  in module: ParsedModule
): Array<ModuleSymbol> {
  let symbols = Array<ModuleSymbol>();
  for (const declaration of module.program.declarations) {
    if (declaration.kind == DeclarationKind.importDeclaration) continue;
    symbols.push(ownSymbol(module, declaration));
  }
  for (const declaration of module.program.imports) {
    const target = importTarget(modules, module, declaration);
    if (declaration.selective) {
      for (const binding of declaration.bindings) {
        const offset = binding.offset;
        const line = binding.line;
        const column = binding.column;
        symbols.push(importedSymbol(
          binding.localName,
          binding.importedName,
          ModuleSymbolKind.importedSymbol,
          target,
          offset,
          line,
          column
        ));
      }
    } else {
      const name = moduleBindingName(declaration);
      const offset = declaration.offset;
      const line = declaration.line;
      const column = declaration.column;
      symbols.push(importedSymbol(
        name,
        declaration.header,
        ModuleSymbolKind.namespaceSymbol,
        target,
        offset,
        line,
        column
      ));
    }
  }
  return symbols;
}

export function moduleSymbolKindName(kind: ModuleSymbolKind): String {
  if (kind == ModuleSymbolKind.functionSymbol) return "function";
  if (kind == ModuleSymbolKind.structSymbol) return "struct";
  if (kind == ModuleSymbolKind.classSymbol) return "class";
  if (kind == ModuleSymbolKind.traitSymbol) return "trait";
  if (kind == ModuleSymbolKind.typeAliasSymbol) return "type";
  if (kind == ModuleSymbolKind.enumSymbol) return "enum";
  if (kind == ModuleSymbolKind.namespaceSymbol) return "namespace";
  return "imported";
}

export function moduleBindingName(in declaration: ImportDeclaration): String {
  return declaration.moduleName.copyBytes(0, declaration.moduleName.byteLength);
}

function requireAvailableBinding(
  inout occupied: Set<String>,
  in path: String,
  in name: String,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  if (occupied.has(name)) throw moduleResolutionError(
    ModuleResolveErrorKind.duplicateBinding,
    path,
    `duplicate module binding ${name}`,
    line,
    column
  );
  occupied.add(name.copyBytes(0, name.byteLength));
}

export function validateModuleBindings(
  in module: ParsedModule
): void throws ModuleResolveError {
  let occupied = Set<String>();
  for (const declaration of module.program.declarations) {
    if (declaration.kind == DeclarationKind.importDeclaration) continue;
    const line = declaration.line;
    const column = declaration.column;
    try requireAvailableBinding(
      inout occupied,
      module.path,
      declaration.name,
      line,
      column
    );
  }
  for (const declaration of module.program.imports) {
    if (declaration.selective) {
      for (const binding of declaration.bindings) {
        const line = binding.line;
        const column = binding.column;
        try requireAvailableBinding(
          inout occupied,
          module.path,
          binding.localName,
          line,
          column
        );
      }
    } else {
      const name = moduleBindingName(declaration);
      const line = declaration.line;
      const column = declaration.column;
      try requireAvailableBinding(
        inout occupied,
        module.path,
        name,
        line,
        column
      );
    }
  }
}

export function buildModuleSymbolIndices(
  in symbols: Array<ModuleSymbol>
): Map<String, usize> {
  let indices = Map<String, usize>();
  let index: usize = 0;
  while (index < symbols.length) {
    indices.set(
      symbols[index].name.copyBytes(0, symbols[index].name.byteLength),
      index
    );
    index = index + 1;
  }
  return indices;
}

export function moduleSymbolIndex(in module: ResolvedModule, in name: String): usize {
  const found = module.symbolIndices.get(name);
  match (in found) {
    some(index) => return index;
    none => return module.symbols.length;
  }
}
