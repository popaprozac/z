import { generateC } from "./codegen-c.ts";
import { lex } from "./lexer.ts";
import { parse } from "./parser.ts";
import { analyze } from "./sema.ts";
import { materializeResultTypes } from "./results.ts";
import { materializeGenerics } from "./generics.ts";
import { inferGenericCalls } from "./generic-inference.ts";
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
  readonly sourceProgram: Program;
  readonly program: Program;
  readonly foreignModules: ReadonlyMap<string, ForeignModule>;
  readonly semanticInfo: SemanticInfo;
  readonly typeDisplayNames: ReadonlyMap<string, string>;
};

export function analyzeSource(source: string, fileName: string): AnalyzedSource {
  const tokens = lex(source, fileName);
  const sourceProgram = parse(tokens, fileName);
  const foreignModules = resolveForeignModules(sourceProgram.imports, fileName);
  const typeDisplayNames = new Map<string, string>();
  const inferredProgram = inferGenericCalls(sourceProgram, fileName, foreignModules);
  const program = materializeResultTypes(materializeGenerics(inferredProgram, fileName, typeDisplayNames));
  const semanticInfo = analyze(program, fileName, foreignModules);
  return { sourceProgram, program, foreignModules, semanticInfo, typeDisplayNames };
}

export function compileToC(source: string, fileName: string): string {
  return compileToNative(source, fileName).source;
}

export function compileToNative(source: string, fileName: string): NativeArtifact {
  const { program, semanticInfo } = analyzeSource(source, fileName);
  return {
    source: generateC(program, fileName, semanticInfo),
    language: semanticInfo.objectiveC
      ? semanticInfo.cPlusPlus ? "objective-c++" : "objective-c"
      : semanticInfo.cPlusPlus ? "c++" : "c",
    frameworks: semanticInfo.frameworks,
  };
}

export function check(source: string, fileName: string): void {
  analyzeSource(source, fileName);
}
