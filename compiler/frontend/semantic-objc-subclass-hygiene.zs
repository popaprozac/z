import { FunctionDeclaration } from "./parser.zs";
import { ParsedModule } from "./module-symbols.zs";
import { ModuleResolveError, ModuleResolveErrorKind, ResolvedModule, codedModuleResolutionError } from "./semantic-model.zs";
import { Set } from "std/collections";

function identifierStart(byte: u8): boolean {
  return byte == 95 || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
}

// Match generated identities, not a reserved prefix: Z_OK and other legitimate
// native names remain available. This is ABI hygiene, not a raw-code sandbox.
function checkRawFunction(
  in module: ParsedModule, in declaration: FunctionDeclaration, in names: Set<String>
): void throws ModuleResolveError {
  if (declaration.rawLanguage.byteLength == 0) return;
  const source = view declaration.rawSource;
  let offset: usize = 0;
  let line = declaration.rawLine;
  let column = declaration.rawColumn;
  let quote: u8 = 0;
  let lineComment = false;
  let blockComment = false;
  while (offset < source.byteLength) {
    const byte = source.byteAt(offset);
    const next: u8 = offset + 1 < source.byteLength ? source.byteAt(offset + 1) : u8(0);
    if (byte == 10) { line = line + 1; column = 0; lineComment = false; }
    if (lineComment) {}
    else if (blockComment) {
      if (byte == 42 && next == 47) { blockComment = false; offset = offset + 1; column = column + 1; }
    } else if (quote != 0) {
      if (byte == 92 && offset + 1 < source.byteLength) {
        if (next == 10) { line = line + 1; column = 0; } else column = column + 1;
        offset = offset + 1;
      } else if (byte == quote) quote = 0;
    } else if (byte == 34 || byte == 39) quote = byte;
    else if (byte == 47 && next == 47) lineComment = true;
    else if (byte == 47 && next == 42) { blockComment = true; offset = offset + 1; column = column + 1; }
    else if (identifierStart(byte)) {
      let end = offset + 1;
      while (end < source.byteLength) {
        const part = source.byteAt(end);
        if (!identifierStart(part) && !(part >= 48 && part <= 57)) break;
        end = end + 1;
      }
      const name = source.copyBytes(offset, end);
      if (names.has(name)) throw codedModuleResolutionError(
        ModuleResolveErrorKind.typeMismatch, "Z0820", module.path,
        `raw native source cannot reference compiler-owned symbol "${name}"`,
        line, column, end - offset
      );
      column = column + end - offset;
      offset = end;
      continue;
    }
    offset = offset + 1;
    column = column + 1;
  }
}

export function validateNativeObjCSubclassRawAccess(
  in parsed: Array<ParsedModule>, in modules: Array<ResolvedModule>
): void throws ModuleResolveError {
  let names = Set<String>();
  for (const module of modules) {
    for (const plan of module.semanticEvidence.objectiveCSubclasses) {
      names.add(copy plan.nativeName);
      names.add(`${plan.nativeName}_new`);
    }
  }
  if (names.length == 0) return;
  names.add("_z_native_subclass_ready");
  for (const module of parsed) {
    for (const declaration of module.program.functions) {
      try checkRawFunction(module, declaration, names);
    }
    for (const aggregate of module.program.aggregates) {
      for (const declaration of aggregate.methods) {
        try checkRawFunction(module, declaration, names);
      }
    }
  }
}
