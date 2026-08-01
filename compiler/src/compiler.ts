import { generateC, generateCHeader } from "./codegen-c.ts";
import { lex } from "./lexer.ts";
import { parse } from "./parser.ts";
import {
  analyze,
  runtimeRootTypeContainsForeignValueStorage,
  runtimeRootTypeNeedsCleanup,
  runtimeRootTypeRequiresMain,
} from "./sema.ts";
import { materializeResultTypes } from "./results.ts";
import {
  materializeGenerics,
  type GenericAggregateMaterialization,
} from "./generics.ts";
import { inferGenericCalls } from "./generic-inference.ts";
import { resolveForeignModules } from "./foreign.ts";
import {
  collectForeignHandleTypeAliases,
  resolveForeignHandleTypeAnnotations,
} from "./foreign-handle-types.ts";
import { resolveTypeAliases } from "./type-aliases.ts";
import type { Program, SourceLocation } from "./ast.ts";
import type { ForeignModule } from "./foreign.ts";
import type { SemanticInfo } from "./sema.ts";
import { prepareProject, type ProjectBuild } from "./project.ts";
import { linkSourceModules, type SourceModuleBatch, type SourceModuleInfo } from "./modules.ts";
import { materializeWeakTypes } from "./weak-types.ts";
import { materializeStructDefaults } from "./struct-defaults.ts";
import { generateAsyncC } from "./async-codegen-c.ts";
import { parseForeignDeclarationContracts } from "./foreign-declarations.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { Stage1ModuleGraph } from "./self-hosting.ts";
import type { NativeSemanticIndex } from "./native-semantic-index.ts";
import { validateNativeFrontendSemantics } from "./native-semantic-parity.ts";
import { createNativeSemanticBridge } from "./native-call-shadow.ts";
import {
  NativeFrontendDiagnosticError,
  type NativeFrontendDiagnosticKind,
} from "./native-frontend-diagnostics.ts";
import {
  hasRawNativeBodies,
  validateRawNativeGeneratedSymbolAccess,
} from "./raw-native-hygiene.ts";

export type NativeLanguage = "c" | "objective-c" | "c++" | "objective-c++";

export type NativeArtifact = {
  readonly source: string;
  readonly header: string | null;
  readonly targetKind: ProjectBuild["targetKind"];
  readonly targetName: string | null;
  readonly language: NativeLanguage;
  readonly frameworks: readonly string[];
  readonly includeDirectories: readonly string[];
  readonly nativeLibraries: readonly string[];
  readonly nativeLinkerArguments: readonly string[];
  readonly deploymentTarget: ProjectBuild["deploymentTarget"];
  readonly warnings: readonly DiagnosticError[];
};

export type NativeTestArtifact = NativeArtifact & {
  readonly testNames: readonly string[];
};

export type NativeCompileOptions = {
  readonly requireMain?: boolean;
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

function embeddedRuntimeSymbolPart(targetName: string): string {
  return targetName.replaceAll("-", "_");
}

function validateEmbeddedRuntimePublicNames(
  program: Program,
  targetName: string | null,
  fileName: string,
): void {
  if (targetName === null) return;
  const prefix = embeddedRuntimeSymbolPart(targetName);
  const reserved = new Set([
    `${prefix}_runtime_initialize`,
    `${prefix}_runtime_shutdown`,
    `${prefix}_runtime_status`,
    `${prefix}_runtime_config`,
    `${prefix}_runtime_enqueue_release`,
  ]);
  for (const declaration of program.functions) {
    const name = declaration.nativeExport?.name;
    if (!name || !reserved.has(name)) continue;
    throw new DiagnosticError(
      declaration.location.fileName ?? fileName,
      declaration.nativeExport!.location,
      `C export name ${JSON.stringify(name)} collides with the generated runtime contract for target ${JSON.stringify(targetName)}`,
      {
        code: "Z0610",
        helps: ["choose a different C export name or rename target.name"],
      },
    );
  }
  for (const declaration of [...program.structs, ...program.enums]) {
    const layout = declaration.nativeLayout;
    if (!layout || !reserved.has(layout.name)) continue;
    throw new DiagnosticError(
      layout.location.fileName ?? fileName,
      layout.location,
      `public C type name ${JSON.stringify(layout.name)} collides with the generated runtime contract for target ${JSON.stringify(targetName)}`,
      {
        code: "Z0610",
        helps: ["choose a different C layout name or rename target.name"],
      },
    );
  }
}

function embeddedRuntimeInitializer(
  program: Program,
  semanticInfo: SemanticInfo,
  projectBuild: ProjectBuild,
  fileName: string,
): {
  readonly functionName: string;
  readonly returnType: string;
  readonly requiresMainThread: boolean;
} | null {
  const configured = projectBuild.runtimeInitializer;
  if (configured === null) return null;
  const declaration = program.functions.find((candidate) => (
    candidate.name === configured
    && (candidate.location.fileName ?? fileName) === (projectBuild.entryPath ?? fileName)
  ));
  const reject = (summary: string, help?: string): never => {
    throw new DiagnosticError(
      declaration?.location.fileName ?? projectBuild.entryPath ?? fileName,
      declaration?.location ?? {
        offset: 0,
        line: 1,
        column: 1,
        fileName: projectBuild.entryPath ?? fileName,
      },
      summary,
      {
        code: "Z0611",
        notes: ["the selected return value is owned by the generated library runtime until shutdown"],
        helps: help ? [help] : undefined,
      },
    );
  };
  if (!declaration) {
    reject(
      `runtime initializer ${JSON.stringify(configured)} was not found in the target entry module`,
      `declare \`function ${configured}(): OwnedRoot\` in ${JSON.stringify(projectBuild.entryPath ?? fileName)}`,
    );
  }
  if (declaration.parameters.length !== 0) reject("a runtime initializer cannot accept parameters in the first tier");
  if (declaration.async) reject("a runtime initializer cannot be async in the first tier");
  if (declaration.errorType) reject("a runtime initializer cannot throw in the first tier");
  if ((declaration.typeParameters?.length ?? 0) > 0) reject("a runtime initializer cannot be generic");
  if (declaration.rawBody) reject("a runtime initializer must have an ordinary checked Z body");
  if (declaration.nativeExport) reject("a runtime initializer is selected by z.json and cannot also be a public C export");
  const returnType = declaration.returnType.name;
  if (!runtimeRootTypeNeedsCleanup(returnType, program, semanticInfo)) {
    reject(
      `runtime initializer return type ${JSON.stringify(returnType)} does not own cleanup-bearing state`,
      "return one owned value such as a OnceLifetime<T>, class, Mutex<T>, or Z struct containing the library's roots",
    );
  }
  if (runtimeRootTypeContainsForeignValueStorage(returnType, program, semanticInfo)) {
    reject(
      `runtime initializer return type ${JSON.stringify(returnType)} contains a native by-value resource that is not yet supported in generated static runtime storage`,
      "wrap the native value behind a Z class or keep it behind an owned native handle until placement construction lands",
    );
  }
  const returnRequiresMain = runtimeRootTypeRequiresMain(
    returnType,
    program,
    semanticInfo,
  );
  if (returnRequiresMain && !declaration.executorAffinity) {
    reject(
      `runtime initializer returning main-bound ${JSON.stringify(returnType)} must declare \`on thread.main\``,
      `write \`function ${configured}(): ${returnType} on thread.main\``,
    );
  }
  return {
    functionName: declaration.name,
    returnType,
    requiresMainThread: Boolean(declaration.executorAffinity) || returnRequiresMain,
  };
}

export type AnalysisOptions = {
  readonly requireMain?: boolean;
  readonly includeTests?: boolean;
  readonly validateTarget?: boolean;
  readonly nativeFrontendResolver?: (sourceBatch: SourceModuleBatch) => Stage1ModuleGraph;
  readonly foreignDeclarationOverrides?: Readonly<Record<string, {
    readonly source: string;
    readonly fileName: string;
  }>>;
};

export function analyzeSource(source: string, fileName: string, options: AnalysisOptions = {}): AnalyzedSource {
  const tokens = lex(source, fileName);
  const sourceProgram = parse(tokens, fileName);
  const linked = linkSourceModules(source, sourceProgram, fileName);
  const linkedProgram = options.includeTests === false
    ? {
        ...linked.program,
        functions: linked.program.functions.filter((declaration) => !declaration.testName),
      }
    : linked.program;
  const typeAliases = resolveTypeAliases(linkedProgram, fileName, linked.typeDisplayNames);
  const projectBuild = prepareProject(fileName);
  const includeDirectories = [...new Set([...projectBuild.includeDirectories, ...linked.includeDirectories])];
  const foreignModules = resolveForeignModules(
    typeAliases.program.imports,
    fileName,
    includeDirectories,
    projectBuild.deploymentTarget,
    projectBuild.foreignApiNotes,
    options.foreignDeclarationOverrides,
  );
  const foreignHandleTypes = collectForeignHandleTypeAliases(foreignModules);
  const typeDisplayNames = new Map(linked.typeDisplayNames);
  for (const module of foreignModules.values()) {
    for (const type of module.types.values()) {
      typeDisplayNames.set(type.typeName, `${type.cName}${type.nullable ? " | null" : ""}`);
    }
  }
  for (const [canonical, display] of foreignHandleTypes.displayByCanonicalName) {
    typeDisplayNames.set(canonical, display);
  }
  const resolvedProgram = resolveForeignHandleTypeAnnotations(
    typeAliases.program,
    foreignHandleTypes.canonicalBySourceName,
  );
  validateRawNativeDeclarationShapes(resolvedProgram, fileName);
  const inferredProgram = inferGenericCalls(resolvedProgram, fileName, foreignModules);
  const genericAggregateMaterializations = new Map<
    string,
    GenericAggregateMaterialization
  >();
  const foreignIdentityTypes = new Set(
    [...foreignModules.values()].flatMap((module) => [...module.interfaces.values()].map((type) => type.typeName)),
  );
  const program = materializeStructDefaults(
    materializeResultTypes(
      materializeWeakTypes(materializeGenerics(
        inferredProgram,
        fileName,
        typeDisplayNames,
        foreignIdentityTypes,
        genericAggregateMaterializations,
      )),
      foreignModules,
    ),
    fileName,
  );
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
  const nativeDiagnostic = authoritativeNativeDiagnostic(nativeFrontendFailure, linked.sourceBatch);
  if (nativeDiagnostic) throw nativeDiagnostic;
  const nativeSemanticBridge = nativeEvidence
    ? createNativeSemanticBridge(linked.sourceBatch, nativeEvidence.index, typeDisplayNames)
    : null;
  const semanticInfo = analyze(
    program,
    fileName,
    foreignModules,
    typeDisplayNames,
    options.requireMain ?? projectBuild.targetKind === "executable",
    projectBuild.deploymentTarget,
    nativeSemanticBridge?.observer ?? null,
    genericAggregateMaterializations,
  );
  if (options.validateTarget !== false) {
    validateLibraryStandardCalls(program, semanticInfo, projectBuild, fileName);
  }
  if (hasRawNativeBodies(program)) {
    const asyncDeclaration = [
      ...program.functions,
      ...program.structs.flatMap((declaration) => declaration.methods),
    ].find((declaration) => declaration.async);
    const asyncGenerated = asyncDeclaration ? generateAsyncC(program, fileName, semanticInfo) : null;
    const synchronousProgram = asyncGenerated?.synchronousProgram ?? program;
    const generatedWithoutRawBodies = [
      generateC(synchronousProgram, fileName, semanticInfo, { omitRawNativeBodies: true }),
      asyncGenerated?.source ?? "",
    ].join("\n");
    validateRawNativeGeneratedSymbolAccess(
      program,
      foreignModules,
      generatedWithoutRawBodies,
      fileName,
    );
  }
  if (nativeFrontendFailure) throw nativeFrontendFailure;
  return {
    sourceProgram,
    program,
    foreignModules,
    semanticInfo,
    typeDisplayNames: semanticInfo.typeDisplayNames,
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

function validateRawNativeDeclarationShapes(program: Program, fileName: string): void {
  const validateFunction = (declaration: Program["functions"][number]): void => {
    if (!declaration.rawBody) return;
    const diagnosticFile = declaration.rawBody.location.fileName ?? fileName;
    if (declaration.async || declaration.errorType) {
      throw new DiagnosticError(
        diagnosticFile,
        declaration.rawBody.location,
        "a raw native function body must be synchronous and non-throwing in the first tier",
        { code: "Z0820" },
      );
    }
    if ((declaration.typeParameters?.length ?? 0) > 0) {
      throw new DiagnosticError(
        diagnosticFile,
        declaration.rawBody.location,
        "a raw native function body cannot be generic in the first tier",
        {
          code: "Z0820",
          notes: ["the native body needs one concrete ABI signature"],
        },
      );
    }
  };
  for (const declaration of program.functions) validateFunction(declaration);
  for (const aggregate of program.structs) {
    for (const method of aggregate.methods) {
      if (!method.rawBody) continue;
      throw new DiagnosticError(
        method.rawBody.location.fileName ?? fileName,
        method.rawBody.location,
        "raw native method bodies are deferred beyond the first raw interop tier",
        {
          code: "Z0820",
          helps: ["use a free raw native function with an explicit boundary signature"],
        },
      );
    }
  }
}

export function compileToC(source: string, fileName: string): string {
  return compileToNative(source, fileName).source;
}

const authoritativeNativeDiagnosticKinds = new Set<NativeFrontendDiagnosticKind>([
  "unknownName",
  "unknownType",
  "unknownMember",
  "typeMismatch",
  "invalidOperator",
  "invalidMatch",
]);

function authoritativeNativeDiagnostic(
  error: unknown,
  sourceBatch: SourceModuleBatch,
): DiagnosticError | null {
  if (!(error instanceof NativeFrontendDiagnosticError)) return null;
  if (!authoritativeNativeDiagnosticKinds.has(error.kind)) return null;
  const sourceModule = sourceBatch.modules.find((module) => module.fileName === error.fileName);
  if (!sourceModule) return null;
  const lines = sourceModule.source.split(/\r?\n/);
  const line = lines[error.line - 1];
  if (line === undefined || error.column > line.length + 1) return null;
  return new DiagnosticError(
    error.fileName,
    {
      offset: sourceOffset(sourceModule.source, error.line, error.column),
      line: error.line,
      column: error.column,
      fileName: error.fileName,
    },
    error.summary,
  );
}

function sourceOffset(source: string, targetLine: number, targetColumn: number): number {
  let offset = 0;
  let line = 1;
  while (line < targetLine) {
    const newline = source.indexOf("\n", offset);
    if (newline < 0) return 0;
    offset = newline + 1;
    line += 1;
  }
  return offset + targetColumn - 1;
}

function validateLibraryStandardCalls(
  program: Program,
  semanticInfo: SemanticInfo,
  projectBuild: ProjectBuild,
  fileName: string,
): void {
  if (projectBuild.targetKind === "executable") return;
  const unsupported = [...semanticInfo.standardFunctionReferences]
    .find(([, name]) => name === "process.args" || name === "process.executablePath");
  if (!unsupported) return;
  const [offset, name] = unsupported;
  const location = sourceLocationAtOffset(program, offset)
    ?? { offset: 0, line: 1, column: 1, fileName };
  throw new DiagnosticError(
    location.fileName ?? fileName,
    location,
    `${name}() is unavailable in a ${projectBuild.targetKind} target because no Z main receives the host process arguments`,
    {
      code: "Z0604",
      notes: ["library entry points run inside a foreign host process and do not implicitly own its argc/argv"],
      helps: ["pass the required host data through an export c function; an explicit embedding argument contract remains future work"],
    },
  );
}

function sourceLocationAtOffset(value: unknown, offset: number): SourceLocation | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = sourceLocationAtOffset(item, offset);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const location = record.location;
  if (
    location
    && typeof location === "object"
    && (location as SourceLocation).offset === offset
  ) return location as SourceLocation;
  for (const child of Object.values(record)) {
    const found = sourceLocationAtOffset(child, offset);
    if (found) return found;
  }
  return null;
}

export function compileToNative(
  source: string,
  fileName: string,
  options: NativeCompileOptions = {},
): NativeArtifact {
  const { program, semanticInfo, projectBuild, moduleIncludeDirectories } = analyzeSource(source, fileName, {
    requireMain: options.requireMain,
    includeTests: false,
  });
  const asyncDeclaration = [
    ...program.functions,
    ...program.structs.flatMap((declaration) => declaration.methods),
  ].find((declaration) => declaration.async);
  const generated = asyncDeclaration ? generateAsyncC(program, fileName, semanticInfo) : null;
  const synchronousProgram = generated?.synchronousProgram ?? program;
  const embeddedRuntimeName = projectBuild.targetKind === "executable"
    ? null
    : projectBuild.targetName;
  validateEmbeddedRuntimePublicNames(program, embeddedRuntimeName, fileName);
  const runtimeInitializer = embeddedRuntimeInitializer(
    program,
    semanticInfo,
    projectBuild,
    fileName,
  );
  const synchronousSource = generateC(synchronousProgram, fileName, semanticInfo, {
    embeddedRuntimeName,
    embeddedRuntimeInitializer: runtimeInitializer,
  });
  const embeddedRuntimeRequiresMain = program.structs.some((declaration) => (
    declaration.kind === "class"
    && semanticInfo.aggregateExecutorAffinities.has(declaration.name)
  )) || Boolean(runtimeInitializer?.requiresMainThread);
  return {
    source: generated ? `${synchronousSource}\n${generated.source}\n` : synchronousSource,
    header: generateCHeader(
      program,
      embeddedRuntimeName,
      embeddedRuntimeRequiresMain,
      embeddedRuntimeRequiresMain,
    ),
    targetKind: projectBuild.targetKind,
    targetName: projectBuild.targetName,
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
      ...(
        (
          semanticInfo.threadSpawnCalls.size > 0
          || semanticInfo.taskScopeAsyncCalls.size > 0
          || [...semanticInfo.standardTypeBindings.values()].includes("Mutex")
        )
        && process.platform !== "win32"
          ? ["-pthread"]
          : []
      ),
      ...projectBuild.nativeLinkerArguments,
    ])],
    deploymentTarget: projectBuild.deploymentTarget,
    warnings: semanticInfo.warnings,
  };
}

export function compileTestsToNative(
  source: string,
  fileName: string,
): NativeTestArtifact {
  const {
    program,
    semanticInfo,
    projectBuild,
    moduleIncludeDirectories,
  } = analyzeSource(source, fileName, {
    requireMain: false,
    includeTests: true,
  });
  const tests = program.functions.filter((declaration) => declaration.testName);
  if (tests.length === 0) {
    throw new DiagnosticError(
      fileName,
      { offset: 0, line: 1, column: 1, fileName },
      "no tests were found in this module or its imports",
      {
        code: "Z0900",
        helps: ['add a top-level `test "descriptive name" { ... }` declaration'],
      },
    );
  }
  const testProgram: Program = {
    ...program,
    functions: program.functions.filter((declaration) => declaration.name !== "main"),
  };
  const asyncDeclaration = [
    ...testProgram.functions,
    ...testProgram.structs.flatMap((declaration) => declaration.methods),
  ].find((declaration) => declaration.async);
  const generated = asyncDeclaration
    ? generateAsyncC(testProgram, fileName, semanticInfo)
    : null;
  const synchronousProgram = generated?.synchronousProgram ?? testProgram;
  const synchronousSource = generateC(
    synchronousProgram,
    fileName,
    semanticInfo,
    { testRunner: tests },
  );
  return {
    source: generated ? `${synchronousSource}\n${generated.source}\n` : synchronousSource,
    header: generateCHeader(testProgram),
    targetKind: projectBuild.targetKind,
    targetName: projectBuild.targetName,
    language: semanticInfo.objectiveC
      ? semanticInfo.cPlusPlus ? "objective-c++" : "objective-c"
      : semanticInfo.cPlusPlus ? "c++" : "c",
    frameworks: [...new Set([
      ...semanticInfo.frameworks,
      ...projectBuild.frameworks,
      ...(generated?.frameworks ?? []),
    ])],
    includeDirectories: [...new Set([
      ...projectBuild.includeDirectories,
      ...moduleIncludeDirectories,
    ])],
    nativeLibraries: projectBuild.nativeLibraries,
    nativeLinkerArguments: [...new Set([
      ...(
        (
          semanticInfo.threadSpawnCalls.size > 0
          || semanticInfo.taskScopeAsyncCalls.size > 0
          || [...semanticInfo.standardTypeBindings.values()].includes("Mutex")
        )
        && process.platform !== "win32"
          ? ["-pthread"]
          : []
      ),
      ...projectBuild.nativeLinkerArguments,
    ])],
    deploymentTarget: projectBuild.deploymentTarget,
    warnings: semanticInfo.warnings,
    testNames: tests.map((declaration) => declaration.testName!),
  };
}

export function check(source: string, fileName: string): readonly DiagnosticError[] {
  if (fileName.endsWith(".zd")) {
    const contracts = parseForeignDeclarationContracts(source, fileName);
    const declarationProbe = `import nativeContract from ${JSON.stringify(contracts.moduleSpecifier)};`;
    return analyzeSource(declarationProbe, fileName, {
      requireMain: false,
      foreignDeclarationOverrides: {
        [contracts.moduleSpecifier]: { source, fileName },
      },
    }).semanticInfo.warnings;
  }
  return analyzeSource(source, fileName, { requireMain: false }).semanticInfo.warnings;
}
