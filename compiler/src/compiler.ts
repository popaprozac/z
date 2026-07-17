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
import { prepareProject, type ProjectBuild } from "./project.ts";
import { linkSourceModules, type SourceModuleInfo } from "./modules.ts";
import { materializeWeakTypes } from "./weak-types.ts";
import { DiagnosticError } from "./diagnostics.ts";

export type NativeLanguage = "c" | "objective-c" | "c++" | "objective-c++";

export type NativeArtifact = {
  readonly source: string;
  readonly language: NativeLanguage;
  readonly frameworks: readonly string[];
  readonly includeDirectories: readonly string[];
  readonly nativeLibraries: readonly string[];
};

export type AnalyzedSource = {
  readonly sourceProgram: Program;
  readonly program: Program;
  readonly foreignModules: ReadonlyMap<string, ForeignModule>;
  readonly semanticInfo: SemanticInfo;
  readonly typeDisplayNames: ReadonlyMap<string, string>;
  readonly projectBuild: ProjectBuild;
  readonly sourceModules: ReadonlyMap<string, SourceModuleInfo>;
  readonly moduleIncludeDirectories: readonly string[];
};

export type AnalysisOptions = {
  readonly requireMain?: boolean;
};

export function analyzeSource(source: string, fileName: string, options: AnalysisOptions = {}): AnalyzedSource {
  const tokens = lex(source, fileName);
  const sourceProgram = parse(tokens, fileName);
  const linked = linkSourceModules(sourceProgram, fileName);
  const projectBuild = prepareProject(fileName);
  const includeDirectories = [...new Set([...projectBuild.includeDirectories, ...linked.includeDirectories])];
  const foreignModules = resolveForeignModules(linked.program.imports, fileName, includeDirectories);
  const typeDisplayNames = new Map(linked.typeDisplayNames);
  const inferredProgram = inferGenericCalls(linked.program, fileName, foreignModules);
  const program = materializeResultTypes(materializeWeakTypes(materializeGenerics(inferredProgram, fileName, typeDisplayNames)));
  for (const declaration of program.enums) {
    if (!declaration.name.startsWith("__z_Result_")) continue;
    const success = declaration.variants.find((variant) => variant.name === "success")?.payload?.name;
    const failure = declaration.variants.find((variant) => variant.name === "failure")?.payload?.name;
    if (!success || !failure) continue;
    typeDisplayNames.set(
      declaration.name,
      `Result<${typeDisplayNames.get(success) ?? success}, ${typeDisplayNames.get(failure) ?? failure}>`,
    );
  }
  const semanticInfo = analyze(program, fileName, foreignModules, typeDisplayNames, options.requireMain ?? true);
  return {
    sourceProgram,
    program,
    foreignModules,
    semanticInfo,
    typeDisplayNames,
    projectBuild,
    sourceModules: linked.modules,
    moduleIncludeDirectories: linked.includeDirectories,
  };
}

export function compileToC(source: string, fileName: string): string {
  return compileToNative(source, fileName).source;
}

export function compileToNative(source: string, fileName: string): NativeArtifact {
  const { program, semanticInfo, projectBuild, moduleIncludeDirectories } = analyzeSource(source, fileName);
  const asyncDeclaration = [
    ...program.functions,
    ...program.structs.flatMap((declaration) => declaration.methods),
  ].find((declaration) => declaration.async);
  if (asyncDeclaration) {
    throw new DiagnosticError(fileName, asyncDeclaration.location, "async runtime lowering is not implemented in Phase 0", {
      code: "Z0700",
      notes: ["syntax, typing, ownership restrictions, diagnostics, and editor services are available now"],
      helps: ["use `z check` while designing async code; executable state-machine lowering lands in Async Phase 1"],
    });
  }
  return {
    source: generateC(program, fileName, semanticInfo),
    language: semanticInfo.objectiveC
      ? semanticInfo.cPlusPlus ? "objective-c++" : "objective-c"
      : semanticInfo.cPlusPlus ? "c++" : "c",
    frameworks: [...new Set([...semanticInfo.frameworks, ...projectBuild.frameworks])],
    includeDirectories: [...new Set([...projectBuild.includeDirectories, ...moduleIncludeDirectories])],
    nativeLibraries: projectBuild.nativeLibraries,
  };
}

export function check(source: string, fileName: string): void {
  analyzeSource(source, fileName, { requireMain: false });
}
