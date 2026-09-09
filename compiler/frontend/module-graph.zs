import { tokenize } from "./lexer.zs";
import { Arena } from "std/memory";
import {
  parseProgram,
} from "./parser.zs";
import {
  isLocalModuleHeader,
  normalizedModulePath,
} from "./module-paths.zs";
import {
  ParsedModule,
  ParsedModuleBatch,
  buildModuleSymbolIndices,
  buildModuleSymbols,
  findModule,
  importTarget,
  moduleExports,
  moduleHasInternal,
  validateModuleBindings,
} from "./module-symbols.zs";
import {
  ModuleBindingResolution,
  ModuleCallResolution,
  ModuleExpressionResolution,
  ModuleForeignUnionMatch,
  ModuleObjCAdapterResolution,
  ModuleObjCRegistrationResolution,
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSemanticEvidence,
  ModuleSource,
  ResolvedModule,
  moduleResolutionError,
} from "./semantic-model.zs";

export function parseModule(
  in source: ModuleSource
): ParsedModule throws ModuleResolveError {
  const tokenOutcome = attempt tokenize(source.source);
  const tokens = match (tokenOutcome) {
    success(tokens) => tokens;
    failure(error) => {
      const line = error.line;
      const column = error.column;
      throw moduleResolutionError(
        ModuleResolveErrorKind.lexer,
        source.path,
        error.message,
        line,
        column
      );
    }
  };
  const programOutcome = attempt parseProgram(tokens);
  const program = match (programOutcome) {
    success(program) => program;
    failure(error) => {
      const line = error.line;
      const column = error.column;
      throw moduleResolutionError(
        ModuleResolveErrorKind.parser,
        source.path,
        error.message,
        line,
        column
      );
    }
  };
  const module = ParsedModule({
    path: source.path.copyBytes(0, source.path.byteLength),
    packageIdentity: source.packageIdentity.copyBytes(0, source.packageIdentity.byteLength),
    packageSpecifiers: copy source.packageSpecifiers,
    program,
  });
  if (module.packageIdentity.byteLength == 0) {
    for (const declaration of module.program.declarations) {
      if (!declaration.packageVisible) continue;
      throw moduleResolutionError(
        ModuleResolveErrorKind.missingExport,
        module.path,
        `internal declaration ${declaration.name} requires a manifest-defined package identity`,
        declaration.line,
        declaration.column
      );
    }
  }
  try validateModuleBindings(module);
  return module;
}

export function parseModuleSources(
  in sources: Array<ModuleSource>
): ParsedModuleBatch throws ModuleResolveError {
  let parsed = Array<ParsedModule>();
  for (const source of sources) {
    const module = try parseModule(source);
    parsed.push(module);
  }
  let arena = Arena();
  const storedModules = arena.create(move parsed);
  return ParsedModuleBatch({
    arena: move arena,
    modules: storedModules,
  });
}

export function findEntryModule(
  in modules: Array<ParsedModule>,
  in entryPath: String
): usize throws ModuleResolveError {
  const normalizedEntry = normalizedModulePath(entryPath);
  const entryOption = findModule(modules, normalizedEntry);
  return match (entryOption) {
    some(entry) => entry;
    none => throw moduleResolutionError(
      ModuleResolveErrorKind.missingModule,
      normalizedEntry,
      `could not find entry Z module ${normalizedEntry}`,
      1,
      1
    );
  };
}

function resolveDependencies(
  in modules: Array<ParsedModule>,
  in module: ParsedModule
): Array<usize> throws ModuleResolveError {
  let dependencies = Array<usize>();
  for (const declaration of module.program.imports) {
    const target = importTarget(modules, module, declaration);
    const dependency = match (target) {
      some(dependency) => dependency;
      none => {
        if (!isLocalModuleHeader(declaration.header)) continue;
        const line = declaration.line;
        const column = declaration.column;
        throw moduleResolutionError(
          ModuleResolveErrorKind.missingModule,
          module.path,
          `could not find Z module ${declaration.header}`,
          line,
          column
        );
      }
    };
    if (declaration.selective) {
      for (const binding of declaration.bindings) {
        if (!moduleExports(
          modules[dependency],
          binding.importedName,
          module.packageIdentity
        )) {
          const line = binding.line;
          const column = binding.column;
          if (moduleHasInternal(modules[dependency], binding.importedName)) {
            throw moduleResolutionError(
              ModuleResolveErrorKind.missingExport,
              module.path,
              `declaration ${binding.importedName} is internal to its package`,
              line,
              column
            );
          }
          throw moduleResolutionError(
            ModuleResolveErrorKind.missingExport,
            module.path,
            `module ${declaration.header} has no export ${binding.importedName}`,
            line,
            column
          );
        }
      }
    }
    dependencies.push(dependency);
  }
  return dependencies;
}

export function buildResolvedModules(
  in parsed: Array<ParsedModule>
): Array<ResolvedModule> throws ModuleResolveError {
  let modules = Array<ResolvedModule>();
  let index: usize = 0;
  while (index < parsed.length) {
    const dependencies = try resolveDependencies(parsed, parsed[index]);
    const symbols = buildModuleSymbols(parsed, parsed[index]);
    const symbolIndices = buildModuleSymbolIndices(symbols);
    modules.push(ResolvedModule({
      path: parsed[index].path.copyBytes(0, parsed[index].path.byteLength),
      packageIdentity: parsed[index].packageIdentity.copyBytes(0, parsed[index].packageIdentity.byteLength),
      dependencies,
      symbols,
      symbolIndices,
      semanticEvidence: ModuleSemanticEvidence({
        callResolutions: Array<ModuleCallResolution>(),
        bindingResolutions: Array<ModuleBindingResolution>(),
        expressionResolutions: Array<ModuleExpressionResolution>(),
        foreignUnionMatches: Array<ModuleForeignUnionMatch>(),
        objectiveCRegistrations: Array<ModuleObjCRegistrationResolution>(),
        objectiveCAdapters: Array<ModuleObjCAdapterResolution>(),
      }),
    }));
    index = index + 1;
  }
  return modules;
}

function visitModule(
  index: usize,
  in parsed: Array<ParsedModule>,
  in modules: Array<ResolvedModule>,
  inout states: Array<u8>,
  inout order: Array<usize>
): void throws ModuleResolveError {
  if (states[index] == 2) return;
  if (states[index] == 1) throw moduleResolutionError(
    ModuleResolveErrorKind.circularImport,
    modules[index].path,
    `circular Z module import through ${modules[index].path}`,
    1,
    1
  );
  states[index] = 1;
  for (const declaration of parsed[index].program.imports) {
    if (declaration.generatedAdapterLink) continue;
    const target = importTarget(parsed, parsed[index], declaration);
    match (target) {
      some(dependency) => {
        try visitModule(dependency, parsed, modules, inout states, inout order);
      }
      none => {}
    }
  }
  states[index] = 2;
  order.push(index);
}

export function resolveModuleOrder(
  in parsed: Array<ParsedModule>,
  in modules: Array<ResolvedModule>,
  entry: usize
): Array<usize> throws ModuleResolveError {
  let states = Array<u8>();
  let index: usize = 0;
  while (index < modules.length) {
    states.push(0);
    index = index + 1;
  }
  let dependencyOrder = Array<usize>();
  try visitModule(entry, parsed, modules, inout states, inout dependencyOrder);
  // Include generated function roots without making them initialization edges
  // back from the caller. Each root's authored imports remain a checked DAG.
  let orderedIndex: usize = 0;
  while (orderedIndex < dependencyOrder.length) {
    const moduleIndex = dependencyOrder[orderedIndex];
    for (const declaration of parsed[moduleIndex].program.imports) {
      if (!declaration.generatedAdapterLink) continue;
      const target = importTarget(parsed, parsed[moduleIndex], declaration);
      match (target) {
        some(dependency) => {
          try visitModule(dependency, parsed, modules, inout states, inout dependencyOrder);
        }
        none => {}
      }
    }
    orderedIndex = orderedIndex + 1;
  }
  return dependencyOrder;
}
