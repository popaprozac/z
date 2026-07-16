import { generateC } from "./codegen-c.ts";
import { lex } from "./lexer.ts";
import { parse } from "./parser.ts";
import { analyze } from "./sema.ts";
import { materializeResultTypes } from "./results.ts";
import { materializeGenerics } from "./generics.ts";
import { resolveForeignModules } from "./foreign.ts";
import type { Program } from "./ast.ts";
import type { ForeignModule } from "./foreign.ts";
import type { SemanticInfo } from "./sema.ts";

export type NativeLanguage = "c" | "objective-c" | "c++" | "objective-c++";

export type NativeArtifact = {
  readonly source: string;
  readonly language: NativeLanguage;
  readonly frameworks: readonly string[];
};

export type AnalyzedSource = {
  readonly program: Program;
  readonly foreignModules: ReadonlyMap<string, ForeignModule>;
  readonly semanticInfo: SemanticInfo;
};

export function analyzeSource(source: string, fileName: string): AnalyzedSource {
  const tokens = lex(source, fileName);
  const program = materializeResultTypes(materializeGenerics(parse(tokens, fileName), fileName));
  const foreignModules = resolveForeignModules(program.imports, fileName);
  const semanticInfo = analyze(program, fileName, foreignModules);
  return { program, foreignModules, semanticInfo };
}

export function compileToC(source: string, fileName: string): string {
  return compileToNative(source, fileName).source;
}

export function compileToNative(source: string, fileName: string): NativeArtifact {
  const { program, semanticInfo } = analyzeSource(source, fileName);
  return {
    source: generateC(program, fileName, semanticInfo),
    language: semanticInfo.objectiveC ? "objective-c" : "c",
    frameworks: semanticInfo.frameworks,
  };
}

export function check(source: string, fileName: string): void {
  analyzeSource(source, fileName);
}
