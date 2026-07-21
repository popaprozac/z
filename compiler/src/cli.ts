#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  const bridgePath = join(projectRoot, "examples/applications/source-inspector/parser-stream.z");
  const boundary = prepareStage1Bridge(projectRoot, bridgePath);
  const executionStarted = performance.now();
  const execution = spawnSync(boundary.executablePath, inputPaths, { encoding: "utf8" });
  const executionMilliseconds = performance.now() - executionStarted;
  if (execution.error) throw execution.error;
  if (execution.status !== 0) throw new Error(execution.stderr || "the stage-1 parser failed");
  const decodeStarted = performance.now();
  const stage1Programs = decodeStage1ProgramBatchStream(execution.stdout);
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
    console.log(`${inputPath}: stage-1 parser matches ${stage1.length} declarations, ${stage1Program.functionSignatures.length} function signatures, ${stage1Program.functionBodies.length} function bodies, and ${stage1Program.typeShapes.length} type shapes`);
  }
  if (timings) {
    const cacheState = boundary.cacheHit ? "cache hit" : "cache miss; stage-0 compile + native build included";
    console.log(`stage-1 parser timing (${inputPaths.length} ${inputPaths.length === 1 ? "file" : "files"}, ${cacheState})`);
    console.log(`  boundary preparation: ${formatMilliseconds(boundary.prepareMilliseconds)}`);
    console.log(`  native batch (process startup + file I/O + lex + parse + encode): ${formatMilliseconds(executionMilliseconds)}`);
    console.log(`  protocol decode: ${formatMilliseconds(decodeMilliseconds)}`);
    console.log(`  stage-0 parity parse (file I/O excluded): ${formatMilliseconds(stage0Milliseconds)}`);
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
          canonicalExpressionTree(statement.initializer!) ?? "opaque"
        }`
      : "";
    return `variable@${location}(${binding}:${statement.name}@${canonicalLocation(statement.nameLocation)}${type}${expression})`;
  }
  if (statement.kind === "return") {
    const returnStart = statement.expression ? lexicalExpressionStart(tokens, statement.location.offset, "return") : null;
    const expression = returnStart
      ? `=${canonicalLocation(returnStart.location)}:${canonicalExpressionTokens(tokens, returnStart.location.offset)}#${
          canonicalExpressionTree(statement.expression!) ?? "opaque"
        }`
      : "";
    return `return@${location}(${expression})`;
  }
  if (statement.kind === "expressionStatement") {
    if (statement.expression.kind === "executorPlacement") return "";
    const expressionStart = lexicalStatementStart(tokens, statement.location.offset);
    return `expression@${canonicalLocation(expressionStart.location)}(=${canonicalLocation(expressionStart.location)}:${canonicalExpressionTokens(
      tokens,
      expressionStart.location.offset,
    )}#${canonicalExpressionTree(statement.expression) ?? "opaque"})`;
  }
  if (statement.kind === "block") {
    return `block@${location}(${statement.statements.map((child) => canonicalStatementText(child, tokens)).join("")})`;
  }
  return "";
}

function lexicalStatementStart(tokens: readonly Token[], rootOffset: number): Token {
  const rootIndex = tokens.findIndex((token) => token.location.offset === rootOffset);
  if (rootIndex < 0) throw new Error(`could not find expression root at source offset ${rootOffset}`);
  let index = rootIndex;
  while (index > 0) {
    const previous = tokens[index - 1];
    if (previous.kind === "semicolon" || previous.kind === "leftBrace" || previous.kind === "rightBrace") break;
    index -= 1;
  }
  return tokens[index];
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
  readonly location: SourceLocation;
};

function canonicalExpressionTree(expression: Expression): string | null {
  const nodes: FlatExpressionNode[] = [];
  const root = flattenExpression(expression, nodes);
  if (root === null) return null;
  return `root:${root};${nodes.map((node) => (
    `${node.kind}@${canonicalLocation(node.location)}:${Buffer.byteLength(node.value, "utf8")}:${node.value}`
    + `[${node.children.join(",")}]`
    + `{${node.labels.map((label) => `${Buffer.byteLength(label, "utf8")}:${label}`).join(",")}};`
  )).join("")}`;
}

function flattenExpression(expression: Expression, nodes: FlatExpressionNode[]): number | null {
  const leaf = (kind: string, value: string): number => {
    const index = nodes.length;
    nodes.push({ kind, value, children: [], labels: [], location: expression.location });
    return index;
  };
  if (expression.kind === "identifier") {
    if (parseGenericType(expression.name)) return null;
    return leaf("identifier", expression.name);
  }
  if (expression.kind === "number") return leaf("number", expression.value);
  if (expression.kind === "string") return leaf("string", expression.value);
  if (expression.kind === "boolean") return leaf("boolean", expression.value ? "true" : "false");
  if (expression.kind === "null") return leaf("null", "");

  const append = (kind: string, value: string, children: readonly number[], labels: readonly string[]): number => {
    const index = nodes.length;
    nodes.push({ kind, value, children, labels, location: expression.location });
    return index;
  };
  if (expression.kind === "arrayExpression") {
    const children = flattenExpressions(expression.elements, nodes);
    return children ? append("arrayExpression", "", children, []) : null;
  }
  if (expression.kind === "objectExpression") {
    const children = flattenExpressions(expression.fields.map((field) => field.expression), nodes);
    return children ? append("objectExpression", "", children, expression.fields.map((field) => field.name)) : null;
  }
  if (expression.kind === "member") {
    const object = flattenExpression(expression.object, nodes);
    return object === null ? null : append("member", expression.property, [object], []);
  }
  if (expression.kind === "call") {
    const callee = flattenExpression(expression.callee, nodes);
    if (callee === null) return null;
    const arguments_ = flattenExpressions(expression.arguments, nodes);
    return arguments_ ? append("call", "", [callee, ...arguments_], expression.argumentLabels.map((label) => label ?? "")) : null;
  }
  if (expression.kind === "index") {
    const object = flattenExpression(expression.object, nodes);
    if (object === null) return null;
    const index = flattenExpression(expression.index, nodes);
    return index === null ? null : append("index", "", [object, index], []);
  }
  if (expression.kind === "unary") {
    const operand = flattenExpression(expression.operand, nodes);
    return operand === null ? null : append("unary", expression.operator, [operand], []);
  }
  if (expression.kind === "binary") {
    const left = flattenExpression(expression.left, nodes);
    if (left === null) return null;
    const right = flattenExpression(expression.right, nodes);
    return right === null ? null : append("binary", expression.operator, [left, right], []);
  }
  if (expression.kind === "conditional") {
    const condition = flattenExpression(expression.condition, nodes);
    if (condition === null) return null;
    const thenExpression = flattenExpression(expression.thenExpression, nodes);
    if (thenExpression === null) return null;
    const elseExpression = flattenExpression(expression.elseExpression, nodes);
    return elseExpression === null ? null : append("conditional", "", [condition, thenExpression, elseExpression], []);
  }
  return null;
}

function flattenExpressions(expressions: readonly Expression[], nodes: FlatExpressionNode[]): number[] | null {
  const children: number[] = [];
  for (const expression of expressions) {
    const child = flattenExpression(expression, nodes);
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
  const stem = outputStem ?? basename(inputPath).replace(/\.z$/, "");
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

type PreparedStage1Bridge = {
  readonly executablePath: string;
  readonly cacheHit: boolean;
  readonly prepareMilliseconds: number;
};

function prepareStage1Bridge(projectRoot: string, bridgePath: string): PreparedStage1Bridge {
  const started = performance.now();
  const fingerprint = stage1BridgeFingerprint(projectRoot);
  const outputStem = `stage1-${basename(bridgePath, ".z")}-${fingerprint.slice(0, 20)}`;
  const executablePath = join(
    projectRoot,
    ".z-cache",
    `${outputStem}${process.platform === "win32" ? ".exe" : ""}`,
  );
  if (existsSync(executablePath)) {
    return { executablePath, cacheHit: true, prepareMilliseconds: performance.now() - started };
  }

  const bridgeSource = readFileSync(bridgePath, "utf8");
  const artifact = compileToNative(bridgeSource, bridgePath);
  for (const warning of artifact.warnings) console.error(formatDiagnostic(warning, bridgeSource));
  const builtPath = buildNative(bridgePath, artifact, outputStem);
  return { executablePath: builtPath, cacheHit: false, prepareMilliseconds: performance.now() - started };
}

function stage1BridgeFingerprint(projectRoot: string): string {
  const hash = createHash("sha256");
  hash.update(`z-stage1-bridge-v1\0${process.platform}\0${process.arch}\0${Bun.version}\0`);
  const roots = [
    join(projectRoot, "compiler/src"),
    join(projectRoot, "examples/applications/source-inspector"),
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
    else if (entry.isFile() && (path.endsWith(".ts") || path.endsWith(".z"))) files.push(path);
  }
  return files;
}

function formatMilliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
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
  console.error("       z self-host-parse <file.z> [more.z ...] [--timings]");
}
