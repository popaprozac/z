import { Map, Set } from "std/collections";
import { Arena } from "std/memory";
import {
  Declaration,
  DeclarationKind,
  ExpressionKind,
  ExpressionTree,
  ImportDeclaration,
  Program,
} from "./parser.zs";
import {
  importedModulePath,
  isLocalModuleHeader,
  sourceStandardModulePathMatches,
} from "./module-paths.zs";
import {
  declarationSymbolKind,
  programFunctionSignature,
  programTypeSignature,
} from "./module-signatures.zs";
import {
  ModuleForeignArgument,
  ModuleFunctionSignature,
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSymbol,
  ModuleSymbolKind,
  ModuleTypeSignature,
  ResolvedModule,
  moduleResolutionError,
} from "./semantic-model.zs";
import { genericTypeShape } from "./semantic-type-shapes.zs";

export struct ParsedModule {
  path: String;
  packageIdentity: String;
  targetPlatform: String = "";
  targetMinimumVersion: String = "";
  packageSpecifiers: Array<String>;
  program: Program;
}

export readonly struct ParsedModuleBatch {
  arena: Arena;
  modules: view Array<ParsedModule>;
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

function hasVisibleDeclaration(
  in declaration: Declaration,
  in name: String,
  in ownerPackageIdentity: String,
  in requesterPackageIdentity: String
): boolean {
  if (declaration.name != name) return false;
  if (declaration.exported) return true;
  return declaration.packageVisible
    && ownerPackageIdentity.byteLength > 0
    && ownerPackageIdentity == requesterPackageIdentity;
}

export function moduleExports(
  in module: ParsedModule,
  in name: String,
  in requesterPackageIdentity: String
): boolean {
  for (const declaration of module.program.declarations) {
    if (hasVisibleDeclaration(
      declaration,
      name,
      module.packageIdentity,
      requesterPackageIdentity
    )) return true;
  }
  return false;
}

export function moduleHasInternal(
  in module: ParsedModule,
  in name: String
): boolean {
  for (const declaration of module.program.declarations) {
    if (declaration.name == name && declaration.packageVisible) return true;
  }
  return false;
}

function moduleNumericLiteralType(in value: String): String {
  let index: usize = 0;
  while (index < value.byteLength) {
    const byte = value.byteAt(index);
    if (byte == 46 || byte == 69 || byte == 101) return "f64";
    index = index + 1;
  }
  return "i32";
}

function ownSymbol(in module: ParsedModule, in declaration: Declaration): ModuleSymbol {
  let importedName = declaration.name.copyBytes(0, declaration.name.byteLength);
  let valueType = "";
  let nativeCExport = false;
  if (declaration.kind == DeclarationKind.functionDeclaration) {
    for (const functionDeclaration of module.program.functions) {
      if (functionDeclaration.name != declaration.name) continue;
      nativeCExport = functionDeclaration.nativeCExport;
    }
  }
  if (declaration.kind == DeclarationKind.typeAliasDeclaration) {
    for (const alias of module.program.typeAliases) {
      if (alias.name != declaration.name) continue;
      importedName = alias.target.name.copyBytes(0, alias.target.name.byteLength);
    }
  }
  if (declaration.kind == DeclarationKind.constantDeclaration) {
    for (const constant of module.program.constants) {
      if (constant.name != declaration.name) continue;
      match (in constant.typeAnnotation) {
        some(type) => valueType = type.name.copyBytes(0, type.name.byteLength);
        none => {
          match (in constant.initializer.tree) {
            some(tree) => {
              const root = view tree.nodes[tree.root];
              if (embedBytesInitializer(module, tree)) valueType = "embed.StaticBytes";
              else if (root.kind == ExpressionKind.stringExpression) valueType = "String";
              else if (root.kind == ExpressionKind.booleanExpression) valueType = "boolean";
              else if (root.kind == ExpressionKind.numberExpression) {
                valueType = moduleNumericLiteralType(root.value);
              } else if (
                root.kind == ExpressionKind.unaryExpression
                && root.children.length == 1
              ) {
                valueType = moduleNumericLiteralType(
                  tree.nodes[root.children[0]].value
                );
              } else if (
                root.kind == ExpressionKind.callExpression
                && root.children.length == 1
                && tree.nodes[root.children[0]].kind
                  == ExpressionKind.identifierExpression
              ) {
                match (genericTypeShape(
                  tree.nodes[root.children[0]].value
                )) {
                  some(generic) => {
                    if (
                      generic.base == "Once"
                      && generic.arguments.length == 1
                    ) valueType = tree.nodes[root.children[0]].value.copyBytes(
                      0,
                      tree.nodes[root.children[0]].value.byteLength
                    );
                  }
                  none => {}
                }
              }
            }
            none => {}
          }
        }
      }
    }
  }
  return ModuleSymbol({
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
    kind: declarationSymbolKind(declaration.kind),
    exported: declaration.exported,
    packageVisible: declaration.packageVisible,
    nativeCExport,
    targetModule: Option<usize>.none,
    importedName,
    valueType,
    functionSignature: programFunctionSignature(module.program, declaration),
    typeSignature: programTypeSignature(module.program, declaration),
    foreignHeader: "",
    foreignSuccessValues: Array<String>(),
    foreignArguments: Array<ModuleForeignArgument>(),
    offset: declaration.offset,
    line: declaration.line,
    column: declaration.column,
  });
}

export function embedBytesInitializer(
  in module: ParsedModule,
  in tree: ExpressionTree
): boolean {
  const root = view tree.nodes[tree.root];
  if (root.kind != ExpressionKind.callExpression || root.children.length != 2) return false;
  const callee = root.children[0];
  if (
    tree.nodes[callee].kind != ExpressionKind.memberExpression
    || tree.nodes[callee].value != "bytes"
    || tree.nodes[callee].children.length != 1
  ) return false;
  const owner = tree.nodes[callee].children[0];
  if (tree.nodes[owner].kind != ExpressionKind.identifierExpression) return false;
  for (const declaration of module.program.imports) {
    if (
      declaration.header == "std/embed"
      && !declaration.selective
      && declaration.moduleName == tree.nodes[owner].value
    ) return tree.nodes[root.children[1]].kind == ExpressionKind.stringExpression;
  }
  return false;
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
    packageVisible: false,
    nativeCExport: false,
    targetModule,
    importedName: importedName.copyBytes(0, importedName.byteLength),
    valueType: "",
    functionSignature: Option<ModuleFunctionSignature>.none,
    typeSignature: Option<ModuleTypeSignature>.none,
    foreignHeader: "",
    foreignSuccessValues: Array<String>(),
    foreignArguments: Array<ModuleForeignArgument>(),
    offset,
    line,
    column,
  });
}

export function importTarget(
  in modules: Array<ParsedModule>,
  in module: ParsedModule,
  in declaration: ImportDeclaration
): Option<usize> {
  if (isLocalModuleHeader(declaration.header)) {
    const targetPath = importedModulePath(module.path, declaration.header);
    return findModule(modules, targetPath);
  }
  let index: usize = 0;
  while (index < modules.length) {
    if (sourceStandardModulePathMatches(
      modules[index].path,
      declaration.header
    )) return Option.some(index);
    for (const specifier of modules[index].packageSpecifiers) {
      if (specifier == declaration.header) return Option.some(index);
    }
    index = index + 1;
  }
  return Option<usize>.none;
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
        let symbol = importedSymbol(
          binding.localName,
          binding.importedName,
          ModuleSymbolKind.importedSymbol,
          target,
          offset,
          line,
          column
        );
        if (declaration.header == "std/channel") {
          symbol.standardTypeName = copy binding.importedName;
        }
        if (declaration.header == "std/text" && binding.importedName == "Utf8Error") {
          symbol.standardTypeName = "__z_std_text_Utf8Error";
        }
        symbols.push(move symbol);
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
  if (kind == ModuleSymbolKind.constantSymbol) return "const";
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
