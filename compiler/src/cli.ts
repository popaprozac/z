#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Expression, FunctionDeclaration, Program, SourceLocation, Statement, StructDeclaration } from "./ast.ts";
import { canonicalTypeName } from "./canonical-type-name.ts";
import { analyzeSource, check, compileToNative, type NativeArtifact } from "./compiler.ts";
import { DiagnosticError, formatDiagnostic } from "./diagnostics.ts";
import { writeForeignDeclarationArtifact } from "./foreign-adapter.ts";
import { parseGenericType } from "./generic-types.ts";
import { lex, type Token } from "./lexer.ts";
import { loadSourceModuleBatch, type SourceModuleBatch } from "./modules.ts";
import {
  emitWithNativeFrontendLibrary,
  parseWithNativeFrontendLibrary,
  resolveStreamWithNativeFrontendLibrary,
  type NativeFrontendGraphSummary,
} from "./native-frontend.ts";
import { validateNativeFrontendSemantics } from "./native-semantic-parity.ts";
import { parse } from "./parser.ts";
import { deploymentTargetFlags, prepareProject } from "./project.ts";
import {
  decodeStage1ProgramBatchStream,
  decodeStage1TokenStream,
  encodeStage1ModuleBatch,
  type Stage1Declaration,
  type Stage1FunctionBody,
  type Stage1FunctionSignature,
  type Stage1ImportShape,
  type Stage1ModuleGraph,
  type Stage1ModuleSource,
  type Stage1TypeShape,
} from "./self-hosting.ts";

const [command, suppliedInputArgument, ...suppliedTrailingArguments] = process.argv.slice(2);
const buildUsesCurrentDirectory = command === "build"
  && (suppliedInputArgument === undefined || suppliedInputArgument.startsWith("--"));
const inputArgument = buildUsesCurrentDirectory ? "." : suppliedInputArgument;
const trailingArguments = buildUsesCurrentDirectory
  ? process.argv.slice(3)
  : suppliedTrailingArguments;
const programArguments = trailingArguments[0] === "--" ? trailingArguments.slice(1) : trailingArguments;

if (!command || !inputArgument || !["build", "check", "emit", "run", "self-host-lex", "self-host-parse", "self-host-resolve", "self-host-emit", "self-host-foreign"].includes(command)) {
  usage();
  process.exitCode = 2;
} else {
  const inputPath = resolve(inputArgument);
  try {
    if (command === "build") {
      buildStaticLibraryProject(inputPath, trailingArguments);
    } else if (command === "self-host-lex") {
      verifyStage1Lexer([inputPath, ...trailingArguments.map((argument) => resolve(argument))]);
    } else if (command === "self-host-parse") {
      const timings = trailingArguments.includes("--timings");
      verifyStage1Parser(
        [inputPath, ...trailingArguments.filter((argument) => argument !== "--timings").map((argument) => resolve(argument))],
        timings,
      );
    } else if (command === "self-host-resolve") {
      const timings = trailingArguments.includes("--timings");
      const unexpected = trailingArguments.filter((argument) => argument !== "--timings");
      if (unexpected.length > 0) throw new Error("self-host-resolve discovers local modules from its entry; pass only one .zs path");
      verifyStage1Resolver(inputPath, timings);
    } else if (command === "self-host-emit") {
      if (trailingArguments.length > 0) throw new Error("self-host-emit accepts one .zs source path");
      emitWithStage1(inputPath);
    } else if (command === "self-host-foreign") {
      if (trailingArguments.length !== 2) {
        throw new Error(
          "self-host-foreign requires a header specifier and output .zfdcl path",
        );
      }
      writeForeignDeclarationArtifact(
        inputPath,
        trailingArguments[0],
        resolve(trailingArguments[1]),
      );
    } else if (command === "check") {
      const nativeFrontend = trailingArguments.includes("--native-frontend");
      const timings = trailingArguments.includes("--timings");
      const unexpected = trailingArguments.filter((argument) => argument !== "--native-frontend" && argument !== "--timings");
      if (unexpected.length > 0) throw new Error(`unknown check option ${JSON.stringify(unexpected[0])}`);
      if (timings && !nativeFrontend) throw new Error("check --timings requires --native-frontend");
      if (nativeFrontend && !inputPath.endsWith(".zs")) {
        throw new Error("check --native-frontend currently requires a .zs source module");
      }
      const source = readFileSync(inputPath, "utf8");
      if (inputPath.endsWith(".zd")) {
        for (const warning of check(source, inputPath)) console.error(formatDiagnostic(warning, source));
      } else {
        let nativeRun: Stage1ResolverRun | null = null;
        const analysis = analyzeSource(source, inputPath, {
          requireMain: false,
          nativeFrontendResolver: nativeFrontend
            ? (sourceBatch) => {
              nativeRun = runStage1Resolver(inputPath, sourceBatch);
              return nativeRun.graph;
            }
            : undefined,
        });
        for (const warning of analysis.semanticInfo.warnings) console.error(formatDiagnostic(warning, source));
        if (nativeRun) {
          reportStage1Resolver(
            nativeRun,
            timings,
            "check-hybrid",
            analysis.nativeFrontendParityMilliseconds ?? 0,
            analysis.nativeSemanticQueryCount,
            analysis.nativeCallResolutionCount,
            analysis.nativeMethodResolutionCount,
            analysis.nativeConstructorResolutionCount,
            analysis.nativeAggregateResolutionCount,
            analysis.nativeFieldResolutionCount,
            analysis.nativeEnumVariantResolutionCount,
            analysis.nativeTypeResolutionCount,
            analysis.nativeBindingResolutionCount,
            analysis.nativeExpressionResolutionCount,
            analysis.nativeAuthoritativeFunctionResolutionCount,
            analysis.nativeAuthoritativeMethodResolutionCount,
            analysis.nativeAuthoritativeConstructorResolutionCount,
            analysis.nativeAuthoritativeAggregateResolutionCount,
            analysis.nativeAuthoritativeFieldResolutionCount,
            analysis.nativeAuthoritativeEnumVariantResolutionCount,
            analysis.nativeAuthoritativeTypeResolutionCount,
            analysis.nativeAuthoritativeBindingResolutionCount,
            analysis.nativeAuthoritativeExpressionResolutionCount,
          );
        }
      }
      console.log(`${inputPath}: ok`);
    } else {
      const source = readFileSync(inputPath, "utf8");
      const artifact = compileToNative(source, inputPath);
      for (const warning of artifact.warnings) console.error(formatDiagnostic(warning, source));
      if (command === "emit") {
        process.stdout.write(artifact.source);
      } else {
        runNative(inputPath, artifact, programArguments);
      }
    }
  } catch (error) {
    console.error(error instanceof DiagnosticError
      ? formatDiagnostic(error, readSourceIfAvailable(error.fileName))
      : error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

type Stage1ResolverRun = {
  readonly entryPath: string;
  readonly sourceBatch: SourceModuleBatch;
  readonly graph: Stage1ModuleGraph;
  readonly summary: NativeFrontendGraphSummary;
  readonly boundary: PreparedStage1ParserLibrary;
  readonly loadingMilliseconds: number;
  readonly batchMilliseconds: number;
  readonly executionMilliseconds: number;
};

function runStage1Resolver(
  inputPath: string,
  discoveredSourceBatch?: SourceModuleBatch,
): Stage1ResolverRun {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const entryPath = realpathSync(inputPath);
  const loadingStarted = performance.now();
  const sourceBatch = discoveredSourceBatch ?? (() => {
    const entrySource = readFileSync(entryPath, "utf8");
    const entryProgram = parse(lex(entrySource, entryPath), entryPath);
    return loadSourceModuleBatch(entrySource, entryProgram, entryPath);
  })();
  const loadingMilliseconds = performance.now() - loadingStarted;
  const sources: Stage1ModuleSource[] = sourceBatch.modules.map((module) => ({
    path: module.fileName,
    source: module.source,
  }));
  const bridgePath = join(projectRoot, "compiler/frontend/parser-library.zs");
  const boundary = prepareSelfHostedStage1StringLibrary(projectRoot, bridgePath);
  const batchStarted = performance.now();
  const batch = encodeStage1ModuleBatch(sources);
  const batchMilliseconds = performance.now() - batchStarted;
  const executionStarted = performance.now();
  const nativeResponse = resolveStreamWithNativeFrontendLibrary(
    boundary.libraryPath,
    entryPath,
    batch,
  );
  const executionMilliseconds = performance.now() - executionStarted;
  return {
    entryPath,
    sourceBatch,
    graph: nativeResponse.graph,
    summary: nativeResponse.summary,
    boundary,
    loadingMilliseconds,
    batchMilliseconds,
    executionMilliseconds,
  };
}

function reportStage1Resolver(
  run: Stage1ResolverRun,
  timings: boolean,
  presentation: "self-host-command" | "check-hybrid",
  parityMilliseconds: number,
  queryCount: number,
  callResolutionCount: number | null,
  methodResolutionCount = 0,
  constructorResolutionCount = 0,
  aggregateResolutionCount = 0,
  fieldResolutionCount = 0,
  enumVariantResolutionCount = 0,
  typeResolutionCount = 0,
  bindingResolutionCount = 0,
  expressionResolutionCount = 0,
  authoritativeFunctionResolutionCount = 0,
  authoritativeMethodResolutionCount = 0,
  authoritativeConstructorResolutionCount = 0,
  authoritativeAggregateResolutionCount = 0,
  authoritativeFieldResolutionCount = 0,
  authoritativeEnumVariantResolutionCount = 0,
  authoritativeTypeResolutionCount = 0,
  authoritativeBindingResolutionCount = 0,
  authoritativeExpressionResolutionCount = 0,
): void {
  const edges = run.summary.dependencyCount;
  const symbols = run.summary.symbolCount;
  const order = run.graph.dependencyOrder
    .map((index) => basename(run.graph.modules[index].path))
    .join(" -> ");
  const edgeLabel = edges === 1 ? "edge" : "edges";
  const symbolLabel = symbols === 1 ? "symbol" : "symbols";
  const resolvedCallContracts = run.summary.callResolutionCount;
  const resolvedCallContractLabel = resolvedCallContracts === 1 ? "contract" : "contracts";
  const bindingContracts = run.summary.bindingResolutionCount;
  const bindingContractLabel = bindingContracts === 1 ? "contract" : "contracts";
  const expressionContracts = run.summary.expressionResolutionCount;
  const expressionContractLabel = expressionContracts === 1 ? "contract" : "contracts";
  const subject = presentation === "check-hybrid" ? "native frontend hybrid" : "stage-1 resolver";
  console.log(`${run.entryPath}: ${subject} matches ${run.summary.moduleCount} modules, ${edges} local ${edgeLabel}, and ${symbols} ${symbolLabel} (${order})`);
  console.log(`${subject} compiler index matches ${queryCount} binding/signature queries`);
  console.log(`${subject} exports ${resolvedCallContracts} resolved call ${resolvedCallContractLabel}`);
  console.log(`${subject} exports ${bindingContracts} inferred local binding ${bindingContractLabel}`);
  console.log(`${subject} exports ${expressionContracts} expression type ${expressionContractLabel}`);
  if (callResolutionCount !== null) {
    console.log(`${subject} observes ${callResolutionCount} function, ${methodResolutionCount} method, and ${constructorResolutionCount} constructor stage-0 Z resolutions`);
    console.log(`${subject} observes ${aggregateResolutionCount} aggregate, ${fieldResolutionCount} field, and ${enumVariantResolutionCount} enum-variant stage-0 Z resolutions`);
    console.log(`${subject} observes ${typeResolutionCount} explicit type-use stage-0 Z resolutions`);
    console.log(`${subject} observes ${bindingResolutionCount} inferred local binding stage-0 Z resolutions`);
    console.log(`${subject} observes ${expressionResolutionCount} expression stage-0 Z resolutions`);
    console.log(`${subject} uses ${authoritativeFunctionResolutionCount} function, ${authoritativeMethodResolutionCount} method, and ${authoritativeConstructorResolutionCount} constructor native-authoritative contracts`);
    console.log(`${subject} uses ${authoritativeAggregateResolutionCount} aggregate, ${authoritativeFieldResolutionCount} field, and ${authoritativeEnumVariantResolutionCount} enum-variant native-authoritative contracts`);
    console.log(`${subject} uses ${authoritativeTypeResolutionCount} explicit type-use native-authoritative contracts`);
    console.log(`${subject} uses ${authoritativeBindingResolutionCount} inferred local binding native-authoritative contracts`);
    console.log(`${subject} uses ${authoritativeExpressionResolutionCount} expression native-authoritative contracts`);
  }
  if (timings) {
    const cacheState = run.boundary.cacheHit
      ? "cache hit"
      : "cache miss; seed compile + self-emission + native build + fixed-point verification included";
    console.log(`${subject} timing (${run.summary.moduleCount} modules, ${cacheState})`);
    console.log(`  boundary preparation: ${formatMilliseconds(run.boundary.prepareMilliseconds)}`);
    console.log(`  host discovery (file I/O + stage-0 import parse): ${formatMilliseconds(run.loadingMilliseconds)}`);
    console.log(`  host batch framing: ${formatMilliseconds(run.batchMilliseconds)}`);
    console.log(`  native phase (FFI + lex + parse + resolve + graph stream decode): ${formatMilliseconds(run.executionMilliseconds)}`);
    console.log(`  compiler parity + semantic queries (reused AST): ${formatMilliseconds(parityMilliseconds)}`);
  }
}

function verifyStage1Resolver(inputPath: string, timings: boolean): void {
  const run = runStage1Resolver(inputPath);
  const parityStarted = performance.now();
  const evidence = validateNativeFrontendSemantics(run.sourceBatch, run.graph);
  const parityMilliseconds = performance.now() - parityStarted;
  reportStage1Resolver(run, timings, "self-host-command", parityMilliseconds, evidence.queryCount, null);
}

function verifyStage1Parser(inputPaths: readonly string[], timings: boolean): void {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const bridgePath = join(projectRoot, "compiler/frontend/parser-library.zs");
  const boundary = prepareSelfHostedStage1StringLibrary(projectRoot, bridgePath);
  const executionStarted = performance.now();
  const nativeStream = parseWithNativeFrontendLibrary(boundary.libraryPath, inputPaths);
  const executionMilliseconds = performance.now() - executionStarted;
  const decodeStarted = performance.now();
  const stage1Programs = decodeStage1ProgramBatchStream(nativeStream);
  const decodeMilliseconds = performance.now() - decodeStarted;
  let stage0Milliseconds = 0;
  for (const inputPath of inputPaths) {
    const source = readFileSync(inputPath, "utf8");
    const stage1Program = stage1Programs.get(inputPath);
    if (!stage1Program) throw new Error(`the stage-1 parser did not emit a program for ${inputPath}`);
    const stage0Started = performance.now();
    const stage0Tokens = lex(source, inputPath);
    const stage0Program = parse(stage0Tokens, inputPath);
    stage0Milliseconds += performance.now() - stage0Started;
    const stage1 = stage1Program.declarations;
    const stage0 = stage0Declarations(stage0Program, inputPath);
    const count = Math.max(stage0.length, stage1.length);
    for (let index = 0; index < count; index += 1) {
      if (sameDeclaration(stage0[index], stage1[index])) continue;
      throw new Error(
        `stage-1 parser mismatch at declaration ${index}: stage 0 produced ${describeDeclaration(stage0[index])}, stage 1 produced ${describeDeclaration(stage1[index])}`,
      );
    }
    const stage0Imports = stage0ImportShapes(stage0Program, inputPath);
    const importCount = Math.max(stage0Imports.length, stage1Program.importShapes.length);
    for (let index = 0; index < importCount; index += 1) {
      const stage0Import = stage0Imports[index];
      const stage1Import = stage1Program.importShapes[index];
      if (sameImportShape(stage0Import, stage1Import)) continue;
      throw new Error(
        `stage-1 parser mismatch at import shape ${index}: stage 0 produced ${describeImportShape(stage0Import)}, stage 1 produced ${describeImportShape(stage1Import)}`,
      );
    }
    const stage0Signatures = stage0Program.functions.map((declaration) => stage0FunctionSignature(declaration, inputPath));
    const signatureCount = Math.max(stage0Signatures.length, stage1Program.functionSignatures.length);
    for (let index = 0; index < signatureCount; index += 1) {
      const stage0Signature = stage0Signatures[index];
      const stage1Signature = stage1Program.functionSignatures[index];
      if (sameFunctionSignature(stage0Signature, stage1Signature)) continue;
      throw new Error(
        `stage-1 parser mismatch at function signature ${index}: stage 0 produced ${describeFunctionSignature(stage0Signature)}, stage 1 produced ${describeFunctionSignature(stage1Signature)}`,
      );
    }
    const stage0Bodies = stage0Program.functions.map((declaration) => stage0FunctionBody(declaration, stage0Tokens, inputPath));
    const bodyCount = Math.max(stage0Bodies.length, stage1Program.functionBodies.length);
    for (let index = 0; index < bodyCount; index += 1) {
      const stage0Body = stage0Bodies[index];
      const stage1Body = stage1Program.functionBodies[index];
      if (sameFunctionBody(stage0Body, stage1Body)) continue;
      throw new Error(
        `stage-1 parser mismatch at function body ${index}: stage 0 produced ${describeFunctionBody(stage0Body)}, stage 1 produced ${describeFunctionBody(stage1Body)}`,
      );
    }
    const stage0Shapes = stage0TypeShapes(stage0Program, inputPath);
    const shapeCount = Math.max(stage0Shapes.length, stage1Program.typeShapes.length);
    for (let index = 0; index < shapeCount; index += 1) {
      const stage0Shape = stage0Shapes[index];
      const stage1Shape = stage1Program.typeShapes[index];
      if (sameTypeShape(stage0Shape, stage1Shape)) continue;
      throw new Error(
        `stage-1 parser mismatch at type shape ${index}: stage 0 produced ${describeTypeShape(stage0Shape)}, stage 1 produced ${describeTypeShape(stage1Shape)}`,
      );
    }
    console.log(`${inputPath}: stage-1 parser matches ${stage1.length} declarations, ${stage1Program.importShapes.length} imports, ${stage1Program.functionSignatures.length} function signatures, ${stage1Program.functionBodies.length} function bodies, and ${stage1Program.typeShapes.length} type shapes`);
  }
  if (timings) {
    const cacheState = boundary.cacheHit
      ? "cache hit"
      : "cache miss; seed compile + self-emission + native build + fixed-point verification included";
    console.log(`stage-1 parser timing (${inputPaths.length} ${inputPaths.length === 1 ? "file" : "files"}, ${cacheState})`);
    console.log(`  boundary preparation: ${formatMilliseconds(boundary.prepareMilliseconds)}`);
    console.log(`  native in-process batch (host file I/O + FFI + lex + parse + encode): ${formatMilliseconds(executionMilliseconds)}`);
    console.log(`  protocol decode: ${formatMilliseconds(decodeMilliseconds)}`);
    console.log(`  stage-0 parity parse (file I/O excluded): ${formatMilliseconds(stage0Milliseconds)}`);
  }
}

function emitWithStage1(inputPath: string): void {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const entryPath = realpathSync(inputPath);
  const entrySource = readFileSync(entryPath, "utf8");
  const entryProgram = parse(lex(entrySource, entryPath), entryPath);
  const sourceBatch = loadSourceModuleBatch(entrySource, entryProgram, entryPath);
  const sources: Stage1ModuleSource[] = sourceBatch.modules.map((module) => ({
    path: module.fileName,
    source: module.source,
  }));
  const batch = encodeStage1ModuleBatch(sources);
  const bridgePath = join(projectRoot, "compiler/frontend/parser-library.zs");
  const boundary = prepareSelfHostedStage1StringLibrary(projectRoot, bridgePath);
  process.stdout.write(emitWithNativeFrontendLibrary(boundary.libraryPath, entryPath, batch));
}

function stage0ImportShapes(program: Program, fileName: string): readonly Stage1ImportShape[] {
  return program.imports.map((declaration) => ({
    text: declaration.bindings
      ? `import {${declaration.bindings.map((binding) => (
          `${binding.importedName}@${canonicalLocation(binding.location)}`
          + (binding.localName === binding.importedName ? "" : ` as ${binding.localName}`)
        )).join(", ")}} from ${JSON.stringify(declaration.header)};`
      : `import ${declaration.moduleName} from ${JSON.stringify(declaration.header)};`,
    location: { ...declaration.location, fileName },
  }));
}

function sameImportShape(left: Stage1ImportShape | undefined, right: Stage1ImportShape | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.text === right.text
    && left.location.offset === right.location.offset
    && left.location.line === right.location.line
    && left.location.column === right.location.column;
}

function describeImportShape(shape: Stage1ImportShape | undefined): string {
  if (!shape) return "no import shape";
  return `${JSON.stringify(shape.text)} at ${shape.location.line}:${shape.location.column}`;
}

function stage0Declarations(program: Program, fileName: string): readonly Stage1Declaration[] {
  const exported = new Set(program.exports.map((item) => `${item.declarationKind}\0${item.name}`));
  return [
    ...program.imports.map((item): Stage1Declaration => ({
      kind: "import",
      name: item.header,
      exported: false,
      asynchronous: false,
      location: { ...item.location, fileName },
    })),
    ...program.functions.map((item): Stage1Declaration => ({
      kind: "function",
      name: item.name,
      exported: exported.has(`function\0${item.name}`),
      asynchronous: Boolean(item.async),
      location: { ...item.location, fileName },
    })),
    ...program.typeAliases.map((item): Stage1Declaration => ({
      kind: "type",
      name: item.name,
      exported: exported.has(`type\0${item.name}`),
      asynchronous: false,
      location: { ...item.location, fileName },
    })),
    ...program.structs.map((item): Stage1Declaration => ({
      kind: item.kind,
      name: item.name,
      exported: exported.has(`${item.kind}\0${item.name}`),
      asynchronous: false,
      location: { ...item.location, fileName },
    })),
    ...program.traits.map((item): Stage1Declaration => ({
      kind: "trait",
      name: item.name,
      exported: exported.has(`trait\0${item.name}`),
      asynchronous: false,
      location: { ...item.location, fileName },
    })),
    ...program.enums.map((item): Stage1Declaration => ({
      kind: "enum",
      name: item.name,
      exported: exported.has(`enum\0${item.name}`),
      asynchronous: false,
      location: { ...item.location, fileName },
    })),
  ].sort((left, right) => left.location.offset - right.location.offset);
}

function stage0FunctionSignature(declaration: FunctionDeclaration, fileName: string): Stage1FunctionSignature {
  return {
    text: canonicalFunctionText(declaration),
    location: { ...declaration.location, fileName },
  };
}

function canonicalFunctionText(declaration: FunctionDeclaration): string {
  const generic = canonicalTypeParameters(declaration.typeParameters, declaration.typeParameterConstraints);
  const parameters = declaration.parameters.map((parameter) => {
    const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
    return `${capability}${parameter.name}: ${canonicalTypeName(parameter.type.name)}`;
  });
  if (declaration.receiverMode) parameters.unshift(`${declaration.receiverMode} this`);
  const error = declaration.errorType ? ` throws ${canonicalTypeName(declaration.errorType.name)}` : "";
  const asynchronous = declaration.async ? "async " : "";
  const executor = canonicalExecutorAffinity(declaration.executorAffinity);
  return `${asynchronous}function ${declaration.name}${generic}(${parameters.join(", ")}): ${canonicalTypeName(declaration.returnType.name)}${error}${executor}`;
}

function canonicalExecutorAffinity(
  affinity: FunctionDeclaration["executorAffinity"] | StructDeclaration["executorAffinity"],
): string {
  if (!affinity) return "";
  const expression = affinity.executor;
  if (expression.kind === "member" && expression.object.kind === "identifier") {
    return ` on ${expression.object.name}.${expression.property}`;
  }
  return " on <executor>";
}

function stage0FunctionBody(
  declaration: FunctionDeclaration,
  tokens: readonly Token[],
  fileName: string,
): Stage1FunctionBody {
  return {
    text: `{${declaration.body.map((statement) => canonicalStatementText(statement, tokens)).join("")}}`,
    location: { ...declaration.location, fileName },
  };
}

function canonicalStatementText(statement: Statement, tokens: readonly Token[]): string {
  const location = canonicalLocation(statement.location);
  if (statement.kind === "variable") {
    const binding = statement.mutable ? "let" : "const";
    const type = statement.type
      ? `:${canonicalTypeName(statement.type.name)}@${canonicalLocation(statement.type.location)}`
      : "";
    const initializerStart = statement.initializer ? lexicalExpressionStart(tokens, statement.location.offset, "equal") : null;
    const expression = initializerStart
      ? `=${canonicalLocation(initializerStart.location)}:${canonicalExpressionTokens(tokens, initializerStart.location.offset)}#${
          canonicalExpressionTree(statement.initializer!, tokens) ?? "opaque"
        }`
      : "";
    return `variable@${location}(${binding}:${statement.name}@${canonicalLocation(statement.nameLocation)}${type}${expression})`;
  }
  if (statement.kind === "destructure") {
    const statementIndex = tokens.findIndex((token) => token.location.offset === statement.location.offset);
    const equalIndex = tokens.findIndex((token, index) => index > statementIndex && token.kind === "equal");
    const initializerStart = tokens[equalIndex + 1];
    if (statementIndex < 0 || equalIndex < 0 || !initializerStart) {
      throw new Error(`could not locate object destructuring initializer at source offset ${statement.location.offset}`);
    }
    const binding = statement.mutable ? "let" : "const";
    const fields = statement.objectBindings.map((field) => (
      `${field.fieldName}@${canonicalLocation(field.fieldLocation)}:${field.bindingName}@${canonicalLocation(field.bindingLocation)}`
    )).join(",");
    const type = statement.type ? `:${canonicalTypeName(statement.type.name)}@${canonicalLocation(statement.type.location)}` : "";
    return `destructure@${location}(${binding}:{${fields}}${type}`
      + `=${canonicalLocation(initializerStart.location)}:${canonicalExpressionTokens(tokens, initializerStart.location.offset)}#${
        canonicalExpressionTree(statement.initializer, tokens) ?? "opaque"
      })`;
  }
  if (statement.kind === "return") {
    const returnStart = statement.expression ? lexicalExpressionStart(tokens, statement.location.offset, "return") : null;
    const expression = returnStart
      ? `=${canonicalLocation(returnStart.location)}:${canonicalExpressionTokens(tokens, returnStart.location.offset)}#${
          canonicalExpressionTree(statement.expression!, tokens) ?? "opaque"
        }`
      : "";
    return `return@${location}(${expression})`;
  }
  if (statement.kind === "throw" || statement.kind === "yield" || statement.kind === "select") {
    const expressionStart = lexicalFollowingToken(tokens, statement.location.offset);
    const expression = `=${canonicalLocation(expressionStart.location)}:${canonicalExpressionTokens(
      tokens,
      expressionStart.location.offset,
    )}#${canonicalExpressionTree(statement.expression, tokens) ?? "opaque"}`;
    return `${statement.kind}@${location}(${expression})`;
  }
  if (statement.kind === "assignment") {
    const targetStartLocation = lexicalExpressionLocation(statement.target);
    const targetStart = tokens.find((token) => token.location.offset === targetStartLocation.offset);
    if (!targetStart) throw new Error(`could not locate assignment target at source offset ${statement.location.offset}`);
    const targetIndex = tokens.findIndex((token) => token.location.offset === targetStart.location.offset);
    if (targetIndex < 0) throw new Error(`could not locate assignment at source offset ${statement.location.offset}`);
    const equalIndex = tokens.findIndex((token, index) => index >= targetIndex && token.kind === "equal");
    if (equalIndex < 0) throw new Error(`could not find assignment operator at source offset ${statement.location.offset}`);
    const valueStart = tokens[equalIndex + 1];
    if (!valueStart) throw new Error(`could not find assignment value at source offset ${statement.location.offset}`);
    const targetTokens = canonicalExpressionTokenRange(tokens, targetIndex, equalIndex);
    const valueTokens = canonicalExpressionTokens(tokens, valueStart.location.offset);
    return `assignment@${canonicalLocation(targetStart.location)}(`
      + `target=${canonicalLocation(targetStart.location)}:${targetTokens}#${canonicalExpressionTree(statement.target, tokens) ?? "opaque"}`
      + `value=${canonicalLocation(valueStart.location)}:${valueTokens}#${canonicalExpressionTree(statement.expression, tokens) ?? "opaque"}`
      + ")";
  }
  if (statement.kind === "break" || statement.kind === "continue") {
    return `${statement.kind}@${location}()`;
  }
  if (statement.kind === "if") {
    const statementIndex = tokens.findIndex((token) => token.location.offset === statement.location.offset);
    const leftParenIndex = tokens.findIndex((token, index) => index > statementIndex && token.kind === "leftParen");
    if (statementIndex < 0 || leftParenIndex < 0) {
      throw new Error(`could not locate if condition at source offset ${statement.location.offset}`);
    }
    const rightParenIndex = matchingRightParenIndex(tokens, leftParenIndex, statement.location.offset, "if condition");
    const conditionStart = tokens[leftParenIndex + 1];
    const conditionTokens = canonicalExpressionTokenRange(tokens, leftParenIndex + 1, rightParenIndex);
    const condition = `=${canonicalLocation(conditionStart.location)}:${conditionTokens}#${
      canonicalExpressionTree(statement.condition, tokens) ?? "opaque"
    }`;
    const thenBranch = `then=${canonicalStatementText(statement.thenBranch, tokens)}`;
    const elseBranch = statement.elseBranch ? `else=${canonicalStatementText(statement.elseBranch, tokens)}` : "";
    return `if@${location}(${condition}${thenBranch}${elseBranch})`;
  }
  if (statement.kind === "while") {
    const statementIndex = tokens.findIndex((token) => token.location.offset === statement.location.offset);
    const leftParenIndex = tokens.findIndex((token, index) => index > statementIndex && token.kind === "leftParen");
    if (statementIndex < 0 || leftParenIndex < 0) {
      throw new Error(`could not locate while condition at source offset ${statement.location.offset}`);
    }
    const rightParenIndex = matchingRightParenIndex(tokens, leftParenIndex, statement.location.offset, "while condition");
    const conditionStart = tokens[leftParenIndex + 1];
    const conditionTokens = canonicalExpressionTokenRange(tokens, leftParenIndex + 1, rightParenIndex);
    const condition = `=${canonicalLocation(conditionStart.location)}:${conditionTokens}#${
      canonicalExpressionTree(statement.condition, tokens) ?? "opaque"
    }`;
    return `while@${location}(${condition}body=${canonicalStatementText(statement.body, tokens)})`;
  }
  if (statement.kind === "for") {
    const statementIndex = tokens.findIndex((token) => token.location.offset === statement.location.offset);
    const leftParenIndex = tokens.findIndex((token, index) => index > statementIndex && token.kind === "leftParen");
    if (statementIndex < 0 || leftParenIndex < 0) {
      throw new Error(`could not locate for-of header at source offset ${statement.location.offset}`);
    }
    const rightParenIndex = matchingRightParenIndex(tokens, leftParenIndex, statement.location.offset, "for-of header");
    const ofIndex = tokens.findIndex((token, index) => index > leftParenIndex && index < rightParenIndex && token.kind === "of");
    if (ofIndex < 0 || ofIndex + 1 >= rightParenIndex) {
      throw new Error(`could not locate for-of iterable at source offset ${statement.location.offset}`);
    }
    const iterableLocation = lexicalExpressionLocation(statement.iterable);
    const iterableIndex = tokens.findIndex((token) => token.location.offset === iterableLocation.offset);
    if (iterableIndex < 0 || iterableIndex >= rightParenIndex) {
      throw new Error(`could not locate for-of iterable expression at source offset ${statement.location.offset}`);
    }
    const iterableStart = tokens[iterableIndex];
    const iterableTokens = canonicalExpressionTokenRange(tokens, iterableIndex, rightParenIndex);
    const iterable = `${canonicalLocation(iterableStart.location)}:${iterableTokens}#${
      canonicalExpressionTree(statement.iterable, tokens) ?? "opaque"
    }`;
    const binding = statement.binding && statement.bindingLocation
      ? `${statement.binding}@${canonicalLocation(statement.bindingLocation)}`
      : `{${(statement.objectBindings ?? []).map((field) => (
        `${field.fieldName}@${canonicalLocation(field.fieldLocation)}:${field.bindingName}@${canonicalLocation(field.bindingLocation)}`
      )).join(",")}}`;
    return `${statement.errorMode === "try" ? "try-" : ""}for${statement.asynchronous ? "-await" : ""}@${location}(const:${binding}`
      + `${statement.mode === "inout" ? "inout:" : ""}iterable=${iterable}`
      + `body=${canonicalStatementText(statement.body, tokens)})`;
  }
  if (statement.kind === "match") {
    const statementIndex = tokens.findIndex((token) => token.location.offset === statement.location.offset);
    if (statementIndex < 0) throw new Error(`could not locate match at source offset ${statement.location.offset}`);
    const endIndex = matchingMatchEndIndex(tokens, statementIndex, statement.location.offset);
    const expression: Expression = {
      kind: "matchExpression",
      mode: statement.mode,
      expression: statement.expression,
      arms: statement.arms,
      location: statement.location,
    };
    return `match@${location}(=${location}:${canonicalExpressionTokenRange(tokens, statementIndex, endIndex)}#${
      canonicalExpressionTree(expression, tokens) ?? "opaque"
    })`;
  }
  if (statement.kind === "asyncScope") {
    const name = statement.name && statement.nameLocation
      ? `name=${statement.name}@${canonicalLocation(statement.nameLocation)},`
      : "";
    return `asyncScope@${location}(${name}body=${canonicalStatementText(statement.body, tokens)})`;
  }
  if (statement.kind === "unsafe") {
    return `unsafe@${location}(body=${canonicalStatementText(statement.body, tokens)})`;
  }
  if (statement.kind === "expressionStatement") {
    const expressionLocation = lexicalExpressionLocation(statement.expression);
    const expressionStart = tokens.find((token) => token.location.offset === expressionLocation.offset);
    if (!expressionStart) {
      throw new Error(`could not locate expression statement at source offset ${statement.location.offset}`);
    }
    if (statement.expression.kind === "executorPlacement") {
      const expressionIndex = tokens.findIndex((token) => token.location.offset === expressionStart.location.offset);
      const endIndex = executorPlacementEndIndex(tokens, statement.expression);
      return `expression@${canonicalLocation(expressionStart.location)}(=${canonicalLocation(expressionStart.location)}:${
        canonicalExpressionTokenRange(tokens, expressionIndex, endIndex)
      }#${canonicalExpressionTree(statement.expression, tokens) ?? "opaque"})`;
    }
    return `expression@${canonicalLocation(expressionStart.location)}(=${canonicalLocation(expressionStart.location)}:${canonicalExpressionTokens(
      tokens,
      expressionStart.location.offset,
    )}#${canonicalExpressionTree(statement.expression, tokens) ?? "opaque"})`;
  }
  if (statement.kind === "block") {
    return `block@${location}(${statement.statements.map((child) => canonicalStatementText(child, tokens)).join("")})`;
  }
  return "";
}

function lexicalExpressionLocation(expression: Expression): SourceLocation {
  if (expression.kind === "member" || expression.kind === "index") {
    return lexicalExpressionLocation(expression.object);
  }
  if (expression.kind === "call") return lexicalExpressionLocation(expression.callee);
  return expression.location;
}

function matchingRightParenIndex(
  tokens: readonly Token[],
  leftParenIndex: number,
  statementOffset: number,
  description: string,
): number {
  let depth = 1;
  let rightParenIndex = leftParenIndex + 1;
  while (rightParenIndex < tokens.length && depth > 0) {
    if (tokens[rightParenIndex].kind === "leftParen") depth += 1;
    else if (tokens[rightParenIndex].kind === "rightParen") depth -= 1;
    rightParenIndex += 1;
  }
  if (depth !== 0 || rightParenIndex - 1 <= leftParenIndex) {
    throw new Error(`could not close ${description} at source offset ${statementOffset}`);
  }
  return rightParenIndex - 1;
}

function matchingMatchEndIndex(
  tokens: readonly Token[],
  matchIndex: number,
  statementOffset: number,
): number {
  const leftParenIndex = tokens.findIndex((token, index) => index > matchIndex && token.kind === "leftParen");
  if (leftParenIndex < 0) throw new Error(`could not locate match subject at source offset ${statementOffset}`);
  const rightParenIndex = matchingRightParenIndex(tokens, leftParenIndex, statementOffset, "match subject");
  const leftBraceIndex = tokens.findIndex((token, index) => index > rightParenIndex && token.kind === "leftBrace");
  if (leftBraceIndex < 0) throw new Error(`could not locate match arms at source offset ${statementOffset}`);
  let depth = 1;
  let index = leftBraceIndex + 1;
  while (index < tokens.length && depth > 0) {
    if (tokens[index].kind === "leftBrace") depth += 1;
    else if (tokens[index].kind === "rightBrace") depth -= 1;
    index += 1;
  }
  if (depth !== 0) throw new Error(`could not close match arms at source offset ${statementOffset}`);
  return index;
}

function executorPlacementEndIndex(
  tokens: readonly Token[],
  expression: Extract<Expression, { kind: "executorPlacement" }>,
): number {
  if (expression.call) {
    const start = tokens.findIndex((token) => token.location.offset === expression.call!.location.offset);
    for (let index = start + 1; index < tokens.length; index += 1) {
      if (tokens[index].kind === "semicolon" || tokens[index].kind === "eof") return index;
    }
    throw new Error(`could not close direct executor-placement call at source offset ${expression.location.offset}`);
  }
  const leftBraceIndex = tokens.findIndex((token) => token.location.offset === expression.body.location.offset);
  if (leftBraceIndex < 0) {
    throw new Error(`could not locate executor-placement body at source offset ${expression.location.offset}`);
  }
  let depth = 1;
  let index = leftBraceIndex + 1;
  while (index < tokens.length && depth > 0) {
    if (tokens[index].kind === "leftBrace") depth += 1;
    else if (tokens[index].kind === "rightBrace") depth -= 1;
    index += 1;
  }
  if (depth !== 0) {
    throw new Error(`could not close executor-placement body at source offset ${expression.location.offset}`);
  }
  return index;
}

function lexicalFollowingToken(tokens: readonly Token[], statementOffset: number): Token {
  const statementIndex = tokens.findIndex((token) => token.location.offset === statementOffset);
  const token = statementIndex >= 0 ? tokens[statementIndex + 1] : undefined;
  if (!token || token.kind === "semicolon") {
    throw new Error(`could not find statement value at source offset ${statementOffset}`);
  }
  return token;
}

function canonicalExpressionTokenRange(
  tokens: readonly Token[],
  start: number,
  end: number,
): string {
  return tokens.slice(start, end).map((token) => (
    `${token.kind}:${Buffer.byteLength(token.text, "utf8")}:${token.text};`
  )).join("");
}

function lexicalExpressionStart(
  tokens: readonly Token[],
  statementOffset: number,
  marker: "equal" | "return",
): Token {
  const statementIndex = tokens.findIndex((token) => token.location.offset === statementOffset);
  if (statementIndex < 0) throw new Error(`could not find statement token at source offset ${statementOffset}`);
  if (marker === "return") {
    const token = tokens[statementIndex + 1];
    if (!token || token.kind === "semicolon") throw new Error(`could not find return value at source offset ${statementOffset}`);
    return token;
  }
  for (let index = statementIndex + 1; index < tokens.length; index += 1) {
    if (tokens[index].kind === "equal") {
      const token = tokens[index + 1];
      if (!token) throw new Error(`could not find variable initializer at source offset ${statementOffset}`);
      return token;
    }
    if (tokens[index].kind === "semicolon" || tokens[index].kind === "eof") break;
  }
  throw new Error(`could not find variable initializer at source offset ${statementOffset}`);
}

type FlatExpressionNode = {
  readonly kind: string;
  readonly value: string;
  readonly children: readonly number[];
  readonly labels: readonly string[];
  readonly statementBodies: readonly (readonly Statement[])[];
  readonly location: SourceLocation;
};

function canonicalExpressionTree(expression: Expression, tokens: readonly Token[]): string | null {
  const nodes: FlatExpressionNode[] = [];
  const root = flattenExpression(expression, nodes, tokens);
  if (root === null) return null;
  return `root:${root};${nodes.map((node) => (
    `${node.kind}@${canonicalLocation(node.location)}:${Buffer.byteLength(node.value, "utf8")}:${node.value}`
    + `[${node.children.join(",")}]`
    + `{${node.labels.map((label) => `${Buffer.byteLength(label, "utf8")}:${label}`).join(",")}}`
    + node.statementBodies.map((body) => `body{${body.map((statement) => canonicalStatementText(statement, tokens)).join("")}}`).join("")
    + ";"
  )).join("")}`;
}

function variantMarkerLocation(
  expression: Extract<Expression, { kind: "variantExpression" }>,
  tokens: readonly Token[],
): SourceLocation {
  const start = tokens.findIndex((token) => token.location.offset === expression.location.offset);
  if (start < 0) return expression.location;
  for (let index = start + 1; index + 1 < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.location.offset >= expression.payload.location.offset) break;
    if (
      token.kind === "dot"
      && tokens[index + 1]?.kind === "identifier"
      && tokens[index + 1]?.text === expression.variantName
    ) return tokens[index + 1]!.location;
  }
  return expression.location;
}

function flattenExpression(
  expression: Expression,
  nodes: FlatExpressionNode[],
  tokens: readonly Token[],
): number | null {
  const leaf = (kind: string, value: string): number => {
    const index = nodes.length;
    nodes.push({ kind, value, children: [], labels: [], statementBodies: [], location: expression.location });
    return index;
  };
  if (expression.kind === "identifier") {
    return leaf("identifier", parseGenericType(expression.name) ? canonicalTypeName(expression.name) : expression.name);
  }
  if (expression.kind === "number") return leaf("number", expression.value);
  if (expression.kind === "string") return leaf("string", expression.value);
  if (expression.kind === "boolean") return leaf("boolean", expression.value ? "true" : "false");
  if (expression.kind === "null") return leaf("null", "");

  const appendAt = (
    kind: string,
    value: string,
    children: readonly number[],
    labels: readonly string[],
    location: SourceLocation,
    statementBodies: readonly (readonly Statement[])[] = [],
  ): number => {
    const index = nodes.length;
    nodes.push({ kind, value, children, labels, statementBodies, location });
    return index;
  };
  const append = (kind: string, value: string, children: readonly number[], labels: readonly string[]): number => (
    appendAt(kind, value, children, labels, expression.location)
  );
  if (expression.kind === "argumentReference") {
    const binding = appendAt("argumentBinding", expression.name, [], [], expression.nameLocation);
    return append("argumentReference", expression.access, [binding], []);
  }
  if (expression.kind === "variantExpression") {
    const marker = appendAt("variantMarker", expression.variantName, [], [], variantMarkerLocation(expression, tokens));
    const payload = flattenExpression(expression.payload, nodes, tokens);
    return payload === null ? null : append("variant", expression.enumName, [marker, payload], []);
  }
  if (expression.kind === "template") {
    const children: number[] = [];
    for (const part of expression.parts) {
      if (part.kind === "text") {
        children.push(appendAt("templateText", part.value, [], [], part.location));
        continue;
      }
      const child = flattenExpression(part.expression, nodes, tokens);
      if (child === null) return null;
      children.push(child);
    }
    return append("template", "", children, []);
  }
  if (expression.kind === "closure") {
    const children = expression.parameters.map((parameter) => appendAt(
      "closureParameter",
      parameter.name,
      [],
      [parameter.mode, parameter.type ? canonicalTypeName(parameter.type.name) : ""],
      parameter.location,
    ));
    if (expression.body.kind === "block") {
      return appendAt(
        "closure",
        expression.captureMode,
        children,
        [
          expression.returnType ? canonicalTypeName(expression.returnType.name) : "",
          expression.errorType ? canonicalTypeName(expression.errorType.name) : "",
          "block",
        ],
        expression.location,
        [expression.body.statements],
      );
    }
    const body = flattenExpression(expression.body, nodes, tokens);
    if (body === null) return null;
    children.push(body);
    return append(
      "closure",
      expression.captureMode,
      children,
      [
        expression.returnType ? canonicalTypeName(expression.returnType.name) : "",
        expression.errorType ? canonicalTypeName(expression.errorType.name) : "",
        "expression",
      ],
    );
  }
  if (expression.kind === "matchExpression") {
    const subject = flattenExpression(expression.expression, nodes, tokens);
    if (subject === null) return null;
    const children = [subject];
    for (const arm of expression.arms) {
      const patternChildren: number[] = [];
      let patternKind = "none";
      if (arm.binding && arm.bindingLocation) {
        patternKind = "binding";
        patternChildren.push(appendAt("matchBinding", arm.binding, [], [], arm.bindingLocation));
      } else if (arm.objectBindings) {
        patternKind = "object";
        for (const binding of arm.objectBindings) {
          const bindingNode = appendAt("matchBinding", binding.bindingName, [], [], binding.bindingLocation);
          patternChildren.push(appendAt(
            "matchObjectField",
            binding.fieldName,
            [bindingNode],
            [],
            binding.fieldLocation,
          ));
        }
      }
      children.push(appendAt(
        "matchArm",
        arm.variantName,
        patternChildren,
        [patternKind],
        arm.location,
        [[arm.body]],
      ));
    }
    return append("match", expression.mode, children, []);
  }
  if (expression.kind === "ifExpression") {
    const condition = flattenExpression(expression.condition, nodes, tokens);
    if (condition === null) return null;
    const thenBranch = appendAt(
      "valueBlock",
      "",
      [],
      [],
      expression.thenBranch.location,
      [expression.thenBranch.statements],
    );
    const elseBranch = expression.elseBranch.kind === "ifExpression"
      ? flattenExpression(expression.elseBranch, nodes, tokens)
      : appendAt(
          "valueBlock",
          "",
          [],
          [],
          expression.elseBranch.location,
          [expression.elseBranch.statements],
        );
    if (elseBranch === null) return null;
    return append("ifExpression", "", [condition, thenBranch, elseBranch], []);
  }
  if (expression.kind === "unsafeExpression") {
    return appendAt(
      "unsafeExpression",
      "",
      [],
      [],
      expression.location,
      [expression.body.statements],
    );
  }
  if (expression.kind === "whileExpression") {
    const condition = flattenExpression(expression.condition, nodes, tokens);
    if (condition === null) return null;
    const body = appendAt(
      "valueBlock",
      "",
      [],
      [],
      expression.body.location,
      [expression.body.statements],
    );
    const elseBranch = appendAt(
      "valueBlock",
      "",
      [],
      [],
      expression.elseBranch.location,
      [expression.elseBranch.statements],
    );
    return append("whileExpression", "", [condition, body, elseBranch], []);
  }
  if (expression.kind === "forExpression") {
    const patternChildren: number[] = [];
    let patternKind = "binding";
    let patternLocation = expression.location;
    if (expression.binding && expression.bindingLocation) {
      patternLocation = expression.bindingLocation;
      patternChildren.push(appendAt(
        "matchBinding",
        expression.binding,
        [],
        [],
        expression.bindingLocation,
      ));
    } else {
      patternKind = "object";
      patternLocation = expression.objectBindings?.[0]?.fieldLocation ?? expression.location;
      for (const binding of expression.objectBindings ?? []) {
        const bindingNode = appendAt(
          "matchBinding",
          binding.bindingName,
          [],
          [],
          binding.bindingLocation,
        );
        patternChildren.push(appendAt(
          "matchObjectField",
          binding.fieldName,
          [bindingNode],
          [],
          binding.fieldLocation,
        ));
      }
    }
    const pattern = appendAt("forBinding", patternKind, patternChildren, [], patternLocation);
    const iterable = flattenExpression(expression.iterable, nodes, tokens);
    if (iterable === null) return null;
    const body = appendAt(
      "valueBlock",
      "",
      [],
      [],
      expression.body.location,
      [expression.body.statements],
    );
    const elseBranch = appendAt(
      "valueBlock",
      "",
      [],
      [],
      expression.elseBranch.location,
      [expression.elseBranch.statements],
    );
    return append("forExpression", expression.mode, [pattern, iterable, body, elseBranch], []);
  }
  if (expression.kind === "executorPlacement") {
    const marker = appendAt("executorOn", "", [], [], expression.onLocation);
    const executor = flattenExpression(expression.executor, nodes, tokens);
    if (executor === null) return null;
    const captures = expression.captures.map((capture) => appendAt(
      "executorCapture",
      capture.mode,
      [],
      [capture.name],
      capture.location,
    ));
    const call = expression.call ? flattenExpression(expression.call, nodes, tokens) : null;
    if (expression.call && call === null) return null;
    return appendAt(
      "executorPlacement",
      expression.mode,
      call === null ? [marker, executor, ...captures] : [marker, executor, call],
      [
        expression.returnType ? canonicalTypeName(expression.returnType.name) : "",
        expression.errorType ? canonicalTypeName(expression.errorType.name) : "",
        expression.call ? "call" : "",
      ],
      expression.location,
      expression.call ? [] : [expression.body.statements],
    );
  }
  if (expression.kind === "arrayExpression") {
    const children = flattenExpressions(expression.elements, nodes, tokens);
    return children ? append("arrayExpression", "", children, []) : null;
  }
  if (expression.kind === "objectExpression") {
    const children = flattenExpressions(expression.fields.map((field) => field.expression), nodes, tokens);
    return children ? append("objectExpression", "", children, expression.fields.map((field) => field.name)) : null;
  }
  if (expression.kind === "member") {
    const object = flattenExpression(expression.object, nodes, tokens);
    const property = parseGenericType(expression.property) ? canonicalTypeName(expression.property) : expression.property;
    return object === null ? null : append("member", property, [object], []);
  }
  if (expression.kind === "call") {
    const callee = flattenExpression(expression.callee, nodes, tokens);
    if (callee === null) return null;
    const arguments_ = flattenExpressions(expression.arguments, nodes, tokens);
    return arguments_ ? append("call", "", [callee, ...arguments_], expression.argumentLabels.map((label) => label ?? "")) : null;
  }
  if (expression.kind === "index") {
    const object = flattenExpression(expression.object, nodes, tokens);
    if (object === null) return null;
    const index = flattenExpression(expression.index, nodes, tokens);
    return index === null ? null : append("index", "", [object, index], []);
  }
  if (expression.kind === "unary") {
    const operand = flattenExpression(expression.operand, nodes, tokens);
    return operand === null ? null : append("unary", expression.operator, [operand], []);
  }
  if (expression.kind === "binary") {
    const left = flattenExpression(expression.left, nodes, tokens);
    if (left === null) return null;
    const right = flattenExpression(expression.right, nodes, tokens);
    return right === null ? null : append("binary", expression.operator, [left, right], []);
  }
  if (expression.kind === "conditional") {
    const condition = flattenExpression(expression.condition, nodes, tokens);
    if (condition === null) return null;
    const thenExpression = flattenExpression(expression.thenExpression, nodes, tokens);
    if (thenExpression === null) return null;
    const elseExpression = flattenExpression(expression.elseExpression, nodes, tokens);
    return elseExpression === null ? null : append("conditional", "", [condition, thenExpression, elseExpression], []);
  }
  if (expression.kind === "new") {
    const arguments_ = flattenExpressions(expression.arguments, nodes, tokens);
    return arguments_
      ? append("new", canonicalTypeName(expression.typeName), arguments_, expression.argumentLabels.map((label) => label ?? ""))
      : null;
  }
  if (
    expression.kind === "weak"
    || expression.kind === "try"
    || expression.kind === "attempt"
    || expression.kind === "await"
    || expression.kind === "spawn"
  ) {
    const operand = flattenExpression(expression.expression, nodes, tokens);
    return operand === null ? null : append(expression.kind, "", [operand], []);
  }
  return null;
}

function flattenExpressions(
  expressions: readonly Expression[],
  nodes: FlatExpressionNode[],
  tokens: readonly Token[],
): number[] | null {
  const children: number[] = [];
  for (const expression of expressions) {
    const child = flattenExpression(expression, nodes, tokens);
    if (child === null) return null;
    children.push(child);
  }
  return children;
}

function canonicalExpressionTokens(tokens: readonly Token[], startOffset: number): string {
  let index = tokens.findIndex((token) => token.location.offset === startOffset);
  if (index < 0) throw new Error(`could not find expression token at source offset ${startOffset}`);
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let templates = 0;
  let text = "";
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === "eof") throw new Error(`unterminated expression token span at source offset ${startOffset}`);
    if (token.kind === "semicolon" && parentheses === 0 && brackets === 0 && braces === 0 && templates === 0) break;
    text += `${token.kind}:${Buffer.byteLength(token.text, "utf8")}:${token.text};`;
    if (token.kind === "leftParen") parentheses += 1;
    else if (token.kind === "rightParen" && parentheses > 0) parentheses -= 1;
    else if (token.kind === "leftBracket") brackets += 1;
    else if (token.kind === "rightBracket" && brackets > 0) brackets -= 1;
    else if (token.kind === "leftBrace") braces += 1;
    else if (token.kind === "rightBrace" && braces > 0) braces -= 1;
    else if (token.kind === "templateExpressionStart") templates += 1;
    else if (token.kind === "templateExpressionEnd" && templates > 0) templates -= 1;
    index += 1;
  }
  return text;
}

function canonicalLocation(location: SourceLocation): string {
  return `${location.offset},${location.line},${location.column}`;
}

function canonicalTypeParameters(
  parameters: readonly string[] | undefined,
  constraints: FunctionDeclaration["typeParameterConstraints"],
): string {
  if (!parameters?.length) return "";
  return `<${parameters.map((parameter) => {
    const constraint = constraints?.find((candidate) => candidate.parameter === parameter);
    return constraint?.traits.length
      ? `${parameter}: ${constraint.traits.map((trait) => canonicalTypeName(trait.name)).join(" & ")}`
      : parameter;
  }).join(", ")}>`;
}

function stage0TypeShapes(program: Program, fileName: string): readonly Stage1TypeShape[] {
  return [
    ...program.typeAliases.map((declaration): Stage1TypeShape => ({
      kind: "type",
      text: `type ${declaration.name} = ${canonicalTypeName(declaration.target.name)}`,
      location: { ...declaration.location, fileName },
    })),
    ...program.structs.map((declaration): Stage1TypeShape => {
      const executor = canonicalExecutorAffinity(declaration.executorAffinity);
      const implemented = declaration.implements.length
        ? ` implements ${declaration.implements.map((trait) => canonicalTypeName(trait.name)).join(", ")}`
        : "";
      const members = [
        ...declaration.fields.map((field) => {
          const visibility = `${field.visibility} `;
          const readonly = field.readonly ? "readonly " : "";
          return `${visibility}${readonly}${field.name}: ${canonicalTypeName(field.type.name)};`;
        }),
        ...(declaration.constructor ? [
          `constructor(${canonicalParameters(declaration.constructor.parameters)})${
            declaration.constructor.errorType ? ` throws ${canonicalTypeName(declaration.constructor.errorType.name)}` : ""
          };`,
        ] : []),
        ...declaration.methods.map((method) => {
          const visibility = `${method.visibility ?? "public"} `;
          const staticMethod = method.static ? "static " : "";
          return `${visibility}${staticMethod}${canonicalFunctionText(method)};`;
        }),
        ...(declaration.deinitializer ? [`deinit@${declaration.deinitializer.location.offset};`] : []),
      ];
      return {
        kind: declaration.kind,
        text: `${declaration.kind} ${declaration.name}${canonicalTypeParameters(
          declaration.typeParameters,
          declaration.typeParameterConstraints,
        )}${executor}${implemented} {${members.length ? ` ${members.join(" ")}` : ""} }`,
        location: { ...declaration.location, fileName },
      };
    }),
    ...program.traits.map((declaration): Stage1TypeShape => ({
      kind: "trait",
      text: `trait ${declaration.name}${canonicalTypeParameters(
        declaration.typeParameters,
        declaration.typeParameterConstraints,
      )} {${declaration.methods.length
        ? ` ${declaration.methods.map((method) => `${canonicalFunctionText(method)};`).join(" ")}`
        : ""} }`,
      location: { ...declaration.location, fileName },
    })),
    ...program.enums.map((declaration): Stage1TypeShape => ({
      kind: "enum",
      text: `enum ${declaration.name} {${declaration.variants.length
        ? ` ${declaration.variants.map((variant) => (
          `${variant.name}${variant.payload ? ` ${canonicalTypeName(variant.payload.name)}` : ""};`
        )).join(" ")}`
        : ""} }`,
      location: { ...declaration.location, fileName },
    })),
  ].sort((left, right) => left.location.offset - right.location.offset);
}

function canonicalParameters(parameters: FunctionDeclaration["parameters"]): string {
  return parameters.map((parameter) => {
    const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
    return `${capability}${parameter.name}: ${canonicalTypeName(parameter.type.name)}`;
  }).join(", ");
}

function sameFunctionSignature(left: Stage1FunctionSignature | undefined, right: Stage1FunctionSignature | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.text === right.text
    && left.location.offset === right.location.offset
    && left.location.line === right.location.line
    && left.location.column === right.location.column;
}

function describeFunctionSignature(signature: Stage1FunctionSignature | undefined): string {
  if (!signature) return "no function signature";
  return `${JSON.stringify(signature.text)} at ${signature.location.line}:${signature.location.column}`;
}

function sameFunctionBody(left: Stage1FunctionBody | undefined, right: Stage1FunctionBody | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.text === right.text
    && left.location.offset === right.location.offset
    && left.location.line === right.location.line
    && left.location.column === right.location.column;
}

function describeFunctionBody(body: Stage1FunctionBody | undefined): string {
  if (!body) return "no function body";
  return `${JSON.stringify(body.text)} at ${body.location.line}:${body.location.column}`;
}

function sameTypeShape(left: Stage1TypeShape | undefined, right: Stage1TypeShape | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.kind === right.kind
    && left.text === right.text
    && left.location.offset === right.location.offset
    && left.location.line === right.location.line
    && left.location.column === right.location.column;
}

function describeTypeShape(shape: Stage1TypeShape | undefined): string {
  if (!shape) return "no type shape";
  return `${shape.kind} ${JSON.stringify(shape.text)} at ${shape.location.line}:${shape.location.column}`;
}

function sameDeclaration(left: Stage1Declaration | undefined, right: Stage1Declaration | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.kind === right.kind
    && left.name === right.name
    && left.exported === right.exported
    && left.asynchronous === right.asynchronous
    && left.location.offset === right.location.offset
    && left.location.line === right.location.line
    && left.location.column === right.location.column;
}

function describeDeclaration(declaration: Stage1Declaration | undefined): string {
  if (!declaration) return "no declaration";
  const exported = declaration.exported ? "exported " : "";
  const asynchronous = declaration.asynchronous ? "async " : "";
  return `${exported}${asynchronous}${declaration.kind} ${JSON.stringify(declaration.name)} at ${declaration.location.line}:${declaration.location.column}`;
}

function readSourceIfAvailable(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function runNative(inputPath: string, artifact: NativeArtifact, programArguments: readonly string[]): void {
  const executablePath = buildNative(inputPath, artifact);
  const execution = spawnSync(executablePath, programArguments, { stdio: "inherit" });
  if (execution.error) throw execution.error;
  if (execution.status !== 0) process.exitCode = execution.status ?? 1;
}

function buildNative(inputPath: string, artifact: NativeArtifact, outputStem?: string): string {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const cacheDirectory = join(projectRoot, ".z-cache");
  mkdirSync(cacheDirectory, { recursive: true });
  const stem = outputStem ?? basename(inputPath).replace(/\.zs$/, "");
  const sourcePath = join(cacheDirectory, `${stem}.${nativeExtension(artifact.language)}`);
  const executablePath = join(cacheDirectory, `${stem}${process.platform === "win32" ? ".exe" : ""}`);
  writeFileSync(sourcePath, artifact.source);

  const compiler = nativeCompiler(artifact.language);
  const compilerArguments = [
    ...nativeLanguageFlags(artifact.language),
    ...deploymentTargetFlags(artifact.deploymentTarget),
    "-Wall",
    "-Wextra",
    "-Werror",
    ...(artifact.deploymentTarget ? ["-Wno-deprecated-declarations"] : []),
    "-I", dirname(inputPath),
    ...artifact.includeDirectories.flatMap((directory) => ["-I", directory]),
    sourcePath,
    ...artifact.nativeLibraries,
    ...artifact.nativeLinkerArguments,
    ...artifact.frameworks.flatMap((framework) => ["-framework", framework]),
    "-o",
    executablePath,
  ];
  const compilation = process.platform === "darwin"
    ? spawnSync("xcrun", [compiler, ...compilerArguments], { encoding: "utf8" })
    : spawnSync(compiler, compilerArguments, { encoding: "utf8" });
  if (compilation.status !== 0) {
    throw new Error(compilation.stderr || "Clang failed");
  }
  return executablePath;
}

function buildStaticLibraryProject(
  projectArgument: string,
  options: readonly string[],
): void {
  const unexpected = options.filter((argument) => argument !== "--release");
  if (unexpected.length > 0) throw new Error(`unknown build option ${JSON.stringify(unexpected[0])}`);
  const release = options.includes("--release");
  const probePath = (() => {
    if (!existsSync(projectArgument)) {
      throw new Error(`project path ${JSON.stringify(projectArgument)} does not exist`);
    }
    const stats = statSync(projectArgument);
    if (stats.isDirectory()) return join(projectArgument, "__z_project_probe.zs");
    if (basename(projectArgument) === "z.json") return join(dirname(projectArgument), "__z_project_probe.zs");
    if (projectArgument.endsWith(".zs")) return projectArgument;
    throw new Error("z build expects a project directory, z.json manifest, or .zs project entry");
  })();
  const project = prepareProject(probePath);
  if (!project.manifestPath) {
    throw new Error(`z build could not find z.json from ${JSON.stringify(projectArgument)}`);
  }
  if (project.targetKind !== "static-library") {
    throw new Error('z build project target.kind must be "static-library" in the first project artifact tier');
  }
  if (!project.entryPath || !project.targetName) {
    throw new Error("static-library project configuration is missing its checked entry or name");
  }

  const source = readFileSync(project.entryPath, "utf8");
  const artifact = compileToNative(source, project.entryPath);
  if (!artifact.header) {
    throw new Error("a static-library project must declare at least one `export c function`");
  }
  const projectDirectory = dirname(project.manifestPath);
  const outputDirectory = join(projectDirectory, "build");
  const cacheDirectory = join(projectDirectory, ".z-cache", "build");
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(cacheDirectory, { recursive: true });

  const sourcePath = join(cacheDirectory, `${project.targetName}.${nativeExtension(artifact.language)}`);
  const objectPath = join(cacheDirectory, `${project.targetName}${process.platform === "win32" ? ".obj" : ".o"}`);
  const libraryName = process.platform === "win32"
    ? `${project.targetName}.lib`
    : `lib${project.targetName}.a`;
  const libraryPath = join(outputDirectory, libraryName);
  const headerPath = join(outputDirectory, `${project.targetName}.h`);
  writeFileSync(sourcePath, artifact.source);

  const compiler = nativeCompiler(artifact.language);
  const compilerArguments = [
    ...nativeLanguageFlags(artifact.language),
    ...deploymentTargetFlags(artifact.deploymentTarget),
    release ? "-O2" : "-O0",
    ...(release ? ["-DNDEBUG"] : ["-g"]),
    "-Wall",
    "-Wextra",
    "-Werror",
    ...(artifact.deploymentTarget ? ["-Wno-deprecated-declarations"] : []),
    "-I", dirname(project.entryPath),
    ...artifact.includeDirectories.flatMap((directory) => ["-I", directory]),
    "-c",
    sourcePath,
    "-o",
    objectPath,
  ];
  const compilation = process.platform === "darwin"
    ? spawnSync("xcrun", [compiler, ...compilerArguments], { encoding: "utf8" })
    : spawnSync(compiler, compilerArguments, { encoding: "utf8" });
  if (compilation.error) throw compilation.error;
  if (compilation.status !== 0) throw new Error(compilation.stderr || "Clang failed");

  const archive = process.platform === "darwin"
    ? spawnSync("xcrun", ["ar", "rcs", libraryPath, objectPath], { encoding: "utf8" })
    : spawnSync(process.platform === "win32" ? "llvm-ar" : "ar", ["rcs", libraryPath, objectPath], { encoding: "utf8" });
  if (archive.error) throw archive.error;
  if (archive.status !== 0) throw new Error(archive.stderr || "native archiver failed");
  writeFileSync(headerPath, artifact.header);
  console.log(`built ${libraryPath}`);
  console.log(`generated ${headerPath}`);
}

type PreparedStage1ParserLibrary = {
  readonly libraryPath: string;
  readonly cacheHit: boolean;
  readonly prepareMilliseconds: number;
};

function prepareStage1ParserLibrary(projectRoot: string, bridgePath: string): PreparedStage1ParserLibrary {
  const started = performance.now();
  const fingerprint = stage1BridgeFingerprint(projectRoot);
  const outputStem = `stage1-${basename(bridgePath, ".zs")}-${fingerprint.slice(0, 20)}`;
  const libraryPath = join(projectRoot, ".z-cache", `${outputStem}${nativeLibraryExtension()}`);
  if (existsSync(libraryPath)) {
    return { libraryPath, cacheHit: true, prepareMilliseconds: performance.now() - started };
  }

  const bridgeSource = readFileSync(bridgePath, "utf8");
  const artifact = compileToNative(bridgeSource, bridgePath);
  for (const warning of artifact.warnings) console.error(formatDiagnostic(warning, bridgeSource));
  const builtPath = buildNativeLibrary(bridgePath, artifact, outputStem);
  return { libraryPath: builtPath, cacheHit: false, prepareMilliseconds: performance.now() - started };
}

function prepareSelfHostedStage1StringLibrary(
  projectRoot: string,
  bridgePath: string,
): PreparedStage1ParserLibrary {
  const started = performance.now();
  const fingerprint = stage1BridgeFingerprint(projectRoot);
  const outputStem = `stage1-self-hosted-strings-${fingerprint.slice(0, 20)}`;
  const libraryPath = join(projectRoot, ".z-cache", `${outputStem}${nativeLibraryExtension()}`);
  if (existsSync(libraryPath)) {
    return { libraryPath, cacheHit: true, prepareMilliseconds: performance.now() - started };
  }

  const bootstrap = prepareStage1ParserLibrary(projectRoot, bridgePath);
  const bridgeSource = readFileSync(bridgePath, "utf8");
  const bridgeProgram = parse(lex(bridgeSource, bridgePath), bridgePath);
  const sourceBatch = loadSourceModuleBatch(bridgeSource, bridgeProgram, bridgePath);
  const batch = encodeStage1ModuleBatch(sourceBatch.modules.map((module) => ({
    path: module.fileName,
    source: module.source,
  })));
  const emitted = emitWithNativeFrontendLibrary(
    bootstrap.libraryPath,
    bridgePath,
    batch,
  );
  const builtPath = buildSelfHostedNativeLibrary(
    bridgePath,
    emitted,
    stage1StringLibraryWrapper(),
    outputStem,
  );
  const regenerated = emitWithNativeFrontendLibrary(
    builtPath,
    bridgePath,
    batch,
  );
  if (regenerated !== emitted) {
    unlinkSync(builtPath);
    const mismatch = firstDifferentByte(emitted, regenerated);
    throw new Error(
      "the self-emitted frontend did not reach a fixed point: "
      + `seed generation ${createHash("sha256").update(emitted).digest("hex")}, `
      + `self generation ${createHash("sha256").update(regenerated).digest("hex")}, `
      + `first differing byte ${mismatch}`,
    );
  }
  return { libraryPath: builtPath, cacheHit: false, prepareMilliseconds: performance.now() - started };
}

function firstDifferentByte(left: string, right: string): number {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const sharedLength = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return index;
  }
  return leftBytes.byteLength === rightBytes.byteLength ? -1 : sharedLength;
}

function buildSelfHostedNativeLibrary(
  inputPath: string,
  source: string,
  wrapper: string,
  outputStem: string,
): string {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const cacheDirectory = join(projectRoot, ".z-cache");
  mkdirSync(cacheDirectory, { recursive: true });
  const sourcePath = join(cacheDirectory, `${outputStem}.c`);
  const libraryPath = join(cacheDirectory, `${outputStem}${nativeLibraryExtension()}`);
  writeFileSync(sourcePath, `${source}\n${wrapper}`);

  const compilerArguments = [
    "-std=c11",
    ...(process.platform === "darwin"
      ? ["-dynamiclib"]
      : process.platform === "win32"
        ? ["-shared"]
        : ["-shared", "-fPIC"]),
    "-Wall",
    "-Wextra",
    "-Werror",
    "-g",
    "-I", dirname(inputPath),
    sourcePath,
    "-o",
    libraryPath,
  ];
  const compilation = process.platform === "darwin"
    ? spawnSync("xcrun", ["clang", ...compilerArguments], { encoding: "utf8" })
    : spawnSync("clang", compilerArguments, { encoding: "utf8" });
  if (compilation.status !== 0) throw new Error(compilation.stderr || "Clang failed");
  return libraryPath;
}

function buildNativeLibrary(inputPath: string, artifact: NativeArtifact, outputStem: string): string {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const cacheDirectory = join(projectRoot, ".z-cache");
  mkdirSync(cacheDirectory, { recursive: true });
  const sourcePath = join(cacheDirectory, `${outputStem}.${nativeExtension(artifact.language)}`);
  const libraryPath = join(cacheDirectory, `${outputStem}${nativeLibraryExtension()}`);
  writeFileSync(sourcePath, `${artifact.source}\n${stage1ParserLibraryWrapper()}`);

  const compiler = nativeCompiler(artifact.language);
  const compilerArguments = [
    ...nativeLanguageFlags(artifact.language),
    ...deploymentTargetFlags(artifact.deploymentTarget),
    ...(process.platform === "darwin" ? ["-dynamiclib"] : process.platform === "win32" ? ["-shared"] : ["-shared", "-fPIC"]),
    "-Wall",
    "-Wextra",
    "-Werror",
    ...(artifact.deploymentTarget ? ["-Wno-deprecated-declarations"] : []),
    "-I", dirname(inputPath),
    ...artifact.includeDirectories.flatMap((directory) => ["-I", directory]),
    sourcePath,
    ...artifact.nativeLibraries,
    ...artifact.nativeLinkerArguments,
    ...artifact.frameworks.flatMap((framework) => ["-framework", framework]),
    "-o",
    libraryPath,
  ];
  const compilation = process.platform === "darwin"
    ? spawnSync("xcrun", [compiler, ...compilerArguments], { encoding: "utf8" })
    : spawnSync(compiler, compilerArguments, { encoding: "utf8" });
  if (compilation.status !== 0) throw new Error(compilation.stderr || "Clang failed");
  return libraryPath;
}

function nativeLibraryExtension(): string {
  if (process.platform === "darwin") return ".dylib";
  if (process.platform === "win32") return ".dll";
  return ".so";
}

function stage1StringLibraryWrapper(): string {
  return `#if defined(_WIN32)
#define Z_STAGE1_EXPORT __declspec(dllexport)
#else
#define Z_STAGE1_EXPORT __attribute__((visibility("default")))
#endif

static void *z_stage1_copy_string(Z_String result) {
  char *copy = (char *)malloc(result.length + 1);
  if (copy == NULL) abort();
  if (result.length > 0) memcpy(copy, result.data, result.length);
  copy[result.length] = '\\0';
  if (result.capacity > 0) free((void *)result.data);
  return copy;
}

Z_STAGE1_EXPORT void *z_stage1_parse(
  const uint8_t *path_data,
  uintptr_t path_length,
  const uint8_t *source_data,
  uintptr_t source_length
) {
  Z_String path = { (const char *)path_data, path_length, 0 };
  Z_String source = { (const char *)source_data, source_length, 0 };
  return z_stage1_copy_string(stage1Parse(&path, &source));
}

Z_STAGE1_EXPORT void *z_stage1_emit(
  const uint8_t *entry_data,
  uintptr_t entry_length,
  const uint8_t *batch_data,
  uintptr_t batch_length
) {
  Z_String entry = { (const char *)entry_data, entry_length, 0 };
  Z_String batch = { (const char *)batch_data, batch_length, 0 };
  return z_stage1_copy_string(stage1Emit(&entry, &batch));
}

Z_STAGE1_EXPORT void *z_stage1_resolve_stream(
  const uint8_t *entry_data,
  uintptr_t entry_length,
  const uint8_t *batch_data,
  uintptr_t batch_length
) {
  Z_String entry = { (const char *)entry_data, entry_length, 0 };
  Z_String batch = { (const char *)batch_data, batch_length, 0 };
  return z_stage1_copy_string(stage1ResolveStream(&entry, &batch));
}

Z_STAGE1_EXPORT void z_stage1_free(void *pointer) {
  free(pointer);
}`;
}

function stage1ParserLibraryWrapper(): string {
  return `#if defined(_WIN32)
#define Z_STAGE1_EXPORT __declspec(dllexport)
#else
#define Z_STAGE1_EXPORT __attribute__((visibility("default")))
#endif

static void *z_stage1_clone_string(Z_String result) {
  char *copy = (char *)malloc(result.length + 1);
  if (copy == NULL) abort();
  if (result.length > 0) memcpy(copy, result.data, result.length);
  copy[result.length] = '\\0';
  return copy;
}

static void *z_stage1_copy_string(Z_String result) {
  void *copy = z_stage1_clone_string(result);
  if (result.capacity > 0) free((void *)result.data);
  return copy;
}

typedef struct {
  char *error_payload;
  Z_Stage1ResolveResponse result;
} Z_Stage1ResolveHandle;

typedef struct {
  uint64_t name_data;
  uint64_t name_length;
  uint64_t imported_name_data;
  uint64_t imported_name_length;
  uint64_t kind;
  uint64_t exported;
  uint64_t has_target;
  uint64_t target;
  uint64_t offset;
  uint64_t line;
  uint64_t column;
} Z_Stage1SymbolRecord;

typedef struct {
  uint64_t module_index;
  uint64_t symbol_index;
  uint64_t asynchronous;
  uint64_t return_type_data;
  uint64_t return_type_length;
  uint64_t error_type_data;
  uint64_t error_type_length;
  uint64_t executor_affinity_data;
  uint64_t executor_affinity_length;
  uint64_t type_parameter_count;
  uint64_t parameter_count;
  uint64_t constraint_count;
} Z_Stage1FunctionSignatureRecord;

typedef struct {
  uint64_t module_index;
  uint64_t symbol_index;
  uint64_t kind;
  uint64_t index;
  uint64_t first_data;
  uint64_t first_length;
  uint64_t second_data;
  uint64_t second_length;
} Z_Stage1FunctionSignatureItemRecord;

typedef struct {
  uint64_t module_index;
  uint64_t symbol_index;
  uint64_t executor_affinity_data;
  uint64_t executor_affinity_length;
  uint64_t custom_deinit;
  uint64_t custom_constructor;
  uint64_t type_parameter_count;
  uint64_t constraint_count;
  uint64_t implemented_trait_count;
  uint64_t field_count;
  uint64_t method_count;
  uint64_t variant_count;
} Z_Stage1TypeSignatureRecord;

typedef struct {
  uint64_t module_index;
  uint64_t symbol_index;
  uint64_t kind;
  uint64_t index;
  uint64_t first_data;
  uint64_t first_length;
  uint64_t second_data;
  uint64_t second_length;
  uint64_t third_data;
  uint64_t third_length;
  uint64_t flag;
} Z_Stage1TypeSignatureItemRecord;

typedef struct {
  uint64_t module_index;
  uint64_t symbol_index;
  uint64_t kind;
  uint64_t index;
  uint64_t name_data;
  uint64_t name_length;
  uint64_t static_method;
  uint64_t visibility_data;
  uint64_t visibility_length;
  uint64_t receiver_mode_data;
  uint64_t receiver_mode_length;
  uint64_t asynchronous;
  uint64_t return_type_data;
  uint64_t return_type_length;
  uint64_t error_type_data;
  uint64_t error_type_length;
  uint64_t executor_affinity_data;
  uint64_t executor_affinity_length;
  uint64_t type_parameter_count;
  uint64_t parameter_count;
  uint64_t constraint_count;
} Z_Stage1MemberSignatureRecord;

typedef struct {
  uint64_t module_index;
  uint64_t symbol_index;
  uint64_t member_kind;
  uint64_t member_index;
  uint64_t item_kind;
  uint64_t item_index;
  uint64_t first_data;
  uint64_t first_length;
  uint64_t second_data;
  uint64_t second_length;
} Z_Stage1MemberSignatureItemRecord;

typedef struct {
  uint64_t module_index;
  uint64_t resolution_index;
  uint64_t offset;
  uint64_t line;
  uint64_t column;
  uint64_t target_module;
  uint64_t target_symbol;
  uint64_t kind_data;
  uint64_t kind_length;
  uint64_t target_name_data;
  uint64_t target_name_length;
  uint64_t asynchronous;
  uint64_t receiver_mode_data;
  uint64_t receiver_mode_length;
  uint64_t return_type_data;
  uint64_t return_type_length;
  uint64_t error_type_data;
  uint64_t error_type_length;
  uint64_t type_count;
  uint64_t parameter_count;
} Z_Stage1CallResolutionRecord;

typedef struct {
  uint64_t module_index;
  uint64_t resolution_index;
  uint64_t kind;
  uint64_t index;
  uint64_t first_data;
  uint64_t first_length;
  uint64_t second_data;
  uint64_t second_length;
} Z_Stage1CallResolutionItemRecord;

typedef struct {
  uint64_t module_index;
  uint64_t resolution_index;
  uint64_t offset;
  uint64_t line;
  uint64_t column;
  uint64_t name_data;
  uint64_t name_length;
  uint64_t mutable_binding;
  uint64_t type_name_data;
  uint64_t type_name_length;
  uint64_t identity_count;
} Z_Stage1BindingResolutionRecord;

typedef struct {
  uint64_t module_index;
  uint64_t resolution_index;
  uint64_t offset;
  uint64_t line;
  uint64_t column;
  uint64_t type_name_data;
  uint64_t type_name_length;
  uint64_t target_name_data;
  uint64_t target_name_length;
  uint64_t identity_count;
} Z_Stage1ExpressionResolutionRecord;

typedef struct {
  uint64_t module_index;
  uint64_t evidence_kind;
  uint64_t resolution_index;
  uint64_t identity_index;
  uint64_t path_data;
  uint64_t path_length;
  uint64_t target_module;
  uint64_t target_symbol;
} Z_Stage1TypeIdentityRecord;

Z_STAGE1_EXPORT void *z_stage1_parse(
  const uint8_t *path_data,
  uintptr_t path_length,
  const uint8_t *source_data,
  uintptr_t source_length
) {
  Z_String path = { (const char *)path_data, path_length, 0 };
  Z_String source = { (const char *)source_data, source_length, 0 };
  return z_stage1_copy_string(stage1Parse(&path, &source));
}

Z_STAGE1_EXPORT void *z_stage1_emit(
  const uint8_t *entry_data,
  uintptr_t entry_length,
  const uint8_t *batch_data,
  uintptr_t batch_length
) {
  Z_String entry = { (const char *)entry_data, entry_length, 0 };
  Z_String batch = { (const char *)batch_data, batch_length, 0 };
  return z_stage1_copy_string(stage1Emit(&entry, &batch));
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_api_version(void) {
  return 1;
}

Z_STAGE1_EXPORT void *z_stage1_resolve(
  const uint8_t *entry_data,
  uintptr_t entry_length,
  const uint8_t *batch_data,
  uintptr_t batch_length
) {
  Z_String entry = { (const char *)entry_data, entry_length, 0 };
  Z_String batch = { (const char *)batch_data, batch_length, 0 };
  Z_Stage1ResolveResponse result = stage1Resolve(&entry, &batch);
  Z_Stage1ResolveHandle *response = (Z_Stage1ResolveHandle *)malloc(sizeof(Z_Stage1ResolveHandle));
  if (response == NULL) abort();
  response->error_payload = result.success
    ? NULL
    : (char *)z_stage1_clone_string(result.error);
  response->result = result;
  return response;
}

Z_STAGE1_EXPORT uint8_t z_stage1_resolve_success(const void *pointer) {
  return ((const Z_Stage1ResolveHandle *)pointer)->result.success ? 1 : 0;
}

Z_STAGE1_EXPORT const void *z_stage1_resolve_error_payload(const void *pointer) {
  return ((const Z_Stage1ResolveHandle *)pointer)->error_payload;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_entry(const void *pointer) {
  return ((const Z_Stage1ResolveHandle *)pointer)->result.graph.entry;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_module_count(const void *pointer) {
  return ((const Z_Stage1ResolveHandle *)pointer)->result.graph.moduleCount;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_dependency_count(const void *pointer) {
  return ((const Z_Stage1ResolveHandle *)pointer)->result.graph.dependencyCount;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_dependency_order_count(const void *pointer) {
  return ((const Z_Stage1ResolveHandle *)pointer)->result.graph.dependencyOrderCount;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_symbol_count(const void *pointer) {
  return ((const Z_Stage1ResolveHandle *)pointer)->result.graph.symbolCount;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_function_signature_count(
  const void *pointer
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t count = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (stage1SymbolHasFunctionSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        count += 1;
      }
    }
  }
  return count;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_function_signature_item_count(
  const void *pointer
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t count = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (!stage1SymbolHasFunctionSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        continue;
      }
      count += response->result.graph.resolved.modules.data[module_index]
        .symbols.data[symbol_index].functionSignature.data.some.typeParameters.length;
      count += response->result.graph.resolved.modules.data[module_index]
        .symbols.data[symbol_index].functionSignature.data.some.parameterTypes.length;
      count += response->result.graph.resolved.modules.data[module_index]
        .symbols.data[symbol_index].functionSignature.data.some
        .typeParameterConstraints.length;
    }
  }
  return count;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_type_signature_count(
  const void *pointer
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t count = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (stage1SymbolHasTypeSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        count += 1;
      }
    }
  }
  return count;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_type_signature_item_count(
  const void *pointer
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t count = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (!stage1SymbolHasTypeSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        continue;
      }
      count += response->result.graph.resolved.modules.data[module_index]
        .symbols.data[symbol_index].typeSignature.data.some.typeParameters.length;
      count += response->result.graph.resolved.modules.data[module_index]
        .symbols.data[symbol_index].typeSignature.data.some
        .typeParameterConstraints.length;
      count += response->result.graph.resolved.modules.data[module_index]
        .symbols.data[symbol_index].typeSignature.data.some.implementedTraits.length;
      count += response->result.graph.resolved.modules.data[module_index]
        .symbols.data[symbol_index].typeSignature.data.some.fields.length;
      count += response->result.graph.resolved.modules.data[module_index]
        .symbols.data[symbol_index].typeSignature.data.some.variants.length;
    }
  }
  return count;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_member_signature_count(
  const void *pointer
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t count = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (!stage1SymbolHasTypeSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        continue;
      }
      count += response->result.graph.resolved.modules.data[module_index]
        .symbols.data[symbol_index].typeSignature.data.some.methods.length;
      if (stage1TypeHasConstructorSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        count += 1;
      }
    }
  }
  return count;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_member_signature_item_count(
  const void *pointer
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t count = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (!stage1SymbolHasTypeSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        continue;
      }
      if (stage1TypeHasConstructorSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        count += response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some
          .constructorSignature.data.some.typeParameters.length;
        count += response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some
          .constructorSignature.data.some.parameterTypes.length;
        count += response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some
          .constructorSignature.data.some.typeParameterConstraints.length;
      }
      for (
        uintptr_t method_index = 0;
        method_index < response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some.methods.length;
        method_index += 1
      ) {
        count += response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some
          .methods.data[method_index].signature.typeParameters.length;
        count += response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some
          .methods.data[method_index].signature.parameterTypes.length;
        count += response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some
          .methods.data[method_index].signature.typeParameterConstraints.length;
      }
    }
  }
  return count;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_call_resolution_item_count(
  const void *pointer
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t count = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t resolution_index = 0;
      resolution_index < response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.callResolutions.length;
      resolution_index += 1
    ) {
      count += response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.callResolutions.data[resolution_index].typeParameters.length;
      count += response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.callResolutions.data[resolution_index].parameterTypes.length;
    }
  }
  return count;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_type_identity_count(
  const void *pointer
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t count = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t resolution_index = 0;
      resolution_index < response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.bindingResolutions.length;
      resolution_index += 1
    ) {
      count += response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.bindingResolutions.data[resolution_index].typeIdentities.length;
    }
    for (
      uintptr_t resolution_index = 0;
      resolution_index < response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.expressionResolutions.length;
      resolution_index += 1
    ) {
      count += response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.expressionResolutions.data[resolution_index]
        .typeIdentities.length;
    }
  }
  return count;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_call_resolution_count(const void *pointer) {
  return ((const Z_Stage1ResolveHandle *)pointer)->result.graph.callResolutionCount;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_binding_resolution_count(const void *pointer) {
  return ((const Z_Stage1ResolveHandle *)pointer)->result.graph.bindingResolutionCount;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_expression_resolution_count(const void *pointer) {
  return ((const Z_Stage1ResolveHandle *)pointer)->result.graph.expressionResolutionCount;
}

Z_STAGE1_EXPORT const void *z_stage1_resolve_module_path_data(
  const void *pointer,
  uintptr_t module_index
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  if (module_index >= response->result.graph.resolved.modules.length) return NULL;
  return response->result.graph.resolved.modules.data[module_index].path.data;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_module_path_length(
  const void *pointer,
  uintptr_t module_index
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  if (module_index >= response->result.graph.resolved.modules.length) return 0;
  return response->result.graph.resolved.modules.data[module_index].path.length;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_module_dependency_count(
  const void *pointer,
  uintptr_t module_index
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  if (module_index >= response->result.graph.resolved.modules.length) return 0;
  return response->result.graph.resolved.modules.data[module_index].dependencies.length;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_module_dependency(
  const void *pointer,
  uintptr_t module_index,
  uintptr_t dependency_index
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  if (module_index >= response->result.graph.resolved.modules.length) return 0;
  const Z_DynamicArray___z_dynamic_array_3a_usize *dependencies =
    &response->result.graph.resolved.modules.data[module_index].dependencies;
  if (dependency_index >= dependencies->length) return 0;
  return dependencies->data[dependency_index];
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_dependency_order(
  const void *pointer,
  uintptr_t order_index
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  if (order_index >= response->result.graph.resolved.dependencyOrder.length) return 0;
  return response->result.graph.resolved.dependencyOrder.data[order_index];
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_module_symbol_count(
  const void *pointer,
  uintptr_t module_index
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  if (module_index >= response->result.graph.resolved.modules.length) return 0;
  return response->result.graph.resolved.modules.data[module_index].symbols.length;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_copy_symbol_records(
  const void *pointer,
  Z_Stage1SymbolRecord *records,
  uintptr_t capacity
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t written = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (written >= capacity) return written;
      const uintptr_t symbol_offset = symbol_index;
      records[written] = (Z_Stage1SymbolRecord){
        .name_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_offset].name.data,
        .name_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_offset].name.length,
        .imported_name_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_offset].importedName.data,
        .imported_name_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_offset].importedName.length,
        .kind = (uint64_t)stage1SymbolKindCode(
          &response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_offset]
        ),
        .exported = response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_offset].exported ? 1 : 0,
        .has_target = stage1SymbolHasTarget(
          &response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_offset]
        ) ? 1 : 0,
        .target = (uint64_t)stage1SymbolTarget(
          &response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_offset]
        ),
        .offset = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_offset].offset,
        .line = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_offset].line,
        .column = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_offset].column,
      };
      written += 1;
    }
  }
  return written;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_copy_function_signature_records(
  const void *pointer,
  Z_Stage1FunctionSignatureRecord *records,
  uintptr_t capacity
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t written = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (!stage1SymbolHasFunctionSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        continue;
      }
      if (written >= capacity) return written;
      records[written] = (Z_Stage1FunctionSignatureRecord){
        .module_index = (uint64_t)module_index,
        .symbol_index = (uint64_t)symbol_index,
        .asynchronous = response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].functionSignature.data.some.asynchronous ? 1 : 0,
        .return_type_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .functionSignature.data.some.returnType.data,
        .return_type_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .functionSignature.data.some.returnType.length,
        .error_type_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .functionSignature.data.some.errorType.data,
        .error_type_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .functionSignature.data.some.errorType.length,
        .executor_affinity_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .functionSignature.data.some.executorAffinity.data,
        .executor_affinity_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .functionSignature.data.some.executorAffinity.length,
        .type_parameter_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .functionSignature.data.some.typeParameters.length,
        .parameter_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .functionSignature.data.some.parameterTypes.length,
        .constraint_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .functionSignature.data.some.typeParameterConstraints.length,
      };
      written += 1;
    }
  }
  return written;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_copy_function_signature_item_records(
  const void *pointer,
  Z_Stage1FunctionSignatureItemRecord *records,
  uintptr_t capacity
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t written = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (!stage1SymbolHasFunctionSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        continue;
      }
      for (
        uintptr_t item_index = 0;
        item_index < response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].functionSignature.data.some.typeParameters.length;
        item_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1FunctionSignatureItemRecord){
          .module_index = (uint64_t)module_index,
          .symbol_index = (uint64_t)symbol_index,
          .kind = 0,
          .index = (uint64_t)item_index,
          .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .functionSignature.data.some.typeParameters.data[item_index].data,
          .first_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .functionSignature.data.some.typeParameters.data[item_index].length,
          .second_data = 0,
          .second_length = 0,
        };
        written += 1;
      }
      for (
        uintptr_t item_index = 0;
        item_index < response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].functionSignature.data.some.parameterTypes.length;
        item_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1FunctionSignatureItemRecord){
          .module_index = (uint64_t)module_index,
          .symbol_index = (uint64_t)symbol_index,
          .kind = 1,
          .index = (uint64_t)item_index,
          .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .functionSignature.data.some.parameterModes.data[item_index].data,
          .first_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .functionSignature.data.some.parameterModes.data[item_index].length,
          .second_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .functionSignature.data.some.parameterTypes.data[item_index].data,
          .second_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .functionSignature.data.some.parameterTypes.data[item_index].length,
        };
        written += 1;
      }
      for (
        uintptr_t item_index = 0;
        item_index < response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].functionSignature.data.some
          .typeParameterConstraints.length;
        item_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1FunctionSignatureItemRecord){
          .module_index = (uint64_t)module_index,
          .symbol_index = (uint64_t)symbol_index,
          .kind = 2,
          .index = (uint64_t)item_index,
          .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .functionSignature.data.some.typeParameterConstraints
            .data[item_index].parameter.data,
          .first_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .functionSignature.data.some.typeParameterConstraints
            .data[item_index].parameter.length,
          .second_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .functionSignature.data.some.typeParameterConstraints
            .data[item_index].traitName.data,
          .second_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .functionSignature.data.some.typeParameterConstraints
            .data[item_index].traitName.length,
        };
        written += 1;
      }
    }
  }
  return written;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_copy_type_signature_records(
  const void *pointer,
  Z_Stage1TypeSignatureRecord *records,
  uintptr_t capacity
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t written = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (!stage1SymbolHasTypeSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        continue;
      }
      if (written >= capacity) return written;
      records[written] = (Z_Stage1TypeSignatureRecord){
        .module_index = (uint64_t)module_index,
        .symbol_index = (uint64_t)symbol_index,
        .executor_affinity_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .typeSignature.data.some.executorAffinity.data,
        .executor_affinity_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .typeSignature.data.some.executorAffinity.length,
        .custom_deinit = response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some.customDeinit ? 1 : 0,
        .custom_constructor = response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some.customConstructor ? 1 : 0,
        .type_parameter_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .typeSignature.data.some.typeParameters.length,
        .constraint_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .typeSignature.data.some.typeParameterConstraints.length,
        .implemented_trait_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .typeSignature.data.some.implementedTraits.length,
        .field_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .typeSignature.data.some.fields.length,
        .method_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .typeSignature.data.some.methods.length,
        .variant_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
          .typeSignature.data.some.variants.length,
      };
      written += 1;
    }
  }
  return written;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_copy_type_signature_item_records(
  const void *pointer,
  Z_Stage1TypeSignatureItemRecord *records,
  uintptr_t capacity
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t written = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (!stage1SymbolHasTypeSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        continue;
      }
      for (
        uintptr_t item_index = 0;
        item_index < response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some.typeParameters.length;
        item_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1TypeSignatureItemRecord){
          .module_index = (uint64_t)module_index,
          .symbol_index = (uint64_t)symbol_index,
          .kind = 0,
          .index = (uint64_t)item_index,
          .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.typeParameters.data[item_index].data,
          .first_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.typeParameters.data[item_index].length,
          .second_data = 0,
          .second_length = 0,
          .third_data = 0,
          .third_length = 0,
          .flag = 0,
        };
        written += 1;
      }
      for (
        uintptr_t item_index = 0;
        item_index < response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some
          .typeParameterConstraints.length;
        item_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1TypeSignatureItemRecord){
          .module_index = (uint64_t)module_index,
          .symbol_index = (uint64_t)symbol_index,
          .kind = 1,
          .index = (uint64_t)item_index,
          .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.typeParameterConstraints
            .data[item_index].parameter.data,
          .first_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.typeParameterConstraints
            .data[item_index].parameter.length,
          .second_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.typeParameterConstraints
            .data[item_index].traitName.data,
          .second_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.typeParameterConstraints
            .data[item_index].traitName.length,
          .third_data = 0,
          .third_length = 0,
          .flag = 0,
        };
        written += 1;
      }
      for (
        uintptr_t item_index = 0;
        item_index < response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some.implementedTraits.length;
        item_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1TypeSignatureItemRecord){
          .module_index = (uint64_t)module_index,
          .symbol_index = (uint64_t)symbol_index,
          .kind = 2,
          .index = (uint64_t)item_index,
          .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.implementedTraits.data[item_index].data,
          .first_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.implementedTraits.data[item_index].length,
          .second_data = 0,
          .second_length = 0,
          .third_data = 0,
          .third_length = 0,
          .flag = 0,
        };
        written += 1;
      }
      for (
        uintptr_t item_index = 0;
        item_index < response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some.fields.length;
        item_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1TypeSignatureItemRecord){
          .module_index = (uint64_t)module_index,
          .symbol_index = (uint64_t)symbol_index,
          .kind = 3,
          .index = (uint64_t)item_index,
          .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.fields.data[item_index].name.data,
          .first_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.fields.data[item_index].name.length,
          .second_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.fields.data[item_index].typeName.data,
          .second_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.fields.data[item_index].typeName.length,
          .third_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.fields.data[item_index].visibility.data,
          .third_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.fields.data[item_index].visibility.length,
          .flag = response->result.graph.resolved.modules.data[module_index]
            .symbols.data[symbol_index].typeSignature.data.some
            .fields.data[item_index].readonlyField ? 1 : 0,
        };
        written += 1;
      }
      for (
        uintptr_t item_index = 0;
        item_index < response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some.variants.length;
        item_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1TypeSignatureItemRecord){
          .module_index = (uint64_t)module_index,
          .symbol_index = (uint64_t)symbol_index,
          .kind = 4,
          .index = (uint64_t)item_index,
          .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.variants.data[item_index].name.data,
          .first_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.variants.data[item_index].name.length,
          .second_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.variants.data[item_index].payloadType.data,
          .second_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.variants.data[item_index].payloadType.length,
          .third_data = 0,
          .third_length = 0,
          .flag = 0,
        };
        written += 1;
      }
    }
  }
  return written;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_copy_member_signature_records(
  const void *pointer,
  Z_Stage1MemberSignatureRecord *records,
  uintptr_t capacity
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t written = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (!stage1SymbolHasTypeSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        continue;
      }
      if (stage1TypeHasConstructorSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1MemberSignatureRecord){
          .module_index = (uint64_t)module_index,
          .symbol_index = (uint64_t)symbol_index,
          .kind = 0,
          .index = 0,
          .name_data = 0,
          .name_length = 0,
          .static_method = 0,
          .visibility_data = 0,
          .visibility_length = 0,
          .receiver_mode_data = 0,
          .receiver_mode_length = 0,
          .asynchronous = response->result.graph.resolved.modules.data[module_index]
            .symbols.data[symbol_index].typeSignature.data.some
            .constructorSignature.data.some.asynchronous ? 1 : 0,
          .return_type_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.constructorSignature.data.some.returnType.data,
          .return_type_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.constructorSignature.data.some.returnType.length,
          .error_type_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.constructorSignature.data.some.errorType.data,
          .error_type_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.constructorSignature.data.some.errorType.length,
          .executor_affinity_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.constructorSignature.data.some
            .executorAffinity.data,
          .executor_affinity_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.constructorSignature.data.some
            .executorAffinity.length,
          .type_parameter_count = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.constructorSignature.data.some
            .typeParameters.length,
          .parameter_count = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.constructorSignature.data.some
            .parameterTypes.length,
          .constraint_count = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.constructorSignature.data.some
            .typeParameterConstraints.length,
        };
        written += 1;
      }
      for (
        uintptr_t method_index = 0;
        method_index < response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some.methods.length;
        method_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1MemberSignatureRecord){
          .module_index = (uint64_t)module_index,
          .symbol_index = (uint64_t)symbol_index,
          .kind = 1,
          .index = (uint64_t)method_index,
          .name_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index].name.data,
          .name_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index].name.length,
          .static_method = response->result.graph.resolved.modules.data[module_index]
            .symbols.data[symbol_index].typeSignature.data.some
            .methods.data[method_index].staticMethod ? 1 : 0,
          .visibility_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index].visibility.data,
          .visibility_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index].visibility.length,
          .receiver_mode_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index].receiverMode.data,
          .receiver_mode_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index].receiverMode.length,
          .asynchronous = response->result.graph.resolved.modules.data[module_index]
            .symbols.data[symbol_index].typeSignature.data.some
            .methods.data[method_index].signature.asynchronous ? 1 : 0,
          .return_type_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index].signature.returnType.data,
          .return_type_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index].signature.returnType.length,
          .error_type_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index].signature.errorType.data,
          .error_type_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index].signature.errorType.length,
          .executor_affinity_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index]
            .signature.executorAffinity.data,
          .executor_affinity_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index]
            .signature.executorAffinity.length,
          .type_parameter_count = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index]
            .signature.typeParameters.length,
          .parameter_count = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index]
            .signature.parameterTypes.length,
          .constraint_count = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].symbols.data[symbol_index]
            .typeSignature.data.some.methods.data[method_index]
            .signature.typeParameterConstraints.length,
        };
        written += 1;
      }
    }
  }
  return written;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_copy_member_signature_item_records(
  const void *pointer,
  Z_Stage1MemberSignatureItemRecord *records,
  uintptr_t capacity
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t written = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t symbol_index = 0;
      symbol_index
        < response->result.graph.resolved.modules.data[module_index].symbols.length;
      symbol_index += 1
    ) {
      if (!stage1SymbolHasTypeSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        continue;
      }
      if (stage1TypeHasConstructorSignature(
        &response->result.graph.resolved
          .modules.data[module_index].symbols.data[symbol_index]
      )) {
        for (
          uintptr_t item_index = 0;
          item_index < response->result.graph.resolved.modules.data[module_index]
            .symbols.data[symbol_index].typeSignature.data.some
            .constructorSignature.data.some.typeParameters.length;
          item_index += 1
        ) {
          if (written >= capacity) return written;
          records[written] = (Z_Stage1MemberSignatureItemRecord){
            .module_index = (uint64_t)module_index,
            .symbol_index = (uint64_t)symbol_index,
            .member_kind = 0,
            .member_index = 0,
            .item_kind = 0,
            .item_index = (uint64_t)item_index,
            .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.constructorSignature.data.some
              .typeParameters.data[item_index].data,
            .first_length = (uint64_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.constructorSignature.data.some
              .typeParameters.data[item_index].length,
            .second_data = 0,
            .second_length = 0,
          };
          written += 1;
        }
        for (
          uintptr_t item_index = 0;
          item_index < response->result.graph.resolved.modules.data[module_index]
            .symbols.data[symbol_index].typeSignature.data.some
            .constructorSignature.data.some.parameterTypes.length;
          item_index += 1
        ) {
          if (written >= capacity) return written;
          records[written] = (Z_Stage1MemberSignatureItemRecord){
            .module_index = (uint64_t)module_index,
            .symbol_index = (uint64_t)symbol_index,
            .member_kind = 0,
            .member_index = 0,
            .item_kind = 1,
            .item_index = (uint64_t)item_index,
            .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.constructorSignature.data.some
              .parameterModes.data[item_index].data,
            .first_length = (uint64_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.constructorSignature.data.some
              .parameterModes.data[item_index].length,
            .second_data = (uint64_t)(uintptr_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.constructorSignature.data.some
              .parameterTypes.data[item_index].data,
            .second_length = (uint64_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.constructorSignature.data.some
              .parameterTypes.data[item_index].length,
          };
          written += 1;
        }
        for (
          uintptr_t item_index = 0;
          item_index < response->result.graph.resolved.modules.data[module_index]
            .symbols.data[symbol_index].typeSignature.data.some
            .constructorSignature.data.some.typeParameterConstraints.length;
          item_index += 1
        ) {
          if (written >= capacity) return written;
          records[written] = (Z_Stage1MemberSignatureItemRecord){
            .module_index = (uint64_t)module_index,
            .symbol_index = (uint64_t)symbol_index,
            .member_kind = 0,
            .member_index = 0,
            .item_kind = 2,
            .item_index = (uint64_t)item_index,
            .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.constructorSignature.data.some
              .typeParameterConstraints.data[item_index].parameter.data,
            .first_length = (uint64_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.constructorSignature.data.some
              .typeParameterConstraints.data[item_index].parameter.length,
            .second_data = (uint64_t)(uintptr_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.constructorSignature.data.some
              .typeParameterConstraints.data[item_index].traitName.data,
            .second_length = (uint64_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.constructorSignature.data.some
              .typeParameterConstraints.data[item_index].traitName.length,
          };
          written += 1;
        }
      }
      for (
        uintptr_t method_index = 0;
        method_index < response->result.graph.resolved.modules.data[module_index]
          .symbols.data[symbol_index].typeSignature.data.some.methods.length;
        method_index += 1
      ) {
        for (
          uintptr_t item_index = 0;
          item_index < response->result.graph.resolved.modules.data[module_index]
            .symbols.data[symbol_index].typeSignature.data.some
            .methods.data[method_index].signature.typeParameters.length;
          item_index += 1
        ) {
          if (written >= capacity) return written;
          records[written] = (Z_Stage1MemberSignatureItemRecord){
            .module_index = (uint64_t)module_index,
            .symbol_index = (uint64_t)symbol_index,
            .member_kind = 1,
            .member_index = (uint64_t)method_index,
            .item_kind = 0,
            .item_index = (uint64_t)item_index,
            .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.methods.data[method_index]
              .signature.typeParameters.data[item_index].data,
            .first_length = (uint64_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.methods.data[method_index]
              .signature.typeParameters.data[item_index].length,
            .second_data = 0,
            .second_length = 0,
          };
          written += 1;
        }
        for (
          uintptr_t item_index = 0;
          item_index < response->result.graph.resolved.modules.data[module_index]
            .symbols.data[symbol_index].typeSignature.data.some
            .methods.data[method_index].signature.parameterTypes.length;
          item_index += 1
        ) {
          if (written >= capacity) return written;
          records[written] = (Z_Stage1MemberSignatureItemRecord){
            .module_index = (uint64_t)module_index,
            .symbol_index = (uint64_t)symbol_index,
            .member_kind = 1,
            .member_index = (uint64_t)method_index,
            .item_kind = 1,
            .item_index = (uint64_t)item_index,
            .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.methods.data[method_index]
              .signature.parameterModes.data[item_index].data,
            .first_length = (uint64_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.methods.data[method_index]
              .signature.parameterModes.data[item_index].length,
            .second_data = (uint64_t)(uintptr_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.methods.data[method_index]
              .signature.parameterTypes.data[item_index].data,
            .second_length = (uint64_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.methods.data[method_index]
              .signature.parameterTypes.data[item_index].length,
          };
          written += 1;
        }
        for (
          uintptr_t item_index = 0;
          item_index < response->result.graph.resolved.modules.data[module_index]
            .symbols.data[symbol_index].typeSignature.data.some
            .methods.data[method_index].signature.typeParameterConstraints.length;
          item_index += 1
        ) {
          if (written >= capacity) return written;
          records[written] = (Z_Stage1MemberSignatureItemRecord){
            .module_index = (uint64_t)module_index,
            .symbol_index = (uint64_t)symbol_index,
            .member_kind = 1,
            .member_index = (uint64_t)method_index,
            .item_kind = 2,
            .item_index = (uint64_t)item_index,
            .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.methods.data[method_index]
              .signature.typeParameterConstraints.data[item_index].parameter.data,
            .first_length = (uint64_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.methods.data[method_index]
              .signature.typeParameterConstraints.data[item_index].parameter.length,
            .second_data = (uint64_t)(uintptr_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.methods.data[method_index]
              .signature.typeParameterConstraints.data[item_index].traitName.data,
            .second_length = (uint64_t)response->result.graph.resolved
              .modules.data[module_index].symbols.data[symbol_index]
              .typeSignature.data.some.methods.data[method_index]
              .signature.typeParameterConstraints.data[item_index].traitName.length,
          };
          written += 1;
        }
      }
    }
  }
  return written;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_copy_call_resolution_records(
  const void *pointer,
  Z_Stage1CallResolutionRecord *records,
  uintptr_t capacity
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t written = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t resolution_index = 0;
      resolution_index < response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.callResolutions.length;
      resolution_index += 1
    ) {
      if (written >= capacity) return written;
      records[written] = (Z_Stage1CallResolutionRecord){
        .module_index = (uint64_t)module_index,
        .resolution_index = (uint64_t)resolution_index,
        .offset = (uint64_t)response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.callResolutions.data[resolution_index].offset,
        .line = (uint64_t)response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.callResolutions.data[resolution_index].line,
        .column = (uint64_t)response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.callResolutions.data[resolution_index].column,
        .target_module = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].targetModuleIndex,
        .target_symbol = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].targetSymbolIndex,
        .kind_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].kind.data,
        .kind_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].kind.length,
        .target_name_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].targetName.data,
        .target_name_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].targetName.length,
        .asynchronous = response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.callResolutions.data[resolution_index].asynchronous ? 1 : 0,
        .receiver_mode_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].receiverMode.data,
        .receiver_mode_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].receiverMode.length,
        .return_type_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].returnType.data,
        .return_type_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].returnType.length,
        .error_type_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].errorType.data,
        .error_type_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].errorType.length,
        .type_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].typeParameters.length,
        .parameter_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .callResolutions.data[resolution_index].parameterTypes.length,
      };
      written += 1;
    }
  }
  return written;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_copy_call_resolution_item_records(
  const void *pointer,
  Z_Stage1CallResolutionItemRecord *records,
  uintptr_t capacity
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t written = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t resolution_index = 0;
      resolution_index < response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.callResolutions.length;
      resolution_index += 1
    ) {
      for (
        uintptr_t item_index = 0;
        item_index < response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.callResolutions.data[resolution_index].typeParameters.length;
        item_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1CallResolutionItemRecord){
          .module_index = (uint64_t)module_index,
          .resolution_index = (uint64_t)resolution_index,
          .kind = 0,
          .index = (uint64_t)item_index,
          .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .callResolutions.data[resolution_index].typeParameters.data[item_index].data,
          .first_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .callResolutions.data[resolution_index].typeParameters.data[item_index].length,
          .second_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .callResolutions.data[resolution_index].typeArguments.data[item_index].data,
          .second_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .callResolutions.data[resolution_index].typeArguments.data[item_index].length,
        };
        written += 1;
      }
      for (
        uintptr_t item_index = 0;
        item_index < response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.callResolutions.data[resolution_index].parameterTypes.length;
        item_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1CallResolutionItemRecord){
          .module_index = (uint64_t)module_index,
          .resolution_index = (uint64_t)resolution_index,
          .kind = 1,
          .index = (uint64_t)item_index,
          .first_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .callResolutions.data[resolution_index].parameterModes.data[item_index].data,
          .first_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .callResolutions.data[resolution_index].parameterModes.data[item_index].length,
          .second_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .callResolutions.data[resolution_index].parameterTypes.data[item_index].data,
          .second_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .callResolutions.data[resolution_index].parameterTypes.data[item_index].length,
        };
        written += 1;
      }
    }
  }
  return written;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_copy_binding_resolution_records(
  const void *pointer,
  Z_Stage1BindingResolutionRecord *records,
  uintptr_t capacity
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t written = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t resolution_index = 0;
      resolution_index < response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.bindingResolutions.length;
      resolution_index += 1
    ) {
      if (written >= capacity) return written;
      records[written] = (Z_Stage1BindingResolutionRecord){
        .module_index = (uint64_t)module_index,
        .resolution_index = (uint64_t)resolution_index,
        .offset = (uint64_t)response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.bindingResolutions.data[resolution_index].offset,
        .line = (uint64_t)response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.bindingResolutions.data[resolution_index].line,
        .column = (uint64_t)response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.bindingResolutions.data[resolution_index].column,
        .name_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .bindingResolutions.data[resolution_index].name.data,
        .name_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .bindingResolutions.data[resolution_index].name.length,
        .mutable_binding = response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.bindingResolutions.data[resolution_index].mutableBinding ? 1 : 0,
        .type_name_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .bindingResolutions.data[resolution_index].typeName.data,
        .type_name_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .bindingResolutions.data[resolution_index].typeName.length,
        .identity_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .bindingResolutions.data[resolution_index].typeIdentities.length,
      };
      written += 1;
    }
  }
  return written;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_copy_expression_resolution_records(
  const void *pointer,
  Z_Stage1ExpressionResolutionRecord *records,
  uintptr_t capacity
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t written = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t resolution_index = 0;
      resolution_index < response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.expressionResolutions.length;
      resolution_index += 1
    ) {
      if (written >= capacity) return written;
      records[written] = (Z_Stage1ExpressionResolutionRecord){
        .module_index = (uint64_t)module_index,
        .resolution_index = (uint64_t)resolution_index,
        .offset = (uint64_t)response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.expressionResolutions.data[resolution_index].offset,
        .line = (uint64_t)response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.expressionResolutions.data[resolution_index].line,
        .column = (uint64_t)response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.expressionResolutions.data[resolution_index].column,
        .type_name_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .expressionResolutions.data[resolution_index].typeName.data,
        .type_name_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .expressionResolutions.data[resolution_index].typeName.length,
        .target_name_data = (uint64_t)(uintptr_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .expressionResolutions.data[resolution_index].targetName.data,
        .target_name_length = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .expressionResolutions.data[resolution_index].targetName.length,
        .identity_count = (uint64_t)response->result.graph.resolved
          .modules.data[module_index].semanticEvidence
          .expressionResolutions.data[resolution_index].typeIdentities.length,
      };
      written += 1;
    }
  }
  return written;
}

Z_STAGE1_EXPORT uintptr_t z_stage1_resolve_copy_type_identity_records(
  const void *pointer,
  Z_Stage1TypeIdentityRecord *records,
  uintptr_t capacity
) {
  const Z_Stage1ResolveHandle *response = (const Z_Stage1ResolveHandle *)pointer;
  uintptr_t written = 0;
  for (
    uintptr_t module_index = 0;
    module_index < response->result.graph.resolved.modules.length;
    module_index += 1
  ) {
    for (
      uintptr_t resolution_index = 0;
      resolution_index < response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.bindingResolutions.length;
      resolution_index += 1
    ) {
      for (
        uintptr_t identity_index = 0;
        identity_index < response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.bindingResolutions.data[resolution_index]
          .typeIdentities.length;
        identity_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1TypeIdentityRecord){
          .module_index = (uint64_t)module_index,
          .evidence_kind = 0,
          .resolution_index = (uint64_t)resolution_index,
          .identity_index = (uint64_t)identity_index,
          .path_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .bindingResolutions.data[resolution_index]
            .typeIdentities.data[identity_index].path.data,
          .path_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .bindingResolutions.data[resolution_index]
            .typeIdentities.data[identity_index].path.length,
          .target_module = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .bindingResolutions.data[resolution_index]
            .typeIdentities.data[identity_index].targetModuleIndex,
          .target_symbol = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .bindingResolutions.data[resolution_index]
            .typeIdentities.data[identity_index].targetSymbolIndex,
        };
        written += 1;
      }
    }
    for (
      uintptr_t resolution_index = 0;
      resolution_index < response->result.graph.resolved.modules.data[module_index]
        .semanticEvidence.expressionResolutions.length;
      resolution_index += 1
    ) {
      for (
        uintptr_t identity_index = 0;
        identity_index < response->result.graph.resolved.modules.data[module_index]
          .semanticEvidence.expressionResolutions.data[resolution_index]
          .typeIdentities.length;
        identity_index += 1
      ) {
        if (written >= capacity) return written;
        records[written] = (Z_Stage1TypeIdentityRecord){
          .module_index = (uint64_t)module_index,
          .evidence_kind = 1,
          .resolution_index = (uint64_t)resolution_index,
          .identity_index = (uint64_t)identity_index,
          .path_data = (uint64_t)(uintptr_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .expressionResolutions.data[resolution_index]
            .typeIdentities.data[identity_index].path.data,
          .path_length = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .expressionResolutions.data[resolution_index]
            .typeIdentities.data[identity_index].path.length,
          .target_module = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .expressionResolutions.data[resolution_index]
            .typeIdentities.data[identity_index].targetModuleIndex,
          .target_symbol = (uint64_t)response->result.graph.resolved
            .modules.data[module_index].semanticEvidence
            .expressionResolutions.data[resolution_index]
            .typeIdentities.data[identity_index].targetSymbolIndex,
        };
        written += 1;
      }
    }
  }
  return written;
}

Z_STAGE1_EXPORT void z_stage1_resolve_free(void *pointer) {
  Z_Stage1ResolveHandle *response = (Z_Stage1ResolveHandle *)pointer;
  free(response->error_payload);
  Z_Stage1ResolveResponse_deinit(&response->result);
  free(response);
}

Z_STAGE1_EXPORT void z_stage1_free(void *pointer) {
  free(pointer);
}`;
}

function stage1BridgeFingerprint(projectRoot: string): string {
  const hash = createHash("sha256");
  hash.update(`z-stage1-bridge-v2\0${process.platform}\0${process.arch}\0${Bun.version}\0`);
  const roots = [
    join(projectRoot, "compiler/src"),
    join(projectRoot, "compiler/frontend"),
  ];
  const files = roots.flatMap((root) => collectBootstrapFiles(root)).sort();
  const packagePath = join(projectRoot, "package.json");
  if (existsSync(packagePath)) files.push(packagePath);
  for (const file of files) {
    hash.update(file.slice(projectRoot.length));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectBootstrapFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectBootstrapFiles(path));
    else if (entry.isFile() && (path.endsWith(".ts") || path.endsWith(".zs"))) files.push(path);
  }
  return files;
}

function formatMilliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function verifyStage1Lexer(inputPaths: readonly string[]): void {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const bridgePath = join(projectRoot, "examples/applications/source-inspector/token-stream.zs");
  const bridgeSource = readFileSync(bridgePath, "utf8");
  const artifact = compileToNative(bridgeSource, bridgePath);
  for (const warning of artifact.warnings) console.error(formatDiagnostic(warning, bridgeSource));
  const executablePath = buildNative(bridgePath, artifact);
  for (const inputPath of inputPaths) {
    const source = readFileSync(inputPath, "utf8");
    const execution = spawnSync(executablePath, [inputPath], { encoding: "utf8" });
    if (execution.error) throw execution.error;
    if (execution.status !== 0) throw new Error(execution.stderr || "the stage-1 lexer failed");

    const stage1 = decodeStage1TokenStream(execution.stdout, inputPath);
    const stage0 = lex(source, inputPath);
    const count = Math.max(stage0.length, stage1.length);
    for (let index = 0; index < count; index += 1) {
      if (sameToken(stage0[index], stage1[index])) continue;
      throw new Error(
        `stage-1 lexer mismatch at token ${index}: stage 0 produced ${describeToken(stage0[index])}, stage 1 produced ${describeToken(stage1[index])}`,
      );
    }
    console.log(`${inputPath}: stage-1 lexer matches ${stage1.length} tokens`);
  }
}

function sameToken(left: Token | undefined, right: Token | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.kind === right.kind
    && left.text === right.text
    && left.location.offset === right.location.offset
    && left.location.line === right.location.line
    && left.location.column === right.location.column;
}

function describeToken(token: Token | undefined): string {
  if (!token) return "no token";
  return `${token.kind} ${JSON.stringify(token.text)} at ${token.location.line}:${token.location.column}`;
}

function nativeCompiler(language: NativeArtifact["language"]): string {
  return language === "c++" || language === "objective-c++" ? "clang++" : "clang";
}

function nativeExtension(language: NativeArtifact["language"]): string {
  if (language === "objective-c") return "m";
  if (language === "c++") return "cc";
  if (language === "objective-c++") return "mm";
  return "c";
}

function nativeLanguageFlags(language: NativeArtifact["language"]): string[] {
  if (language === "objective-c") return ["-fobjc-arc"];
  if (language === "c++") return ["-std=c++20"];
  if (language === "objective-c++") return ["-std=c++20", "-fobjc-arc"];
  return ["-std=c11"];
}

function usage(): void {
  console.error("usage: z build [project-directory] [--release]");
  console.error("usage: z check <file.zs> [--native-frontend] [--timings]");
  console.error("       z <emit|run> <file.zs> [-- program arguments]");
  console.error("       z self-host-lex <file.zs> [more.zs ...]");
  console.error("       z self-host-parse <file.zs> [more.zs ...] [--timings]");
  console.error("       z self-host-resolve <entry.zs> [--timings]");
  console.error("       z self-host-emit <file.zs>");
  console.error("       z self-host-foreign <file.zs> <header> <output.zfdcl>");
}
