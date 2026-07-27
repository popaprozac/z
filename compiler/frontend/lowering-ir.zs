// Typed, target-neutral lowering boundary between native semantics and C text.
//
// The parser AST preserves source structure. This IR instead records settled
// operations: checked arithmetic is no longer an operator string, and aggregate
// construction is no longer a call-shaped syntax node. Cleanup plans will join
// this representation when ownership-bearing aggregates land.

import {
  DeclarationKind,
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  FunctionDeclaration,
  ParameterMode,
  Program,
  StatementArena,
  StatementKind,
  TypeReference,
} from "./parser.zs";
import {
  ParsedModule,
  moduleSymbolIndex,
} from "./module-symbols.zs";
import {
  ModuleGraph,
  ModuleSemanticEvidence,
  ModuleSymbolKind,
} from "./semantic-model.zs";
import { genericTypeShape } from "./semantic-type-shapes.zs";

export enum LoweredTypeKind {
  voidType,
  booleanType,
  i32Type,
  structType,
  enumType,
}

export struct LoweredType {
  kind: LoweredTypeKind;
  name: String;
}

export struct LoweredField {
  name: String;
  type: LoweredType;
}

export struct LoweredStruct {
  name: String;
  fields: Array<LoweredField>;
  needsDeinit: boolean;
  deinitializer: Option<LoweredFunction>;
}

export struct LoweredEnum {
  name: String;
  variants: Array<LoweredVariant>;
  payloadBearing: boolean;
  needsDeinit: boolean;
}

export struct LoweredVariant {
  name: String;
  payload: Option<LoweredType>;
}

export struct LoweredParameter {
  name: String;
  type: LoweredType;
}

export enum LoweredExpressionKind {
  localValue,
  receiverValue,
  integerValue,
  booleanValue,
  checkedAddI32,
  checkedSubtractI32,
  checkedMultiplyI32,
  checkedNegateI32,
  moveValue,
  unaryOperation,
  binaryOperation,
  directCall,
  fieldValue,
  structValue,
  enumValue,
  enumPayloadValue,
}

export struct LoweredExpression {
  kind: LoweredExpressionKind;
  value: String;
  children: Array<usize>;
  labels: Array<String>;
}

export enum LoweredStatementKind {
  localStatement,
  assignmentStatement,
  returnStatement,
  expressionStatement,
  blockStatement,
  ifStatement,
  whileStatement,
  tryStatement,
  matchStatement,
  matchArmStatement,
  breakStatement,
  continueStatement,
}

export struct LoweredStatement {
  kind: LoweredStatementKind;
  mutableBinding: boolean;
  name: String;
  type: Option<LoweredType>;
  expression: Option<usize>;
  secondExpression: Option<usize>;
  children: Array<usize>;
  cleanups: Array<LoweredCleanup>;
  liveFlag: String;
  labels: Array<String>;
  matchConsumesSubject: boolean;
  matchBindingNeedsCleanup: boolean;
}

export struct LoweredCleanup {
  name: String;
  type: LoweredType;
  guard: String;
}

export struct LoweredLiveFlag {
  owner: String;
  name: String;
  parameter: boolean;
}

export struct LoweredFunction {
  name: String;
  parameters: Array<LoweredParameter>;
  returnType: LoweredType;
  expressions: Array<LoweredExpression>;
  statements: Array<LoweredStatement>;
  roots: Array<usize>;
  fallthroughCleanups: Array<LoweredCleanup>;
  liveFlags: Array<LoweredLiveFlag>;
}

export struct LoweredProgram {
  structs: Array<LoweredStruct>;
  enums: Array<LoweredEnum>;
  functions: Array<LoweredFunction>;
}

struct LoweredImportedType {
  localName: String;
  targetName: String;
  kind: LoweredTypeKind;
  needsDeinit: boolean;
  variants: Array<LoweredVariant>;
  payloadBearing: boolean;
}

function structIndex(in program: Program, in name: String): Option<usize> {
  let index: usize = 0;
  while (index < program.aggregates.length) {
    if (
      program.aggregates[index].kind == DeclarationKind.structDeclaration
      && program.aggregates[index].name == name
    ) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function enumIndex(in program: Program, in name: String): Option<usize> {
  let index: usize = 0;
  while (index < program.enums.length) {
    if (program.enums[index].name == name) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function enumHasPayload(in program: Program, index: usize): boolean {
  for (const variant of program.enums[index].variants) {
    match (in variant.payload) {
      some(_) => return true;
      none => {}
    }
  }
  return false;
}

function stringStartsWith(in value: String, in prefix: String): boolean {
  if (value.byteLength < prefix.byteLength) return false;
  let index: usize = 0;
  while (index < prefix.byteLength) {
    if (value.byteAt(index) != prefix.byteAt(index)) return false;
    index = index + 1;
  }
  return true;
}

function loweredTypeIdentity(in type: LoweredType): String {
  if (type.kind == LoweredTypeKind.voidType) return "void";
  if (type.kind == LoweredTypeKind.booleanType) return "boolean";
  if (type.kind == LoweredTypeKind.i32Type) return "i32";
  return type.name.copyBytes(0, type.name.byteLength);
}

function intrinsicOptionName(in payload: LoweredType): String {
  const identity = loweredTypeIdentity(payload);
  return `__z_Option_${identity}`;
}

function intrinsicResultName(
  in successType: LoweredType,
  in errorType: LoweredType
): String {
  const successIdentity = loweredTypeIdentity(successType);
  const errorIdentity = loweredTypeIdentity(errorType);
  return `__z_Result_${successIdentity}_${errorIdentity}`;
}

function intrinsicOptionPayloadName(in name: String): Option<String> {
  const prefix = "__z_Option_";
  if (!stringStartsWith(name, prefix)) return Option<String>.none;
  return Option.some(name.copyBytes(prefix.byteLength, name.byteLength));
}

function lowerTypeName(
  in program: Program,
  in name: String
): LoweredType throws String {
  if (name == "void") return LoweredType({ kind: LoweredTypeKind.voidType, name: "" });
  if (name == "boolean") {
    return LoweredType({ kind: LoweredTypeKind.booleanType, name: "" });
  }
  if (name == "i32") return LoweredType({ kind: LoweredTypeKind.i32Type, name: "" });
  match (intrinsicOptionPayloadName(name)) {
    some(_) => return LoweredType({
      kind: LoweredTypeKind.enumType,
      name: name.copyBytes(0, name.byteLength),
    });
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base == "Option" && generic.arguments.length == 1) {
        const payload = try lowerTypeName(program, generic.arguments[0]);
        return LoweredType({
          kind: LoweredTypeKind.enumType,
          name: intrinsicOptionName(payload),
        });
      }
      if (generic.base == "Result" && generic.arguments.length == 2) {
        const successType = try lowerTypeName(program, generic.arguments[0]);
        const errorType = try lowerTypeName(program, generic.arguments[1]);
        return LoweredType({
          kind: LoweredTypeKind.enumType,
          name: intrinsicResultName(successType, errorType),
        });
      }
    }
    none => {}
  }
  match (structIndex(program, name)) {
    some(_) => return LoweredType({
      kind: LoweredTypeKind.structType,
      name: name.copyBytes(0, name.byteLength),
    });
    none => {}
  }
  match (enumIndex(program, name)) {
    some(_) => return LoweredType({
      kind: LoweredTypeKind.enumType,
      name: name.copyBytes(0, name.byteLength),
    });
    none => {}
  }
  throw `native lowering does not support type ${name} yet`;
}

function lowerType(in program: Program, in type: TypeReference): LoweredType throws String {
  return try lowerTypeName(program, type.name);
}

function lowerModuleTypeName(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): LoweredType throws String {
  const local = attempt lowerTypeName(program, name);
  match (local) {
    success(type) => return type;
    failure(_) => {}
  }
  for (const imported of importedTypes) {
    if (
      imported.localName == name
      || imported.targetName == name
    ) return LoweredType({
      kind: imported.kind,
      name: imported.targetName.copyBytes(0, imported.targetName.byteLength),
    });
  }
  throw `native lowering does not support type ${name} yet`;
}

function lowerModuleType(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in type: TypeReference
): LoweredType throws String {
  return try lowerModuleTypeName(program, importedTypes, type.name);
}

function lowerBindingType(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  index: usize
): LoweredType throws String {
  match (in arena.nodes[index].typeAnnotation) {
    some(annotation) => return try lowerModuleType(
      program,
      importedTypes,
      annotation
    );
    none => {}
  }
  for (const binding of evidence.bindingResolutions) {
    if (
      binding.offset == arena.nodes[index].nameOffset
      && binding.name == arena.nodes[index].name
    ) return try lowerModuleTypeName(
      program,
      importedTypes,
      binding.typeName
    );
  }
  throw `native lowering could not find the inferred type for local ${arena.nodes[index].name}`;
}

function enumNeedsCleanup(
  in program: Program,
  index: usize,
  depth: usize
): boolean {
  if (depth > program.aggregates.length + program.enums.length) return false;
  for (const variant of program.enums[index].variants) {
    match (in variant.payload) {
      some(payload) => {
        match (structIndex(program, payload.name)) {
          some(aggregateIndex) => {
            if (aggregateNeedsCleanup(program, aggregateIndex, depth + 1)) {
              return true;
            }
          }
          none => {}
        }
        match (enumIndex(program, payload.name)) {
          some(enumPosition) => {
            if (enumNeedsCleanup(program, enumPosition, depth + 1)) return true;
          }
          none => {}
        }
      }
      none => {}
    }
  }
  return false;
}

function aggregateNeedsCleanup(
  in program: Program,
  index: usize,
  depth: usize
): boolean {
  if (depth > program.aggregates.length + program.enums.length) return false;
  match (in program.aggregates[index].deinitializer) {
    some(_) => return true;
    none => {}
  }
  for (const field of program.aggregates[index].fields) {
    match (structIndex(program, field.type.name)) {
      some(fieldIndex) => {
        if (aggregateNeedsCleanup(program, fieldIndex, depth + 1)) return true;
      }
      none => {}
    }
    match (enumIndex(program, field.type.name)) {
      some(fieldIndex) => {
        if (enumNeedsCleanup(program, fieldIndex, depth + 1)) return true;
      }
      none => {}
    }
  }
  return false;
}

function typeNeedsCleanup(in program: Program, in type: LoweredType): boolean {
  if (type.kind == LoweredTypeKind.structType) {
    match (structIndex(program, type.name)) {
      some(index) => return aggregateNeedsCleanup(program, index, 0);
      none => return false;
    }
  }
  if (type.kind == LoweredTypeKind.enumType) {
    match (enumIndex(program, type.name)) {
      some(index) => return enumNeedsCleanup(program, index, 0);
      none => {}
    }
    match (intrinsicOptionPayloadName(type.name)) {
      some(payloadName) => {
        const payload = attempt lowerTypeName(program, payloadName);
        return match (payload) {
          success(lowered) => typeNeedsCleanup(program, lowered);
          failure(_) => false;
        };
      }
      none => {}
    }
    for (const declaration of program.functions) {
      match (in declaration.errorType) {
        some(error) => {
          const successType = attempt lowerType(program, declaration.returnType);
          const errorType = attempt lowerType(program, error);
          match (successType) {
            success(successValue) => {
              match (errorType) {
                success(errorValue) => {
                  if (
                    intrinsicResultName(successValue, errorValue) == type.name
                  ) {
                    return typeNeedsCleanup(program, successValue)
                      || typeNeedsCleanup(program, errorValue);
                  }
                }
                failure(_) => {}
              }
            }
            failure(_) => {}
          }
        }
        none => {}
      }
    }
  }
  return false;
}

function moduleEnumNeedsCleanup(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  index: usize,
  depth: usize
): boolean {
  if (depth > program.aggregates.length + program.enums.length) return false;
  for (const variant of program.enums[index].variants) {
    match (in variant.payload) {
      some(payload) => {
        const lowered = attempt lowerModuleType(program, importedTypes, payload);
        match (lowered) {
          success(type) => {
            if (moduleTypeNeedsCleanupDepth(
              program,
              importedTypes,
              type,
              depth + 1
            )) return true;
          }
          failure(_) => {}
        }
      }
      none => {}
    }
  }
  return false;
}

function moduleAggregateNeedsCleanup(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  index: usize,
  depth: usize
): boolean {
  if (depth > program.aggregates.length + program.enums.length) return false;
  match (in program.aggregates[index].deinitializer) {
    some(_) => return true;
    none => {}
  }
  for (const field of program.aggregates[index].fields) {
    const lowered = attempt lowerModuleType(program, importedTypes, field.type);
    match (lowered) {
      success(type) => {
        if (moduleTypeNeedsCleanupDepth(
          program,
          importedTypes,
          type,
          depth + 1
        )) return true;
      }
      failure(_) => {}
    }
  }
  return false;
}

function moduleTypeNeedsCleanupDepth(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in type: LoweredType,
  depth: usize
): boolean {
  if (type.kind == LoweredTypeKind.structType) {
    match (structIndex(program, type.name)) {
      some(index) => return moduleAggregateNeedsCleanup(
        program,
        importedTypes,
        index,
        depth
      );
      none => {}
    }
  }
  if (type.kind == LoweredTypeKind.enumType) {
    match (enumIndex(program, type.name)) {
      some(index) => return moduleEnumNeedsCleanup(
        program,
        importedTypes,
        index,
        depth
      );
      none => {}
    }
  }
  for (const imported of importedTypes) {
    if (
      imported.kind == type.kind
      && (
        imported.localName == type.name
        || imported.targetName == type.name
      )
    ) return imported.needsDeinit;
  }
  return typeNeedsCleanup(program, type);
}

function moduleTypeNeedsCleanup(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in type: LoweredType
): boolean {
  return moduleTypeNeedsCleanupDepth(program, importedTypes, type, 0);
}

function intrinsicOptionDeclaration(
  in program: Program,
  in name: String
): Option<LoweredEnum> throws String {
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base != "Option" || generic.arguments.length != 1) {
        return Option<LoweredEnum>.none;
      }
      const payload = try lowerTypeName(program, generic.arguments[0]);
      let variants = Array<LoweredVariant>();
      variants.push(LoweredVariant({
        name: "some",
        payload: Option.some(LoweredType({
          kind: payload.kind,
          name: payload.name.copyBytes(0, payload.name.byteLength),
        })),
      }));
      variants.push(LoweredVariant({
        name: "none",
        payload: Option<LoweredType>.none,
      }));
      return Option.some(LoweredEnum({
        name: intrinsicOptionName(payload),
        variants,
        payloadBearing: true,
        needsDeinit: typeNeedsCleanup(program, payload),
      }));
    }
    none => return Option<LoweredEnum>.none;
  }
}

function intrinsicResultDeclaration(
  in program: Program,
  in name: String
): Option<LoweredEnum> throws String {
  match (genericTypeShape(name)) {
    some(generic) => {
      if (generic.base != "Result" || generic.arguments.length != 2) {
        return Option<LoweredEnum>.none;
      }
      const successType = try lowerTypeName(program, generic.arguments[0]);
      const errorType = try lowerTypeName(program, generic.arguments[1]);
      let variants = Array<LoweredVariant>();
      let successPayload = Option<LoweredType>.none;
      if (successType.kind != LoweredTypeKind.voidType) {
        successPayload = Option.some(LoweredType({
          kind: successType.kind,
          name: successType.name.copyBytes(0, successType.name.byteLength),
        }));
      }
      variants.push(LoweredVariant({
        name: "success",
        payload: successPayload,
      }));
      variants.push(LoweredVariant({
        name: "failure",
        payload: Option.some(LoweredType({
          kind: errorType.kind,
          name: errorType.name.copyBytes(0, errorType.name.byteLength),
        })),
      }));
      return Option.some(LoweredEnum({
        name: intrinsicResultName(successType, errorType),
        variants,
        payloadBearing: true,
        needsDeinit: typeNeedsCleanup(program, successType)
          || typeNeedsCleanup(program, errorType),
      }));
    }
    none => return Option<LoweredEnum>.none;
  }
}

function intrinsicEnumDeclaration(
  in program: Program,
  in name: String
): Option<LoweredEnum> throws String {
  const option = try intrinsicOptionDeclaration(program, name);
  match (option) {
    some(declaration) => return Option.some(move declaration);
    none => {}
  }
  return try intrinsicResultDeclaration(program, name);
}

function throwingFunctionResult(
  in program: Program,
  in ownerName: String
): Option<LoweredEnum> throws String {
  for (const declaration of program.functions) {
    if (declaration.name == ownerName) {
      match (in declaration.errorType) {
        some(errorType) => {
          const returnName = declaration.returnType.name.copyBytes(
            0,
            declaration.returnType.name.byteLength
          );
          const errorName = errorType.name.copyBytes(0, errorType.name.byteLength);
          const resultName = `Result<${returnName}, ${errorName}>`;
          return try intrinsicResultDeclaration(program, resultName);
        }
        none => return Option<LoweredEnum>.none;
      }
    }
  }
  return Option<LoweredEnum>.none;
}

function copyCleanup(in cleanup: LoweredCleanup): LoweredCleanup {
  return LoweredCleanup({
    name: cleanup.name.copyBytes(0, cleanup.name.byteLength),
    type: LoweredType({
      kind: cleanup.type.kind,
      name: cleanup.type.name.copyBytes(0, cleanup.type.name.byteLength),
    }),
    guard: cleanup.guard.copyBytes(0, cleanup.guard.byteLength),
  });
}

function treeMovesName(
  in program: Program,
  in tree: ExpressionTree,
  index: usize,
  in name: String
): boolean {
  if (
    tree.nodes[index].kind == ExpressionKind.matchExpression
    && tree.nodes[index].value != "in"
    && tree.nodes[index].children.length > 0
  ) {
    const subject = tree.nodes[index].children[0];
    if (
      tree.nodes[subject].kind == ExpressionKind.identifierExpression
      && tree.nodes[subject].value == name
    ) return true;
  }
  if (
    tree.nodes[index].kind == ExpressionKind.unaryExpression
    && tree.nodes[index].value == "move"
    && tree.nodes[index].children.length == 1
  ) {
    const operand = tree.nodes[index].children[0];
    if (
      tree.nodes[operand].kind == ExpressionKind.identifierExpression
      && tree.nodes[operand].value == name
    ) return true;
  }
  if (
    tree.nodes[index].kind == ExpressionKind.callExpression
    && tree.nodes[index].children.length > 0
  ) {
    const callee = tree.nodes[index].children[0];
    if (tree.nodes[callee].kind == ExpressionKind.identifierExpression) {
      for (const aggregate of program.aggregates) {
        if (
          aggregate.name != tree.nodes[callee].value
          || tree.nodes[index].children.length != 2
        ) continue;
        const initializer = tree.nodes[index].children[1];
        if (tree.nodes[initializer].kind != ExpressionKind.objectExpression) {
          continue;
        }
        for (const field of tree.nodes[initializer].children) {
          if (
            tree.nodes[field].kind == ExpressionKind.identifierExpression
            && tree.nodes[field].value == name
          ) return true;
        }
      }
      for (const declaration of program.functions) {
        if (declaration.name != tree.nodes[callee].value) continue;
        let parameter: usize = 0;
        while (
          parameter < declaration.parameters.length
          && parameter + 1 < tree.nodes[index].children.length
        ) {
          const argument = tree.nodes[index].children[parameter + 1];
          if (
            declaration.parameters[parameter].mode == ParameterMode.value
            && tree.nodes[argument].kind == ExpressionKind.identifierExpression
            && tree.nodes[argument].value == name
          ) return true;
          parameter = parameter + 1;
        }
      }
    }
  }
  for (const child of tree.nodes[index].children) {
    if (treeMovesName(program, tree, child, name)) return true;
  }
  return false;
}

function syntaxMovesName(
  in program: Program,
  in expression: ExpressionSyntax,
  in name: String
): boolean {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      select treeMovesName(program, tree, root, name);
    }
    none => false;
  };
}

function syntaxIsIdentifier(
  in expression: ExpressionSyntax,
  in name: String
): boolean {
  return match (in expression.tree) {
    some(tree) => tree.nodes[tree.root].kind
      == ExpressionKind.identifierExpression
      && tree.nodes[tree.root].value == name;
    none => false;
  };
}

function arenaMovesName(
  in program: Program,
  in arena: StatementArena,
  in name: String
): boolean {
  for (const statement of arena.nodes) {
    match (in statement.expression) {
      some(expression) => {
        if (syntaxMovesName(program, expression, name)) return true;
      }
      none => {}
    }
    match (in statement.secondExpression) {
      some(expression) => {
        if (syntaxMovesName(program, expression, name)) return true;
      }
      none => {}
    }
  }
  return false;
}

function arenaHasControlFlow(in arena: StatementArena): boolean {
  for (const statement of arena.nodes) {
    if (
      statement.kind == StatementKind.ifStatement
      || statement.kind == StatementKind.whileStatement
    ) return true;
  }
  return false;
}

function arenaHasLoop(in arena: StatementArena): boolean {
  for (const statement of arena.nodes) {
    if (statement.kind == StatementKind.whileStatement) return true;
  }
  return false;
}

function ownerLiveFlag(in name: String): String {
  return `_z_stage1_live_${name}`;
}

function statementFallsThrough(in arena: StatementArena, index: usize): boolean {
  if (
    arena.nodes[index].kind == StatementKind.returnStatement
    || arena.nodes[index].kind == StatementKind.throwStatement
    || arena.nodes[index].kind == StatementKind.breakStatement
    || arena.nodes[index].kind == StatementKind.continueStatement
  ) return false;
  if (arena.nodes[index].kind == StatementKind.blockStatement) {
    let children = Array<usize>();
    for (const child of arena.nodes[index].children) {
      children.push(child);
    }
    return sequenceFallsThrough(arena, children);
  }
  if (arena.nodes[index].kind == StatementKind.ifStatement) {
    if (arena.nodes[index].children.length < 2) return true;
    const thenBranch = arena.nodes[index].children[0];
    const elseBranch = arena.nodes[index].children[1];
    return statementFallsThrough(arena, thenBranch)
      || statementFallsThrough(arena, elseBranch);
  }
  return true;
}

function sequenceFallsThrough(
  in arena: StatementArena,
  in roots: Array<usize>
): boolean {
  for (const root of roots) {
    if (!statementFallsThrough(arena, root)) return false;
  }
  return true;
}

function loweredSequenceFallsThrough(
  in statements: Array<LoweredStatement>,
  in roots: Array<usize>
): boolean {
  if (roots.length == 0) return true;
  const last = roots[roots.length - 1];
  if (
    statements[last].kind == LoweredStatementKind.returnStatement
    || statements[last].kind == LoweredStatementKind.breakStatement
    || statements[last].kind == LoweredStatementKind.continueStatement
  ) return false;
  if (statements[last].kind == LoweredStatementKind.blockStatement) {
    return loweredSequenceFallsThrough(statements, statements[last].children);
  }
  return true;
}

function appendCleanupCopies(
  inout output: Array<LoweredCleanup>,
  in cleanups: Array<LoweredCleanup>
): void {
  for (const cleanup of cleanups) {
    output.push(copyCleanup(cleanup));
  }
}

function appendStatementCleanupCopies(
  inout statements: Array<LoweredStatement>,
  index: usize,
  in cleanups: Array<LoweredCleanup>
): void {
  for (const cleanup of cleanups) {
    statements[index].cleanups.push(copyCleanup(cleanup));
  }
}

function attachReplacementCleanup(
  in arena: StatementArena,
  index: usize,
  in cleanups: Array<LoweredCleanup>,
  inout statements: Array<LoweredStatement>,
  loweredIndex: usize
): void {
  match (in arena.nodes[index].expression) {
    some(expression) => match (in expression.tree) {
      some(tree) => {
        if (tree.nodes[tree.root].kind != ExpressionKind.identifierExpression) {
          return;
        }
        for (const cleanup of cleanups) {
          if (tree.nodes[tree.root].value == cleanup.name) {
            statements[loweredIndex].cleanups.push(copyCleanup(cleanup));
            return;
          }
        }
      }
      none => {}
    }
    none => {}
  }
}

function planCleanupStatement(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in arena: StatementArena,
  in ownerName: String,
  sourceIndex: usize,
  loweredIndex: usize,
  in live: Array<LoweredCleanup>,
  inout statements: Array<LoweredStatement>,
  inout liveFlags: Array<LoweredLiveFlag>,
  insideLoop: boolean,
  in loopCleanups: Array<LoweredCleanup>
): void throws String {
  if (statements[loweredIndex].kind == LoweredStatementKind.returnStatement) {
    appendStatementCleanupCopies(inout statements, loweredIndex, live);
    return;
  }
  if (statements[loweredIndex].kind == LoweredStatementKind.tryStatement) {
    appendStatementCleanupCopies(inout statements, loweredIndex, live);
    return;
  }
  if (
    statements[loweredIndex].kind == LoweredStatementKind.localStatement
    && statements[loweredIndex].children.length == 1
    && statements[statements[loweredIndex].children[0]].kind
      == LoweredStatementKind.tryStatement
  ) {
    const loweredTry = statements[loweredIndex].children[0];
    for (const cleanup of live) {
      if (cleanup.name != statements[loweredIndex].name) {
        statements[loweredTry].cleanups.push(copyCleanup(cleanup));
      }
    }
    return;
  }
  if (
    statements[loweredIndex].kind == LoweredStatementKind.localStatement
    && statements[loweredIndex].children.length == 1
    && statements[statements[loweredIndex].children[0]].kind
      == LoweredStatementKind.matchStatement
  ) {
    const loweredMatch = statements[loweredIndex].children[0];
    try planCleanupStatement(
      program,
      importedTypes,
      arena,
      ownerName,
      sourceIndex,
      loweredMatch,
      live,
      inout statements,
      inout liveFlags,
      insideLoop,
      loopCleanups
    );
    return;
  }
  if (statements[loweredIndex].kind == LoweredStatementKind.matchStatement) {
    match (in arena.nodes[sourceIndex].expression) {
      some(syntax) => {
        match (in syntax.tree) {
          some(tree) => {
            const root = tree.root;
            const consuming = tree.nodes[root].value != "in";
            const subject = tree.nodes[root].children[0];
            if (
              consuming
              && tree.nodes[subject].kind == ExpressionKind.identifierExpression
            ) {
              for (const cleanup of live) {
                if (cleanup.name == tree.nodes[subject].value) {
                  statements[loweredIndex].liveFlag = cleanup.guard.copyBytes(
                    0,
                    cleanup.guard.byteLength
                  );
                }
              }
            }
            let armPosition: usize = 1;
            while (armPosition < tree.nodes[root].children.length) {
              const arm = tree.nodes[root].children[armPosition];
              const loweredArm = statements[loweredIndex].children[armPosition - 1];
              let sourceRoots = Array<usize>();
              for (const bodyIndex of tree.nodes[arm].statements) {
                sourceRoots.push(bodyIndex);
              }
              let loweredRoots = Array<usize>();
              for (const bodyIndex of statements[loweredArm].children) {
                loweredRoots.push(bodyIndex);
              }
              let armLive = Array<LoweredCleanup>();
              appendCleanupCopies(inout armLive, live);
              let payloadCleanup = Option<LoweredCleanup>.none;
              if (statements[loweredArm].matchBindingNeedsCleanup) {
                const payloadType = match (in statements[loweredArm].type) {
                  some(type) => LoweredType({
                    kind: type.kind,
                    name: type.name.copyBytes(0, type.name.byteLength),
                  });
                  none => throw "native cleanup planning lost a match payload type";
                };
                if (statements[loweredArm].labels.length != 1) {
                  throw "native cleanup planning lost a match payload binding";
                }
                const cleanup = LoweredCleanup({
                  name: statements[loweredArm].labels[0].copyBytes(
                    0,
                    statements[loweredArm].labels[0].byteLength
                  ),
                  type: move payloadType,
                  guard: "",
                });
                armLive.push(copyCleanup(cleanup));
                payloadCleanup = Option.some(move cleanup);
              }
              const introduced = try planCleanupSequence(
                program,
                importedTypes,
                arena,
                ownerName,
                sourceRoots,
                loweredRoots,
                armLive,
                inout statements,
                inout liveFlags,
                insideLoop,
                loopCleanups
              );
              if (
                sequenceFallsThrough(arena, sourceRoots)
                && loweredSequenceFallsThrough(statements, loweredRoots)
              ) {
                match (in payloadCleanup) {
                  some(cleanup) => statements[loweredArm].cleanups.push(
                    copyCleanup(cleanup)
                  );
                  none => {}
                }
                appendStatementCleanupCopies(
                  inout statements,
                  loweredArm,
                  introduced
                );
              }
              armPosition = armPosition + 1;
            }
            return;
          }
          none => throw "native cleanup planning received an opaque match";
        }
      }
      none => throw "native cleanup planning received a match without an expression";
    }
  }
  if (arena.nodes[sourceIndex].kind == StatementKind.blockStatement) {
    let sourceChildren = Array<usize>();
    for (const child of arena.nodes[sourceIndex].children) {
      sourceChildren.push(child);
    }
    let loweredChildren = Array<usize>();
    for (const child of statements[loweredIndex].children) {
      loweredChildren.push(child);
    }
    const introduced = try planCleanupSequence(
      program,
      importedTypes,
      arena,
      ownerName,
      sourceChildren,
      loweredChildren,
      live,
      inout statements,
      inout liveFlags,
      insideLoop,
      loopCleanups
    );
    if (
      sequenceFallsThrough(arena, sourceChildren)
      && loweredSequenceFallsThrough(statements, loweredChildren)
    ) {
      appendStatementCleanupCopies(inout statements, loweredIndex, introduced);
    }
    return;
  }
  if (
    arena.nodes[sourceIndex].kind == StatementKind.breakStatement
    || arena.nodes[sourceIndex].kind == StatementKind.continueStatement
  ) {
    appendStatementCleanupCopies(inout statements, loweredIndex, loopCleanups);
    return;
  }
  if (
    arena.nodes[sourceIndex].kind == StatementKind.ifStatement
    || arena.nodes[sourceIndex].kind == StatementKind.whileStatement
  ) {
    let childIndex: usize = 0;
    while (childIndex < arena.nodes[sourceIndex].children.length) {
      const sourceChild = arena.nodes[sourceIndex].children[childIndex];
      const loweredChild = statements[loweredIndex].children[childIndex];
      let childLoopCleanups = Array<LoweredCleanup>();
      if (arena.nodes[sourceIndex].kind == StatementKind.ifStatement) {
        appendCleanupCopies(inout childLoopCleanups, loopCleanups);
      }
      try planCleanupStatement(
        program,
        importedTypes,
        arena,
        ownerName,
        sourceChild,
        loweredChild,
        live,
        inout statements,
        inout liveFlags,
        insideLoop || arena.nodes[sourceIndex].kind == StatementKind.whileStatement,
        childLoopCleanups
      );
      childIndex = childIndex + 1;
    }
  }
}

function planCleanupSequence(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in arena: StatementArena,
  in ownerName: String,
  in sourceRoots: Array<usize>,
  in loweredRoots: Array<usize>,
  in inherited: Array<LoweredCleanup>,
  inout statements: Array<LoweredStatement>,
  inout liveFlags: Array<LoweredLiveFlag>,
  insideLoop: boolean,
  in inheritedLoopCleanups: Array<LoweredCleanup>
): Array<LoweredCleanup> throws String {
  let live = Array<LoweredCleanup>();
  appendCleanupCopies(inout live, inherited);
  let loopCleanups = Array<LoweredCleanup>();
  appendCleanupCopies(inout loopCleanups, inheritedLoopCleanups);
  let introduced = Array<LoweredCleanup>();
  let rootIndex: usize = 0;
  while (rootIndex < sourceRoots.length) {
    const sourceIndex = sourceRoots[rootIndex];
    const loweredIndex = loweredRoots[rootIndex];
    if (arena.nodes[sourceIndex].kind == StatementKind.variableStatement) {
      let localType = Option<LoweredType>.none;
      match (in statements[loweredIndex].type) {
        some(type) => localType = Option.some(LoweredType({
          kind: type.kind,
          name: type.name.copyBytes(0, type.name.byteLength),
        }));
        none => {}
      }
      match (localType) {
        some(type) => {
          const ownedType = LoweredType({
            kind: type.kind,
            name: type.name.copyBytes(0, type.name.byteLength),
          });
          if (moduleTypeNeedsCleanup(program, importedTypes, ownedType)) {
            const moved = arenaMovesName(
              program,
              arena,
              arena.nodes[sourceIndex].name
            );
            if (moved && arenaHasLoop(arena)) {
              throw `native cleanup lowering does not support path-sensitive transfer of ${arena.nodes[sourceIndex].name} in ${ownerName} yet`;
            }
            let guard = "";
            if (moved && arenaHasControlFlow(arena)) {
              guard = ownerLiveFlag(arena.nodes[sourceIndex].name);
              statements[loweredIndex].liveFlag = guard.copyBytes(
                0,
                guard.byteLength
              );
              liveFlags.push(LoweredLiveFlag({
                owner: arena.nodes[sourceIndex].name.copyBytes(
                  0,
                  arena.nodes[sourceIndex].name.byteLength
                ),
                name: guard.copyBytes(0, guard.byteLength),
                parameter: false,
              }));
            }
            if (!moved || guard.byteLength > 0) {
              const cleanup = LoweredCleanup({
                name: arena.nodes[sourceIndex].name.copyBytes(
                  0,
                  arena.nodes[sourceIndex].name.byteLength
                ),
                type: move ownedType,
                guard: move guard,
              });
              live.push(copyCleanup(cleanup));
              if (insideLoop) loopCleanups.push(copyCleanup(cleanup));
              introduced.push(move cleanup);
            }
          }
        }
        none => {}
      }
    } else if (
      arena.nodes[sourceIndex].kind == StatementKind.assignmentStatement
    ) {
      attachReplacementCleanup(
        arena,
        sourceIndex,
        live,
        inout statements,
        loweredIndex
      );
    }
    try planCleanupStatement(
      program,
      importedTypes,
      arena,
      ownerName,
      sourceIndex,
      loweredIndex,
      live,
      inout statements,
      inout liveFlags,
      insideLoop,
      loopCleanups
    );
    rootIndex = rootIndex + 1;
  }
  return introduced;
}

function attachMoveLiveFlags(
  inout expressions: Array<LoweredExpression>,
  in liveFlags: Array<LoweredLiveFlag>
): void {
  let index: usize = 0;
  while (index < expressions.length) {
    if (
      expressions[index].kind == LoweredExpressionKind.moveValue
      && expressions[index].children.length == 1
    ) {
      const operand = expressions[index].children[0];
      expressions[index].value = "";
      if (expressions[operand].kind == LoweredExpressionKind.localValue) {
        for (const flag of liveFlags) {
          if (flag.owner == expressions[operand].value) {
            expressions[index].value = flag.name.copyBytes(0, flag.name.byteLength);
          }
        }
      }
    }
    index = index + 1;
  }
}

function pushExpression(
  inout output: Array<LoweredExpression>,
  kind: LoweredExpressionKind,
  in value: String,
  children: Array<usize>,
  labels: Array<String>
): usize {
  const index = output.length;
  output.push(LoweredExpression({
    kind,
    value: value.copyBytes(0, value.byteLength),
    children,
    labels,
  }));
  return index;
}

function resolvedCallTarget(
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  for (const resolution of evidence.callResolutions) {
    if (
      resolution.offset == tree.nodes[index].offset
      && resolution.line == tree.nodes[index].line
      && resolution.column == tree.nodes[index].column
    ) return Option.some(resolution.targetName.copyBytes(
      0,
      resolution.targetName.byteLength
    ));
  }
  return Option<String>.none;
}

function importedCallTarget(
  in program: Program,
  in localName: String
): Option<String> {
  for (const declaration of program.imports) {
    if (!declaration.selective) continue;
    for (const binding of declaration.bindings) {
      if (binding.localName == localName) return Option.some(
        binding.importedName.copyBytes(0, binding.importedName.byteLength)
      );
    }
  }
  return Option<String>.none;
}

function importedEnumDeclaration(
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<LoweredEnum> {
  for (const imported of importedTypes) {
    if (
      imported.kind != LoweredTypeKind.enumType
      || (
        imported.localName != name
        && imported.targetName != name
      )
    ) continue;
    let variants = Array<LoweredVariant>();
    for (const variant of imported.variants) {
      variants.push(copyLoweredVariant(variant));
    }
    return Option.some(LoweredEnum({
      name: imported.targetName.copyBytes(0, imported.targetName.byteLength),
      variants,
      payloadBearing: imported.payloadBearing,
      needsDeinit: imported.needsDeinit,
    }));
  }
  return Option<LoweredEnum>.none;
}

function importedStructTarget(
  in importedTypes: Array<LoweredImportedType>,
  in name: String
): Option<String> {
  for (const imported of importedTypes) {
    if (
      imported.kind == LoweredTypeKind.structType
      && (
        imported.localName == name
        || imported.targetName == name
      )
    ) return Option.some(imported.targetName.copyBytes(
      0,
      imported.targetName.byteLength
    ));
  }
  return Option<String>.none;
}

function lowerExpression(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in tree: ExpressionTree,
  index: usize,
  inout output: Array<LoweredExpression>
): usize throws String {
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
    const kind = tree.nodes[index].value == "this"
      ? LoweredExpressionKind.receiverValue
      : LoweredExpressionKind.localValue;
    return pushExpression(
      inout output,
      kind,
      tree.nodes[index].value,
      Array<usize>(),
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.numberExpression) {
    return pushExpression(
      inout output,
      LoweredExpressionKind.integerValue,
      tree.nodes[index].value,
      Array<usize>(),
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.booleanExpression) {
    return pushExpression(
      inout output,
      LoweredExpressionKind.booleanValue,
      tree.nodes[index].value,
      Array<usize>(),
      Array<String>()
    );
  }
  if (
    tree.nodes[index].kind == ExpressionKind.attemptExpression
    && tree.nodes[index].children.length == 1
  ) {
    const attempted = tree.nodes[index].children[0];
    return try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      attempted,
      inout output
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.tryExpression) {
    throw "native lowering does not support try propagation yet";
  }
  if (tree.nodes[index].kind == ExpressionKind.unaryExpression) {
    if (tree.nodes[index].children.length != 1) {
      throw "native lowering received a malformed unary expression";
    }
    const operandInput = tree.nodes[index].children[0];
    const operand = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      operandInput,
      inout output
    );
    let kind = LoweredExpressionKind.unaryOperation;
    if (tree.nodes[index].value == "-") kind = LoweredExpressionKind.checkedNegateI32;
    else if (tree.nodes[index].value == "move") kind = LoweredExpressionKind.moveValue;
    else if (
      tree.nodes[index].value != "!"
      && tree.nodes[index].value != "+"
      && tree.nodes[index].value != "~"
      && tree.nodes[index].value != "move"
    ) {
      throw `native lowering does not support unary operator ${tree.nodes[index].value} yet`;
    }
    let children = Array<usize>();
    children.push(operand);
    return pushExpression(
      inout output,
      kind,
      tree.nodes[index].value,
      children,
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.binaryExpression) {
    if (tree.nodes[index].children.length != 2) {
      throw "native lowering received a malformed binary expression";
    }
    const leftInput = tree.nodes[index].children[0];
    const rightInput = tree.nodes[index].children[1];
    const left = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      leftInput,
      inout output
    );
    const right = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      rightInput,
      inout output
    );
    let kind = LoweredExpressionKind.binaryOperation;
    if (tree.nodes[index].value == "+") kind = LoweredExpressionKind.checkedAddI32;
    else if (tree.nodes[index].value == "-") kind = LoweredExpressionKind.checkedSubtractI32;
    else if (tree.nodes[index].value == "*") kind = LoweredExpressionKind.checkedMultiplyI32;
    else if (
      tree.nodes[index].value != "=="
      && tree.nodes[index].value != "!="
      && tree.nodes[index].value != "<"
      && tree.nodes[index].value != "<="
      && tree.nodes[index].value != ">"
      && tree.nodes[index].value != ">="
      && tree.nodes[index].value != "&&"
      && tree.nodes[index].value != "||"
      && tree.nodes[index].value != "&"
      && tree.nodes[index].value != "|"
      && tree.nodes[index].value != "^"
    ) {
      throw `native lowering does not support binary operator ${tree.nodes[index].value} yet`;
    }
    let children = Array<usize>();
    children.push(left);
    children.push(right);
    return pushExpression(
      inout output,
      kind,
      tree.nodes[index].value,
      children,
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.callExpression) {
    if (tree.nodes[index].children.length == 0) {
      throw "native lowering received a malformed call expression";
    }
    const calleeInput = tree.nodes[index].children[0];
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.memberExpression
      && tree.nodes[calleeInput].children.length == 1
    ) {
      const enumInput = tree.nodes[calleeInput].children[0];
      if (tree.nodes[enumInput].kind == ExpressionKind.identifierExpression) {
        const intrinsic = try intrinsicOptionDeclaration(
          program,
          tree.nodes[enumInput].value
        );
        match (in intrinsic) {
          some(declaration) => {
            for (const variant of declaration.variants) {
              if (variant.name == tree.nodes[calleeInput].value) {
                match (in variant.payload) {
                  some(_) => {
                    if (tree.nodes[index].children.length != 2) {
                      throw `native enum payload construction for ${tree.nodes[enumInput].value}.${variant.name} requires one value`;
                    }
                    const payloadInput = tree.nodes[index].children[1];
                    const payload = try lowerExpression(
                      program,
                      importedTypes,
                      evidence,
                      tree,
                      payloadInput,
                      inout output
                    );
                    let children = Array<usize>();
                    children.push(payload);
                    let labels = Array<String>();
                    labels.push(variant.name.copyBytes(0, variant.name.byteLength));
                    return pushExpression(
                      inout output,
                      LoweredExpressionKind.enumPayloadValue,
                      declaration.name,
                      children,
                      labels
                    );
                  }
                  none => {}
                }
              }
            }
          }
          none => {}
        }
        match (enumIndex(program, tree.nodes[enumInput].value)) {
          some(declarationIndex) => {
            for (const variant of program.enums[declarationIndex].variants) {
              if (variant.name == tree.nodes[calleeInput].value) {
                match (in variant.payload) {
                  some(_) => {
                    if (tree.nodes[index].children.length != 2) {
                      throw `native enum payload construction for ${tree.nodes[enumInput].value}.${variant.name} requires one value`;
                    }
                    const payloadInput = tree.nodes[index].children[1];
                    const payload = try lowerExpression(
                      program,
                      importedTypes,
                      evidence,
                      tree,
                      payloadInput,
                      inout output
                    );
                    let children = Array<usize>();
                    children.push(payload);
                    let labels = Array<String>();
                    labels.push(variant.name.copyBytes(0, variant.name.byteLength));
                    return pushExpression(
                      inout output,
                      LoweredExpressionKind.enumPayloadValue,
                      tree.nodes[enumInput].value,
                      children,
                      labels
                    );
                  }
                  none => {}
                }
              }
            }
          }
          none => {}
        }
        match (importedEnumDeclaration(
          importedTypes,
          tree.nodes[enumInput].value
        )) {
          some(declaration) => {
            for (const variant of declaration.variants) {
              if (variant.name != tree.nodes[calleeInput].value) continue;
              match (in variant.payload) {
                some(_) => {
                  if (tree.nodes[index].children.length != 2) {
                    throw `native enum payload construction for ${tree.nodes[enumInput].value}.${variant.name} requires one value`;
                  }
                  const payloadInput = tree.nodes[index].children[1];
                  const payload = try lowerExpression(
                    program,
                    importedTypes,
                    evidence,
                    tree,
                    payloadInput,
                    inout output
                  );
                  let children = Array<usize>();
                  children.push(payload);
                  let labels = Array<String>();
                  labels.push(variant.name.copyBytes(0, variant.name.byteLength));
                  return pushExpression(
                    inout output,
                    LoweredExpressionKind.enumPayloadValue,
                    declaration.name,
                    children,
                    labels
                  );
                }
                none => {}
              }
            }
          }
          none => {}
        }
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression
      && tree.nodes[index].children.length == 2
    ) {
      let constructionName = "";
      match (structIndex(program, tree.nodes[calleeInput].value)) {
        some(_) => constructionName = tree.nodes[calleeInput].value.copyBytes(
          0,
          tree.nodes[calleeInput].value.byteLength
        );
        none => match (importedStructTarget(
          importedTypes,
          tree.nodes[calleeInput].value
        )) {
          some(name) => constructionName = name;
          none => {}
        }
      }
      if (constructionName.byteLength > 0) {
          const objectInput = tree.nodes[index].children[1];
          if (tree.nodes[objectInput].kind != ExpressionKind.objectExpression) {
            throw "native struct construction requires an object initializer";
          }
          if (
            tree.nodes[objectInput].children.length
            != tree.nodes[objectInput].labels.length
          ) {
            throw "native lowering received a malformed object initializer";
          }
          let children = Array<usize>();
          let labels = Array<String>();
          let field: usize = 0;
          while (field < tree.nodes[objectInput].children.length) {
            const valueInput = tree.nodes[objectInput].children[field];
            const value = try lowerExpression(
              program,
              importedTypes,
              evidence,
              tree,
              valueInput,
              inout output
            );
            children.push(value);
            labels.push(tree.nodes[objectInput].labels[field].copyBytes(
              0,
              tree.nodes[objectInput].labels[field].byteLength
            ));
            field = field + 1;
          }
          return pushExpression(
            inout output,
            LoweredExpressionKind.structValue,
            constructionName,
            children,
            labels
          );
      }
    }
    let callee: usize = 0;
    if (tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression) {
      match (resolvedCallTarget(evidence, tree, index)) {
        some(target) => callee = pushExpression(
          inout output,
          LoweredExpressionKind.localValue,
          target,
          Array<usize>(),
          Array<String>()
        );
        none => match (importedCallTarget(
          program,
          tree.nodes[calleeInput].value
        )) {
          some(target) => callee = pushExpression(
            inout output,
            LoweredExpressionKind.localValue,
            target,
            Array<usize>(),
            Array<String>()
          );
          none => callee = try lowerExpression(
            program,
            importedTypes,
            evidence,
            tree,
            calleeInput,
            inout output
          );
        }
      }
    } else {
      callee = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        calleeInput,
        inout output
      );
    }
    let children = Array<usize>();
    children.push(callee);
    let argument: usize = 1;
    while (argument < tree.nodes[index].children.length) {
      const argumentInput = tree.nodes[index].children[argument];
      const value = try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        argumentInput,
        inout output
      );
      children.push(value);
      argument = argument + 1;
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.directCall,
      "",
      children,
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.memberExpression) {
    if (tree.nodes[index].children.length != 1) {
      throw "native lowering received a malformed member expression";
    }
    const receiverInput = tree.nodes[index].children[0];
    if (tree.nodes[receiverInput].kind == ExpressionKind.identifierExpression) {
      const intrinsic = try intrinsicOptionDeclaration(
        program,
        tree.nodes[receiverInput].value
      );
      match (in intrinsic) {
        some(declaration) => {
          for (const variant of declaration.variants) {
            if (variant.name == tree.nodes[index].value) {
              match (in variant.payload) {
                some(_) => throw `native lowering does not support payload enum variant ${tree.nodes[receiverInput].value}.${variant.name} without a value`;
                none => {}
              }
              let labels = Array<String>();
              labels.push(variant.name.copyBytes(0, variant.name.byteLength));
              labels.push("tagged");
              return pushExpression(
                inout output,
                LoweredExpressionKind.enumValue,
                declaration.name,
                Array<usize>(),
                labels
              );
            }
          }
        }
        none => {}
      }
      match (enumIndex(program, tree.nodes[receiverInput].value)) {
        some(declarationIndex) => {
          for (const variant of program.enums[declarationIndex].variants) {
            if (variant.name == tree.nodes[index].value) {
              match (in variant.payload) {
                some(_) => throw `native lowering does not support payload enum variant ${tree.nodes[receiverInput].value}.${variant.name} yet`;
                none => {}
              }
              let labels = Array<String>();
              labels.push(variant.name.copyBytes(0, variant.name.byteLength));
              if (enumHasPayload(program, declarationIndex)) {
                labels.push("tagged");
              }
              return pushExpression(
                inout output,
                LoweredExpressionKind.enumValue,
                tree.nodes[receiverInput].value,
                Array<usize>(),
                labels
              );
            }
          }
        }
        none => {}
      }
      match (importedEnumDeclaration(
        importedTypes,
        tree.nodes[receiverInput].value
      )) {
        some(declaration) => {
          for (const variant of declaration.variants) {
            if (variant.name != tree.nodes[index].value) continue;
            match (in variant.payload) {
              some(_) => throw `native lowering does not support payload enum variant ${tree.nodes[receiverInput].value}.${variant.name} without a value`;
              none => {}
            }
            let labels = Array<String>();
            labels.push(variant.name.copyBytes(0, variant.name.byteLength));
            if (declaration.payloadBearing) labels.push("tagged");
            return pushExpression(
              inout output,
              LoweredExpressionKind.enumValue,
              declaration.name,
              Array<usize>(),
              labels
            );
          }
        }
        none => {}
      }
    }
    const receiver = try lowerExpression(
      program,
      importedTypes,
      evidence,
      tree,
      receiverInput,
      inout output
    );
    let children = Array<usize>();
    children.push(receiver);
    return pushExpression(
      inout output,
      LoweredExpressionKind.fieldValue,
      tree.nodes[index].value,
      children,
      Array<String>()
    );
  }
  throw "native lowering does not support this expression shape yet";
}

function lowerExpressionSyntax(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in expression: ExpressionSyntax,
  inout output: Array<LoweredExpression>
): usize throws String {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      select try lowerExpression(
        program,
        importedTypes,
        evidence,
        tree,
        root,
        inout output
      );
    }
    none => throw "native lowering cannot lower an opaque expression";
  };
}

function loweredSourceEnum(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  index: usize
): LoweredEnum throws String {
  let variants = Array<LoweredVariant>();
  let payloadBearing = false;
  for (const variant of program.enums[index].variants) {
    let payload = Option<LoweredType>.none;
    match (in variant.payload) {
      some(type) => {
        const lowered = try lowerModuleType(program, importedTypes, type);
        payload = Option.some(move lowered);
        payloadBearing = true;
      }
      none => {}
    }
    variants.push(LoweredVariant({
      name: variant.name.copyBytes(0, variant.name.byteLength),
      payload,
    }));
  }
  return LoweredEnum({
    name: program.enums[index].name.copyBytes(
      0,
      program.enums[index].name.byteLength
    ),
    variants,
    payloadBearing,
    needsDeinit: moduleEnumNeedsCleanup(program, importedTypes, index, 0),
  });
}

function directThrowingCallResult(
  in program: Program,
  in tree: ExpressionTree,
  index: usize
): Option<LoweredEnum> throws String {
  if (
    tree.nodes[index].kind != ExpressionKind.callExpression
    || tree.nodes[index].children.length == 0
  ) return Option<LoweredEnum>.none;
  const callee = tree.nodes[index].children[0];
  if (tree.nodes[callee].kind != ExpressionKind.identifierExpression) {
    return Option<LoweredEnum>.none;
  }
  for (const declaration of program.functions) {
    if (declaration.name == tree.nodes[callee].value) {
      match (in declaration.errorType) {
        some(errorType) => {
          const returnName = declaration.returnType.name.copyBytes(
            0,
            declaration.returnType.name.byteLength
          );
          const errorName = errorType.name.copyBytes(0, errorType.name.byteLength);
          const resultName = `Result<${returnName}, ${errorName}>`;
          return try intrinsicResultDeclaration(program, resultName);
        }
        none => return Option<LoweredEnum>.none;
      }
    }
  }
  return Option<LoweredEnum>.none;
}

function matchSubjectTypeName(
  in program: Program,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  let subject = index;
  if (
    tree.nodes[subject].kind == ExpressionKind.attemptExpression
    && tree.nodes[subject].children.length == 1
  ) {
    const attempted = tree.nodes[subject].children[0];
    if (
      tree.nodes[attempted].kind == ExpressionKind.callExpression
      && tree.nodes[attempted].children.length > 0
    ) {
      const callee = tree.nodes[attempted].children[0];
      if (tree.nodes[callee].kind == ExpressionKind.identifierExpression) {
        for (const declaration of program.functions) {
          if (declaration.name == tree.nodes[callee].value) {
            match (in declaration.errorType) {
              some(errorType) => {
                const returnName = declaration.returnType.name.copyBytes(
                  0,
                  declaration.returnType.name.byteLength
                );
                const errorName = errorType.name.copyBytes(
                  0,
                  errorType.name.byteLength
                );
                return Option.some(`Result<${returnName}, ${errorName}>`);
              }
              none => {}
            }
          }
        }
      }
    }
  }
  if (
    tree.nodes[subject].kind == ExpressionKind.callExpression
    && tree.nodes[subject].children.length > 0
  ) subject = tree.nodes[subject].children[0];
  if (
    tree.nodes[subject].kind == ExpressionKind.memberExpression
    && tree.nodes[subject].children.length == 1
  ) {
    const receiver = tree.nodes[subject].children[0];
    if (tree.nodes[receiver].kind == ExpressionKind.identifierExpression) {
      return Option.some(tree.nodes[receiver].value.copyBytes(
        0,
        tree.nodes[receiver].value.byteLength
      ));
    }
  }
  if (tree.nodes[subject].kind == ExpressionKind.identifierExpression) {
    const name = tree.nodes[subject].value.copyBytes(
      0,
      tree.nodes[subject].value.byteLength
    );
    for (const statement of arena.nodes) {
      if (
        statement.kind == StatementKind.variableStatement
        && statement.name == name
      ) {
        match (in statement.typeAnnotation) {
          some(type) => return Option.some(type.name.copyBytes(
            0,
            type.name.byteLength
          ));
          none => {
            for (const binding of evidence.bindingResolutions) {
              if (
                binding.offset == statement.nameOffset
                && binding.name == statement.name
              ) {
                return Option.some(binding.typeName.copyBytes(
                  0,
                  binding.typeName.byteLength
                ));
              }
            }
          }
        }
      }
    }
    for (const declaration of program.functions) {
      if (declaration.name == ownerName) {
        for (const parameter of declaration.parameters) {
          if (parameter.name == name) {
            return Option.some(parameter.type.name.copyBytes(
              0,
              parameter.type.name.byteLength
            ));
          }
        }
      }
    }
  }
  if (
    tree.nodes[subject].kind == ExpressionKind.callExpression
    && tree.nodes[subject].children.length > 0
  ) {
    const callee = tree.nodes[subject].children[0];
    if (tree.nodes[callee].kind == ExpressionKind.identifierExpression) {
      for (const declaration of program.functions) {
        if (declaration.name == tree.nodes[callee].value) {
          return Option.some(declaration.returnType.name.copyBytes(
            0,
            declaration.returnType.name.byteLength
          ));
        }
      }
    }
  }
  return Option<String>.none;
}

function matchEnumDeclaration(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  root: usize
): LoweredEnum throws String {
  const subjectInput = tree.nodes[root].children[0];
  match (matchSubjectTypeName(
    program,
    evidence,
    arena,
    ownerName,
    tree,
    subjectInput
  )) {
    some(name) => {
      const intrinsic = try intrinsicEnumDeclaration(program, name);
      match (intrinsic) {
        some(declaration) => return declaration;
        none => {}
      }
      match (enumIndex(program, name)) {
        some(index) => return try loweredSourceEnum(
          program,
          importedTypes,
          index
        );
        none => {}
      }
      match (importedEnumDeclaration(importedTypes, name)) {
        some(declaration) => return declaration;
        none => {}
      }
    }
    none => {}
  }
  let found = Option<usize>.none;
  let enumPosition: usize = 0;
  while (enumPosition < program.enums.length) {
    if (program.enums[enumPosition].variants.length == tree.nodes[root].children.length - 1) {
      let allPresent = true;
      let armPosition: usize = 1;
      while (armPosition < tree.nodes[root].children.length) {
        const arm = tree.nodes[root].children[armPosition];
        let present = false;
        for (const variant of program.enums[enumPosition].variants) {
          if (variant.name == tree.nodes[arm].value) present = true;
        }
        if (!present) allPresent = false;
        armPosition = armPosition + 1;
      }
      if (allPresent) {
        match (found) {
          some(_) => throw "native match lowering cannot disambiguate enum variants yet";
          none => found = Option.some(enumPosition);
        }
      }
    }
    enumPosition = enumPosition + 1;
  }
  return match (found) {
    some(index) => try loweredSourceEnum(program, importedTypes, index);
    none => throw "native match lowering could not resolve the subject enum";
  };
}

function valueArmIsIdentifier(
  in arena: StatementArena,
  index: usize,
  in name: String
): boolean {
  if (
    arena.nodes[index].kind == StatementKind.expressionStatement
    || arena.nodes[index].kind == StatementKind.selectStatement
  ) {
    return match (in arena.nodes[index].expression) {
      some(expression) => syntaxIsIdentifier(expression, name);
      none => false;
    };
  }
  if (
    arena.nodes[index].kind == StatementKind.blockStatement
    && arena.nodes[index].children.length > 0
  ) {
    const finalChild = arena.nodes[index].children[
      arena.nodes[index].children.length - 1
    ];
    return valueArmIsIdentifier(
      arena,
      finalChild,
      name
    );
  }
  return false;
}

function lowerValueDestination(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in expression: ExpressionSyntax,
  returnValue: boolean,
  in valueBinding: String,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
  const value = try lowerExpressionSyntax(
    program,
    importedTypes,
    evidence,
    expression,
    inout expressions
  );
  const loweredBody = statements.length;
  if (returnValue) {
    statements.push(LoweredStatement({
      kind: LoweredStatementKind.returnStatement,
      mutableBinding: false,
      name: "",
      type: Option<LoweredType>.none,
      expression: Option.some(value),
      secondExpression: Option<usize>.none,
      children: Array<usize>(),
      cleanups: Array<LoweredCleanup>(),
      liveFlag: "",
      labels: Array<String>(),
      matchConsumesSubject: false,
      matchBindingNeedsCleanup: false,
    }));
  } else {
    const target = pushExpression(
      inout expressions,
      LoweredExpressionKind.localValue,
      valueBinding,
      Array<usize>(),
      Array<String>()
    );
    statements.push(LoweredStatement({
      kind: LoweredStatementKind.assignmentStatement,
      mutableBinding: false,
      name: "",
      type: Option<LoweredType>.none,
      expression: Option.some(target),
      secondExpression: Option.some(value),
      children: Array<usize>(),
      cleanups: Array<LoweredCleanup>(),
      liveFlag: "",
      labels: Array<String>(),
      matchConsumesSubject: false,
      matchBindingNeedsCleanup: false,
    }));
  }
  return loweredBody;
}

function lowerValueArmStatement(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  index: usize,
  returnValue: boolean,
  in valueBinding: String,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
  if (
    arena.nodes[index].kind == StatementKind.expressionStatement
    || arena.nodes[index].kind == StatementKind.selectStatement
  ) {
    return match (in arena.nodes[index].expression) {
      some(expression) => try lowerValueDestination(
        program,
        importedTypes,
        evidence,
        expression,
        returnValue,
        valueBinding,
        inout expressions,
        inout statements
      );
      none => throw "native value-match lowering received an empty arm";
    };
  }
  if (arena.nodes[index].kind == StatementKind.blockStatement) {
    if (arena.nodes[index].children.length == 0) {
      throw "native value-match lowering received an empty block arm";
    }
    let children = Array<usize>();
    let childIndex: usize = 0;
    while (childIndex < arena.nodes[index].children.length) {
      const sourceChild = arena.nodes[index].children[childIndex];
      let loweredChild: usize = 0;
      if (childIndex + 1 == arena.nodes[index].children.length) {
        if (arena.nodes[sourceChild].kind != StatementKind.selectStatement) {
          throw "native value-match lowering requires a final select in a block arm";
        }
        loweredChild = try lowerValueArmStatement(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          sourceChild,
          returnValue,
          valueBinding,
          inout expressions,
          inout statements
        );
      } else {
        loweredChild = try lowerStatement(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          sourceChild,
          inout expressions,
          inout statements
        );
      }
      children.push(loweredChild);
      childIndex = childIndex + 1;
    }
    const block = statements.length;
    statements.push(LoweredStatement({
      kind: LoweredStatementKind.blockStatement,
      mutableBinding: false,
      name: "",
      type: Option<LoweredType>.none,
      expression: Option<usize>.none,
      secondExpression: Option<usize>.none,
      children,
      cleanups: Array<LoweredCleanup>(),
      liveFlag: "",
      labels: Array<String>(),
      matchConsumesSubject: false,
      matchBindingNeedsCleanup: false,
    }));
    return block;
  }
  throw "native value-match lowering requires a concise expression or selecting block arm yet";
}

function lowerMatchTree(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  root: usize,
  returnValueArms: boolean,
  in valueBinding: String,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
  if (
    tree.nodes[root].kind != ExpressionKind.matchExpression
    || tree.nodes[root].children.length < 2
  ) {
    throw "native match lowering received a malformed match expression";
  }
  const subjectInput = tree.nodes[root].children[0];
  const subject = try lowerExpression(
    program,
    importedTypes,
    evidence,
    tree,
    subjectInput,
    inout expressions
  );
  const declaration = try matchEnumDeclaration(
    program,
    importedTypes,
    evidence,
    arena,
    ownerName,
    tree,
    root
  );
  let armStatements = Array<usize>();
  let armPosition: usize = 1;
  while (armPosition < tree.nodes[root].children.length) {
    const arm = tree.nodes[root].children[armPosition];
    if (tree.nodes[arm].kind != ExpressionKind.matchArmExpression) {
      throw "native match lowering received a malformed match arm";
    }
    let payloadType = Option<LoweredType>.none;
    for (const variant of declaration.variants) {
      if (variant.name == tree.nodes[arm].value) {
        match (in variant.payload) {
          some(type) => {
            payloadType = Option.some(LoweredType({
              kind: type.kind,
              name: type.name.copyBytes(0, type.name.byteLength),
            }));
          }
          none => {}
        }
      }
    }
    let labels = Array<String>();
    if (tree.nodes[arm].children.length > 0) {
      const binding = tree.nodes[arm].children[0];
      if (tree.nodes[binding].kind != ExpressionKind.matchBindingExpression) {
        throw "native match lowering only supports one direct payload binding yet";
      }
      labels.push(tree.nodes[binding].value.copyBytes(
        0,
        tree.nodes[binding].value.byteLength
      ));
    }
    let children = Array<usize>();
    let payloadTransfersOut = false;
    if (returnValueArms || valueBinding.byteLength > 0) {
      if (tree.nodes[arm].statements.length != 1) {
        throw "native value-match lowering requires one value-producing arm body";
      }
      const bodyIndex = tree.nodes[arm].statements[0];
      if (
        labels.length == 1
        && valueArmIsIdentifier(arena, bodyIndex, labels[0])
      ) payloadTransfersOut = true;
      const loweredBody = try lowerValueArmStatement(
        program,
        importedTypes,
        evidence,
        arena,
        ownerName,
        bodyIndex,
        returnValueArms,
        valueBinding,
        inout expressions,
        inout statements
      );
      children.push(loweredBody);
    } else {
      for (const bodyIndex of tree.nodes[arm].statements) {
        const loweredBody = try lowerStatement(
          program,
          importedTypes,
          evidence,
          arena,
          ownerName,
          bodyIndex,
          inout expressions,
          inout statements
        );
        children.push(loweredBody);
      }
    }
    const matchBindingNeedsCleanup = match (in payloadType) {
      some(type) => tree.nodes[root].value != "in"
        && moduleTypeNeedsCleanup(program, importedTypes, type)
        && !payloadTransfersOut;
      none => false;
    };
    const loweredArm = statements.length;
    statements.push(LoweredStatement({
      kind: LoweredStatementKind.matchArmStatement,
      mutableBinding: false,
      name: tree.nodes[arm].value.copyBytes(
        0,
        tree.nodes[arm].value.byteLength
      ),
      type: payloadType,
      expression: Option<usize>.none,
      secondExpression: Option<usize>.none,
      children,
      cleanups: Array<LoweredCleanup>(),
      liveFlag: "",
      labels,
      matchConsumesSubject: false,
      matchBindingNeedsCleanup,
    }));
    armStatements.push(loweredArm);
    armPosition = armPosition + 1;
  }
  let labels = Array<String>();
  if (declaration.payloadBearing) labels.push("tagged");
  const outputIndex = statements.length;
  statements.push(LoweredStatement({
    kind: LoweredStatementKind.matchStatement,
    mutableBinding: false,
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
    type: Option.some(LoweredType({
      kind: LoweredTypeKind.enumType,
      name: declaration.name.copyBytes(0, declaration.name.byteLength),
    })),
    expression: Option.some(subject),
    secondExpression: Option<usize>.none,
    children: armStatements,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels,
    matchConsumesSubject: tree.nodes[root].value != "in",
    matchBindingNeedsCleanup: false,
  }));
  return outputIndex;
}

function lowerStatement(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in arena: StatementArena,
  in ownerName: String,
  index: usize,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
  if (arena.nodes[index].kind == StatementKind.expressionStatement) {
    match (in arena.nodes[index].expression) {
      some(syntax) => {
        match (in syntax.tree) {
          some(tree) => {
            const root = tree.root;
            if (
              tree.nodes[root].kind == ExpressionKind.tryExpression
              && tree.nodes[root].children.length == 1
            ) {
              const attempted = tree.nodes[root].children[0];
              const innerResult = try directThrowingCallResult(
                program,
                tree,
                attempted
              );
              const inner = match (innerResult) {
                some(declaration) => declaration;
                none => throw "native try lowering requires one direct throwing function call yet";
              };
              for (const variant of inner.variants) {
                if (variant.name == "success") {
                  match (in variant.payload) {
                    some(_) => throw "native expression-statement try currently requires a void success type";
                    none => {}
                  }
                }
              }
              const outerResult = try throwingFunctionResult(program, ownerName);
              const outer = match (outerResult) {
                some(declaration) => declaration;
                none => throw "native try lowering requires an enclosing throwing function";
              };
              const call = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                attempted,
                inout expressions
              );
              let labels = Array<String>();
              labels.push("");
              labels.push(outer.name.copyBytes(0, outer.name.byteLength));
              const loweredTry = statements.length;
              statements.push(LoweredStatement({
                kind: LoweredStatementKind.tryStatement,
                mutableBinding: false,
                name: inner.name.copyBytes(0, inner.name.byteLength),
                type: Option.some(LoweredType({
                  kind: LoweredTypeKind.voidType,
                  name: "",
                })),
                expression: Option.some(call),
                secondExpression: Option<usize>.none,
                children: Array<usize>(),
                cleanups: Array<LoweredCleanup>(),
                liveFlag: "",
                labels,
                matchConsumesSubject: false,
                matchBindingNeedsCleanup: false,
              }));
              return loweredTry;
            }
          }
          none => {}
        }
      }
      none => {}
    }
  }
  if (arena.nodes[index].kind == StatementKind.variableStatement) {
    match (in arena.nodes[index].expression) {
      some(syntax) => {
        match (in syntax.tree) {
          some(tree) => {
            const root = tree.root;
            if (
              tree.nodes[root].kind == ExpressionKind.tryExpression
              && tree.nodes[root].children.length == 1
            ) {
              const attempted = tree.nodes[root].children[0];
              const innerResult = try directThrowingCallResult(
                program,
                tree,
                attempted
              );
              const inner = match (innerResult) {
                some(declaration) => declaration;
                none => throw "native try lowering requires one direct throwing function call yet";
              };
              const outerResult = try throwingFunctionResult(program, ownerName);
              const outer = match (outerResult) {
                some(declaration) => declaration;
                none => throw "native try lowering requires an enclosing throwing function";
              };
              const bindingType = try lowerBindingType(
                program,
                importedTypes,
                evidence,
                arena,
                index
              );
              const call = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                attempted,
                inout expressions
              );
              let tryLabels = Array<String>();
              tryLabels.push(arena.nodes[index].name.copyBytes(
                0,
                arena.nodes[index].name.byteLength
              ));
              tryLabels.push(outer.name.copyBytes(0, outer.name.byteLength));
              const loweredTry = statements.length;
              statements.push(LoweredStatement({
                kind: LoweredStatementKind.tryStatement,
                mutableBinding: false,
                name: inner.name.copyBytes(0, inner.name.byteLength),
                type: Option.some(LoweredType({
                  kind: bindingType.kind,
                  name: bindingType.name.copyBytes(0, bindingType.name.byteLength),
                })),
                expression: Option.some(call),
                secondExpression: Option<usize>.none,
                children: Array<usize>(),
                cleanups: Array<LoweredCleanup>(),
                liveFlag: "",
                labels: tryLabels,
                matchConsumesSubject: false,
                matchBindingNeedsCleanup: false,
              }));
              let children = Array<usize>();
              children.push(loweredTry);
              const localIndex = statements.length;
              statements.push(LoweredStatement({
                kind: LoweredStatementKind.localStatement,
                mutableBinding: arena.nodes[index].mutableBinding,
                name: arena.nodes[index].name.copyBytes(
                  0,
                  arena.nodes[index].name.byteLength
                ),
                type: Option.some(move bindingType),
                expression: Option<usize>.none,
                secondExpression: Option<usize>.none,
                children,
                cleanups: Array<LoweredCleanup>(),
                liveFlag: "",
                labels: Array<String>(),
                matchConsumesSubject: false,
                matchBindingNeedsCleanup: false,
              }));
              return localIndex;
            }
          }
          none => {}
        }
      }
      none => {}
    }
  }
  if (
    arena.nodes[index].kind == StatementKind.matchStatement
    || arena.nodes[index].kind == StatementKind.returnStatement
    || arena.nodes[index].kind == StatementKind.variableStatement
  ) {
    match (in arena.nodes[index].expression) {
      some(syntax) => {
        match (in syntax.tree) {
          some(tree) => {
            const root = tree.root;
            if (tree.nodes[root].kind == ExpressionKind.matchExpression) {
              const valueBinding = arena.nodes[index].kind
                == StatementKind.variableStatement
                ? arena.nodes[index].name.copyBytes(
                  0,
                  arena.nodes[index].name.byteLength
                )
                : "";
              const loweredMatch = try lowerMatchTree(
                program,
                importedTypes,
                evidence,
                arena,
                ownerName,
                tree,
                root,
                arena.nodes[index].kind == StatementKind.returnStatement,
                valueBinding,
                inout expressions,
                inout statements
              );
              if (arena.nodes[index].kind != StatementKind.variableStatement) {
                return loweredMatch;
              }
              const bindingType = try lowerBindingType(
                program,
                importedTypes,
                evidence,
                arena,
                index
              );
              let children = Array<usize>();
              children.push(loweredMatch);
              const localIndex = statements.length;
              statements.push(LoweredStatement({
                kind: LoweredStatementKind.localStatement,
                mutableBinding: arena.nodes[index].mutableBinding,
                name: arena.nodes[index].name.copyBytes(
                  0,
                  arena.nodes[index].name.byteLength
                ),
                type: Option.some(move bindingType),
                expression: Option<usize>.none,
                secondExpression: Option<usize>.none,
                children,
                cleanups: Array<LoweredCleanup>(),
                liveFlag: "",
                labels: Array<String>(),
                matchConsumesSubject: false,
                matchBindingNeedsCleanup: false,
              }));
              return localIndex;
            }
          }
          none => {}
        }
      }
      none => {}
    }
  }
  let kind = LoweredStatementKind.expressionStatement;
  if (arena.nodes[index].kind == StatementKind.variableStatement) {
    kind = LoweredStatementKind.localStatement;
  } else if (arena.nodes[index].kind == StatementKind.assignmentStatement) {
    kind = LoweredStatementKind.assignmentStatement;
  } else if (arena.nodes[index].kind == StatementKind.returnStatement) {
    kind = LoweredStatementKind.returnStatement;
  } else if (arena.nodes[index].kind == StatementKind.throwStatement) {
    kind = LoweredStatementKind.returnStatement;
  } else if (arena.nodes[index].kind == StatementKind.expressionStatement) {
    kind = LoweredStatementKind.expressionStatement;
  } else if (arena.nodes[index].kind == StatementKind.blockStatement) {
    kind = LoweredStatementKind.blockStatement;
  } else if (arena.nodes[index].kind == StatementKind.ifStatement) {
    kind = LoweredStatementKind.ifStatement;
  } else if (arena.nodes[index].kind == StatementKind.whileStatement) {
    kind = LoweredStatementKind.whileStatement;
  } else if (arena.nodes[index].kind == StatementKind.breakStatement) {
    kind = LoweredStatementKind.breakStatement;
  } else if (arena.nodes[index].kind == StatementKind.continueStatement) {
    kind = LoweredStatementKind.continueStatement;
  } else {
    throw "native lowering does not support this statement shape yet";
  }

  let type = Option<LoweredType>.none;
  if (arena.nodes[index].kind == StatementKind.variableStatement) {
    const loweredType = try lowerBindingType(
      program,
      importedTypes,
      evidence,
      arena,
      index
    );
    type = Option.some(move loweredType);
  } else {
    match (in arena.nodes[index].typeAnnotation) {
      some(annotation) => {
        const loweredType = try lowerModuleType(
          program,
          importedTypes,
          annotation
        );
        type = Option.some(move loweredType);
      }
      none => {}
    }
  }
  let expression = Option<usize>.none;
  match (in arena.nodes[index].expression) {
    some(source) => {
      let directTryReturn = false;
      let loweredValue: usize = 0;
      if (arena.nodes[index].kind == StatementKind.returnStatement) {
        match (in source.tree) {
          some(tree) => {
            const root = tree.root;
            if (
              tree.nodes[root].kind == ExpressionKind.tryExpression
              && tree.nodes[root].children.length == 1
            ) {
              const attempted = tree.nodes[root].children[0];
              loweredValue = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                attempted,
                inout expressions
              );
              directTryReturn = true;
            } else {
              loweredValue = try lowerExpression(
                program,
                importedTypes,
                evidence,
                tree,
                root,
                inout expressions
              );
            }
          }
          none => throw "native lowering cannot lower an opaque expression";
        }
      } else {
        loweredValue = try lowerExpressionSyntax(
          program,
          importedTypes,
          evidence,
          source,
          inout expressions
        );
      }
      if (
        arena.nodes[index].kind == StatementKind.returnStatement
        || arena.nodes[index].kind == StatementKind.throwStatement
      ) {
        const result = try throwingFunctionResult(program, ownerName);
        match (in result) {
          some(declaration) => {
            if (directTryReturn) {
              expression = Option.some(loweredValue);
            } else {
              let children = Array<usize>();
              children.push(loweredValue);
              let labels = Array<String>();
              if (arena.nodes[index].kind == StatementKind.throwStatement) {
                labels.push("failure");
              } else {
                labels.push("success");
              }
              const wrapped = pushExpression(
                inout expressions,
                LoweredExpressionKind.enumPayloadValue,
                declaration.name,
                children,
                labels
              );
              expression = Option.some(wrapped);
            }
          }
          none => expression = Option.some(loweredValue);
        }
      } else {
        expression = Option.some(loweredValue);
      }
    }
    none => {}
  }
  const expressionMissing = match (in expression) {
    some(_) => false;
    none => true;
  };
  if (
    arena.nodes[index].kind == StatementKind.returnStatement
    && expressionMissing
  ) {
    const result = try throwingFunctionResult(program, ownerName);
    match (in result) {
      some(declaration) => {
        let labels = Array<String>();
        labels.push("success");
        labels.push("tagged");
        const wrapped = pushExpression(
          inout expressions,
          LoweredExpressionKind.enumValue,
          declaration.name,
          Array<usize>(),
          labels
        );
        expression = Option.some(wrapped);
      }
      none => {}
    }
  }
  let secondExpression = Option<usize>.none;
  match (in arena.nodes[index].secondExpression) {
    some(source) => {
      const loweredExpression = try lowerExpressionSyntax(
        program,
        importedTypes,
        evidence,
        source,
        inout expressions
      );
      secondExpression = Option.some(loweredExpression);
    }
    none => {}
  }
  let children = Array<usize>();
  for (const child of arena.nodes[index].children) {
    const loweredChild = try lowerStatement(
      program,
      importedTypes,
      evidence,
      arena,
      ownerName,
      child,
      inout expressions,
      inout statements
    );
    children.push(loweredChild);
  }
  const outputIndex = statements.length;
  statements.push(LoweredStatement({
    kind,
    mutableBinding: arena.nodes[index].mutableBinding,
    name: arena.nodes[index].name.copyBytes(0, arena.nodes[index].name.byteLength),
    type,
    expression,
    secondExpression,
    children,
    cleanups: Array<LoweredCleanup>(),
    liveFlag: "",
    labels: Array<String>(),
    matchConsumesSubject: false,
    matchBindingNeedsCleanup: false,
  }));
  return outputIndex;
}

function lowerFunction(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in declaration: FunctionDeclaration
): LoweredFunction throws String {
  if (declaration.asynchronous) {
    throw `native lowering does not support async function ${declaration.name} yet`;
  }
  let parameters = Array<LoweredParameter>();
  let ownedParameters = Array<LoweredCleanup>();
  let liveFlags = Array<LoweredLiveFlag>();
  for (const parameter of declaration.parameters) {
    if (parameter.mode != ParameterMode.value) {
      throw `native lowering only supports value parameters in ${declaration.name} yet`;
    }
    const parameterType = try lowerModuleType(
      program,
      importedTypes,
      parameter.type
    );
    if (moduleTypeNeedsCleanup(program, importedTypes, parameterType)) {
      const moved = arenaMovesName(
        program,
        declaration.body,
        parameter.name
      );
      if (moved && arenaHasLoop(declaration.body)) {
        throw `native cleanup lowering does not support path-sensitive transfer of ${parameter.name} in ${declaration.name} yet`;
      }
      let guard = "";
      if (moved && arenaHasControlFlow(declaration.body)) {
        guard = ownerLiveFlag(parameter.name);
        liveFlags.push(LoweredLiveFlag({
          owner: parameter.name.copyBytes(0, parameter.name.byteLength),
          name: guard.copyBytes(0, guard.byteLength),
          parameter: true,
        }));
      }
      if (!moved || guard.byteLength > 0) {
        ownedParameters.push(LoweredCleanup({
          name: parameter.name.copyBytes(0, parameter.name.byteLength),
          type: LoweredType({
            kind: parameterType.kind,
            name: parameterType.name.copyBytes(0, parameterType.name.byteLength),
          }),
          guard: move guard,
        }));
      }
    }
    parameters.push(LoweredParameter({
      name: parameter.name.copyBytes(0, parameter.name.byteLength),
      type: move parameterType,
    }));
  }
  let expressions = Array<LoweredExpression>();
  let statements = Array<LoweredStatement>();
  let sourceRoots = Array<usize>();
  let roots = Array<usize>();
  for (const root of declaration.body.roots) {
    sourceRoots.push(root);
    const loweredRoot = try lowerStatement(
      program,
      importedTypes,
      evidence,
      declaration.body,
      declaration.name,
      root,
      inout expressions,
      inout statements
    );
    roots.push(loweredRoot);
  }
  const rootLoopCleanups = Array<LoweredCleanup>();
  const introduced = try planCleanupSequence(
    program,
    importedTypes,
    declaration.body,
    declaration.name,
    sourceRoots,
    roots,
    ownedParameters,
    inout statements,
    inout liveFlags,
    false,
    rootLoopCleanups
  );
  let fallthroughCleanups = Array<LoweredCleanup>();
  appendCleanupCopies(inout fallthroughCleanups, ownedParameters);
  appendCleanupCopies(inout fallthroughCleanups, introduced);
  attachMoveLiveFlags(inout expressions, liveFlags);
  let returnType = try lowerModuleType(
    program,
    importedTypes,
    declaration.returnType
  );
  const resultType = try throwingFunctionResult(program, declaration.name);
  match (in resultType) {
    some(result) => returnType = LoweredType({
      kind: LoweredTypeKind.enumType,
      name: result.name.copyBytes(0, result.name.byteLength),
    });
    none => {}
  }
  return LoweredFunction({
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
    parameters,
    returnType: move returnType,
    expressions,
    statements,
    roots,
    fallthroughCleanups,
    liveFlags,
  });
}

function lowerDeinitializer(
  in program: Program,
  in importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in ownerName: String,
  in body: StatementArena
): LoweredFunction throws String {
  let expressions = Array<LoweredExpression>();
  let statements = Array<LoweredStatement>();
  let liveFlags = Array<LoweredLiveFlag>();
  let sourceRoots = Array<usize>();
  let roots = Array<usize>();
  for (const root of body.roots) {
    sourceRoots.push(root);
    const loweredRoot = try lowerStatement(
      program,
      importedTypes,
      evidence,
      body,
      `${ownerName}.deinit`,
      root,
      inout expressions,
      inout statements
    );
    roots.push(loweredRoot);
  }
  const inherited = Array<LoweredCleanup>();
  const loopCleanups = Array<LoweredCleanup>();
  const introduced = try planCleanupSequence(
    program,
    importedTypes,
    body,
    `${ownerName}.deinit`,
    sourceRoots,
    roots,
    inherited,
    inout statements,
    inout liveFlags,
    false,
    loopCleanups
  );
  let fallthroughCleanups = Array<LoweredCleanup>();
  appendCleanupCopies(inout fallthroughCleanups, introduced);
  attachMoveLiveFlags(inout expressions, liveFlags);
  return LoweredFunction({
    name: `${ownerName}.deinit`,
    parameters: Array<LoweredParameter>(),
    returnType: LoweredType({ kind: LoweredTypeKind.voidType, name: "" }),
    expressions,
    statements,
    roots,
    fallthroughCleanups,
    liveFlags,
  });
}

function containsLoweredEnum(
  in enums: Array<LoweredEnum>,
  in name: String
): boolean {
  for (const declaration of enums) {
    if (declaration.name == name) return true;
  }
  return false;
}

function containsLoweredStruct(
  in structs: Array<LoweredStruct>,
  in name: String
): boolean {
  for (const declaration of structs) {
    if (declaration.name == name) return true;
  }
  return false;
}

function containsLoweredFunction(
  in functions: Array<LoweredFunction>,
  in name: String
): boolean {
  for (const declaration of functions) {
    if (declaration.name == name) return true;
  }
  return false;
}

function functionIsExported(
  in program: Program,
  in name: String
): boolean {
  for (const declaration of program.declarations) {
    if (
      declaration.kind == DeclarationKind.functionDeclaration
      && declaration.name == name
    ) return declaration.exported;
  }
  return false;
}

function containsName(in names: Array<String>, in name: String): boolean {
  for (const candidate of names) {
    if (candidate == name) return true;
  }
  return false;
}

function collisionSafePrivateFunctionNames(
  in parsed: Array<ParsedModule>
): Array<String> {
  let names = Array<String>();
  for (const module of parsed) {
    for (const declaration of module.program.functions) {
      if (containsName(names, declaration.name)) continue;
      let count: usize = 0;
      let exportedCount: usize = 0;
      for (const candidateModule of parsed) {
        for (const candidate of candidateModule.program.functions) {
          if (candidate.name != declaration.name) continue;
          count = count + 1;
          if (functionIsExported(
            candidateModule.program,
            candidate.name
          )) exportedCount = exportedCount + 1;
        }
      }
      if (count > 1 && exportedCount <= 1) {
        names.push(declaration.name.copyBytes(
          0,
          declaration.name.byteLength
        ));
      }
    }
  }
  return names;
}

function privateFunctionNeedsMangle(
  in program: Program,
  in collisionNames: Array<String>,
  moduleIndex: usize,
  entryIndex: usize,
  in name: String
): boolean {
  if (!containsName(collisionNames, name)) return false;
  if (functionIsExported(program, name)) return false;
  return moduleIndex != entryIndex || name != "main";
}

function emittedPrivateFunctionName(
  moduleIndex: usize,
  in name: String
): String {
  return `__z_module_${moduleIndex}_${name}`;
}

function rewritePrivateCallTargets(
  in program: Program,
  in collisionNames: Array<String>,
  moduleIndex: usize,
  entryIndex: usize,
  inout lowered: LoweredFunction
): void {
  let index: usize = 0;
  while (index < lowered.expressions.length) {
    if (
      lowered.expressions[index].kind == LoweredExpressionKind.directCall
      && lowered.expressions[index].children.length > 0
    ) {
      const callee = lowered.expressions[index].children[0];
      if (
        lowered.expressions[callee].kind == LoweredExpressionKind.localValue
      ) {
        for (const declaration of program.functions) {
          if (
            declaration.name == lowered.expressions[callee].value
            && privateFunctionNeedsMangle(
              program,
              collisionNames,
              moduleIndex,
              entryIndex,
              declaration.name
            )
          ) {
            lowered.expressions[callee] = LoweredExpression({
              kind: LoweredExpressionKind.localValue,
              value: emittedPrivateFunctionName(
                moduleIndex,
                declaration.name
              ),
              children: Array<usize>(),
              labels: Array<String>(),
            });
          }
        }
      }
    }
    index = index + 1;
  }
}

function collectIntrinsicTypeName(
  in program: Program,
  in name: String,
  inout enums: Array<LoweredEnum>
): void throws String {
  match (genericTypeShape(name)) {
    some(generic) => {
      for (const argument of generic.arguments) {
        try collectIntrinsicTypeName(program, argument, inout enums);
      }
      const intrinsic = try intrinsicEnumDeclaration(program, name);
      match (intrinsic) {
        some(declaration) => {
          if (!containsLoweredEnum(enums, declaration.name)) {
            enums.push(move declaration);
          }
        }
        none => {}
      }
    }
    none => {}
  }
}

function collectArenaIntrinsicEnums(
  in program: Program,
  in arena: StatementArena,
  inout enums: Array<LoweredEnum>
): void throws String {
  for (const statement of arena.nodes) {
    match (in statement.typeAnnotation) {
      some(type) => try collectIntrinsicTypeName(program, type.name, inout enums);
      none => {}
    }
    match (in statement.expression) {
      some(expression) => {
        match (in expression.tree) {
          some(tree) => {
            for (const node of tree.nodes) {
              try collectIntrinsicTypeName(program, node.value, inout enums);
            }
          }
          none => {}
        }
      }
      none => {}
    }
    match (in statement.secondExpression) {
      some(expression) => {
        match (in expression.tree) {
          some(tree) => {
            for (const node of tree.nodes) {
              try collectIntrinsicTypeName(program, node.value, inout enums);
            }
          }
          none => {}
        }
      }
      none => {}
    }
  }
}

function collectIntrinsicEnums(
  in program: Program,
  inout enums: Array<LoweredEnum>
): void throws String {
  for (const aggregate of program.aggregates) {
    for (const field of aggregate.fields) {
      try collectIntrinsicTypeName(program, field.type.name, inout enums);
    }
    match (in aggregate.deinitializer) {
      some(deinitializer) => try collectArenaIntrinsicEnums(
        program,
        deinitializer.body,
        inout enums
      );
      none => {}
    }
  }
  for (const declaration of program.enums) {
    for (const variant of declaration.variants) {
      match (in variant.payload) {
        some(type) => try collectIntrinsicTypeName(program, type.name, inout enums);
        none => {}
      }
    }
  }
  for (const declaration of program.functions) {
    for (const parameter of declaration.parameters) {
      try collectIntrinsicTypeName(program, parameter.type.name, inout enums);
    }
    try collectIntrinsicTypeName(program, declaration.returnType.name, inout enums);
    match (in declaration.errorType) {
      some(type) => {
        try collectIntrinsicTypeName(program, type.name, inout enums);
        const returnName = declaration.returnType.name.copyBytes(
          0,
          declaration.returnType.name.byteLength
        );
        const errorName = type.name.copyBytes(0, type.name.byteLength);
        const resultName = `Result<${returnName}, ${errorName}>`;
        try collectIntrinsicTypeName(program, resultName, inout enums);
      }
      none => {}
    }
    try collectArenaIntrinsicEnums(program, declaration.body, inout enums);
  }
}

function loweredStructCleanup(
  in structs: Array<LoweredStruct>,
  in name: String
): Option<boolean> {
  for (const declaration of structs) {
    if (declaration.name == name) {
      return Option.some(declaration.needsDeinit);
    }
  }
  return Option<boolean>.none;
}

function copyLoweredVariant(in variant: LoweredVariant): LoweredVariant {
  let payload = Option<LoweredType>.none;
  match (in variant.payload) {
    some(type) => payload = Option.some(LoweredType({
      kind: type.kind,
      name: type.name.copyBytes(0, type.name.byteLength),
    }));
    none => {}
  }
  return LoweredVariant({
    name: variant.name.copyBytes(0, variant.name.byteLength),
    payload,
  });
}

function loweredEnumCopy(
  in enums: Array<LoweredEnum>,
  in name: String
): Option<LoweredEnum> {
  for (const declaration of enums) {
    if (declaration.name != name) continue;
    let variants = Array<LoweredVariant>();
    for (const variant of declaration.variants) {
      variants.push(copyLoweredVariant(variant));
    }
    return Option.some(LoweredEnum({
      name: declaration.name.copyBytes(0, declaration.name.byteLength),
      variants,
      payloadBearing: declaration.payloadBearing,
      needsDeinit: declaration.needsDeinit,
    }));
  }
  return Option<LoweredEnum>.none;
}

function importedTypesForModule(
  in graph: ModuleGraph,
  in structs: Array<LoweredStruct>,
  in enums: Array<LoweredEnum>,
  moduleIndex: usize
): Array<LoweredImportedType> {
  let types = Array<LoweredImportedType>();
  for (const symbol of graph.modules[moduleIndex].symbols) {
    if (symbol.kind != ModuleSymbolKind.importedSymbol) continue;
    let targetModule = graph.modules.length;
    match (in symbol.targetModule) {
      some(index) => targetModule = index;
      none => {}
    }
    if (targetModule >= graph.modules.length) continue;
    const targetSymbol = moduleSymbolIndex(
      graph.modules[targetModule],
      symbol.importedName
    );
    if (targetSymbol >= graph.modules[targetModule].symbols.length) continue;
    if (
      graph.modules[targetModule].symbols[targetSymbol].kind
        == ModuleSymbolKind.structSymbol
    ) {
      const targetName = graph.modules[targetModule].symbols[
        targetSymbol
      ].name.copyBytes(
        0,
        graph.modules[targetModule].symbols[targetSymbol].name.byteLength
      );
      match (loweredStructCleanup(structs, targetName)) {
        some(needsDeinit) => types.push(LoweredImportedType({
          localName: symbol.name.copyBytes(0, symbol.name.byteLength),
          targetName,
          kind: LoweredTypeKind.structType,
          needsDeinit,
          variants: Array<LoweredVariant>(),
          payloadBearing: false,
        }));
        none => {}
      }
    } else if (
      graph.modules[targetModule].symbols[targetSymbol].kind
        == ModuleSymbolKind.enumSymbol
    ) {
      const targetName = graph.modules[targetModule].symbols[
        targetSymbol
      ].name.copyBytes(
        0,
        graph.modules[targetModule].symbols[targetSymbol].name.byteLength
      );
      match (loweredEnumCopy(enums, targetName)) {
        some(declaration) => {
          let variants = Array<LoweredVariant>();
          for (const variant of declaration.variants) {
            variants.push(copyLoweredVariant(variant));
          }
          types.push(LoweredImportedType({
            localName: symbol.name.copyBytes(0, symbol.name.byteLength),
            targetName,
            kind: LoweredTypeKind.enumType,
            needsDeinit: declaration.needsDeinit,
            variants,
            payloadBearing: declaration.payloadBearing,
          }));
        }
        none => {}
      }
    }
  }
  return types;
}

function appendLoweredProgram(
  in program: Program,
  inout importedTypes: Array<LoweredImportedType>,
  in evidence: ModuleSemanticEvidence,
  in privateCollisionNames: Array<String>,
  moduleIndex: usize,
  entryIndex: usize,
  inout structs: Array<LoweredStruct>,
  inout enums: Array<LoweredEnum>,
  inout functions: Array<LoweredFunction>
): void throws String {
  if (
    program.traits.length > 0
    || program.typeAliases.length > 0
  ) {
    throw "native lowering does not support traits or type aliases yet";
  }

  try collectIntrinsicEnums(program, inout enums);
  for (const declaration of program.enums) {
    if (
      containsLoweredEnum(enums, declaration.name)
      || containsLoweredStruct(structs, declaration.name)
    ) {
      throw `native module emission requires collision-safe type identity for ${declaration.name}`;
    }
    let variants = Array<LoweredVariant>();
    let payloadBearing = false;
    for (const variant of declaration.variants) {
      let payload = Option<LoweredType>.none;
      match (in variant.payload) {
        some(type) => {
          const lowered = try lowerModuleType(program, importedTypes, type);
          payload = Option.some(move lowered);
          payloadBearing = true;
        }
        none => {}
      }
      variants.push(LoweredVariant({
        name: variant.name.copyBytes(0, variant.name.byteLength),
        payload,
      }));
    }
    const declarationIndex = match (enumIndex(program, declaration.name)) {
      some(index) => index;
      none => throw `native lowering lost enum ${declaration.name}`;
    };
    enums.push(LoweredEnum({
      name: declaration.name.copyBytes(0, declaration.name.byteLength),
      variants,
      payloadBearing,
      needsDeinit: moduleEnumNeedsCleanup(
        program,
        importedTypes,
        declarationIndex,
        0
      ),
    }));
  }

  for (const aggregate of program.aggregates) {
    if (
      containsLoweredStruct(structs, aggregate.name)
      || containsLoweredEnum(enums, aggregate.name)
    ) {
      throw `native module emission requires collision-safe type identity for ${aggregate.name}`;
    }
    if (
      aggregate.kind != DeclarationKind.structDeclaration
      || aggregate.typeParameters.length > 0
      || aggregate.methods.length > 0
    ) {
      throw "native lowering only supports non-generic data-only structs yet";
    }
    match (in aggregate.constructorDeclaration) {
      some(_) => throw `native lowering does not support constructor on ${aggregate.name} yet`;
      none => {}
    }
    let fields = Array<LoweredField>();
    for (const field of aggregate.fields) {
      const fieldType = try lowerModuleType(
        program,
        importedTypes,
        field.type
      );
      fields.push(LoweredField({
        name: field.name.copyBytes(0, field.name.byteLength),
        type: move fieldType,
      }));
    }
    let deinitializer = Option<LoweredFunction>.none;
    match (in aggregate.deinitializer) {
      some(source) => {
        const body = try lowerDeinitializer(
          program,
          importedTypes,
          evidence,
          aggregate.name,
          source.body
        );
        deinitializer = Option.some(move body);
      }
      none => {}
    }
    const aggregateIndex = match (structIndex(program, aggregate.name)) {
      some(index) => index;
      none => throw `native lowering lost aggregate ${aggregate.name}`;
    };
    const needsDeinit = moduleAggregateNeedsCleanup(
      program,
      importedTypes,
      aggregateIndex,
      0
    );
    structs.push(LoweredStruct({
      name: aggregate.name.copyBytes(0, aggregate.name.byteLength),
      fields,
      needsDeinit,
      deinitializer,
    }));
  }

  for (const aggregate of program.aggregates) {
    match (loweredStructCleanup(structs, aggregate.name)) {
      some(needsDeinit) => importedTypes.push(LoweredImportedType({
        localName: aggregate.name.copyBytes(0, aggregate.name.byteLength),
        targetName: aggregate.name.copyBytes(0, aggregate.name.byteLength),
        kind: LoweredTypeKind.structType,
        needsDeinit,
        variants: Array<LoweredVariant>(),
        payloadBearing: false,
      }));
      none => {}
    }
  }

  for (const declaration of program.functions) {
    if (
      containsLoweredFunction(functions, declaration.name)
      && !containsName(privateCollisionNames, declaration.name)
    ) {
      throw `native module emission requires collision-safe function identity for ${declaration.name}`;
    }
    let loweredFunction = try lowerFunction(
      program,
      importedTypes,
      evidence,
      declaration
    );
    rewritePrivateCallTargets(
      program,
      privateCollisionNames,
      moduleIndex,
      entryIndex,
      inout loweredFunction
    );
    if (privateFunctionNeedsMangle(
      program,
      privateCollisionNames,
      moduleIndex,
      entryIndex,
      declaration.name
    )) {
      loweredFunction.name = emittedPrivateFunctionName(
        moduleIndex,
        declaration.name
      );
    }
    functions.push(move loweredFunction);
  }
}

export function lowerProgram(
  in program: Program,
  in evidence: ModuleSemanticEvidence
): LoweredProgram throws String {
  if (program.imports.length > 0) {
    throw "native single-module lowering cannot resolve imports";
  }
  let structs = Array<LoweredStruct>();
  let enums = Array<LoweredEnum>();
  let functions = Array<LoweredFunction>();
  let importedTypes = Array<LoweredImportedType>();
  const privateCollisionNames = Array<String>();
  try appendLoweredProgram(
    program,
    inout importedTypes,
    evidence,
    privateCollisionNames,
    0,
    0,
    inout structs,
    inout enums,
    inout functions
  );
  return LoweredProgram({ structs, enums, functions });
}

export function lowerModules(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): LoweredProgram throws String {
  let structs = Array<LoweredStruct>();
  let enums = Array<LoweredEnum>();
  let functions = Array<LoweredFunction>();
  const privateCollisionNames = collisionSafePrivateFunctionNames(parsed);
  const entryIndex = graph.entry;
  for (const moduleIndex of graph.dependencyOrder) {
    let importedTypes = importedTypesForModule(
      graph,
      structs,
      enums,
      moduleIndex
    );
    try appendLoweredProgram(
      parsed[moduleIndex].program,
      inout importedTypes,
      graph.modules[moduleIndex].semanticEvidence,
      privateCollisionNames,
      moduleIndex,
      entryIndex,
      inout structs,
      inout enums,
      inout functions
    );
  }
  return LoweredProgram({ structs, enums, functions });
}
