import {
  NativeForeignContractSet,
  NativeForeignFunctionContract,
  NativeForeignTypeContract,
} from "./foreign-contracts.zs";
import {
  ParsedModule,
  buildModuleSymbolIndices,
  moduleBindingName,
  moduleSymbolIndex,
} from "./module-symbols.zs";
import {
  ModuleFunctionSignature,
  ModuleFieldSignature,
  ModuleMethodSignature,
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

// Trusted native callable facts are attached only after raw declarations and
// .zd contracts have been normalized. The resolver never consumes ZFDCL wire
// records or unverified contract syntax directly.

export struct NativeForeignModuleContract {
  modulePath: String;
  cacheKey: String;
  contracts: NativeForeignContractSet;
}

function foreignFunctionIndex(
  in contracts: NativeForeignContractSet,
  in name: String
): Option<usize> {
  let index: usize = 0;
  while (index < contracts.functions.length) {
    if (
      contracts.functions[index].name == name
    ) return Option<usize>.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function foreignConstantIndex(
  in contracts: NativeForeignContractSet,
  in name: String
): Option<usize> {
  let index: usize = 0;
  while (index < contracts.constants.length) {
    if (contracts.constants[index].name == name) {
      return Option<usize>.some(index);
    }
    index = index + 1;
  }
  return Option<usize>.none;
}

function foreignTypeIndex(
  in contracts: NativeForeignContractSet,
  in name: String
): Option<usize> {
  let index: usize = 0;
  while (index < contracts.types.length) {
    if (contracts.types[index].name == name) {
      return Option<usize>.some(index);
    }
    index = index + 1;
  }
  return Option<usize>.none;
}

function localForeignTypeName(
  in types: Array<NativeForeignTypeContract>,
  in namespace: String,
  in typeName: String
): String {
  for (const type of types) {
    if (type.name == typeName) return `${namespace}.${type.name}`;
  }
  return typeName.copyBytes(0, typeName.byteLength);
}

function foreignFunctionSignature(
  in contract: NativeForeignFunctionContract,
  in types: Array<NativeForeignTypeContract>,
  in namespace: String
): ModuleFunctionSignature {
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  for (const parameter of contract.parameters) {
    parameterModes.push("value");
    parameterTypes.push(
      localForeignTypeName(types, namespace, parameter.typeName)
    );
  }
  let errorType = "";
  match (in contract.errorType) {
    some(typeName) => {
      errorType = localForeignTypeName(types, namespace, typeName);
    }
    none => {}
  }
  return ModuleFunctionSignature({
    asynchronous: false,
    executorAffinity: "",
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    parameterModes,
    parameterTypes,
    returnType: contract.returnType.copyBytes(
      0,
      contract.returnType.byteLength
    ),
    errorType,
  });
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
  in namespace: String,
  in localName: String,
  in importedName: String,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  const contractIndex = match (foreignFunctionIndex(contracts, importedName)) {
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
        contracts.types,
        namespace
      )
    );
  modules[moduleIndex].symbols[symbolIndex].foreignHeader =
    contracts.moduleSpecifier.copyBytes(
      0,
      contracts.moduleSpecifier.byteLength
    );
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
  in namespace: String,
  offset: usize,
  line: usize,
  column: usize
): void {
  for (const contract of contracts.functions) {
    const name = `${namespace}.${contract.name}`;
    const symbolIndex = modules[moduleIndex].symbols.length;
    let successValues = Array<String>();
    for (const successValue of contract.successValues) {
      successValues.push(
        successValue.copyBytes(0, successValue.byteLength)
      );
    }
    modules[moduleIndex].symbols.push(ModuleSymbol({
      name: name.copyBytes(0, name.byteLength),
      kind: ModuleSymbolKind.importedSymbol,
      exported: false,
      nativeCExport: false,
      targetModule: Option<usize>.none,
      importedName: contract.nativeName.copyBytes(
        0,
        contract.nativeName.byteLength
      ),
      valueType: "",
      functionSignature: Option<ModuleFunctionSignature>.some(
        foreignFunctionSignature(contract, contracts.types, namespace)
      ),
      typeSignature: Option<ModuleTypeSignature>.none,
      foreignHeader: contracts.moduleSpecifier.copyBytes(
        0,
        contracts.moduleSpecifier.byteLength
      ),
      foreignSuccessValues: successValues,
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
      nativeCExport: false,
      targetModule: Option<usize>.none,
      importedName: contract.nativeName.copyBytes(
        0,
        contract.nativeName.byteLength
      ),
      valueType: localForeignTypeName(
        contracts.types,
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
  in type: NativeForeignTypeContract
): ModuleTypeSignature {
  return ModuleTypeSignature({
    nativeCName: "",
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    executorAffinity: "",
    implementedTraits: Array<String>(),
    fields: Array<ModuleFieldSignature>(),
    methods: Array<ModuleMethodSignature>(),
    variants: Array<ModuleVariantSignature>(),
    customDeinit: false,
    customConstructor: false,
    constructorSignature: Option<ModuleFunctionSignature>.none,
    foreignNativeName: type.nativeName.copyBytes(
      0,
      type.nativeName.byteLength
    ),
    foreignUnderlyingType: type.underlyingType.copyBytes(
      0,
      type.underlyingType.byteLength
    ),
  });
}

function attachForeignTypes(
  moduleIndex: usize,
  inout modules: Array<ResolvedModule>,
  in contracts: NativeForeignContractSet,
  in namespace: String,
  offset: usize,
  line: usize,
  column: usize
): void {
  if (moduleSymbolIndex(modules[moduleIndex], namespace) >= modules[moduleIndex].symbols.length) {
    modules[moduleIndex].symbols.push(ModuleSymbol({
      name: namespace.copyBytes(0, namespace.byteLength),
      kind: ModuleSymbolKind.namespaceSymbol,
      exported: false,
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
      offset,
      line,
      column,
    }));
  }
  for (const type of contracts.types) {
    const name = `${namespace}.${type.name}`;
    if (moduleSymbolIndex(modules[moduleIndex], name) < modules[moduleIndex].symbols.length) {
      continue;
    }
    modules[moduleIndex].symbols.push(ModuleSymbol({
      name,
      kind: ModuleSymbolKind.enumSymbol,
      exported: false,
      nativeCExport: false,
      targetModule: Option<usize>.none,
      importedName: type.nativeName.copyBytes(0, type.nativeName.byteLength),
      valueType: "",
      functionSignature: Option<ModuleFunctionSignature>.none,
      typeSignature: Option<ModuleTypeSignature>.some(
        foreignTypeSignature(type)
      ),
      foreignHeader: contracts.moduleSpecifier.copyBytes(
        0,
        contracts.moduleSpecifier.byteLength
      ),
      foreignSuccessValues: Array<String>(),
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
  modules[moduleIndex].symbols[symbolIndex].valueType = localForeignTypeName(
    contracts.types,
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
  in localName: String,
  typeIndex: usize
): void {
  const symbolIndex = moduleSymbolIndex(modules[moduleIndex], localName);
  modules[moduleIndex].symbols[symbolIndex].kind =
    ModuleSymbolKind.enumSymbol;
  modules[moduleIndex].symbols[symbolIndex].importedName =
    contracts.types[typeIndex].nativeName.copyBytes(
      0,
      contracts.types[typeIndex].nativeName.byteLength
    );
  modules[moduleIndex].symbols[symbolIndex].valueType = "";
  modules[moduleIndex].symbols[symbolIndex].typeSignature =
    Option<ModuleTypeSignature>.some(
      foreignTypeSignature(contracts.types[typeIndex])
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
  inout modules: Array<ResolvedModule>
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
    attachForeignTypes(
      moduleIndex,
      inout modules,
      binding.contracts,
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
        match (foreignFunctionIndex(binding.contracts, importedName)) {
          some(_) => try attachSelectiveFunction(
            parsed[moduleIndex],
            moduleIndex,
            inout modules,
            binding.contracts,
            namespace,
            localName,
            importedName,
            line,
            column
          );
          none => match (foreignConstantIndex(
            binding.contracts,
            importedName
          )) {
            some(index) => attachSelectiveConstant(
              moduleIndex,
              inout modules,
              binding.contracts,
              namespace,
              localName,
              index
            );
            none => match (foreignTypeIndex(
              binding.contracts,
              importedName
            )) {
              some(index) => attachSelectiveType(
                moduleIndex,
                inout modules,
                binding.contracts,
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
    } else {
      attachNamespaceFunctions(
        moduleIndex,
        inout modules,
        binding.contracts,
        namespace,
        declaration.offset,
        declaration.line,
        declaration.column
      );
      attachNamespaceConstants(
        moduleIndex,
        inout modules,
        binding.contracts,
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
  for (const binding of contracts) {
    try attachModuleContract(parsed, binding, inout modules);
  }
}
