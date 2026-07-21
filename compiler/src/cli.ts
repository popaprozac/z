#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CString, dlopen, FFIType, ptr } from "bun:ffi";
import type { Expression, FunctionDeclaration, Program, SourceLocation, Statement } from "./ast.ts";
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
  decodeStage1ProgramBatchStream,
  decodeStage1TokenStream,
  type Stage1Declaration,
  type Stage1FunctionBody,
  type Stage1FunctionSignature,
  type Stage1ImportShape,
  type Stage1TypeShape,
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
      const timings = trailingArguments.includes("--timings");
      verifyStage1Parser(
        [inputPath, ...trailingArguments.filter((argument) => argument !== "--timings").map((argument) => resolve(argument))],
        timings,
      );
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

function verifyStage1Parser(inputPaths: readonly string[], timings: boolean): void {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const bridgePath = join(projectRoot, "compiler/frontend/parser-library.zs");
  const boundary = prepareStage1ParserLibrary(projectRoot, bridgePath);
  const executionStarted = performance.now();
  const nativeStream = parseWithStage1Library(boundary.libraryPath, inputPaths);
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
    const cacheState = boundary.cacheHit ? "cache hit" : "cache miss; stage-0 compile + native build included";
    console.log(`stage-1 parser timing (${inputPaths.length} ${inputPaths.length === 1 ? "file" : "files"}, ${cacheState})`);
    console.log(`  boundary preparation: ${formatMilliseconds(boundary.prepareMilliseconds)}`);
    console.log(`  native in-process batch (host file I/O + FFI + lex + parse + encode): ${formatMilliseconds(executionMilliseconds)}`);
    console.log(`  protocol decode: ${formatMilliseconds(decodeMilliseconds)}`);
    console.log(`  stage-0 parity parse (file I/O excluded): ${formatMilliseconds(stage0Milliseconds)}`);
  }
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
  return `${asynchronous}function ${declaration.name}${generic}(${parameters.join(", ")}): ${canonicalTypeName(declaration.returnType.name)}${error}`;
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
  if (statement.kind === "return") {
    const returnStart = statement.expression ? lexicalExpressionStart(tokens, statement.location.offset, "return") : null;
    const expression = returnStart
      ? `=${canonicalLocation(returnStart.location)}:${canonicalExpressionTokens(tokens, returnStart.location.offset)}#${
          canonicalExpressionTree(statement.expression!, tokens) ?? "opaque"
        }`
      : "";
    return `return@${location}(${expression})`;
  }
  if (statement.kind === "throw" || statement.kind === "select") {
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
    const bindingIndex = tokens.findIndex((token) => token.location.offset === statement.bindingLocation.offset);
    const ofIndex = tokens.findIndex((token, index) => index > bindingIndex && index < rightParenIndex && token.kind === "of");
    if (bindingIndex < 0 || ofIndex < 0 || ofIndex + 1 >= rightParenIndex) {
      throw new Error(`could not locate for-of iterable at source offset ${statement.location.offset}`);
    }
    const iterableStart = tokens[ofIndex + 1];
    const iterableTokens = canonicalExpressionTokenRange(tokens, ofIndex + 1, rightParenIndex);
    const iterable = `${canonicalLocation(iterableStart.location)}:${iterableTokens}#${
      canonicalExpressionTree(statement.iterable, tokens) ?? "opaque"
    }`;
    return `for@${location}(const:${statement.binding}@${canonicalLocation(statement.bindingLocation)}`
      + `iterable=${iterable}body=${canonicalStatementText(statement.body, tokens)})`;
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
    return `asyncScope@${location}(body=${canonicalStatementText(statement.body, tokens)})`;
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
  if (expression.kind === "executorPlacement") {
    const marker = appendAt("executorOn", "", [], [], expression.onLocation);
    const executor = flattenExpression(expression.executor, nodes, tokens);
    if (executor === null) return null;
    return appendAt(
      "executorPlacement",
      expression.mode,
      [marker, executor],
      [
        expression.returnType ? canonicalTypeName(expression.returnType.name) : "",
        expression.errorType ? canonicalTypeName(expression.errorType.name) : "",
      ],
      expression.location,
      [expression.body.statements],
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
    ...program.structs.map((declaration): Stage1TypeShape => {
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
        )}${implemented} {${members.length ? ` ${members.join(" ")}` : ""} }`,
        location: { ...declaration.location, fileName },
      };
    }),
    ...program.traits.map((declaration): Stage1TypeShape => ({
      kind: "trait",
      text: `trait ${declaration.name} {${declaration.methods.length
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

function parseWithStage1Library(libraryPath: string, inputPaths: readonly string[]): string {
  const library = dlopen(libraryPath, {
    z_stage1_parse: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.ptr,
    },
    z_stage1_free: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });
  try {
    let stream = "";
    for (const inputPath of inputPaths) {
      const pathBytes = Buffer.from(inputPath, "utf8");
      const sourceBytes = Buffer.from(readFileSync(inputPath, "utf8"), "utf8");
      const pathStorage = pathBytes.byteLength > 0 ? pathBytes : Buffer.alloc(1);
      const sourceStorage = sourceBytes.byteLength > 0 ? sourceBytes : Buffer.alloc(1);
      const resultPointer = library.symbols.z_stage1_parse(
        ptr(pathStorage),
        pathBytes.byteLength,
        ptr(sourceStorage),
        sourceBytes.byteLength,
      );
      if (!resultPointer) throw new Error("the stage-1 parser library returned a null response");
      try {
        const response = new CString(resultPointer).toString();
        if (response.startsWith("error\n")) throw new Error(response.slice("error\n".length));
        if (!response.startsWith("ok\n")) throw new Error("the stage-1 parser library returned a malformed response");
        stream += response.slice("ok\n".length);
      } finally {
        library.symbols.z_stage1_free(resultPointer);
      }
    }
    return stream;
  } finally {
    library.close();
  }
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

function stage1ParserLibraryWrapper(): string {
  return `#if defined(_WIN32)
#define Z_STAGE1_EXPORT __declspec(dllexport)
#else
#define Z_STAGE1_EXPORT __attribute__((visibility("default")))
#endif

Z_STAGE1_EXPORT void *z_stage1_parse(
  const uint8_t *path_data,
  uintptr_t path_length,
  const uint8_t *source_data,
  uintptr_t source_length
) {
  Z_String path = { (const char *)path_data, path_length, 0 };
  Z_String source = { (const char *)source_data, source_length, 0 };
  Z_String result = stage1Parse(&path, &source);
  char *copy = (char *)malloc(result.length + 1);
  if (copy == NULL) abort();
  if (result.length > 0) memcpy(copy, result.data, result.length);
  copy[result.length] = '\\0';
  if (result.capacity > 0) free((void *)result.data);
  return copy;
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
  console.error("usage: z <check|emit|run> <file.zs> [-- program arguments]");
  console.error("       z self-host-lex <file.zs> [more.zs ...]");
  console.error("       z self-host-parse <file.zs> [more.zs ...] [--timings]");
}
