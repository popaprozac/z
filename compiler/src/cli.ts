#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { FunctionDeclaration, Program } from "./ast.ts";
import { parseDynamicArrayType, parseFixedArrayType, parseSliceType } from "./array-types.ts";
import { check, compileToNative, type NativeArtifact } from "./compiler.ts";
import { DiagnosticError, formatDiagnostic } from "./diagnostics.ts";
import { parseFunctionType } from "./function-types.ts";
import { parseGenericType } from "./generic-types.ts";
import { lex, type Token } from "./lexer.ts";
import { isNullableObjCTypeName, publicObjCTypeName } from "./objc-types.ts";
import { parse } from "./parser.ts";
import { deploymentTargetFlags } from "./project.ts";
import {
  decodeStage1ProgramStream,
  decodeStage1TokenStream,
  type Stage1Declaration,
  type Stage1FunctionSignature,
} from "./self-hosting.ts";
import { parseViewType } from "./view-types.ts";

const [command, inputArgument, ...trailingArguments] = process.argv.slice(2);
const programArguments = trailingArguments[0] === "--" ? trailingArguments.slice(1) : trailingArguments;

if (!command || !inputArgument || !["check", "emit", "run", "self-host-lex", "self-host-parse"].includes(command)) {
  usage();
  process.exitCode = 2;
} else {
  const inputPath = resolve(inputArgument);
  try {
    if (command === "self-host-lex") {
      verifyStage1Lexer([inputPath, ...trailingArguments.map((argument) => resolve(argument))]);
    } else if (command === "self-host-parse") {
      verifyStage1Parser([inputPath, ...trailingArguments.map((argument) => resolve(argument))]);
    } else if (command === "check") {
      const source = readFileSync(inputPath, "utf8");
      for (const warning of check(source, inputPath)) console.error(formatDiagnostic(warning, source));
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

function verifyStage1Parser(inputPaths: readonly string[]): void {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const bridgePath = join(projectRoot, "examples/applications/source-inspector/parser-stream.z");
  const bridgeSource = readFileSync(bridgePath, "utf8");
  const artifact = compileToNative(bridgeSource, bridgePath);
  for (const warning of artifact.warnings) console.error(formatDiagnostic(warning, bridgeSource));
  const executablePath = buildNative(bridgePath, artifact);
  for (const inputPath of inputPaths) {
    const source = readFileSync(inputPath, "utf8");
    const execution = spawnSync(executablePath, [inputPath], { encoding: "utf8" });
    if (execution.error) throw execution.error;
    if (execution.status !== 0) throw new Error(execution.stderr || "the stage-1 parser failed");

    const stage1Program = decodeStage1ProgramStream(execution.stdout, inputPath);
    const stage0Program = parse(lex(source, inputPath), inputPath);
    const stage1 = stage1Program.declarations;
    const stage0 = stage0Declarations(stage0Program, inputPath);
    const count = Math.max(stage0.length, stage1.length);
    for (let index = 0; index < count; index += 1) {
      if (sameDeclaration(stage0[index], stage1[index])) continue;
      throw new Error(
        `stage-1 parser mismatch at declaration ${index}: stage 0 produced ${describeDeclaration(stage0[index])}, stage 1 produced ${describeDeclaration(stage1[index])}`,
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
    console.log(`${inputPath}: stage-1 parser matches ${stage1.length} declarations and ${stage1Program.functionSignatures.length} function signatures`);
  }
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
  const generic = declaration.typeParameters?.length
    ? `<${declaration.typeParameters.map((parameter) => {
      const constraint = declaration.typeParameterConstraints?.find((candidate) => candidate.parameter === parameter);
      return constraint?.traits.length
        ? `${parameter}: ${constraint.traits.map((trait) => canonicalTypeName(trait.name)).join(" & ")}`
        : parameter;
    }).join(", ")}>`
    : "";
  const parameters = declaration.parameters.map((parameter) => {
    const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
    return `${capability}${parameter.name}: ${canonicalTypeName(parameter.type.name)}`;
  });
  if (declaration.receiverMode) parameters.unshift(`${declaration.receiverMode} this`);
  const error = declaration.errorType ? ` throws ${canonicalTypeName(declaration.errorType.name)}` : "";
  const asynchronous = declaration.async ? "async " : "";
  return {
    text: `${asynchronous}function ${declaration.name}${generic}(${parameters.join(", ")}): ${canonicalTypeName(declaration.returnType.name)}${error}`,
    location: { ...declaration.location, fileName },
  };
}

function canonicalTypeName(name: string): string {
  if (isNullableObjCTypeName(name)) return `${canonicalTypeName(publicObjCTypeName(name))} | null`;
  const view = parseViewType(name);
  if (view) return `view ${canonicalTypeName(view.target)}`;
  const fixed = parseFixedArrayType(name);
  if (fixed) return `${canonicalTypeName(fixed.elementType)}[${fixed.length}]`;
  const slice = parseSliceType(name);
  if (slice) return `Slice<${canonicalTypeName(slice.elementType)}>`;
  const dynamic = parseDynamicArrayType(name);
  if (dynamic) return `Array<${canonicalTypeName(dynamic.elementType)}>`;
  const generic = parseGenericType(name);
  if (generic) return `${generic.base}<${generic.arguments.map(canonicalTypeName).join(", ")}>`;
  const functionType = parseFunctionType(name);
  if (functionType) {
    const parameters = functionType.parameters.map((parameter) => {
      const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
      return `${capability}${parameter.name}: ${canonicalTypeName(parameter.type)}`;
    });
    return `(${parameters.join(", ")}) => ${canonicalTypeName(functionType.returnType)}`;
  }
  return name;
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

function buildNative(inputPath: string, artifact: NativeArtifact): string {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const cacheDirectory = join(projectRoot, ".z-cache");
  mkdirSync(cacheDirectory, { recursive: true });
  const stem = basename(inputPath).replace(/\.z$/, "");
  const sourcePath = join(cacheDirectory, `${stem}.${nativeExtension(artifact.language)}`);
  const executablePath = join(cacheDirectory, stem);
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

function verifyStage1Lexer(inputPaths: readonly string[]): void {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const bridgePath = join(projectRoot, "examples/applications/source-inspector/token-stream.z");
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
  console.error("usage: z <check|emit|run> <file.z> [-- program arguments]");
  console.error("       z self-host-lex <file.z> [more.z ...]");
  console.error("       z self-host-parse <file.z> [more.z ...]");
}
