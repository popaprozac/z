import { TextBuffer } from "std/text";
import { tokenize } from "./lexer.zs";
import { Declaration, DeclarationKind, ImportDeclaration, Program, parseProgram } from "./parser.zs";

export struct ModuleSource {
  path: String;
  source: String;
}

export enum ModuleResolveErrorKind {
  lexer,
  parser,
  missingModule,
  circularImport,
  missingExport,
  duplicateBinding,
}

export struct ModuleResolveError {
  kind: ModuleResolveErrorKind;
  path: String;
  message: String;
  line: usize;
  column: usize;
}

struct ParsedModule {
  path: String;
  program: Program;
}

export struct ResolvedModule {
  path: String;
  dependencies: Array<usize>;
}

export struct ModuleGraph {
  modules: Array<ResolvedModule>;
  dependencyOrder: Array<usize>;
  entry: usize;
}

function resolutionError(
  kind: ModuleResolveErrorKind,
  in path: String,
  in message: String,
  line: usize,
  column: usize
): ModuleResolveError {
  return ModuleResolveError({
    kind,
    path: path.copyBytes(0, path.byteLength),
    message: message.copyBytes(0, message.byteLength),
    line,
    column,
  });
}

function parseModule(in source: ModuleSource): ParsedModule throws ModuleResolveError {
  const tokenOutcome = attempt tokenize(source.source);
  const tokens = match (tokenOutcome) {
    success(tokens) => tokens;
    failure(error) => {
      const line = error.line;
      const column = error.column;
      throw resolutionError(
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
      throw resolutionError(
        ModuleResolveErrorKind.parser,
        source.path,
        error.message,
        line,
        column
      );
    }
  };
  return ParsedModule({
    path: source.path.copyBytes(0, source.path.byteLength),
    program,
  });
}

function isSlash(byte: u8): boolean {
  return byte == 47 || byte == 92;
}

function isLocalHeader(in header: String): boolean {
  const relative = header.byteLength >= 2
    && header.byteAt(0) == 46
    && (
      isSlash(header.byteAt(1))
      || (
        header.byteLength >= 3
        && header.byteAt(1) == 46
        && isSlash(header.byteAt(2))
      )
    );
  if (!relative || header.byteLength < 3) return false;
  return header.byteAt(header.byteLength - 3) == 46
    && header.byteAt(header.byteLength - 2) == 122
    && header.byteAt(header.byteLength - 1) == 115;
}

function directoryName(in path: String): String {
  let index = path.byteLength;
  while (index > 0) {
    index = index - 1;
    if (!isSlash(path.byteAt(index))) continue;
    if (index == 0) return "/";
    return path.copyBytes(0, index);
  }
  return ".";
}

function storeSegment(
  inout segments: Array<String>,
  count: usize,
  segment: String
): void {
  if (count < segments.length) segments[count] = segment;
  else segments.push(segment);
}

function normalizedPath(in path: String): String {
  let segments = Array<String>();
  let count: usize = 0;
  const absolute = path.byteLength > 0 && isSlash(path.byteAt(0));
  let start: usize = 0;
  let current: usize = 0;
  while (current <= path.byteLength) {
    const boundary = current == path.byteLength || isSlash(path.byteAt(current));
    if (!boundary) {
      current = current + 1;
      continue;
    }
    if (current > start) {
      const segment = path.copyBytes(start, current);
      if (segment == ".") {
      } else if (segment == "..") {
        let floor: usize = 0;
        if (
          count > 0
          && segments[0].byteLength == 2
          && segments[0].byteAt(1) == 58
        ) floor = 1;
        if (count > floor) count = count - 1;
        else if (!absolute) {
          storeSegment(inout segments, count, segment);
          count = count + 1;
        }
      } else {
        storeSegment(inout segments, count, segment);
        count = count + 1;
      }
    }
    start = current + 1;
    current = current + 1;
  }

  let output = TextBuffer();
  if (absolute) output.append("/");
  let index: usize = 0;
  while (index < count) {
    if (index > 0) output.append("/");
    output.append(segments[index]);
    index = index + 1;
  }
  return output.finish();
}

function importedPath(in importer: String, in header: String): String {
  const directory = directoryName(importer);
  return normalizedPath(`${directory}/${header}`);
}

function findModule(in modules: Array<ParsedModule>, in path: String): Option<usize> {
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

function moduleExports(in module: ParsedModule, in name: String): boolean {
  for (const declaration of module.program.declarations) {
    if (hasExport(declaration, name)) return true;
  }
  return false;
}

function bindingName(in declaration: ImportDeclaration): String {
  return declaration.moduleName.copyBytes(0, declaration.moduleName.byteLength);
}

function requireAvailableBinding(
  inout occupied: Array<String>,
  in path: String,
  in name: String,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  for (const candidate of occupied) {
    if (candidate == name) throw resolutionError(
      ModuleResolveErrorKind.duplicateBinding,
      path,
      `duplicate module binding ${name}`,
      line,
      column
    );
  }
  occupied.push(name.copyBytes(0, name.byteLength));
}

function validateBindings(in module: ParsedModule): void throws ModuleResolveError {
  let occupied = Array<String>();
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
      const name = bindingName(declaration);
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

function resolveDependencies(
  in modules: Array<ParsedModule>,
  in module: ParsedModule
): Array<usize> throws ModuleResolveError {
  let dependencies = Array<usize>();
  for (const declaration of module.program.imports) {
    if (!isLocalHeader(declaration.header)) continue;
    const targetPath = importedPath(module.path, declaration.header);
    const target = findModule(modules, targetPath);
    const dependency = match (target) {
      some(dependency) => dependency;
      none => {
        const line = declaration.line;
        const column = declaration.column;
        throw resolutionError(
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
        if (!moduleExports(modules[dependency], binding.importedName)) {
          const line = binding.line;
          const column = binding.column;
          throw resolutionError(
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

function visitModule(
  index: usize,
  in modules: Array<ResolvedModule>,
  inout states: Array<u8>,
  inout order: Array<usize>
): void throws ModuleResolveError {
  if (states[index] == 2) return;
  if (states[index] == 1) throw resolutionError(
    ModuleResolveErrorKind.circularImport,
    modules[index].path,
    `circular Z module import through ${modules[index].path}`,
    1,
    1
  );
  states[index] = 1;
  for (const dependency of modules[index].dependencies) {
    try visitModule(dependency, modules, inout states, inout order);
  }
  states[index] = 2;
  order.push(index);
}

export function resolveModules(
  in sources: Array<ModuleSource>,
  in entryPath: String
): ModuleGraph throws ModuleResolveError {
  let parsed = Array<ParsedModule>();
  for (const source of sources) {
    const module = try parseModule(source);
    try validateBindings(module);
    parsed.push(module);
  }
  const normalizedEntry = normalizedPath(entryPath);
  const entryOption = findModule(parsed, normalizedEntry);
  const entry = match (entryOption) {
    some(entry) => entry;
    none => throw resolutionError(
      ModuleResolveErrorKind.missingModule,
      normalizedEntry,
      `could not find entry Z module ${normalizedEntry}`,
      1,
      1
    );
  };

  let modules = Array<ResolvedModule>();
  let index: usize = 0;
  while (index < parsed.length) {
    const dependencies = try resolveDependencies(parsed, parsed[index]);
    modules.push(ResolvedModule({
      path: parsed[index].path.copyBytes(0, parsed[index].path.byteLength),
      dependencies,
    }));
    index = index + 1;
  }

  let states = Array<u8>();
  index = 0;
  while (index < modules.length) {
    states.push(0);
    index = index + 1;
  }
  let dependencyOrder = Array<usize>();
  try visitModule(entry, modules, inout states, inout dependencyOrder);
  return ModuleGraph({ modules, dependencyOrder, entry });
}
