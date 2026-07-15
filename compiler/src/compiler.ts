import { generateC } from "./codegen-c.ts";
import { lex } from "./lexer.ts";
import { parse } from "./parser.ts";
import { analyze } from "./sema.ts";
import { materializeResultTypes } from "./results.ts";

export function compileToC(source: string, fileName: string): string {
  const tokens = lex(source, fileName);
  const program = materializeResultTypes(parse(tokens, fileName));
  const semanticInfo = analyze(program, fileName);
  return generateC(program, fileName, semanticInfo);
}

export function check(source: string, fileName: string): void {
  const program = materializeResultTypes(parse(lex(source, fileName), fileName));
  analyze(program, fileName);
}
