import { generateC } from "./codegen-c.ts";
import { lex } from "./lexer.ts";
import { parse } from "./parser.ts";
import { analyze } from "./sema.ts";
import { materializeResultTypes } from "./results.ts";
import { resolveForeignModules } from "./foreign.ts";

export function compileToC(source: string, fileName: string): string {
  const tokens = lex(source, fileName);
  const program = materializeResultTypes(parse(tokens, fileName));
  const foreignModules = resolveForeignModules(program.imports, fileName);
  const semanticInfo = analyze(program, fileName, foreignModules);
  return generateC(program, fileName, semanticInfo);
}

export function check(source: string, fileName: string): void {
  const program = materializeResultTypes(parse(lex(source, fileName), fileName));
  const foreignModules = resolveForeignModules(program.imports, fileName);
  analyze(program, fileName, foreignModules);
}
