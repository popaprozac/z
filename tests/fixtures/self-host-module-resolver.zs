import {
  ModuleGraph,
  ModuleResolveErrorKind,
  ModuleSource,
  ModuleSymbol,
  ModuleSymbolKind,
  resolveModules,
} from "../../compiler/frontend/module-resolver.zs";

function module(in path: String, in source: String): ModuleSource {
  return ModuleSource({
    path: path.copyBytes(0, path.byteLength),
    source: source.copyBytes(0, source.byteLength),
  });
}

function successfulGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/app/main.zs", `
import { value as selected } from "./model.zs";
import helper from "./nested/helper.zs";

function main(): i32 {
  return selected() + helper.adjust();
}
`));
  sources.push(module("/workspace/app/model.zs", `
export function value(): i32 {
  return 40;
}
`));
  sources.push(module("/workspace/app/nested/helper.zs", `
import model from "../model.zs";

export function adjust(): i32 {
  return model.value() + 2;
}
`));
  return sources;
}

function missingModuleGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import missing from "./missing.zs";
function main(): i32 { return 0; }
`));
  return sources;
}

function missingExportGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import { hidden } from "./model.zs";
function main(): i32 { return hidden(); }
`));
  sources.push(module("/workspace/model.zs", `
function hidden(): i32 { return 1; }
`));
  return sources;
}

function circularGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import next from "./next.zs";
function main(): i32 { return next.value(); }
`));
  sources.push(module("/workspace/next.zs", `
import main from "./main.zs";
export function value(): i32 { return main.main(); }
`));
  return sources;
}

function duplicateBindingGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import value from "native.h";
function value(): i32 { return 1; }
function main(): i32 { return value(); }
`));
  return sources;
}

function unknownNameGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
function main(): i32 {
  const known = 40;
  return known + missing;
}
`));
  return sources;
}

function useBeforeBindingGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
function main(): i32 {
  const answer = answer;
  return answer;
}
`));
  return sources;
}

function escapedBlockBindingGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
function main(): i32 {
  {
    const answer = 42;
  }
  return answer;
}
`));
  return sources;
}

function unknownTypeGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
function load(value: Option<Missing>): void {
  return;
}
`));
  return sources;
}

function unknownClosureTypeGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
function main(): void {
  const identity = (value: Missing): Missing => value;
  return;
}
`));
  return sources;
}

function importedValueAsTypeGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import { value } from "./model.zs";
function load(input: value): void { return; }
`));
  sources.push(module("/workspace/model.zs", `
export function value(): i32 { return 42; }
`));
  return sources;
}

function typeScopesGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import model from "./model.zs";

trait Named {}

struct Holder<T: Named> {
  value: T;

  function preserve<U: Named>(input: U): U {
    const identity = (value: U): U => value;
    const observed: Option<U> = Option.some(input);
    return match (observed) {
      some(value) => value;
      none => input;
    };
  }
}

function inspect(value: Array<Option<model.Record>>): void {
  return;
}
`));
  sources.push(module("/workspace/model.zs", `
export struct Record {
  id: i32;
}
`));
  return sources;
}

function lexicalScopesGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
enum Outcome { ready i32, empty, }

function inspect(value: Outcome): i32 {
  const offset = 2;
  const apply = (input: i32): i32 => input + offset;
  return match (value) {
    ready(payload) => apply(payload);
    empty => {
      const fallback = 40;
      select fallback + offset;
    }
  };
}

function main(): i32 {
  let total = 0;
  for (const value of [20, 22]) {
    total = total + value;
  }
  return total;
}
`));
  return sources;
}

function expressionTypingGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
function increment(value: i32): i32 {
  const one = 1;
  let total: i32 = value + one;
  total = total + 1;
  if (total > 0) {
    const positive: boolean = true;
  }
  return total;
}

function choose(flag: boolean): i32 {
  return flag ? increment(20) : increment(22);
}
`));
  return sources;
}

function expressionMismatchGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
function main(): boolean {
  const answer = 42;
  return answer;
}
`));
  return sources;
}

function invalidOperatorGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
function main(): boolean {
  return true + false;
}
`));
  return sources;
}

function crossModuleTypeMismatchGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import { add } from "./math.zs";
function main(): i32 { return add(true, 2); }
`));
  sources.push(module("/workspace/math.zs", `
export function add(left: i32, right: i32): i32 { return left + right; }
`));
  return sources;
}

function genericInferenceGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import { identity as copy } from "./model.zs";
import model from "./model.zs";
function main(): i32 {
  const explicit: i32 = copy<i32>(20);
  const values = Array<i32>();
  const pair = [1, 2];
  return explicit + model.keep(values, 19) + model.first(pair) + model.fixed(pair);
}

function recover(result: Result<i32, String>): i32 {
  return model.recover(result, 0);
}
`));
  sources.push(module("/workspace/model.zs", `
export function identity<T>(value: T): T { return value; }
export function keep<T>(in values: Array<T>, fallback: T): T { return fallback; }
export function first<T>(in values: Slice<T>): T { return values[0]; }
export function fixed<T>(in values: T[2]): T { return values[0]; }
export function recover<T, E>(in result: Result<T, E>, fallback: T): T { return fallback; }
`));
  return sources;
}

function genericReturnMismatchGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import { identity } from "./model.zs";
function main(): boolean { return identity(42); }
`));
  sources.push(module("/workspace/model.zs", `
export function identity<T>(value: T): T { return value; }
`));
  return sources;
}

function conflictingGenericInferenceGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import model from "./model.zs";
function main(): i32 { return model.choose(42, true); }
`));
  sources.push(module("/workspace/model.zs", `
export function choose<T>(left: T, right: T): T { return left; }
`));
  return sources;
}

function explicitGenericMismatchGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import { identity } from "./model.zs";
function main(): boolean { return identity<boolean>(42); }
`));
  sources.push(module("/workspace/model.zs", `
export function identity<T>(value: T): T { return value; }
`));
  return sources;
}

function genericArityMismatchGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import { identity } from "./model.zs";
function main(): i32 { return identity<i32, boolean>(42); }
`));
  sources.push(module("/workspace/model.zs", `
export function identity<T>(value: T): T { return value; }
`));
  return sources;
}

function matchTypingGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
struct User { id: i32; name: String; }
enum Lookup { found User, missing, }

function inspect(value: Lookup): i32 {
  return match (value) {
    found({ id }) => id;
    missing => 0;
  };
}

function inspectOption(value: Option<String>): String {
  return match (value) {
    some(text) => text;
    none => "";
  };
}

function inspectResult(value: Result<i32, String>): i32 {
  return match (value) {
    success(answer) => answer;
    failure(error) => 0;
  };
}
`));
  return sources;
}

function nonExhaustiveMatchGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
enum State { ready, stopped, }
function inspect(value: State): i32 {
  return match (value) { ready => 1; };
}
`));
  return sources;
}

function unknownMatchVariantGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
enum State { ready, }
function inspect(value: State): i32 {
  return match (value) { missing => 1; };
}
`));
  return sources;
}

function duplicateMatchArmGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
enum State { ready, }
function inspect(value: State): i32 {
  return match (value) { ready => 1; ready => 2; };
}
`));
  return sources;
}

function invalidMatchPayloadGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
enum State { ready i32, stopped, }
function inspect(value: State): i32 {
  return match (value) { ready => 1; stopped(extra) => extra; };
}
`));
  return sources;
}

function invalidMatchFieldGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
struct User { id: i32; }
enum Lookup { found User, missing, }
function inspect(value: Lookup): i32 {
  return match (value) { found({ name }) => 1; missing => 0; };
}
`));
  return sources;
}

function mismatchedMatchArmsGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
enum Choice { count i32, enabled boolean, }
function inspect(value: Choice): i32 {
  return match (value) { count(number) => number; enabled(flag) => flag; };
}
`));
  return sources;
}

function nonEnumMatchGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
function inspect(value: i32): i32 {
  return match (value) { ready => 1; };
}
`));
  return sources;
}

function symbolKindsGraph(): Array<ModuleSource> {
  let sources = Array<ModuleSource>();
  sources.push(module("/workspace/main.zs", `
import native from "native.h";
export struct Point { value: i32; }
export class Session { id: i32; }
export trait Named {}
export enum State { ready }
export function value(): i32 { return 42; }
`));
  return sources;
}

function resolvesTo(
  sources: Array<ModuleSource>,
  kind: ModuleResolveErrorKind
): boolean {
  const outcome = attempt resolveModules(sources, "/workspace/main.zs");
  return match (outcome) {
    success(graph) => false;
    failure(error) => error.kind == kind;
  };
}

function targetIs(in symbol: ModuleSymbol, expected: usize): boolean {
  return match (in symbol.targetModule) {
    some(index) => index == expected;
    none => false;
  };
}

function hasNoTarget(in symbol: ModuleSymbol): boolean {
  return match (in symbol.targetModule) {
    some(index) => false;
    none => true;
  };
}

function hasFunctionSignature(
  in symbol: ModuleSymbol,
  parameterCount: usize,
  in returnType: String
): boolean {
  return match (in symbol.functionSignature) {
    some(signature) => signature.parameterTypes.length == parameterCount
      && signature.returnType == returnType;
    none => false;
  };
}

function validOrder(in graph: ModuleGraph): boolean {
  return graph.entry == 0
    && graph.modules.length == 3
    && graph.modules[0].dependencies.length == 2
    && graph.modules[0].dependencies[0] == 1
    && graph.modules[0].dependencies[1] == 2
    && graph.modules[2].dependencies.length == 1
    && graph.modules[2].dependencies[0] == 1
    && graph.dependencyOrder.length == 3
    && graph.dependencyOrder[0] == 1
    && graph.dependencyOrder[1] == 2
    && graph.dependencyOrder[2] == 0
    && graph.modules[0].symbols.length == 3
    && graph.modules[0].symbols[0].name == "main"
    && graph.modules[0].symbols[0].kind == ModuleSymbolKind.functionSymbol
    && graph.modules[0].symbols[1].name == "selected"
    && graph.modules[0].symbols[1].kind == ModuleSymbolKind.importedSymbol
    && graph.modules[0].symbols[1].importedName == "value"
    && targetIs(graph.modules[0].symbols[1], 1)
    && graph.modules[0].symbols[2].name == "helper"
    && graph.modules[0].symbols[2].kind == ModuleSymbolKind.namespaceSymbol
    && targetIs(graph.modules[0].symbols[2], 2)
    && graph.modules[1].symbols[0].exported
    && hasFunctionSignature(graph.modules[1].symbols[0], 0, "i32")
    && hasFunctionSignature(graph.modules[2].symbols[0], 0, "i32")
    && graph.modules[2].symbols[0].exported;
}

function validSymbolKinds(in graph: ModuleGraph): boolean {
  return graph.modules.length == 1
    && graph.modules[0].symbols.length == 6
    && graph.modules[0].symbols[0].kind == ModuleSymbolKind.structSymbol
    && graph.modules[0].symbols[1].kind == ModuleSymbolKind.classSymbol
    && graph.modules[0].symbols[2].kind == ModuleSymbolKind.traitSymbol
    && graph.modules[0].symbols[3].kind == ModuleSymbolKind.enumSymbol
    && graph.modules[0].symbols[4].kind == ModuleSymbolKind.functionSymbol
    && graph.modules[0].symbols[5].kind == ModuleSymbolKind.namespaceSymbol
    && hasNoTarget(graph.modules[0].symbols[5]);
}

function main(): i32 {
  const successSources = successfulGraph();
  const success = attempt resolveModules(successSources, "/workspace/app/main.zs");
  const graphIsValid = match (success) {
    success(graph) => validOrder(graph);
    failure(error) => false;
  };
  if (!graphIsValid) return 1;
  if (!resolvesTo(missingModuleGraph(), ModuleResolveErrorKind.missingModule)) return 2;
  if (!resolvesTo(missingExportGraph(), ModuleResolveErrorKind.missingExport)) return 3;
  if (!resolvesTo(circularGraph(), ModuleResolveErrorKind.circularImport)) return 4;
  if (!resolvesTo(duplicateBindingGraph(), ModuleResolveErrorKind.duplicateBinding)) return 5;
  if (!resolvesTo(unknownNameGraph(), ModuleResolveErrorKind.unknownName)) return 6;
  if (!resolvesTo(useBeforeBindingGraph(), ModuleResolveErrorKind.unknownName)) return 7;
  if (!resolvesTo(escapedBlockBindingGraph(), ModuleResolveErrorKind.unknownName)) return 8;
  if (!resolvesTo(unknownTypeGraph(), ModuleResolveErrorKind.unknownType)) return 9;
  if (!resolvesTo(unknownClosureTypeGraph(), ModuleResolveErrorKind.unknownType)) return 10;
  if (!resolvesTo(importedValueAsTypeGraph(), ModuleResolveErrorKind.unknownType)) return 11;
  const lexicalSources = lexicalScopesGraph();
  const lexicalOutcome = attempt resolveModules(lexicalSources, "/workspace/main.zs");
  const lexicalIsValid = match (lexicalOutcome) {
    success(graph) => graph.modules.length == 1;
    failure(error) => false;
  };
  if (!lexicalIsValid) return 12;
  const typeSources = typeScopesGraph();
  const typeOutcome = attempt resolveModules(typeSources, "/workspace/main.zs");
  const typesAreValid = match (typeOutcome) {
    success(graph) => graph.modules.length == 2;
    failure(error) => false;
  };
  if (!typesAreValid) return 13;
  const expressionSources = expressionTypingGraph();
  const expressionOutcome = attempt resolveModules(expressionSources, "/workspace/main.zs");
  const expressionsAreValid = match (expressionOutcome) {
    success(graph) => graph.modules.length == 1;
    failure(error) => false;
  };
  if (!expressionsAreValid) return 14;
  if (!resolvesTo(expressionMismatchGraph(), ModuleResolveErrorKind.typeMismatch)) return 15;
  if (!resolvesTo(invalidOperatorGraph(), ModuleResolveErrorKind.invalidOperator)) return 16;
  if (!resolvesTo(crossModuleTypeMismatchGraph(), ModuleResolveErrorKind.typeMismatch)) return 17;
  const genericSources = genericInferenceGraph();
  const genericOutcome = attempt resolveModules(genericSources, "/workspace/main.zs");
  const genericsAreValid = match (genericOutcome) {
    success(graph) => graph.modules.length == 2;
    failure(error) => false;
  };
  if (!genericsAreValid) return 18;
  if (!resolvesTo(genericReturnMismatchGraph(), ModuleResolveErrorKind.typeMismatch)) return 19;
  if (!resolvesTo(conflictingGenericInferenceGraph(), ModuleResolveErrorKind.typeMismatch)) return 20;
  if (!resolvesTo(explicitGenericMismatchGraph(), ModuleResolveErrorKind.typeMismatch)) return 21;
  if (!resolvesTo(genericArityMismatchGraph(), ModuleResolveErrorKind.typeMismatch)) return 22;
  const matchSources = matchTypingGraph();
  const matchOutcome = attempt resolveModules(matchSources, "/workspace/main.zs");
  const matchesAreValid = match (matchOutcome) {
    success(graph) => graph.modules.length == 1;
    failure(error) => false;
  };
  if (!matchesAreValid) return 23;
  if (!resolvesTo(nonExhaustiveMatchGraph(), ModuleResolveErrorKind.invalidMatch)) return 24;
  if (!resolvesTo(unknownMatchVariantGraph(), ModuleResolveErrorKind.invalidMatch)) return 25;
  if (!resolvesTo(duplicateMatchArmGraph(), ModuleResolveErrorKind.invalidMatch)) return 26;
  if (!resolvesTo(invalidMatchPayloadGraph(), ModuleResolveErrorKind.invalidMatch)) return 27;
  if (!resolvesTo(invalidMatchFieldGraph(), ModuleResolveErrorKind.invalidMatch)) return 28;
  if (!resolvesTo(mismatchedMatchArmsGraph(), ModuleResolveErrorKind.typeMismatch)) return 29;
  if (!resolvesTo(nonEnumMatchGraph(), ModuleResolveErrorKind.invalidMatch)) return 30;
  const kindSources = symbolKindsGraph();
  const kindOutcome = attempt resolveModules(kindSources, "/workspace/main.zs");
  const kindsAreValid = match (kindOutcome) {
    success(graph) => validSymbolKinds(graph);
    failure(error) => false;
  };
  if (!kindsAreValid) return 31;
  return 0;
}
