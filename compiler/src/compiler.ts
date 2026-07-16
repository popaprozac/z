import { generateC } from "./codegen-c.ts";
import { lex } from "./lexer.ts";
import { parse } from "./parser.ts";
import { analyze } from "./sema.ts";
import { materializeResultTypes } from "./results.ts";
import { resolveForeignModules } from "./foreign.ts";

export type NativeLanguage = "c" | "objective-c" | "c++" | "objective-c++";

export type NativeArtifact = {
  readonly source: string;
  readonly language: NativeLanguage;
  readonly frameworks: readonly string[];
};

export function compileToC(source: string, fileName: string): string {
  return compileToNative(source, fileName).source;
}

export function compileToNative(source: string, fileName: string): NativeArtifact {
  const tokens = lex(source, fileName);
  const program = materializeResultTypes(parse(tokens, fileName));
  const foreignModules = resolveForeignModules(program.imports, fileName);
  const semanticInfo = analyze(program, fileName, foreignModules);
  return {
    source: generateC(program, fileName, semanticInfo),
    language: "c",
    frameworks: [],
  };
}

export function check(source: string, fileName: string): void {
  const program = materializeResultTypes(parse(lex(source, fileName), fileName));
  const foreignModules = resolveForeignModules(program.imports, fileName);
  analyze(program, fileName, foreignModules);
}
