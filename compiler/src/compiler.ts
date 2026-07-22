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
import { linkSourceModules, type SourceModuleBatch, type SourceModuleInfo } from "./modules.ts";
import { materializeWeakTypes } from "./weak-types.ts";
import { generateAsyncC } from "./async-codegen-c.ts";
import { parseForeignDeclarationContracts } from "./foreign-declarations.ts";
import type { DiagnosticError } from "./diagnostics.ts";
import type { Stage1ModuleGraph } from "./self-hosting.ts";
import type { NativeSemanticIndex } from "./native-semantic-index.ts";
import { validateNativeFrontendSemantics } from "./native-semantic-parity.ts";
import { createNativeSemanticBridge } from "./native-call-shadow.ts";

export type NativeLanguage = "c" | "objective-c" | "c++" | "objective-c++";

export type NativeArtifact = {
  readonly source: string;
  readonly language: NativeLanguage;
  readonly frameworks: readonly string[];
  readonly includeDirectories: readonly string[];
  readonly nativeLibraries: readonly string[];
  readonly nativeLinkerArguments: readonly string[];
  readonly deploymentTarget: ProjectBuild["deploymentTarget"];
  readonly warnings: readonly DiagnosticError[];
};

export type AnalyzedSource = {
  readonly sourceProgram: Program;
  readonly program: Program;
  readonly foreignModules: ReadonlyMap<string, ForeignModule>;
  readonly semanticInfo: SemanticInfo;
  readonly typeDisplayNames: ReadonlyMap<string, string>;
  readonly projectBuild: ProjectBuild;
  readonly sourceModules: ReadonlyMap<string, SourceModuleInfo>;
  readonly sourceModuleBatch: SourceModuleBatch;
  readonly moduleIncludeDirectories: readonly string[];
  readonly nativeFrontendGraph: Stage1ModuleGraph | null;
  readonly nativeSemanticIndex: NativeSemanticIndex | null;
  readonly nativeSemanticQueryCount: number;
  readonly nativeGenericCallEvidenceCount: number;
  readonly nativeBindingEvidenceCount: number;
  readonly nativeExpressionEvidenceCount: number;
  readonly nativeCallResolutionCount: number;
  readonly nativeMethodResolutionCount: number;
  readonly nativeConstructorResolutionCount: number;
  readonly nativeAggregateResolutionCount: number;
  readonly nativeFieldResolutionCount: number;
  readonly nativeEnumVariantResolutionCount: number;
  readonly nativeTypeResolutionCount: number;
  readonly nativeBindingResolutionCount: number;
  readonly nativeExpressionResolutionCount: number;
  readonly nativeAuthoritativeFunctionResolutionCount: number;
  readonly nativeAuthoritativeMethodResolutionCount: number;
  readonly nativeAuthoritativeConstructorResolutionCount: number;
  readonly nativeAuthoritativeAggregateResolutionCount: number;
  readonly nativeAuthoritativeFieldResolutionCount: number;
  readonly nativeAuthoritativeEnumVariantResolutionCount: number;
  readonly nativeAuthoritativeTypeResolutionCount: number;
  readonly nativeAuthoritativeBindingResolutionCount: number;
  readonly nativeAuthoritativeExpressionResolutionCount: number;
  readonly nativeFrontendParityMilliseconds: number | null;
};

export type AnalysisOptions = {
  readonly requireMain?: boolean;
  readonly nativeFrontendResolver?: (sourceBatch: SourceModuleBatch) => Stage1ModuleGraph;
};

export function analyzeSource(source: string, fileName: string, options: AnalysisOptions = {}): AnalyzedSource {
  const tokens = lex(source, fileName);
  const sourceProgram = parse(tokens, fileName);
  const linked = linkSourceModules(source, sourceProgram, fileName);
  const projectBuild = prepareProject(fileName);
  const includeDirectories = [...new Set([...projectBuild.includeDirectories, ...linked.includeDirectories])];
  const foreignModules = resolveForeignModules(linked.program.imports, fileName, includeDirectories, projectBuild.deploymentTarget);
  const typeDisplayNames = new Map(linked.typeDisplayNames);
  for (const module of foreignModules.values()) {
    for (const type of module.types.values()) {
      typeDisplayNames.set(type.typeName, `${type.cName}${type.nullable ? " | null" : ""}`);
    }
  }
  const inferredProgram = inferGenericCalls(linked.program, fileName, foreignModules);
  const program = materializeResultTypes(materializeWeakTypes(materializeGenerics(inferredProgram, fileName, typeDisplayNames)));
  for (const declaration of program.enums) {
    if (!declaration.name.startsWith("__z_Result_")) continue;
    const successVariant = declaration.variants.find((variant) => variant.name === "success");
    const success = successVariant?.payload?.name ?? (successVariant ? "void" : null);
    const failure = declaration.variants.find((variant) => variant.name === "failure")?.payload?.name;
    if (!success || !failure) continue;
    typeDisplayNames.set(
      declaration.name,
      `Result<${typeDisplayNames.get(success) ?? success}, ${typeDisplayNames.get(failure) ?? failure}>`,
    );
  }
  let nativeFrontendGraph: Stage1ModuleGraph | null = null;
  let nativeEvidence: ReturnType<typeof validateNativeFrontendSemantics> | null = null;
  let nativeFrontendFailure: unknown = null;
  let nativeFrontendParityMilliseconds: number | null = null;
  if (options.nativeFrontendResolver) {
    try {
      nativeFrontendGraph = options.nativeFrontendResolver(linked.sourceBatch);
      const parityStarted = performance.now();
      nativeEvidence = validateNativeFrontendSemantics(linked.sourceBatch, nativeFrontendGraph);
      nativeFrontendParityMilliseconds = performance.now() - parityStarted;
    } catch (error) {
      nativeFrontendFailure = error;
    }
  }
  const nativeSemanticBridge = nativeEvidence
    ? createNativeSemanticBridge(linked.sourceBatch, nativeEvidence.index, typeDisplayNames)
    : null;
  const semanticInfo = analyze(
    program,
    fileName,
    foreignModules,
    typeDisplayNames,
    options.requireMain ?? true,
    projectBuild.deploymentTarget,
    nativeSemanticBridge?.observer ?? null,
  );
  if (nativeFrontendFailure) throw nativeFrontendFailure;
  return {
    sourceProgram,
    program,
    foreignModules,
    semanticInfo,
    typeDisplayNames,
    projectBuild,
    sourceModules: linked.modules,
    sourceModuleBatch: linked.sourceBatch,
    moduleIncludeDirectories: linked.includeDirectories,
    nativeFrontendGraph,
    nativeSemanticIndex: nativeEvidence?.index ?? null,
    nativeSemanticQueryCount: nativeEvidence?.queryCount ?? 0,
    nativeGenericCallEvidenceCount: nativeFrontendGraph?.modules.reduce(
      (count, module) => count + module.callResolutions.length,
      0,
    ) ?? 0,
    nativeBindingEvidenceCount: nativeFrontendGraph?.modules.reduce(
      (count, module) => count + module.bindingResolutions.length,
      0,
    ) ?? 0,
    nativeExpressionEvidenceCount: nativeFrontendGraph?.modules.reduce(
      (count, module) => count + module.expressionResolutions.length,
      0,
    ) ?? 0,
    nativeCallResolutionCount: nativeSemanticBridge?.functionCount() ?? 0,
    nativeMethodResolutionCount: nativeSemanticBridge?.methodCount() ?? 0,
    nativeConstructorResolutionCount: nativeSemanticBridge?.constructorCount() ?? 0,
    nativeAggregateResolutionCount: nativeSemanticBridge?.aggregateCount() ?? 0,
    nativeFieldResolutionCount: nativeSemanticBridge?.fieldCount() ?? 0,
    nativeEnumVariantResolutionCount: nativeSemanticBridge?.enumVariantCount() ?? 0,
    nativeTypeResolutionCount: nativeSemanticBridge?.typeCount() ?? 0,
    nativeBindingResolutionCount: nativeSemanticBridge?.bindingCount() ?? 0,
    nativeExpressionResolutionCount: nativeSemanticBridge?.expressionCount() ?? 0,
    nativeAuthoritativeFunctionResolutionCount: nativeSemanticBridge?.authoritativeFunctionCount() ?? 0,
    nativeAuthoritativeMethodResolutionCount: nativeSemanticBridge?.authoritativeMethodCount() ?? 0,
    nativeAuthoritativeConstructorResolutionCount: nativeSemanticBridge?.authoritativeConstructorCount() ?? 0,
    nativeAuthoritativeAggregateResolutionCount: nativeSemanticBridge?.authoritativeAggregateCount() ?? 0,
    nativeAuthoritativeFieldResolutionCount: nativeSemanticBridge?.authoritativeFieldCount() ?? 0,
    nativeAuthoritativeEnumVariantResolutionCount: nativeSemanticBridge?.authoritativeEnumVariantCount() ?? 0,
    nativeAuthoritativeTypeResolutionCount: nativeSemanticBridge?.authoritativeTypeCount() ?? 0,
    nativeAuthoritativeBindingResolutionCount: nativeSemanticBridge?.authoritativeBindingCount() ?? 0,
    nativeAuthoritativeExpressionResolutionCount: nativeSemanticBridge?.authoritativeExpressionCount() ?? 0,
    nativeFrontendParityMilliseconds,
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
  const generated = asyncDeclaration ? generateAsyncC(program, fileName, semanticInfo) : null;
  const synchronousProgram = generated?.synchronousProgram ?? program;
  const synchronousSource = generateC(synchronousProgram, fileName, semanticInfo);
  return {
    source: generated ? `${synchronousSource}\n${generated.source}\n` : synchronousSource,
    language: semanticInfo.objectiveC
      ? semanticInfo.cPlusPlus ? "objective-c++" : "objective-c"
      : semanticInfo.cPlusPlus ? "c++" : "c",
    frameworks: [...new Set([
      ...semanticInfo.frameworks,
      ...projectBuild.frameworks,
      ...(generated?.frameworks ?? []),
    ])],
    includeDirectories: [...new Set([...projectBuild.includeDirectories, ...moduleIncludeDirectories])],
    nativeLibraries: projectBuild.nativeLibraries,
    nativeLinkerArguments: [...new Set([
      ...(semanticInfo.threadSpawnCalls.size > 0 && process.platform !== "win32" ? ["-pthread"] : []),
      ...projectBuild.nativeLinkerArguments,
    ])],
    deploymentTarget: projectBuild.deploymentTarget,
    warnings: semanticInfo.warnings,
  };
}

export function check(source: string, fileName: string): readonly DiagnosticError[] {
  if (fileName.endsWith(".zd")) parseForeignDeclarationContracts(source, fileName);
  else return analyzeSource(source, fileName, { requireMain: false }).semanticInfo.warnings;
  return [];
}
