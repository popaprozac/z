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
  }
  return false;
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
  for (const child of tree.nodes[index].children) {
    if (treeMovesName(tree, child, name)) return true;
  }
  return false;
}

function syntaxMovesName(in expression: ExpressionSyntax, in name: String): boolean {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      select treeMovesName(tree, root, name);
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
  in arena: StatementArena,
  in name: String
): boolean {
  for (const statement of arena.nodes) {
    match (in statement.expression) {
      some(expression) => {
        if (syntaxMovesName(expression, name)) return true;
      }
      none => {}
    }
    match (in statement.secondExpression) {
      some(expression) => {
        if (syntaxMovesName(expression, name)) return true;
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
  if (
    statements[loweredIndex].kind == LoweredStatementKind.localStatement
    && statements[loweredIndex].children.length == 1
    && statements[statements[loweredIndex].children[0]].kind
      == LoweredStatementKind.matchStatement
  ) {
    const loweredMatch = statements[loweredIndex].children[0];
    try planCleanupStatement(
      program,
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
      match (in arena.nodes[sourceIndex].typeAnnotation) {
        some(annotation) => {
          const type = try lowerType(program, annotation);
          if (typeNeedsCleanup(program, type)) {
            const moved = arenaMovesName(arena, arena.nodes[sourceIndex].name);
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
                type: move type,
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

function lowerExpression(
  in program: Program,
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
  if (tree.nodes[index].kind == ExpressionKind.unaryExpression) {
    if (tree.nodes[index].children.length != 1) {
      throw "native lowering received a malformed unary expression";
    }
    const operandInput = tree.nodes[index].children[0];
    const operand = try lowerExpression(program, tree, operandInput, inout output);
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
    const left = try lowerExpression(program, tree, leftInput, inout output);
    const right = try lowerExpression(program, tree, rightInput, inout output);
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
      }
    }
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression
      && tree.nodes[index].children.length == 2
    ) {
      match (structIndex(program, tree.nodes[calleeInput].value)) {
        some(_) => {
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
            const value = try lowerExpression(program, tree, valueInput, inout output);
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
            tree.nodes[calleeInput].value,
            children,
            labels
          );
        }
        none => {}
      }
    }
    const callee = try lowerExpression(program, tree, calleeInput, inout output);
    let children = Array<usize>();
    children.push(callee);
    let argument: usize = 1;
    while (argument < tree.nodes[index].children.length) {
      const argumentInput = tree.nodes[index].children[argument];
      const value = try lowerExpression(program, tree, argumentInput, inout output);
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
    }
    const receiver = try lowerExpression(program, tree, receiverInput, inout output);
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
  in expression: ExpressionSyntax,
  inout output: Array<LoweredExpression>
): usize throws String {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      select try lowerExpression(program, tree, root, inout output);
    }
    none => throw "native lowering cannot lower an opaque expression";
  };
}

function loweredSourceEnum(
  in program: Program,
  index: usize
): LoweredEnum throws String {
  let variants = Array<LoweredVariant>();
  let payloadBearing = false;
  for (const variant of program.enums[index].variants) {
    let payload = Option<LoweredType>.none;
    match (in variant.payload) {
      some(type) => {
        const lowered = try lowerType(program, type);
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
    needsDeinit: enumNeedsCleanup(program, index, 0),
  });
}

function matchSubjectTypeName(
  in program: Program,
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  index: usize
): Option<String> {
  let subject = index;
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
          none => {}
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
  in arena: StatementArena,
  in ownerName: String,
  in tree: ExpressionTree,
  root: usize
): LoweredEnum throws String {
  const subjectInput = tree.nodes[root].children[0];
  match (matchSubjectTypeName(program, arena, ownerName, tree, subjectInput)) {
    some(name) => {
      const intrinsic = try intrinsicOptionDeclaration(program, name);
      match (intrinsic) {
        some(declaration) => return declaration;
        none => {}
      }
      match (enumIndex(program, name)) {
        some(index) => return try loweredSourceEnum(program, index);
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
    some(index) => try loweredSourceEnum(program, index);
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
  in expression: ExpressionSyntax,
  returnValue: boolean,
  in valueBinding: String,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
  const value = try lowerExpressionSyntax(program, expression, inout expressions);
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
  const subject = try lowerExpression(program, tree, subjectInput, inout expressions);
  const declaration = try matchEnumDeclaration(
    program,
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
        && typeNeedsCleanup(program, type)
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
  in arena: StatementArena,
  in ownerName: String,
  index: usize,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
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
              const bindingType = match (in arena.nodes[index].typeAnnotation) {
                some(annotation) => try lowerType(program, annotation);
                none => throw `native lowering requires an explicit type for local ${arena.nodes[index].name} in its first slice`;
              };
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
  match (in arena.nodes[index].typeAnnotation) {
    some(annotation) => {
      const loweredType = try lowerType(program, annotation);
      type = Option.some(move loweredType);
    }
    none => {
      if (arena.nodes[index].kind == StatementKind.variableStatement) {
        throw `native lowering requires an explicit type for local ${arena.nodes[index].name} in its first slice`;
      }
    }
  }
  let expression = Option<usize>.none;
  match (in arena.nodes[index].expression) {
    some(source) => {
      const loweredExpression = try lowerExpressionSyntax(program, source, inout expressions);
      expression = Option.some(loweredExpression);
    }
    none => {}
  }
  let secondExpression = Option<usize>.none;
  match (in arena.nodes[index].secondExpression) {
    some(source) => {
      const loweredExpression = try lowerExpressionSyntax(
        program,
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
    const parameterType = try lowerType(program, parameter.type);
    if (typeNeedsCleanup(program, parameterType)) {
      const moved = arenaMovesName(declaration.body, parameter.name);
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
  const returnType = try lowerType(program, declaration.returnType);
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
      if (generic.base == "Option" && generic.arguments.length == 1) {
        const payload = try lowerTypeName(program, generic.arguments[0]);
        const declarationName = intrinsicOptionName(payload);
        if (containsLoweredEnum(enums, declarationName)) return;
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
        enums.push(LoweredEnum({
          name: move declarationName,
          variants,
          payloadBearing: true,
          needsDeinit: typeNeedsCleanup(program, payload),
        }));
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

function collectIntrinsicEnums(in program: Program): Array<LoweredEnum> throws String {
  let enums = Array<LoweredEnum>();
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
      some(type) => try collectIntrinsicTypeName(program, type.name, inout enums);
      none => {}
    }
    try collectArenaIntrinsicEnums(program, declaration.body, inout enums);
  }
  return enums;
}

export function lowerProgram(in program: Program): LoweredProgram throws String {
  if (program.imports.length > 0) {
    throw "native lowering does not support imports in its first slice";
  }
  if (
    program.traits.length > 0
    || program.typeAliases.length > 0
  ) {
    throw "native lowering does not support traits or type aliases yet";
  }

  let enums = try collectIntrinsicEnums(program);
  for (const declaration of program.enums) {
    let variants = Array<LoweredVariant>();
    let payloadBearing = false;
    for (const variant of declaration.variants) {
      let payload = Option<LoweredType>.none;
      match (in variant.payload) {
        some(type) => {
          const lowered = try lowerType(program, type);
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
      needsDeinit: enumNeedsCleanup(program, declarationIndex, 0),
    }));
  }

  let structs = Array<LoweredStruct>();
  for (const aggregate of program.aggregates) {
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
      const fieldType = try lowerType(program, field.type);
      fields.push(LoweredField({
        name: field.name.copyBytes(0, field.name.byteLength),
        type: move fieldType,
      }));
    }
    let deinitializer = Option<LoweredFunction>.none;
    match (in aggregate.deinitializer) {
      some(source) => {
        const body = try lowerDeinitializer(program, aggregate.name, source.body);
        deinitializer = Option.some(move body);
      }
      none => {}
    }
    const aggregateIndex = match (structIndex(program, aggregate.name)) {
      some(index) => index;
      none => throw `native lowering lost aggregate ${aggregate.name}`;
    };
    structs.push(LoweredStruct({
      name: aggregate.name.copyBytes(0, aggregate.name.byteLength),
      fields,
      needsDeinit: aggregateNeedsCleanup(program, aggregateIndex, 0),
      deinitializer,
    }));
  }

  let functions = Array<LoweredFunction>();
  for (const declaration of program.functions) {
    const loweredFunction = try lowerFunction(program, declaration);
    functions.push(move loweredFunction);
  }
  return LoweredProgram({ structs, enums, functions });
}
