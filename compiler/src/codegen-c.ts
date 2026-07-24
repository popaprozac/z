import type {
  Expression,
  EnumDeclaration,
  FunctionDeclaration,
  Program,
  Statement,
  StructDeclaration,
} from "./ast.ts";
import { resultTypeName } from "./results.ts";
import {
  dynamicArrayTypeName,
  parseDynamicArrayType,
  parseFixedArrayType,
  parseSliceType,
  sliceTypeName,
} from "./array-types.ts";
import type {
  ClosureInfo,
  ForeignCallArgumentPlan,
  ForeignStatusCallInfo,
  IntegerConversion,
  IntegerOperation,
  ObjCBindingPlan,
  ObjCProtocolConformance,
  SemanticInfo,
} from "./sema.ts";
import {
  parsePointerTypeName,
  type ForeignBlockType,
  type ForeignObjCProtocolMethod,
  type ForeignType,
} from "./foreign.ts";
import {
  isStandardModuleSpecifier,
  objcConnectionTypeName,
  objcSelectorTypeName,
  standardFunctionSignature,
  type StandardFunctionName,
} from "./standard-library.ts";
import {
  functionTypeAbiKey,
  parseFunctionType,
  type FunctionType,
} from "./function-types.ts";
import {
  parseWeakResultType,
  parseWeakType,
  weakExpiredType,
  weakResultTypeName,
} from "./weak-types.ts";
import { optionTypeName, parseOptionType } from "./option-types.ts";
import { parseOptionalViewType, parseViewType, viewTypeName } from "./view-types.ts";
import { mapEntryTypeName, parseMapEntryType, parseMapType } from "./map-types.ts";
import { parseSetType } from "./set-types.ts";
import { generatorStepTypeName, isGeneratorFunction, parseGeneratorType } from "./generator-types.ts";

type GenerationContext = {
  readonly structs: Map<string, StructDeclaration>;
  readonly enums: Map<string, EnumDeclaration>;
  readonly functions: Map<string, FunctionDeclaration>;
  readonly localTypes: Map<string, string>;
  readonly parameterModes: Map<string, "value" | "in" | "inout" | "out">;
  readonly receiver: StructDeclaration | null;
  readonly owner: FunctionDeclaration;
  readonly matchCounter: { value: number };
  readonly tryCounter: { value: number };
  readonly valueCounter: { value: number };
  readonly returnCounter: { value: number };
  readonly loopCounter: { value: number };
  readonly loopStack: LoopGenerationFrame[];
  readonly valueSelectionStack: ValueSelectionGenerationFrame[];
  readonly cleanupCounter: { value: number };
  readonly cleanupScopes: CleanupLocal[][];
  readonly liveFlags: Map<string, string>;
  readonly liveFlagCounter: { value: number };
  readonly expressionOverrides: ReadonlyMap<number, string>;
  readonly semanticInfo: SemanticInfo;
  readonly constructorSelf?: string;
  readonly constructorFieldFlags?: ReadonlyMap<string, string>;
  readonly generatorFrame?: {
    readonly storage: Map<string, string>;
    readonly fields: GeneratorFrameField[];
    readonly liveFlags: Map<string, string>;
    readonly stateCounter: { value: number };
  };
};

type CleanupLocal = {
  readonly name: string;
  readonly type: string;
  readonly liveFlag: string;
  readonly value?: string;
};

type LoopGenerationFrame = {
  readonly breakLabel: string;
  readonly continueLabel: string;
  readonly cleanupDepth: number;
  usedBreak: boolean;
  usedContinue: boolean;
};

type ValueSelectionGenerationFrame = {
  readonly label: string;
  readonly cleanupDepth: number;
  readonly consumeValue: (value: string, context: GenerationContext) => string;
  readonly consumeTerminates: boolean;
};

const primitiveTypeNames: Record<string, string> = {
  i8: "int8_t",
  u8: "uint8_t",
  i16: "int16_t",
  u16: "uint16_t",
  i32: "int32_t",
  u32: "uint32_t",
  i64: "int64_t",
  u64: "uint64_t",
  isize: "intptr_t",
  usize: "uintptr_t",
  f32: "float",
  f64: "double",
  void: "void",
  boolean: "bool",
  cstring: "const char *",
  String: "Z_String",
  TextBuffer: "Z_String",
  Arena: "Z_Arena",
  Hasher: "Z_Hasher",
  TaskScope: "Z_TaskScope *",
  [objcSelectorTypeName]: "SEL",
};

export function generateC(program: Program, sourceName: string, semanticInfo: SemanticInfo): string {
  const structs = new Map(program.structs.map((declaration) => [declaration.name, declaration]));
  const enums = new Map(program.enums.map((declaration) => [declaration.name, declaration]));
  const functions = new Map(program.functions.map((declaration) => [declaration.name, declaration]));
  const threadClosureOffsets = new Set(semanticInfo.threadSpawnCalls.values());
  const closures = [...semanticInfo.closures.entries()]
    .filter(([offset]) => !threadClosureOffsets.has(offset))
    .map(([, closure]) => closure);
  const arrayTypes = collectFixedArrayTypes(program, semanticInfo);
  const sliceTypes = collectSliceTypes(program, semanticInfo);
  const dynamicArrayTypes = collectDynamicArrayTypes(program, semanticInfo);
  const mapTypes = program.structs.map((declaration) => declaration.name).filter((name) => parseMapType(name));
  const setTypes = program.structs.map((declaration) => declaration.name).filter((name) => parseSetType(name));
  const generatorTypes = [...new Set(
    [
      ...semanticInfo.iteratorElementTypes.keys(),
      ...program.functions.flatMap((declaration) => [
        declaration.returnType.name,
        ...declaration.parameters.map((parameter) => parameter.type.name),
      ]),
      ...program.structs.flatMap((declaration) => [
        ...declaration.fields.map((field) => field.type.name),
        ...declaration.methods.flatMap((method) => [
          method.returnType.name,
          ...method.parameters.map((parameter) => parameter.type.name),
        ]),
      ]),
    ].filter((name) => parseGeneratorType(name)),
  )];
  const dynamicArrayPushTypes = [...new Set([
    ...collectDynamicArrayPushTypes(program, semanticInfo),
    ...mapTypes.map((name) => {
      const map = parseMapType(name)!;
      return dynamicArrayTypeName(mapEntryTypeName(map.keyType, map.valueType));
    }),
    ...setTypes.map((name) => dynamicArrayTypeName(parseSetType(name)!.elementType)),
  ])];
  const explicitCopyTypes = collectExplicitCopyTypes(semanticInfo, structs, enums);
  const arenaCreateTypes = [...new Set(semanticInfo.arenaCreateCalls.values())];
  const usesArena = [...semanticInfo.standardTypeBindings.values()].includes("Arena");
  const usesTaskScope = semanticInfo.taskScopeConstructors.size > 0
    || semanticInfo.taskScopeSpawnCalls.size > 0;
  const usesHasher = semanticInfo.hasherAddTypes.size > 0
    || [...semanticInfo.standardTypeBindings.values()].includes("Hasher")
    || [...mapTypes, ...setTypes].some((type) => {
      const key = parseMapType(type)?.keyType ?? parseSetType(type)?.elementType;
      return Boolean(key && structs.get(key)?.implements.some((trait) => trait.name === "Hashable"));
    });
  const functionTypes = collectFunctionTypes(program, semanticInfo);
  const foreignCallbackAdapters = collectForeignCallbackAdapters(semanticInfo);
  const foreignEscapeHelpers = collectForeignEscapeHelpers(foreignCallbackAdapters);
  const usesSleep = [...semanticInfo.standardFunctionReferences.values()].includes("sleep");
  const usesTiming = usesSleep || [...semanticInfo.standardFunctionReferences.values()].includes("delay");
  const usedStandardFunctions = new Set(semanticInfo.standardFunctionReferences.values());
  const usesFileSystem = [...usedStandardFunctions].some((name) => name.startsWith("fs."));
  const usesProcess = [...usedStandardFunctions].some((name) => name.startsWith("process."));
  const usesNativeMove = [...semanticInfo.foreignNamedTypes.values()].some((type) => (
    type.kind === "value" && type.lifecycle.move && !type.lifecycle.copy
  ));
  const usesNativeLifetimeStorage = dynamicArrayTypes.some((type) => {
    const dynamic = parseDynamicArrayType(type)!;
    return requiresNativeMove(dynamic.elementType, structs, enums, semanticInfo.foreignNamedTypes);
  }) || program.enums.some((declaration) => (
    requiresNativeMove(declaration.name, structs, enums, semanticInfo.foreignNamedTypes)
  )) || arenaCreateTypes.some((type) => (
    requiresNativeLifetime(type, structs, enums, semanticInfo.foreignNamedTypes)
  ));
  const includedHeaders = new Set(["stdbool.h", "stddef.h", "stdint.h", "stdlib.h"]);
  const lines = [
    "/* Generated by the Z bootstrap compiler. */",
    `/* Source: ${sourceName.replaceAll("*/", "* /")} */`,
  ];
  if (usesTiming) {
    lines.push(
      "#if !defined(_WIN32) && !defined(__APPLE__) && !defined(_POSIX_C_SOURCE)",
      "#define _POSIX_C_SOURCE 200809L",
      "#endif",
    );
  }
  if (usesFileSystem || usesProcess) {
    lines.push("#include <errno.h>");
    includedHeaders.add("errno.h");
  }
  if (usesProcess) {
    lines.push(
      "#if defined(_WIN32)",
      "#include <io.h>",
      "#include <process.h>",
      "#else",
      "#include <fcntl.h>",
      "#include <sys/types.h>",
      "#include <sys/wait.h>",
      "#include <unistd.h>",
      "#endif",
    );
    includedHeaders.add("io.h");
    includedHeaders.add("process.h");
    includedHeaders.add("fcntl.h");
    includedHeaders.add("sys/types.h");
    includedHeaders.add("sys/wait.h");
    includedHeaders.add("unistd.h");
  } else if (usesFileSystem) {
    lines.push(
      "#if defined(_WIN32)",
      "#include <io.h>",
      "#else",
      "#include <unistd.h>",
      "#endif",
    );
    includedHeaders.add("io.h");
    includedHeaders.add("unistd.h");
  }
  lines.push(
    "#include <stdbool.h>",
    "#include <stddef.h>",
    "#include <stdint.h>",
    "#include <stdlib.h>",
  );
  if (usesNativeMove) {
    lines.push("#include <utility>");
    includedHeaders.add("utility");
  }
  if (usesNativeLifetimeStorage) {
    lines.push("#include <memory>", "#include <new>");
    includedHeaders.add("memory");
    includedHeaders.add("new");
  }
  if (semanticInfo.swiftStringsToZ.size > 0) {
    lines.push("#include <string>");
    includedHeaders.add("string");
  }
  if (usesTiming) {
    lines.push(
      "#if defined(_WIN32)",
      "#include <windows.h>",
      "#else",
      "#include <errno.h>",
      "#include <time.h>",
      "#endif",
    );
  }

  const usesString = programUsesString(program, semanticInfo);
  if (semanticInfo.consoleCalls.size > 0 || usesString || usesFileSystem) {
    lines.push("#include <stdio.h>");
    includedHeaders.add("stdio.h");
  }
  if (usesString) {
    lines.push("#include <string.h>");
    includedHeaders.add("string.h");
  }

  if (semanticInfo.objcConnectionCalls.size > 0 || semanticInfo.objcBindingCalls.size > 0) {
    lines.push("#import <Foundation/Foundation.h>");
    includedHeaders.add("Foundation/Foundation.h");
  }

  for (const declaration of program.imports) {
    if (isStandardModuleSpecifier(declaration.header)) continue;
    if (includedHeaders.has(declaration.header)) continue;
    lines.push(`#include <${declaration.header}>`);
    includedHeaders.add(declaration.header);
  }
  if (semanticInfo.objcBlockArguments.size > 0) {
    lines.push("", generateObjCBlockRuntime());
  }
  const integerRuntime = generateIntegerRuntime(
    semanticInfo.integerOperations,
    semanticInfo.integerConversions,
    semanticInfo.numericLiteralTypes,
  );
  if (integerRuntime.length > 0) lines.push("", ...integerRuntime);
  if (programUsesIndex(program)) {
    lines.push(
      "",
      "static inline uintptr_t z_bounds_index(uintptr_t index, uintptr_t length) {",
      "  if (index >= length) abort();",
      "  return index;",
      "}",
    );
  }
  lines.push("");

  if (usesTaskScope) {
    lines.push(
      "typedef struct Z_TaskScope Z_TaskScope;",
      "static Z_TaskScope *z_task_scope_retain(Z_TaskScope *scope);",
      "static void z_task_scope_release(Z_TaskScope *scope);",
      "static bool z_task_scope_spawn(Z_TaskScope *scope, void (*call)(void *), void *context, void (*retain)(void *), void (*release)(void *));",
      "",
    );
  }

  if (usesString) lines.push(generateStringRuntime(), "");
  if (semanticInfo.swiftStringsToZ.size > 0) lines.push(generateSwiftStringRuntime(), "");
  if (semanticInfo.objcStringsToNative.size > 0 || semanticInfo.objcStringsToZ.size > 0) {
    lines.push(generateObjCStringRuntime(), "");
  }
  if (usesSleep) lines.push(generateSleepRuntime(), "");
  if (usesArena) lines.push(generateArenaRuntime(), "");
  if (usesHasher) lines.push(generateHasherRuntime(usesString), "");

  for (const declaration of program.structs) {
    lines.push(`typedef struct ${structName(declaration.name)} ${structName(declaration.name)};`);
  }
  for (const type of arrayTypes) lines.push(`typedef struct ${arrayName(type)} ${arrayName(type)};`);
  for (const type of sliceTypes) lines.push(`typedef struct ${sliceName(type)} ${sliceName(type)};`);
  for (const type of dynamicArrayTypes) lines.push(`typedef struct ${dynamicArrayName(type)} ${dynamicArrayName(type)};`);
  for (const declaration of program.enums) {
    const niche = nicheOptionPayload(declaration, semanticInfo.foreignNamedTypes);
    lines.push(niche
      ? `typedef ${mapType(niche, structs, enums, semanticInfo.foreignNamedTypes)}${enumName(declaration.name)};`
      : `typedef struct ${enumName(declaration.name)} ${enumName(declaration.name)};`);
  }
  for (const type of generatorTypes) {
    lines.push(`typedef struct ${generatorCName(type)} ${generatorCName(type)};`);
  }
  if (
    program.structs.length > 0
    || program.enums.length > 0
    || arrayTypes.length > 0
    || sliceTypes.length > 0
    || dynamicArrayTypes.length > 0
    || generatorTypes.length > 0
  ) lines.push("");

  if (program.structs.some((declaration) => declaration.kind === "class")) {
    lines.push(generateWeakRuntime(), "");
  }

  for (const functionType of functionTypes) {
    lines.push(generateFunctionTypeDefinition(functionType, structs, enums, semanticInfo.foreignNamedTypes));
  }
  if (functionTypes.length > 0) lines.push("");
  if (semanticInfo.objcConnectionCalls.size > 0) {
    lines.push(generateObjCConnectionRuntime(), "");
  }
  if (semanticInfo.objcBindingCalls.size > 0) {
    lines.push(generateObjCBindingRuntime(), "");
  }
  for (const helper of foreignEscapeHelpers) {
    lines.push(generateForeignEscapeHelpers(helper), "");
  }
  for (const adapter of foreignCallbackAdapters) {
    lines.push(generateForeignCallbackAdapter(adapter), "");
  }

  for (const type of sliceTypes) {
    const slice = parseSliceType(type)!;
    lines.push(`struct ${sliceName(type)} {\n  ${mapType(slice.elementType, structs, enums, semanticInfo.foreignNamedTypes)} *data;\n  uintptr_t length;\n};`, "");
  }

  for (const type of dynamicArrayTypes) {
    const dynamic = parseDynamicArrayType(type)!;
    lines.push(
      `struct ${dynamicArrayName(type)} {\n`
        + `  ${mapType(dynamic.elementType, structs, enums, semanticInfo.foreignNamedTypes)} *data;\n`
        + "  uintptr_t length;\n"
        + "  uintptr_t capacity;\n"
        + "};",
      "",
    );
  }

  lines.push(...generateAggregateDefinitions(program.structs, program.enums, arrayTypes, structs, enums, semanticInfo.foreignNamedTypes));
  for (const type of generatorTypes) {
    lines.push(generateGeneratorRuntime(type, structs, enums, semanticInfo.foreignNamedTypes), "");
  }
  for (const type of explicitCopyTypes) {
    lines.push(`${generateExplicitCopySignature(type, structs, enums, semanticInfo.foreignNamedTypes)};`);
  }
  if (explicitCopyTypes.length > 0) lines.push("");
  for (const type of explicitCopyTypes) {
    lines.push(generateExplicitCopy(type, structs, enums, semanticInfo.foreignNamedTypes), "");
  }
  if (usesFileSystem || usesProcess) {
    lines.push(generateSystemStandardRuntime(usedStandardFunctions), "");
  }
  for (const closure of closures.filter((candidate) => candidate.captures.length > 0)) {
    lines.push(generateClosureEnvironmentDefinition(closure, structs, enums, semanticInfo), "");
  }
  for (const type of dynamicArrayPushTypes) {
    lines.push(generateDynamicArrayPush(type, structs, enums, semanticInfo.foreignNamedTypes), "");
  }
  for (const declaration of program.structs) {
    const moduleUnused = declaration.name.startsWith("__z_module_") ? "__attribute__((unused)) " : "";
    if (hasSemanticCleanupType(declaration.name, structs, enums, semanticInfo)) {
      lines.push(`static ${moduleUnused}void ${deinitName(declaration.name)}(${structName(declaration.name)} *self);`);
    }
    if (declaration.kind === "class") {
      lines.push(`static ${moduleUnused}${structName(declaration.name)} *${retainName(declaration.name)}(${structName(declaration.name)} *value);`);
      lines.push(`static ${moduleUnused}void ${releaseName(declaration.name)}(${structName(declaration.name)} *value);`);
      lines.push(`static ${moduleUnused}Z_Weak ${weakMakeName(declaration.name)}(const ${structName(declaration.name)} *borrowed);`);
      lines.push(`static ${moduleUnused}${enumName(weakResultTypeName(declaration.name))} ${weakUpgradeName(declaration.name)}(Z_Weak value);`);
      lines.push(`${generateClassConstructorSignature(declaration, structs, enums, semanticInfo.foreignNamedTypes)};`);
    }
    for (const method of declaration.methods) {
      lines.push(`${generateFunctionSignature(method, structs, enums, declaration, semanticInfo.foreignNamedTypes)};`);
    }
  }
  for (const declaration of program.functions) {
    lines.push(`${generateFunctionSignature(declaration, structs, enums, null, semanticInfo.foreignNamedTypes)};`);
  }
  for (const type of arenaCreateTypes) {
    lines.push(`${generateArenaCreateSignature(type, structs, enums, semanticInfo.foreignNamedTypes)};`);
  }
  for (const closure of closures) {
    lines.push(`${generateFunctionSignature(closure.declaration, structs, enums, null, semanticInfo.foreignNamedTypes)};`);
    if (closure.owned) {
      lines.push(`static void ${closureEnvironmentRetainName(closure)}(void *context);`);
      lines.push(`static void ${closureEnvironmentReleaseName(closure)}(void *context);`);
    }
    if (closure.storable) {
      lines.push(`${generateClosureAdapterSignature(closure, structs, enums, semanticInfo.foreignNamedTypes)};`);
    }
  }
  if (program.structs.some((declaration) => declaration.methods.length > 0) || program.functions.length > 0) {
    lines.push("");
  }

  for (const type of arenaCreateTypes) {
    lines.push(generateArenaCreate(type, structs, enums, semanticInfo), "");
  }

  // Collection helpers must precede user method bodies. A collection stored in
  // one Z module may be called by that module's renamed methods before the
  // entry-point module reaches the generated standard runtime definitions.
  for (const type of mapTypes) {
    lines.push(generateMapRuntime(type, structs, enums, semanticInfo), "");
  }
  for (const type of setTypes) {
    lines.push(generateSetRuntime(type, structs, enums, semanticInfo), "");
  }

  for (const declaration of program.structs) {
    if (hasSemanticCleanupType(declaration.name, structs, enums, semanticInfo)) {
      lines.push(generateDeinit(declaration, structs, enums, functions, semanticInfo), "");
    }
    if (declaration.kind === "class") {
      lines.push(generateClassLifecycle(declaration, structs, enums, functions, semanticInfo), "");
    }
    for (const method of declaration.methods) {
      lines.push(generateFunction(method, structs, enums, functions, declaration, semanticInfo), "");
    }
  }
  for (const conformance of semanticInfo.objcProtocolConformances.values()) {
    lines.push(generateObjCProtocolAdapter(conformance), "");
  }
  for (const [offset, plan] of semanticInfo.objcBindingCalls) {
    lines.push(generateObjCBindingHelper(offset, plan, semanticInfo), "");
  }
  for (const closure of closures.filter((candidate) => candidate.owned)) {
    lines.push(generateClosureEnvironmentLifecycle(closure, structs, enums, semanticInfo), "");
  }
  for (const closure of closures.filter((candidate) => candidate.storable)) {
    lines.push(generateClosureAdapter(closure, structs, enums, semanticInfo.foreignNamedTypes), "");
  }
  for (const declaration of program.functions.filter((candidate) => candidate.errorType === null && candidate.name !== "main")) {
    lines.push(generateFunctionAdapter(declaration, structs, enums, semanticInfo.foreignNamedTypes), "");
  }
  for (const name of new Set(semanticInfo.standardFunctionReferences.values())) {
    if (standardFunctionSignature(name).async) continue;
    lines.push(generateStandardFunctionAdapter(name, structs, enums, semanticInfo.foreignNamedTypes), "");
  }
  for (const closure of closures) {
    lines.push(generateFunction(closure.declaration, structs, enums, functions, null, semanticInfo), "");
  }
  for (const declaration of program.functions) {
    lines.push(generateFunction(declaration, structs, enums, functions, null, semanticInfo), "");
  }
  return `${lines.join("\n")}\n`;
}

function objcProtocolAdapterName(owner: string): string {
  return `ZObjCProtocolAdapter_${nativeSymbolPart(owner)}`;
}

function foreignCType(type: ForeignType): string {
  return type.cName;
}

function generateObjCProtocolMethodDeclaration(
  requirement: ForeignObjCProtocolMethod,
  argumentNames: readonly string[],
): string {
  const result = foreignCType(requirement.returnType);
  if (requirement.parameters.length === 0) return `- (${result})${requirement.selector}`;
  const labels = requirement.selector.split(":").slice(0, -1);
  return `- (${result})${labels.map((label, index) => (
    `${label}:(${foreignCType(requirement.parameters[index].type)})${argumentNames[index]}`
  )).join(" ")}`;
}

function generateObjCProtocolAdapter(
  conformance: ObjCProtocolConformance,
): string {
  const owner = conformance.declaration;
  const adapter = objcProtocolAdapterName(owner.name);
  const ownerType = structName(owner.name);
  const protocols = conformance.protocols.map((protocol) => protocol.protocolName).join(", ");
  const exported = owner.methods.flatMap((method) => {
    const requirement = conformance.methods.get(method.location.offset);
    return requirement ? [{ method, requirement }] : [];
  });
  const declarations = exported.map(({ requirement }) => {
    const arguments_ = requirement.parameters.map((parameter, index) => cBindingName(parameter.name ?? `argument${index + 1}`));
    return `${generateObjCProtocolMethodDeclaration(requirement, arguments_)};`;
  }).join("\n");
  const implementations = exported.map(({ method, requirement }) => {
    const arguments_ = requirement.parameters.map((parameter, index) => cBindingName(parameter.name ?? `argument${index + 1}`));
    const declaration = generateObjCProtocolMethodDeclaration(requirement, arguments_);
    const call = `${methodName(owner.name, method.name)}(_z_owner${arguments_.length ? `, ${arguments_.join(", ")}` : ""})`;
    const body = method.returnType.name === "void" ? `${call};\n  return;` : `return ${call};`;
    return `${declaration} {
  ${body}
}`;
  }).join("\n\n");
  return `@interface ${adapter} : NSObject <${protocols}> {
@public
  ${ownerType} *_z_owner;
}
- (instancetype)initWithOwner:(${ownerType} *)owner;
${declarations}
@end

@implementation ${adapter}
- (instancetype)initWithOwner:(${ownerType} *)owner {
  self = [super init];
  if (self != nil) {
    _z_owner = ${retainName(owner.name)}(owner);
  }
  return self;
}

${implementations}

- (void)dealloc {
  ${releaseName(owner.name)}(_z_owner);
}
@end`;
}

function collectExplicitCopyTypes(
  semanticInfo: SemanticInfo,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
): string[] {
  const collected = new Set<string>();
  const visit = (type: string): void => {
    const dynamic = parseDynamicArrayType(type);
    const fixed = parseFixedArrayType(type);
    const declaration = structs.get(type);
    const enumeration = enums.get(type);
    if (!dynamic && !fixed && declaration?.kind !== "struct" && !enumeration) return;
    if (collected.has(type)) return;
    collected.add(type);
    if (dynamic) visit(dynamic.elementType);
    else if (fixed) visit(fixed.elementType);
    else if (declaration) for (const field of declaration.fields) visit(field.type.name);
    else for (const variant of enumeration!.variants) if (variant.payload) visit(variant.payload.name);
  };
  for (const plan of semanticInfo.explicitCopies.values()) {
    if (plan.kind === "aggregate") visit(plan.type);
  }
  return [...collected];
}

function explicitCopyName(type: string): string {
  return `z_copy_${nativeSymbolPart(type)}`;
}

function generateExplicitCopySignature(
  type: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const cType = mapType(type, structs, enums, foreignNamedTypes);
  return `static ${cType} ${explicitCopyName(type)}(${cType} source)`;
}

function explicitCopyValue(
  value: string,
  type: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
): string {
  if (type === "String") return `z_string_copy(${value})`;
  if (
    parseDynamicArrayType(type)
    || parseFixedArrayType(type)
    || structs.get(type)?.kind === "struct"
    || enums.has(type)
  ) return `${explicitCopyName(type)}(${value})`;
  return value;
}

function generateExplicitCopy(
  type: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const signature = generateExplicitCopySignature(type, structs, enums, foreignNamedTypes);
  const dynamic = parseDynamicArrayType(type);
  if (dynamic) {
    const cType = mapType(type, structs, enums, foreignNamedTypes);
    const elementType = mapType(dynamic.elementType, structs, enums, foreignNamedTypes);
    const copied = explicitCopyValue("source.data[index]", dynamic.elementType, structs, enums);
    return `${signature} {
  ${cType} result = { NULL, 0, 0 };
  if (source.length == 0) return result;
  if (source.length > SIZE_MAX / sizeof(${elementType})) abort();
  result.data = (${elementType} *)malloc(sizeof(${elementType}) * source.length);
  if (result.data == NULL) abort();
  result.length = source.length;
  result.capacity = source.length;
  for (uintptr_t index = 0; index < source.length; index += 1) {
    result.data[index] = ${copied};
  }
  return result;
}`;
  }
  const fixed = parseFixedArrayType(type);
  if (fixed) {
    const cType = mapType(type, structs, enums, foreignNamedTypes);
    const copied = explicitCopyValue("source.data[index]", fixed.elementType, structs, enums);
    return `${signature} {
  ${cType} result = { 0 };
  for (uintptr_t index = 0; index < ${fixed.length}; index += 1) {
    result.data[index] = ${copied};
  }
  return result;
}`;
  }
  const declaration = structs.get(type);
  if (declaration?.kind === "struct") {
    if (declaration.fields.length === 0) return `${signature} { return source; }`;
    const fields = declaration.fields.map((field) => (
      `.${field.name} = ${explicitCopyValue(`source.${field.name}`, field.type.name, structs, enums)}`
    ));
    return `${signature} {
  return (${mapType(type, structs, enums, foreignNamedTypes)}){ ${fields.join(", ")} };
}`;
  }
  const enumeration = enums.get(type);
  if (enumeration) {
    if (nicheOptionPayload(enumeration, foreignNamedTypes)) return `${signature} { return source; }`;
    const cType = mapType(type, structs, enums, foreignNamedTypes);
    const cases = enumeration.variants.filter((variant) => variant.payload).map((variant) => (
      `    case ${variantTag(enumeration.name, variant.name)}:\n`
      + `      result.data.${variant.name} = ${explicitCopyValue(`source.data.${variant.name}`, variant.payload!.name, structs, enums)};\n`
      + "      break;"
    )).join("\n");
    return `${signature} {
  ${cType} result = { 0 };
  result.tag = source.tag;
  switch (source.tag) {
${cases}
    default:
      break;
  }
  return result;
}`;
  }
  throw new Error(`missing explicit copy lowering for ${type}`);
}

function generateStruct(
  declaration: StructDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const fieldLines = [
    ...(declaration.kind === "class" ? ["  size_t _z_refcount;", "  Z_WeakControl *_z_weak;"] : []),
    ...declaration.fields.map(
      (field) => `  ${mapType(field.type.name, structs, enums, foreignNamedTypes)} ${field.name};`,
    ),
  ];
  if (fieldLines.length === 0) fieldLines.push("  unsigned char _z_empty;");
  const fields = fieldLines.join("\n");
  return `struct ${structName(declaration.name)} {\n${fields}\n};`;
}

function generateWeakRuntime(): string {
  return `typedef struct Z_WeakControl {
  void *value;
  size_t weak_count;
} Z_WeakControl;

typedef struct Z_Weak {
  Z_WeakControl *control;
} Z_Weak;

static inline __attribute__((unused)) Z_Weak z_weak_retain(Z_Weak value) {
  if (value.control != NULL) value.control->weak_count += 1;
  return value;
}

static inline __attribute__((unused)) void z_weak_release(Z_Weak value) {
  if (value.control == NULL) return;
  value.control->weak_count -= 1;
  if (value.control->weak_count == 0) free(value.control);
}`;
}

function generateObjCBlockRuntime(): string {
  return `@interface Z_ObjCClosureBox : NSObject {
@public
  void *_z_context;
  void (*_z_release)(void *context);
}
- (instancetype)initWithContext:(void *)context
                  retainFunction:(void (*)(void *context))retainFunction
                 releaseFunction:(void (*)(void *context))releaseFunction;
@end

@implementation Z_ObjCClosureBox
- (instancetype)initWithContext:(void *)context
                  retainFunction:(void (*)(void *context))retainFunction
                 releaseFunction:(void (*)(void *context))releaseFunction {
  self = [super init];
  if (self != nil) {
    _z_context = context;
    _z_release = releaseFunction;
    if (retainFunction != NULL) retainFunction(context);
  }
  return self;
}

- (void)dealloc {
  if (_z_release != NULL) _z_release(_z_context);
}
@end`;
}

function collectFixedArrayTypes(program: Program, semanticInfo: SemanticInfo): string[] {
  const collected = new Set<string>();
  const add = (name: string): void => {
    const slice = parseSliceType(name);
    if (slice) {
      add(slice.elementType);
      return;
    }
    const array = parseFixedArrayType(name);
    if (!array || collected.has(name)) return;
    add(array.elementType);
    collected.add(name);
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "name" && typeof child === "string") add(child);
      else visit(child);
    }
  };
  visit(program);
  for (const type of semanticInfo.expressionTypes.values()) add(type);
  for (const type of semanticInfo.bindingTypes.values()) add(type);
  return [...collected];
}

function collectSliceTypes(program: Program, semanticInfo: SemanticInfo): string[] {
  const collected = new Set<string>();
  const add = (name: string): void => {
    const slice = parseSliceType(name);
    if (!slice || collected.has(name)) return;
    collected.add(name);
    add(slice.elementType);
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "name" && typeof child === "string") add(child);
      else visit(child);
    }
  };
  visit(program);
  for (const type of semanticInfo.expressionTypes.values()) add(type);
  for (const type of semanticInfo.bindingTypes.values()) add(type);
  for (const conversion of semanticInfo.sliceConversions.values()) add(conversion.targetType);
  for (const name of semanticInfo.standardFunctionReferences.values()) {
    const signature = standardFunctionSignature(name);
    for (const parameter of signature.parameters) add(parameter.type);
    add(signature.returnType);
  }
  return [...collected];
}

function collectDynamicArrayTypes(program: Program, semanticInfo: SemanticInfo): string[] {
  const collected = new Set<string>();
  const add = (name: string): void => {
    const dynamic = parseDynamicArrayType(name);
    if (!dynamic || collected.has(name)) return;
    add(dynamic.elementType);
    collected.add(name);
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "name" || key === "elementType") && typeof child === "string") add(child);
      else visit(child);
    }
  };
  visit(program);
  for (const type of semanticInfo.expressionTypes.values()) add(type);
  for (const type of semanticInfo.bindingTypes.values()) add(type);
  for (const name of semanticInfo.standardFunctionReferences.values()) {
    const signature = standardFunctionSignature(name);
    for (const parameter of signature.parameters) add(parameter.type);
    add(signature.returnType);
  }
  return [...collected];
}

function collectFunctionTypes(program: Program, semanticInfo: SemanticInfo): FunctionType[] {
  const collected = new Map<string, FunctionType>();
  const add = (name: string): void => {
    const functionType = parseFunctionType(name);
    if (!functionType) return;
    collected.set(functionTypeAbiKey(functionType), functionType);
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (typeof child === "string") add(child);
      else visit(child);
    }
  };
  visit(program);
  for (const type of semanticInfo.expressionTypes.values()) add(type);
  for (const type of semanticInfo.bindingTypes.values()) add(type);
  for (const plan of semanticInfo.foreignCallArgumentPlans.values()) {
    for (const argument of plan) {
      if (argument.kind === "callback" || argument.kind === "context" || argument.kind === "release") {
        add(argument.functionType);
      }
    }
  }
  return [...collected.values()].sort((left, right) => functionTypeCName(left).localeCompare(functionTypeCName(right)));
}

function collectForeignCallbackAdapters(semanticInfo: SemanticInfo): Extract<ForeignCallArgumentPlan, { kind: "callback" }>[] {
  const collected = new Map<string, Extract<ForeignCallArgumentPlan, { kind: "callback" }>>();
  for (const plan of semanticInfo.foreignCallArgumentPlans.values()) {
    for (const argument of plan) {
      if (argument.kind !== "callback") continue;
      const name = foreignCallbackAdapterName(argument);
      const existing = collected.get(name);
      if (!existing || argument.callback.lifetime === "escape") collected.set(name, argument);
    }
  }
  return [...collected.values()].sort((left, right) => (
    foreignCallbackAdapterName(left).localeCompare(foreignCallbackAdapterName(right))
  ));
}

function collectForeignEscapeHelpers(
  adapters: readonly Extract<ForeignCallArgumentPlan, { kind: "callback" }>[],
): Extract<ForeignCallArgumentPlan, { kind: "callback" }>[] {
  const collected = new Map<string, Extract<ForeignCallArgumentPlan, { kind: "callback" }>>();
  for (const adapter of adapters) {
    if (adapter.callback.lifetime !== "escape") continue;
    collected.set(foreignCallbackBoxName(adapter), adapter);
  }
  return [...collected.values()];
}

function foreignCallbackBoxName(plan: Extract<ForeignCallArgumentPlan, { kind: "callback" | "context" | "release" }>): string {
  return `${functionTypeCName(parseFunctionType(plan.functionType)!)}_c_escape_box`;
}

function foreignCallbackBoxReleaseName(plan: Extract<ForeignCallArgumentPlan, { kind: "callback" | "context" | "release" }>): string {
  return `${foreignCallbackBoxName(plan)}_release`;
}

function generateForeignEscapeHelpers(plan: Extract<ForeignCallArgumentPlan, { kind: "callback" }>): string {
  const functionType = parseFunctionType(plan.functionType)!;
  const type = functionTypeCName(functionType);
  return `static __attribute__((unused)) void *${foreignCallbackBoxName(plan)}(${type} value) {
  ${type} *boxed = (${type} *)malloc(sizeof(${type}));
  if (boxed == NULL) abort();
  *boxed = ${functionTypeRetainName(functionType)}(value);
  return boxed;
}

static __attribute__((unused)) void ${foreignCallbackBoxReleaseName(plan)}(void *context) {
  ${type} *boxed = (${type} *)context;
  if (boxed == NULL) return;
  ${functionTypeReleaseName(functionType)}(*boxed);
  free(boxed);
}`;
}

function foreignCallbackAdapterName(plan: Extract<ForeignCallArgumentPlan, { kind: "callback" }>): string {
  const functionType = parseFunctionType(plan.functionType)!;
  return `__z_c_callback_${functionTypeCName(functionType)}_context_${plan.callback.context!.callbackParameter}`;
}

function generateForeignCallbackAdapter(plan: Extract<ForeignCallArgumentPlan, { kind: "callback" }>): string {
  const functionType = parseFunctionType(plan.functionType)!;
  const callback = plan.callback;
  const contextIndex = callback.context!.callbackParameter;
  const nativeParameters: string[] = [];
  const argumentNames: string[] = [];
  let visibleIndex = 0;
  for (let nativeIndex = 0; nativeIndex < callback.parameters.length + 1; nativeIndex += 1) {
    if (nativeIndex === contextIndex) {
      nativeParameters.push("void *callback_context");
      continue;
    }
    const name = `argument${visibleIndex + 1}`;
    nativeParameters.push(`${callback.parameters[visibleIndex].cName} ${name}`);
    argumentNames.push(name);
    visibleIndex += 1;
  }
  const functionName = foreignCallbackAdapterName(plan);
  const functionValue = `((${functionTypeCName(functionType)} *)callback_context)`;
  const invoke = `${functionValue}->call(${functionValue}->context${argumentNames.length ? `, ${argumentNames.join(", ")}` : ""})`;
  const body = functionType.returnType === "void" ? `${invoke};\n  return;` : `return ${invoke};`;
  return `static __attribute__((unused)) ${callback.returnType.cName} ${functionName}(${nativeParameters.join(", ") || "void"}) {
  ${body}
}`;
}

function generateFunctionTypeDefinition(
  functionType: FunctionType,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const parameters = generateFunctionTypeParameters(functionType, structs, enums, foreignNamedTypes);
  const result = mapType(functionType.returnType, structs, enums, foreignNamedTypes);
  const name = functionTypeCName(functionType);
  const callParameters = ["void *context", ...parameters].join(", ");
  return `typedef struct ${name} ${name};
struct ${name} {
  ${result} (*call)(${callParameters});
  void *context;
  void (*retain)(void *context);
  void (*release)(void *context);
};

static inline __attribute__((unused)) ${name} ${functionTypeRetainName(functionType)}(${name} value) {
  if (value.retain != NULL) value.retain(value.context);
  return value;
}

static inline __attribute__((unused)) void ${functionTypeReleaseName(functionType)}(${name} value) {
  if (value.release != NULL) value.release(value.context);
}`;
}

function generateObjCConnectionRuntime(): string {
  const functionType: FunctionType = { parameters: [], returnType: "void" };
  const functionName = functionTypeCName(functionType);
  const releaseName = functionTypeReleaseName(functionType);
  return `@interface ZObjCConnection : NSObject {
@public
  ${functionName} _z_operation;
  id _z_control;
}
- (instancetype)initWithControl:(id)control operation:(${functionName})operation;
- (void)z_invoke:(id)sender;
@end

@implementation ZObjCConnection
- (instancetype)initWithControl:(id)control operation:(${functionName})operation {
  self = [super init];
  if (self != nil) {
    _z_operation = operation;
    _z_control = control;
    [_z_control setTarget:self];
    [_z_control setAction:@selector(z_invoke:)];
  }
  return self;
}

- (void)z_invoke:(id)sender {
  (void)sender;
  _z_operation.call(_z_operation.context);
}

- (void)dealloc {
  if ([_z_control target] == self) {
    [_z_control setTarget:nil];
    [_z_control setAction:NULL];
  }
  ${releaseName}(_z_operation);
}
@end

static inline __attribute__((unused)) ZObjCConnection *z_objc_connect(id control, ${functionName} operation) {
  return [[ZObjCConnection alloc] initWithControl:control operation:operation];
}`;
}

function generateObjCBindingRuntime(): string {
  return `@interface ZObjCBinding : NSObject {
@public
  id _z_object;
  NSArray *_z_adapters;
}
- (instancetype)initWithObject:(id)object adapters:(NSArray *)adapters;
@end

@implementation ZObjCBinding
- (instancetype)initWithObject:(id)object adapters:(NSArray *)adapters {
  self = [super init];
  if (self != nil) {
    _z_object = object;
    _z_adapters = adapters;
  }
  return self;
}
@end`;
}

function objcBindingHelperName(offset: number): string {
  return `z_objc_bind_${offset}`;
}

function generateObjCBindingHelper(
  offset: number,
  plan: ObjCBindingPlan,
  semanticInfo: SemanticInfo,
): string {
  const object = semanticInfo.foreignObjectTypes.get(plan.objectType);
  if (!object) throw new Error(`missing Objective-C object type ${JSON.stringify(plan.objectType)} for objc.bind`);
  const owners = new Map<string, { readonly type: string; readonly name: string }>();
  for (const binding of plan.bindings) {
    if (binding.ownerExpression.kind !== "identifier") throw new Error("objc.bind owner must be an identifier");
    owners.set(`${binding.ownerType}:${binding.ownerExpression.name}`, {
      type: binding.ownerType,
      name: binding.ownerExpression.name,
    });
  }
  const parameters = [
    `${object.cName} object`,
    ...[...owners.values()].map((owner) => `${structName(owner.type)} *${cBindingName(owner.name)}`),
  ];
  const adapters = new Map<string, string>();
  const lines: string[] = [];
  for (const owner of owners.values()) {
    const key = `${owner.type}:${owner.name}`;
    const adapter = `_z_adapter_${adapters.size}`;
    adapters.set(key, adapter);
    lines.push(`${objcProtocolAdapterName(owner.type)} *${adapter} = [[${objcProtocolAdapterName(owner.type)} alloc] initWithOwner:${cBindingName(owner.name)}];`);
  }
  for (const binding of plan.bindings) {
    if (binding.ownerExpression.kind !== "identifier") continue;
    const adapter = adapters.get(`${binding.ownerType}:${binding.ownerExpression.name}`)!;
    lines.push(`[object ${binding.property.setter}${adapter}];`);
  }
  lines.push(`return [[ZObjCBinding alloc] initWithObject:object adapters:@[${[...adapters.values()].join(", ")}]];`);
  return `static ZObjCBinding *${objcBindingHelperName(offset)}(${parameters.join(", ")}) {
${indent(lines.join("\n"), 2)}
}`;
}

function generateFunctionTypeParameters(
  functionType: FunctionType,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string[] {
  return functionType.parameters.map((parameter) => {
    const name = cBindingName(parameter.name);
    const type = mapType(parameter.type, structs, enums, foreignNamedTypes);
    if (parseSliceType(parameter.type)) return `${type} ${name}`;
    if (parameter.type === "TaskScope") {
      if (parameter.mode === "inout" || parameter.mode === "out") return `${type} *${name}`;
      return `${type} ${name}`;
    }
    const aggregate = structs.get(parameter.type);
    if (foreignNamedTypes.get(parameter.type)?.kind === "object") {
      if (parameter.mode === "inout" || parameter.mode === "out") return `${type} *${name}`;
      return `${type}${name}`;
    }
    if (aggregate?.kind === "class") {
      if (parameter.mode === "in") return `const ${structName(aggregate.name)} *${name}`;
      if (parameter.mode === "inout" || parameter.mode === "out") return `${structName(aggregate.name)} **${name}`;
      return `${type}${name}`;
    }
    if (parameter.mode === "in") return `const ${type} *${name}`;
    if (parameter.mode === "inout" || parameter.mode === "out") return `${type} *${name}`;
    return `${type} ${name}`;
  });
}

export function functionTypeCName(functionType: FunctionType): string {
  let hash = 14695981039346656037n;
  for (const character of functionTypeAbiKey(functionType)) {
    hash ^= BigInt(character.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return `Z_Function_${hash.toString(16).padStart(16, "0")}`;
}

function functionTypeRetainName(functionType: FunctionType): string {
  return `${functionTypeCName(functionType)}_retain`;
}

function functionTypeReleaseName(functionType: FunctionType): string {
  return `${functionTypeCName(functionType)}_release`;
}

function declarationFunctionType(declaration: FunctionDeclaration, skipParameters = 0): FunctionType {
  return {
    parameters: declaration.parameters.slice(skipParameters).map((parameter) => ({
      name: parameter.name,
      mode: parameter.mode,
      type: parameter.type.name,
    })),
    returnType: declaration.returnType.name,
  };
}

export function closureFunctionType(closure: ClosureInfo): FunctionType {
  return declarationFunctionType(closure.declaration, closure.captures.length);
}

function functionAdapterName(name: string): string {
  return `__z_function_adapter_${nativeSymbolPart(name)}`;
}

function standardFunctionAdapterName(name: StandardFunctionName): string {
  return `__z_standard_function_adapter_${nativeSymbolPart(name)}`;
}

export function closureAdapterName(closure: ClosureInfo): string {
  return `${closure.declaration.name}_adapter`;
}

export function closureEnvironmentName(closure: ClosureInfo): string {
  return `Z_ClosureEnv_${closure.declaration.location.offset}`;
}

export function closureEnvironmentRetainName(closure: ClosureInfo): string {
  return `${closureEnvironmentName(closure)}_retain`;
}

export function closureEnvironmentReleaseName(closure: ClosureInfo): string {
  return `${closureEnvironmentName(closure)}_release`;
}

export function functionValueLiteral(
  functionType: FunctionType,
  call: string,
  context = "NULL",
  retain = "NULL",
  release = "NULL",
): string {
  return `(${functionTypeCName(functionType)}){ .call = ${call}, .context = ${context}, .retain = ${retain}, .release = ${release} }`;
}

function generateFunctionAdapter(
  declaration: FunctionDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const type = declarationFunctionType(declaration);
  const parameters = generateFunctionTypeParameters(type, structs, enums, foreignNamedTypes);
  const names = type.parameters.map((parameter) => {
    const name = cBindingName(parameter.name);
    return parameter.mode === "value" && requiresNativeMove(parameter.type, structs, enums, foreignNamedTypes)
      ? `std::move(${name})`
      : name;
  });
  const result = mapType(type.returnType, structs, enums, foreignNamedTypes);
  const invoke = `${declaration.name}(${names.join(", ") || ""})`;
  const returned = type.returnType === "void" ? `${invoke};\n  return;` : `return ${invoke};`;
  return `static __attribute__((unused)) ${result} ${functionAdapterName(declaration.name)}(void *context${parameters.length ? `, ${parameters.join(", ")}` : ""}) {
  (void)context;
  ${returned}
}`;
}

function generateStandardFunctionAdapter(
  name: StandardFunctionName,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const signature = standardFunctionSignature(name);
  const functionType: FunctionType = {
    parameters: signature.parameters,
    returnType: signature.returnType,
  };
  const parameters = generateFunctionTypeParameters(functionType, structs, enums, foreignNamedTypes);
  const names = signature.parameters.map((parameter) => (
    parameter.abi === "value" && parameter.mode === "in"
      ? `*${cBindingName(parameter.name)}`
      : cBindingName(parameter.name)
  ));
  const invoke = `${signature.cName}(${names.join(", ")})`;
  const effectiveReturnType = signature.errorType
    ? resultTypeName(signature.returnType, signature.errorType)
    : signature.returnType;
  const returned = effectiveReturnType === "void" ? `${invoke};\n  return;` : `return ${invoke};`;
  return `static __attribute__((unused)) ${mapType(effectiveReturnType, structs, enums, foreignNamedTypes)} ${standardFunctionAdapterName(name)}(void *context${parameters.length ? `, ${parameters.join(", ")}` : ""}) {
  (void)context;
  ${returned}
}`;
}

function generateClosureAdapter(
  closure: ClosureInfo,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const type = closureFunctionType(closure);
  const parameters = generateFunctionTypeParameters(type, structs, enums, foreignNamedTypes);
  const visible = type.parameters.map((parameter) => cBindingName(parameter.name));
  const prefix: string[] = [];
  const hidden = closure.captures.map((capture) => {
    const stored = `environment->${capture.name}`;
    if (!closure.owned) return stored;
    if (capture.mode === "value") return stored;
    if (capture.mode === "in" && closureCaptureHasReferenceIdentity(capture.type, structs, foreignNamedTypes)) return stored;
    return `&(${stored})`;
  });
  if (closure.captures.length > 0) {
    prefix.push(`${closureEnvironmentName(closure)} *environment = (${closureEnvironmentName(closure)} *)context;`);
  } else {
    prefix.push("(void)context;");
  }
  const invoke = `${closure.declaration.name}(${[...hidden, ...visible].join(", ")})`;
  const returned = type.returnType === "void" ? `${invoke};\n  return;` : `return ${invoke};`;
  return `${generateClosureAdapterSignature(closure, structs, enums, foreignNamedTypes)} {
  ${prefix.join("\n  ")}
  ${returned}
}`;
}

function generateClosureAdapterSignature(
  closure: ClosureInfo,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const type = closureFunctionType(closure);
  const parameters = generateFunctionTypeParameters(type, structs, enums, foreignNamedTypes);
  return `static ${mapType(type.returnType, structs, enums, foreignNamedTypes)} ${closureAdapterName(closure)}(void *context${parameters.length ? `, ${parameters.join(", ")}` : ""})`;
}

function generateClosureEnvironmentDefinition(
  closure: ClosureInfo,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  semanticInfo: SemanticInfo,
): string {
  const name = closureEnvironmentName(closure);
  const fields = closure.captures.map((capture) => {
    const type = mapType(capture.type, structs, enums, semanticInfo.foreignNamedTypes);
    const borrowedPointer = !closure.owned
      && capture.mode !== "value"
      && !(capture.mode === "in" && closureCaptureHasReferenceIdentity(capture.type, structs, semanticInfo.foreignNamedTypes));
    if (borrowedPointer) {
      return `  ${capture.mode === "in" ? "const " : ""}${type} *${capture.name};`;
    }
    return `  ${type} ${capture.name};`;
  });
  return `typedef struct ${name} {
${closure.owned ? "  size_t refcount;\n" : ""}
${fields.join("\n")}
} ${name};`;
}

function generateClosureEnvironmentLifecycle(
  closure: ClosureInfo,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  semanticInfo: SemanticInfo,
): string {
  const name = closureEnvironmentName(closure);
  const cleanupCounter = { value: 0 };
  const cleanup = [...closure.captures].reverse().map((capture) => (
    generateOwnedEnvironmentCleanup(`environment->${capture.name}`, capture.type, structs, enums, semanticInfo, cleanupCounter)
  )).filter(Boolean).map((line) => indent(line, 4));
  const retain = closure.threadSafe
    ? "__atomic_add_fetch(&environment->refcount, 1, __ATOMIC_RELAXED);"
    : "environment->refcount += 1;";
  const release = closure.threadSafe
    ? "if (__atomic_sub_fetch(&environment->refcount, 1, __ATOMIC_ACQ_REL) != 0) return;"
    : `environment->refcount -= 1;
  if (environment->refcount != 0) return;`;
  return `static void ${closureEnvironmentRetainName(closure)}(void *context) {
  ${name} *environment = (${name} *)context;
  ${retain}
}

static void ${closureEnvironmentReleaseName(closure)}(void *context) {
  ${name} *environment = (${name} *)context;
  ${release}
  {
${cleanup.join("\n")}${cleanup.length ? "\n" : ""}    free(environment);
  }
}`;
}

function generateOwnedEnvironmentCleanup(
  value: string,
  type: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  semanticInfo: SemanticInfo,
  counter: { value: number },
): string {
  if (parseGeneratorType(type)) return `${generatorDeinitName(type)}(&(${value}));`;
  if (type === "String" || type === "TextBuffer") return `if ((${value}).capacity > 0) free((void *)(${value}).data);`;
  if (type === "Arena") return `z_arena_reset(&(${value}));`;
  if (type === "TaskScope") return `z_task_scope_release(${value});`;
  if (parseWeakType(type)) return `z_weak_release(${value});`;
  const functionType = parseFunctionType(type);
  if (functionType) return `${functionTypeReleaseName(functionType)}(${value});`;
  const dynamic = parseDynamicArrayType(type);
  if (dynamic) {
    const lines: string[] = [];
    if (requiresNativeMove(dynamic.elementType, structs, enums, semanticInfo.foreignNamedTypes)) {
      const index = `_z_environment_index_${counter.value++}`;
      const element = `(${value}).data[${index} - 1]`;
      const managedCleanup = hasSemanticCleanupType(dynamic.elementType, structs, enums, semanticInfo)
        ? `${generateOwnedEnvironmentCleanup(element, dynamic.elementType, structs, enums, semanticInfo, counter)}\n`
        : "";
      lines.push(`for (uintptr_t ${index} = (${value}).length; ${index} > 0; ${index} -= 1) {\n${indent(`${managedCleanup}std::destroy_at(&${element});`, 2)}\n}`);
      lines.push(`::operator delete((${value}).data);`);
      return lines.join("\n");
    }
    if (hasSemanticCleanupType(dynamic.elementType, structs, enums, semanticInfo)) {
      const index = `_z_environment_index_${counter.value++}`;
      const nested = generateOwnedEnvironmentCleanup(`(${value}).data[${index} - 1]`, dynamic.elementType, structs, enums, semanticInfo, counter);
      lines.push(`for (uintptr_t ${index} = (${value}).length; ${index} > 0; ${index} -= 1) {\n${indent(nested, 2)}\n}`);
    }
    lines.push(`free((${value}).data);`);
    return lines.join("\n");
  }
  const array = parseFixedArrayType(type);
  if (array) {
    if (!hasSemanticCleanupType(array.elementType, structs, enums, semanticInfo)) return "";
    const index = `_z_environment_index_${counter.value++}`;
    const nested = generateOwnedEnvironmentCleanup(`(${value}).data[${index} - 1]`, array.elementType, structs, enums, semanticInfo, counter);
    return `for (uintptr_t ${index} = ${array.length}; ${index} > 0; ${index} -= 1) {\n${indent(nested, 2)}\n}`;
  }
  const enumDeclaration = enums.get(type);
  if (enumDeclaration) {
    const niche = nicheOptionPayload(enumDeclaration, semanticInfo.foreignNamedTypes);
    const foreign = niche ? semanticInfo.foreignTypes.get(niche) : null;
    if (foreign?.ownership === "owned") {
      return `if (${value} != NULL) ${foreign.release}(${value});`;
    }
    if (niche) return "";
    const cases = enumDeclaration.variants.flatMap((variant) => {
      if (!variant.payload || !hasSemanticCleanupType(variant.payload.name, structs, enums, semanticInfo)) return [];
      const payloadCleanup = generateOwnedEnvironmentCleanup(
        `(${value}).data.${variant.name}`,
        variant.payload.name,
        structs,
        enums,
        semanticInfo,
        counter,
      );
      return [`case ${variantTag(type, variant.name)}:\n${indent(payloadCleanup, 2)}\n  break;`];
    });
    return `switch ((${value}).tag) {\n${indent(cases.join("\n"), 2)}\n  default:\n    break;\n}`;
  }
  const foreign = semanticInfo.foreignTypes.get(type);
  if (foreign?.ownership === "owned") {
    return foreign.nullable ? `if (${value} != NULL) ${foreign.release}(${value});` : `${foreign.release}(${value});`;
  }
  if (semanticInfo.foreignNamedTypes.get(type)?.kind === "object") return `${value} = nil;`;
  const declaration = structs.get(type);
  if (declaration?.kind === "class") return `${releaseName(type)}(${value});`;
  if (declaration && hasSemanticCleanupType(type, structs, enums, semanticInfo)) return `${deinitName(type)}(&(${value}));`;
  return "";
}

function programUsesIndex(program: Program): boolean {
  let found = false;
  const visit = (value: unknown): void => {
    if (found || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if ((value as { readonly kind?: string }).kind === "index") {
      found = true;
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(program);
  return found;
}

function programUsesString(program: Program, semanticInfo: SemanticInfo): boolean {
  if ([...semanticInfo.standardTypeBindings.values()].includes("TextBuffer")) return true;
  if (
    [...semanticInfo.expressionTypes.values(), ...semanticInfo.bindingTypes.values()]
      .some((type) => type === "String" || type === "TextBuffer")
  ) return true;
  let found = false;
  const visit = (value: unknown, directConsoleTemplate = false): void => {
    if (found || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, directConsoleTemplate);
      return;
    }
    const node = value as Partial<Expression> & { readonly name?: string };
    if (node.kind === "string" || (node.kind === "template" && !directConsoleTemplate) || node.name === "String" || node.name === "TextBuffer") {
      found = true;
      return;
    }
    if (
      node.kind === "call"
      && node.location
      && semanticInfo.consoleCalls.has(node.location.offset)
    ) {
      visit(node.callee);
      for (const argument of node.arguments ?? []) visit(argument, argument.kind === "template");
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(program);
  return found;
}

function generateStringRuntime(): string {
  return `#if defined(__GNUC__) || defined(__clang__)
#define Z_UNUSED_FUNCTION __attribute__((unused))
#else
#define Z_UNUSED_FUNCTION
#endif

typedef struct {
  const char *data;
  uintptr_t length;
  uintptr_t capacity;
} Z_String;

static Z_UNUSED_FUNCTION inline Z_String z_string_new(void) {
  Z_String value = { NULL, 0, 0 };
  return value;
}

static Z_UNUSED_FUNCTION inline bool z_string_equal(Z_String left, Z_String right) {
  if (left.length != right.length) return false;
  if (left.length == 0) return true;
  return memcmp(left.data, right.data, left.length) == 0;
}

static Z_UNUSED_FUNCTION inline void z_string_reserve(Z_String *self, uintptr_t additional) {
  if (additional > SIZE_MAX - self->length - 1) abort();
  uintptr_t required = self->length + additional + 1;
  if (required <= self->capacity) return;
  uintptr_t next = self->capacity == 0 ? 32 : self->capacity;
  while (next < required) {
    if (next > SIZE_MAX / 2) {
      next = required;
      break;
    }
    next *= 2;
  }
  void *storage;
  if (self->capacity == 0 && self->data != NULL) {
    storage = malloc(next);
    if (storage != NULL) memcpy(storage, self->data, self->length);
  } else {
    storage = realloc((void *)self->data, next);
  }
  if (storage == NULL) abort();
  self->data = (char *)storage;
  self->capacity = next;
}

static Z_UNUSED_FUNCTION inline void z_string_append_bytes(Z_String *self, const char *data, uintptr_t length) {
  if (length == 0) return;
  z_string_reserve(self, length);
  memcpy((char *)self->data + self->length, data, length);
  self->length += length;
  ((char *)self->data)[self->length] = '\\0';
}

static Z_UNUSED_FUNCTION inline bool z_string_is_valid_utf8(const char *data, uintptr_t length) {
  uintptr_t index = 0;
  while (index < length) {
    const uint8_t first = (uint8_t)data[index];
    if (first <= 0x7Fu) {
      index += 1;
      continue;
    }
    if (first >= 0xC2u && first <= 0xDFu) {
      if (index + 1 >= length || ((uint8_t)data[index + 1] & 0xC0u) != 0x80u) return false;
      index += 2;
      continue;
    }
    if (first >= 0xE0u && first <= 0xEFu) {
      if (index + 2 >= length) return false;
      const uint8_t second = (uint8_t)data[index + 1];
      const uint8_t third = (uint8_t)data[index + 2];
      if ((third & 0xC0u) != 0x80u) return false;
      if (first == 0xE0u ? second < 0xA0u || second > 0xBFu
          : first == 0xEDu ? second < 0x80u || second > 0x9Fu
          : (second & 0xC0u) != 0x80u) return false;
      index += 3;
      continue;
    }
    if (first >= 0xF0u && first <= 0xF4u) {
      if (index + 3 >= length) return false;
      const uint8_t second = (uint8_t)data[index + 1];
      const uint8_t third = (uint8_t)data[index + 2];
      const uint8_t fourth = (uint8_t)data[index + 3];
      if ((third & 0xC0u) != 0x80u || (fourth & 0xC0u) != 0x80u) return false;
      if (first == 0xF0u ? second < 0x90u || second > 0xBFu
          : first == 0xF4u ? second < 0x80u || second > 0x8Fu
          : (second & 0xC0u) != 0x80u) return false;
      index += 4;
      continue;
    }
    return false;
  }
  return true;
}

static Z_UNUSED_FUNCTION inline void z_string_append_cstring(Z_String *self, const char *value) {
  if (value == NULL) {
    z_string_append_bytes(self, "null", 4);
    return;
  }
  const uintptr_t length = (uintptr_t)strlen(value);
  if (!z_string_is_valid_utf8(value, length)) abort();
  z_string_append_bytes(self, value, length);
}

static Z_UNUSED_FUNCTION inline Z_String z_string_from_cstring(const char *value) {
  if (value == NULL) abort();
  const uintptr_t length = (uintptr_t)strlen(value);
  if (!z_string_is_valid_utf8(value, length)) abort();
  Z_String result = z_string_new();
  z_string_append_bytes(&result, value, length);
  return result;
}

static Z_UNUSED_FUNCTION inline uint8_t z_string_byte_at(Z_String value, uintptr_t index) {
  if (index >= value.length) abort();
  return (uint8_t)value.data[index];
}

static Z_UNUSED_FUNCTION inline bool z_string_is_utf8_boundary(Z_String value, uintptr_t index) {
  return index == 0 || index == value.length || (((uint8_t)value.data[index] & 0xC0u) != 0x80u);
}

static Z_UNUSED_FUNCTION inline Z_String z_string_copy_bytes(Z_String value, uintptr_t start, uintptr_t end) {
  if (start > end || end > value.length) abort();
  if (!z_string_is_utf8_boundary(value, start) || !z_string_is_utf8_boundary(value, end)) abort();
  Z_String result = z_string_new();
  const char *bytes = value.data != NULL ? value.data + start : "";
  z_string_append_bytes(&result, bytes, end - start);
  return result;
}

static Z_UNUSED_FUNCTION inline Z_String z_string_copy(Z_String value) {
  return z_string_copy_bytes(value, 0, value.length);
}

static Z_UNUSED_FUNCTION inline void z_text_buffer_append(Z_String *self, Z_String value) {
  z_string_append_bytes(self, value.data != NULL ? value.data : "", value.length);
}

static Z_UNUSED_FUNCTION inline void z_text_buffer_append_bytes(Z_String *self, Z_String value, uintptr_t start, uintptr_t end) {
  if (start > end || end > value.length) abort();
  if (!z_string_is_utf8_boundary(value, start) || !z_string_is_utf8_boundary(value, end)) abort();
  const char *bytes = value.data != NULL ? value.data + start : "";
  z_string_append_bytes(self, bytes, end - start);
}

static Z_UNUSED_FUNCTION inline void z_text_buffer_append_ascii(Z_String *self, uint8_t byte) {
  if (byte > 0x7Fu) abort();
  const char value = (char)byte;
  z_string_append_bytes(self, &value, 1);
}

static Z_UNUSED_FUNCTION inline void z_string_append_signed(Z_String *self, long long value) {
  char buffer[32];
  int length = snprintf(buffer, sizeof(buffer), "%lld", value);
  if (length < 0) abort();
  z_string_append_bytes(self, buffer, (uintptr_t)length);
}

static Z_UNUSED_FUNCTION inline void z_string_append_unsigned(Z_String *self, unsigned long long value) {
  char buffer[32];
  int length = snprintf(buffer, sizeof(buffer), "%llu", value);
  if (length < 0) abort();
  z_string_append_bytes(self, buffer, (uintptr_t)length);
}

static Z_UNUSED_FUNCTION inline void z_string_append_float(Z_String *self, double value) {
  char buffer[64];
  int length = snprintf(buffer, sizeof(buffer), "%g", value);
  if (length < 0) abort();
  z_string_append_bytes(self, buffer, (uintptr_t)length);
}

static Z_UNUSED_FUNCTION inline void z_string_append_pointer(Z_String *self, const void *value) {
  char buffer[32];
  int length = snprintf(buffer, sizeof(buffer), "%p", value);
  if (length < 0) abort();
  z_string_append_bytes(self, buffer, (uintptr_t)length);
}`;
}

function generateObjCStringRuntime(): string {
  return `static Z_UNUSED_FUNCTION NSString *z_nsstring_from_string(Z_String value) {
  const void *bytes = value.data != NULL ? (const void *)value.data : (const void *)"";
  NSString *result = [[NSString alloc] initWithBytes:bytes length:(NSUInteger)value.length encoding:NSUTF8StringEncoding];
  if (result == nil) abort();
  return result;
}

static Z_UNUSED_FUNCTION Z_String z_string_from_nsstring(NSString *value) {
  if (value == nil) abort();
  const NSUInteger length = [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  const char *bytes = [value UTF8String];
  if (bytes == NULL && length != 0) abort();
  Z_String result = z_string_new();
  z_string_append_bytes(&result, bytes != NULL ? bytes : "", (uintptr_t)length);
  return result;
}`;
}

function generateSwiftStringRuntime(): string {
  return `static Z_UNUSED_FUNCTION Z_String z_string_from_swift(const swift::String& value) {
  const std::string bytes = static_cast<std::string>(value);
  Z_String result = z_string_new();
  z_string_append_bytes(&result, bytes.data(), (uintptr_t)bytes.size());
  return result;
}`;
}

function collectDynamicArrayPushTypes(program: Program, semanticInfo: SemanticInfo): string[] {
  const collected = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const expression = value as Partial<Expression>;
    if (expression.kind === "call" && expression.callee?.kind === "member" && expression.callee.property === "push") {
      const type = semanticInfo.expressionTypes.get(expression.callee.object.location.offset);
      if (type && parseDynamicArrayType(type)) collected.add(type);
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(program);
  const collectParameterReceivers = (declaration: FunctionDeclaration): void => {
    const parameterTypes = new Map(declaration.parameters.map((parameter) => [parameter.name, parameter.type.name]));
    const visitFunction = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visitFunction(item);
        return;
      }
      const expression = value as Partial<Expression>;
      if (
        expression.kind === "call"
        && expression.callee?.kind === "member"
        && expression.callee.property === "push"
        && expression.callee.object.kind === "identifier"
      ) {
        const type = parameterTypes.get(expression.callee.object.name);
        if (type && parseDynamicArrayType(type)) collected.add(type);
      }
      for (const child of Object.values(value as Record<string, unknown>)) visitFunction(child);
    };
    visitFunction(declaration.body);
  };
  for (const declaration of program.functions) collectParameterReceivers(declaration);
  for (const declaration of program.structs) {
    for (const method of declaration.methods) collectParameterReceivers(method);
  }
  for (const type of semanticInfo.dynamicArrayPushTypes) collected.add(type);
  return [...collected];
}

function generateAggregateDefinitions(
  declarations: StructDeclaration[],
  enumDeclarations: EnumDeclaration[],
  arrayTypes: string[],
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string[] {
  const lines: string[] = [];
  const definedStructs = new Set<string>();
  const definedEnums = new Set<string>();
  const definedArrays = new Set<string>();
  const emitDependency = (name: string): void => {
    if (parseFixedArrayType(name)) {
      emitArray(name);
      return;
    }
    const nestedStruct = structs.get(name);
    if (nestedStruct?.kind === "struct") {
      emitStruct(nestedStruct);
      return;
    }
    const nestedEnum = enums.get(name);
    if (nestedEnum) emitEnum(nestedEnum);
  };
  const emitArray = (name: string): void => {
    if (definedArrays.has(name)) return;
    definedArrays.add(name);
    const array = parseFixedArrayType(name)!;
    emitDependency(array.elementType);
    lines.push(generateFixedArray(name, array.elementType, array.length, structs, enums, foreignNamedTypes), "");
  };
  const emitStruct = (declaration: StructDeclaration): void => {
    if (definedStructs.has(declaration.name)) return;
    definedStructs.add(declaration.name);
    for (const field of declaration.fields) emitDependency(field.type.name);
    lines.push(generateStruct(declaration, structs, enums, foreignNamedTypes), "");
  };
  const emitEnum = (declaration: EnumDeclaration): void => {
    if (definedEnums.has(declaration.name)) return;
    definedEnums.add(declaration.name);
    for (const variant of declaration.variants) {
      if (variant.payload) emitDependency(variant.payload.name);
    }
    lines.push(generateEnum(declaration, structs, enums, foreignNamedTypes), "");
  };
  for (const declaration of declarations) emitStruct(declaration);
  for (const declaration of enumDeclarations) emitEnum(declaration);
  for (const type of arrayTypes) emitArray(type);
  return lines;
}

function generateFixedArray(
  name: string,
  elementType: string,
  length: number,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  return `struct ${arrayName(name)} {\n  ${mapType(elementType, structs, enums, foreignNamedTypes)} data[${length}];\n};`;
}

function generateDynamicArrayPush(
  name: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const dynamic = parseDynamicArrayType(name)!;
  const arrayType = dynamicArrayName(name);
  const elementType = mapType(dynamic.elementType, structs, enums, foreignNamedTypes);
  const mapEntry = parseMapEntryType(dynamic.elementType);
  if (mapEntry && requiresNativeMove(mapEntry.valueType, structs, enums, foreignNamedTypes)) {
    const keyType = mapType(mapEntry.keyType, structs, enums, foreignNamedTypes);
    return `static void ${dynamicArrayPushName(name)}(${arrayType} *self, ${elementType} value) {
  if (self->length == self->capacity) {
    uintptr_t next;
    if (self->capacity == 0) {
      next = 4;
    } else {
      if (self->capacity > SIZE_MAX / 2) abort();
      next = self->capacity * 2;
    }
    if (next > SIZE_MAX / sizeof(${elementType})) abort();
    ${elementType} *storage = static_cast<${elementType} *>(::operator new(next * sizeof(${elementType}), std::nothrow));
    if (storage == NULL) abort();
    for (uintptr_t index = 0; index < self->length; index += 1) {
      std::construct_at(&storage[index], ${elementType}{
        .key = self->data[index].key,
        .value = std::move(self->data[index].value),
      });
      self->data[index].key = ${keyType}{};
      std::destroy_at(&self->data[index]);
    }
    ::operator delete(self->data);
    self->data = storage;
    self->capacity = next;
  }
  std::construct_at(&self->data[self->length], std::move(value));
  self->length += 1;
}`;
  }
  if (requiresNativeMove(dynamic.elementType, structs, enums, foreignNamedTypes)) {
    return `static void ${dynamicArrayPushName(name)}(${arrayType} *self, ${elementType} value) {
  if (self->length == self->capacity) {
    uintptr_t next;
    if (self->capacity == 0) {
      next = 4;
    } else {
      if (self->capacity > SIZE_MAX / 2) abort();
      next = self->capacity * 2;
    }
    if (next > SIZE_MAX / sizeof(${elementType})) abort();
    ${elementType} *storage = static_cast<${elementType} *>(::operator new(next * sizeof(${elementType}), std::nothrow));
    if (storage == NULL) abort();
    for (uintptr_t index = 0; index < self->length; index += 1) {
      std::construct_at(&storage[index], std::move(self->data[index]));
    }
    for (uintptr_t index = self->length; index > 0; index -= 1) {
      std::destroy_at(&self->data[index - 1]);
    }
    ::operator delete(self->data);
    self->data = storage;
    self->capacity = next;
  }
  std::construct_at(&self->data[self->length], std::move(value));
  self->length += 1;
}`;
  }
  return `static void ${dynamicArrayPushName(name)}(${arrayType} *self, ${elementType} value) {
  if (self->length == self->capacity) {
    uintptr_t next;
    if (self->capacity == 0) {
      next = 4;
    } else {
      if (self->capacity > SIZE_MAX / 2) abort();
      next = self->capacity * 2;
    }
    if (next > SIZE_MAX / sizeof(${elementType})) abort();
    void *storage = realloc(self->data, next * sizeof(${elementType}));
    if (storage == NULL) abort();
    self->data = storage;
    self->capacity = next;
  }
  self->data[self->length] = value;
  self->length += 1;
}`;
}

function generateMapRuntime(
  name: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  semanticInfo: SemanticInfo,
): string {
  const map = parseMapType(name)!;
  const entryName = mapEntryTypeName(map.keyType, map.valueType);
  const entriesType = dynamicArrayTypeName(entryName);
  const mappedMap = mapType(name, structs, enums, semanticInfo.foreignNamedTypes);
  const mappedEntry = mapType(entryName, structs, enums, semanticInfo.foreignNamedTypes);
  const mappedKey = mapType(map.keyType, structs, enums, semanticInfo.foreignNamedTypes);
  const mappedValue = mapType(map.valueType, structs, enums, semanticInfo.foreignNamedTypes);
  const identityValue = mapValueHasReferenceIdentity(map.valueType, structs, semanticInfo);
  const lookupOption = optionTypeName(identityValue ? map.valueType : viewTypeName(map.valueType));
  const valueOption = optionTypeName(map.valueType);
  const mappedLookupOption = mapType(lookupOption, structs, enums, semanticInfo.foreignNamedTypes);
  const mappedValueOption = mapType(valueOption, structs, enums, semanticInfo.foreignNamedTypes);
  const lookupOptionDeclaration = enums.get(lookupOption)!;
  const valueOptionDeclaration = enums.get(valueOption)!;
  const nicheLookup = nicheOptionPayload(lookupOptionDeclaration, semanticInfo.foreignNamedTypes);
  const nicheValue = nicheOptionPayload(valueOptionDeclaration, semanticInfo.foreignNamedTypes);
  const nativeMoveValue = requiresNativeMove(map.valueType, structs, enums, semanticInfo.foreignNamedTypes);
  const nativeMoveEntry = requiresNativeMove(entryName, structs, enums, semanticInfo.foreignNamedTypes);
  const zKeyEnum = enums.get(map.keyType);
  const customKey = structs.get(map.keyType)?.implements.some((trait) => trait.name === "Hashable") ?? false;
  const equals = customKey
    ? `${methodName(map.keyType, "equals")}(&left, &right)`
    : map.keyType === "String"
    ? "z_string_equal(left, right)"
    : zKeyEnum?.variants.every((variant) => variant.payload === null)
      ? "left.tag == right.tag"
      : "left == right";
  const hashBody = customKey
    ? `Z_Hasher hasher = z_hasher_new();
  ${methodName(map.keyType, "hash")}(&value, &hasher);
  return z_hasher_finish(hasher);`
    : map.keyType === "String"
    ? `uint64_t hash = UINT64_C(14695981039346656037);
  for (uintptr_t index = 0; index < value.length; index += 1) {
    hash ^= (unsigned char)value.data[index];
    hash *= UINT64_C(1099511628211);
  }`
    : `uint64_t hash = (uint64_t)${zKeyEnum?.variants.every((variant) => variant.payload === null) ? "value.tag" : "value"};
  hash ^= hash >> 33;
  hash *= UINT64_C(0xff51afd7ed558ccd);
  hash ^= hash >> 33;
  hash *= UINT64_C(0xc4ceb9fe1a85ec53);
  hash ^= hash >> 33;`;
  const keyCleanup = generateOwnedEnvironmentCleanup(
    "key",
    map.keyType,
    structs,
    enums,
    semanticInfo,
    { value: 0 },
  );
  const storedValueCleanup = generateOwnedEnvironmentCleanup(
    "self->entries.data[index].value",
    map.valueType,
    structs,
    enums,
    semanticInfo,
    { value: 0 },
  );
  const storedKeyCleanup = generateOwnedEnvironmentCleanup(
    "self->entries.data[index].key",
    map.keyType,
    structs,
    enums,
    semanticInfo,
    { value: 0 },
  );
  const someValue = nativeMoveValue
    ? `${enumName(valueOption)}::make_some(std::move(self->entries.data[index].value))`
    : nicheValue
    ? "self->entries.data[index].value"
    : `(${mappedValueOption}){ .tag = ${variantTag(valueOption, "some")}, .data.some = self->entries.data[index].value }`;
  const noneValue = nativeMoveValue
    ? `${enumName(valueOption)}::make_none()`
    : nicheValue
    ? nicheOptionNull(nicheValue)
    : `(${mappedValueOption}){ .tag = ${variantTag(valueOption, "none")} }`;
  const cleanupLines = (source: string): string => source ? `${source}\n` : "";
  const replaceStoredValue = nativeMoveValue
    ? `std::destroy_at(&self->entries.data[index].value);\n      std::construct_at(&self->entries.data[index].value, std::move(value));`
    : "self->entries.data[index].value = value;";
  const insertedValue = nativeMoveValue ? "std::move(value)" : "value";
  const zeroKey = nativeMoveEntry
    ? `${mappedKey}{}`
    : mapZeroValue(map.keyType, structs, enums, semanticInfo.foreignNamedTypes);
  const resetStoredValue = nativeMoveValue
    ? ""
    : `    self->entries.data[index].value = ${mapZeroValue(map.valueType, structs, enums, semanticInfo.foreignNamedTypes)};\n`;
  const resetStoredEntry = nativeMoveEntry ? "" : `    self->entries.data[index] = (${mappedEntry}){ 0 };\n`;
  const eraseEntry = nativeMoveEntry
    ? `  if (index != last) {
    std::destroy_at(&self->entries.data[index]);
    std::construct_at(&self->entries.data[index], std::move(self->entries.data[last]));
    std::destroy_at(&self->entries.data[last]);
    uintptr_t movedSlot = ${mapMethodName(name, "hash")}(self->entries.data[index].key) & (self->buckets.length - 1);
    while (self->buckets.data[movedSlot] != last + 1) movedSlot = (movedSlot + 1) & (self->buckets.length - 1);
    self->buckets.data[movedSlot] = index + 1;
  } else {
    std::destroy_at(&self->entries.data[last]);
  }`
    : `  if (index != last) {
    self->entries.data[index] = self->entries.data[last];
    uintptr_t movedSlot = ${mapMethodName(name, "hash")}(self->entries.data[index].key) & (self->buckets.length - 1);
    while (self->buckets.data[movedSlot] != last + 1) movedSlot = (movedSlot + 1) & (self->buckets.length - 1);
    self->buckets.data[movedSlot] = index + 1;
  }
  self->entries.data[last] = (${mappedEntry}){ 0 };`;

  const storedLookup = structs.get(map.valueType)?.kind === "class"
    ? `${retainName(map.valueType)}(self->entries.data[stored - 1].value)`
    : identityValue
      ? "self->entries.data[stored - 1].value"
      : "&self->entries.data[stored - 1].value";
  const someLookup = nicheLookup
    ? storedLookup
    : `(${mappedLookupOption}){ .tag = ${variantTag(lookupOption, "some")}, .data.some = ${storedLookup} }`;
  const noneLookup = nicheLookup
    ? nicheOptionNull(nicheLookup)
    : `(${mappedLookupOption}){ .tag = ${variantTag(lookupOption, "none")} }`;

  return `static inline __attribute__((unused)) bool ${mapEqualityName(name)}(${mappedKey} left, ${mappedKey} right) {
  return ${equals};
}

static inline __attribute__((unused)) uintptr_t ${mapMethodName(name, "hash")}(${mappedKey} value) {
  ${hashBody}
${customKey ? "" : "  return (uintptr_t)hash;"}
}

static __attribute__((unused)) void ${mapMethodName(name, "rehash")}(${mappedMap} *self, uintptr_t capacity) {
  if (capacity < 8) capacity = 8;
  if (capacity > SIZE_MAX / sizeof(uintptr_t)) abort();
  uintptr_t *buckets = (uintptr_t *)calloc(capacity, sizeof(uintptr_t));
  if (buckets == NULL) abort();
  for (uintptr_t index = 0; index < self->entries.length; index += 1) {
    uintptr_t slot = ${mapMethodName(name, "hash")}(self->entries.data[index].key) & (capacity - 1);
    while (buckets[slot] != 0) slot = (slot + 1) & (capacity - 1);
    buckets[slot] = index + 1;
  }
  free(self->buckets.data);
  self->buckets.data = buckets;
  self->buckets.length = capacity;
  self->buckets.capacity = capacity;
  self->tombstones = 0;
}

static __attribute__((unused)) void ${mapMethodName(name, "ensure_capacity")}(${mappedMap} *self) {
  if (self->buckets.length == 0) {
    ${mapMethodName(name, "rehash")}(self, 8);
    return;
  }
  if (self->entries.length + self->tombstones < self->buckets.length - self->buckets.length / 4) return;
  if (self->buckets.length > SIZE_MAX / 2) abort();
  ${mapMethodName(name, "rehash")}(self, self->buckets.length * 2);
}

static __attribute__((unused)) bool ${mapMethodName(name, "has")}(const ${mappedMap} *self, ${mappedKey} key) {
  if (self->buckets.length == 0) return false;
  uintptr_t slot = ${mapMethodName(name, "hash")}(key) & (self->buckets.length - 1);
  for (uintptr_t probe = 0; probe < self->buckets.length; probe += 1) {
    uintptr_t stored = self->buckets.data[slot];
    if (stored == 0) return false;
    if (stored != SIZE_MAX && ${mapEqualityName(name)}(self->entries.data[stored - 1].key, key)) return true;
    slot = (slot + 1) & (self->buckets.length - 1);
  }
  return false;
}

static __attribute__((unused)) ${mappedLookupOption} ${mapMethodName(name, "get")}(const ${mappedMap} *self, ${mappedKey} key) {
  if (self->buckets.length == 0) return ${noneLookup};
  uintptr_t slot = ${mapMethodName(name, "hash")}(key) & (self->buckets.length - 1);
  for (uintptr_t probe = 0; probe < self->buckets.length; probe += 1) {
    uintptr_t stored = self->buckets.data[slot];
    if (stored == 0) return ${noneLookup};
    if (stored != SIZE_MAX && ${mapEqualityName(name)}(self->entries.data[stored - 1].key, key)) return ${someLookup};
    slot = (slot + 1) & (self->buckets.length - 1);
  }
  return ${noneLookup};
}

static __attribute__((unused)) void ${mapMethodName(name, "set")}(${mappedMap} *self, ${mappedKey} key, ${mappedValue} value) {
  ${mapMethodName(name, "ensure_capacity")}(self);
  uintptr_t slot = ${mapMethodName(name, "hash")}(key) & (self->buckets.length - 1);
  uintptr_t available = SIZE_MAX;
  for (uintptr_t probe = 0; probe < self->buckets.length; probe += 1) {
    uintptr_t stored = self->buckets.data[slot];
    if (stored == 0) break;
    if (stored == SIZE_MAX) {
      if (available == SIZE_MAX) available = slot;
    } else if (${mapEqualityName(name)}(self->entries.data[stored - 1].key, key)) {
      uintptr_t index = stored - 1;
${indent(cleanupLines(keyCleanup) + cleanupLines(storedValueCleanup), 6)}      ${replaceStoredValue}
      return;
    }
    slot = (slot + 1) & (self->buckets.length - 1);
  }
  if (available != SIZE_MAX) {
    slot = available;
    self->tombstones -= 1;
  }
  ${dynamicArrayPushName(entriesType)}(&self->entries, (${mappedEntry}){ .key = key, .value = ${insertedValue} });
  self->buckets.data[slot] = self->entries.length;
}

static __attribute__((unused)) void ${mapMethodName(name, "erase_at")}(${mappedMap} *self, uintptr_t slot, uintptr_t index) {
  uintptr_t last = self->entries.length - 1;
  self->buckets.data[slot] = SIZE_MAX;
  self->tombstones += 1;
${eraseEntry}
  self->entries.length = last;
  if (self->entries.length == 0) {
    for (uintptr_t cleared = 0; cleared < self->buckets.length; cleared += 1) self->buckets.data[cleared] = 0;
    self->tombstones = 0;
  } else if (self->tombstones > self->entries.length) {
    ${mapMethodName(name, "rehash")}(self, self->buckets.length);
  }
}

static __attribute__((unused)) ${mappedValueOption} ${mapMethodName(name, "remove")}(${mappedMap} *self, ${mappedKey} key) {
  if (self->buckets.length == 0) return ${noneValue};
  uintptr_t slot = ${mapMethodName(name, "hash")}(key) & (self->buckets.length - 1);
  for (uintptr_t probe = 0; probe < self->buckets.length; probe += 1) {
    uintptr_t stored = self->buckets.data[slot];
    if (stored == 0) return ${noneValue};
    if (stored == SIZE_MAX || !${mapEqualityName(name)}(self->entries.data[stored - 1].key, key)) {
      slot = (slot + 1) & (self->buckets.length - 1);
      continue;
    }
    uintptr_t index = stored - 1;
    ${mappedValueOption} result = ${someValue};
${indent(cleanupLines(storedKeyCleanup), 4)}    self->entries.data[index].key = ${zeroKey};
${resetStoredValue}    ${mapMethodName(name, "erase_at")}(self, slot, index);
    return result;
  }
  return ${noneValue};
}

static __attribute__((unused)) bool ${mapMethodName(name, "delete")}(${mappedMap} *self, ${mappedKey} key) {
  if (self->buckets.length == 0) return false;
  uintptr_t slot = ${mapMethodName(name, "hash")}(key) & (self->buckets.length - 1);
  for (uintptr_t probe = 0; probe < self->buckets.length; probe += 1) {
    uintptr_t stored = self->buckets.data[slot];
    if (stored == 0) return false;
    if (stored == SIZE_MAX || !${mapEqualityName(name)}(self->entries.data[stored - 1].key, key)) {
      slot = (slot + 1) & (self->buckets.length - 1);
      continue;
    }
    uintptr_t index = stored - 1;
${indent(cleanupLines(storedValueCleanup) + cleanupLines(storedKeyCleanup), 4)}    self->entries.data[index].key = ${zeroKey};
${resetStoredEntry}    ${mapMethodName(name, "erase_at")}(self, slot, index);
    return true;
  }
  return false;
}

static __attribute__((unused)) void ${mapMethodName(name, "clear")}(${mappedMap} *self) {
  ${deinitName(name)}(self);
  *self = ${nativeMoveEntry ? `${mappedMap}{}` : `(${mappedMap}){ 0 }`};
}`;
}

function generateSetRuntime(
  name: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  semanticInfo: SemanticInfo,
): string {
  const set = parseSetType(name)!;
  const valuesType = dynamicArrayTypeName(set.elementType);
  const mappedSet = mapType(name, structs, enums, semanticInfo.foreignNamedTypes);
  const mappedElement = mapType(set.elementType, structs, enums, semanticInfo.foreignNamedTypes);
  const valueOption = optionTypeName(set.elementType);
  const mappedValueOption = mapType(valueOption, structs, enums, semanticInfo.foreignNamedTypes);
  const valueOptionDeclaration = enums.get(valueOption)!;
  const nicheValue = nicheOptionPayload(valueOptionDeclaration, semanticInfo.foreignNamedTypes);
  const zElementEnum = enums.get(set.elementType);
  const customElement = structs.get(set.elementType)?.implements.some((trait) => trait.name === "Hashable") ?? false;
  const equals = customElement
    ? `${methodName(set.elementType, "equals")}(&left, &right)`
    : set.elementType === "String"
    ? "z_string_equal(left, right)"
    : zElementEnum?.variants.every((variant) => variant.payload === null)
      ? "left.tag == right.tag"
      : "left == right";
  const hashBody = customElement
    ? `Z_Hasher hasher = z_hasher_new();
  ${methodName(set.elementType, "hash")}(&value, &hasher);
  return z_hasher_finish(hasher);`
    : set.elementType === "String"
    ? `uint64_t hash = UINT64_C(14695981039346656037);
  for (uintptr_t index = 0; index < value.length; index += 1) {
    hash ^= (unsigned char)value.data[index];
    hash *= UINT64_C(1099511628211);
  }`
    : `uint64_t hash = (uint64_t)${zElementEnum?.variants.every((variant) => variant.payload === null) ? "value.tag" : "value"};
  hash ^= hash >> 33;
  hash *= UINT64_C(0xff51afd7ed558ccd);
  hash ^= hash >> 33;
  hash *= UINT64_C(0xc4ceb9fe1a85ec53);
  hash ^= hash >> 33;`;
  const incomingCleanup = generateOwnedEnvironmentCleanup(
    "value",
    set.elementType,
    structs,
    enums,
    semanticInfo,
    { value: 0 },
  );
  const storedElementCleanup = generateOwnedEnvironmentCleanup(
    "self->values.data[index]",
    set.elementType,
    structs,
    enums,
    semanticInfo,
    { value: 0 },
  );
  const someValue = nicheValue
    ? "self->values.data[index]"
    : `(${mappedValueOption}){ .tag = ${variantTag(valueOption, "some")}, .data.some = self->values.data[index] }`;
  const noneValue = nicheValue
    ? nicheOptionNull(nicheValue)
    : `(${mappedValueOption}){ .tag = ${variantTag(valueOption, "none")} }`;
  const duplicateCleanup = incomingCleanup ? `${indent(incomingCleanup, 4)}\n` : "";

  return `static inline __attribute__((unused)) bool ${setEqualityName(name)}(${mappedElement} left, ${mappedElement} right) {
  return ${equals};
}

static inline __attribute__((unused)) uintptr_t ${setMethodName(name, "hash")}(${mappedElement} value) {
  ${hashBody}
${customElement ? "" : "  return (uintptr_t)hash;"}
}

static __attribute__((unused)) void ${setMethodName(name, "rehash")}(${mappedSet} *self, uintptr_t capacity) {
  if (capacity < 8) capacity = 8;
  if (capacity > SIZE_MAX / sizeof(uintptr_t)) abort();
  uintptr_t *buckets = (uintptr_t *)calloc(capacity, sizeof(uintptr_t));
  if (buckets == NULL) abort();
  for (uintptr_t index = 0; index < self->values.length; index += 1) {
    uintptr_t slot = ${setMethodName(name, "hash")}(self->values.data[index]) & (capacity - 1);
    while (buckets[slot] != 0) slot = (slot + 1) & (capacity - 1);
    buckets[slot] = index + 1;
  }
  free(self->buckets.data);
  self->buckets.data = buckets;
  self->buckets.length = capacity;
  self->buckets.capacity = capacity;
  self->tombstones = 0;
}

static __attribute__((unused)) void ${setMethodName(name, "ensure_capacity")}(${mappedSet} *self) {
  if (self->buckets.length == 0) {
    ${setMethodName(name, "rehash")}(self, 8);
    return;
  }
  if (self->values.length + self->tombstones < self->buckets.length - self->buckets.length / 4) return;
  if (self->buckets.length > SIZE_MAX / 2) abort();
  ${setMethodName(name, "rehash")}(self, self->buckets.length * 2);
}

static __attribute__((unused)) bool ${setMethodName(name, "has")}(const ${mappedSet} *self, ${mappedElement} value) {
  if (self->buckets.length == 0) return false;
  uintptr_t slot = ${setMethodName(name, "hash")}(value) & (self->buckets.length - 1);
  for (uintptr_t probe = 0; probe < self->buckets.length; probe += 1) {
    uintptr_t stored = self->buckets.data[slot];
    if (stored == 0) return false;
    if (stored != SIZE_MAX && ${setEqualityName(name)}(self->values.data[stored - 1], value)) return true;
    slot = (slot + 1) & (self->buckets.length - 1);
  }
  return false;
}

static __attribute__((unused)) bool ${setMethodName(name, "add")}(${mappedSet} *self, ${mappedElement} value) {
  ${setMethodName(name, "ensure_capacity")}(self);
  uintptr_t slot = ${setMethodName(name, "hash")}(value) & (self->buckets.length - 1);
  uintptr_t available = SIZE_MAX;
  for (uintptr_t probe = 0; probe < self->buckets.length; probe += 1) {
    uintptr_t stored = self->buckets.data[slot];
    if (stored == 0) break;
    if (stored == SIZE_MAX) {
      if (available == SIZE_MAX) available = slot;
    } else if (${setEqualityName(name)}(self->values.data[stored - 1], value)) {
${duplicateCleanup}      return false;
    }
    slot = (slot + 1) & (self->buckets.length - 1);
  }
  if (available != SIZE_MAX) {
    slot = available;
    self->tombstones -= 1;
  }
  ${dynamicArrayPushName(valuesType)}(&self->values, value);
  self->buckets.data[slot] = self->values.length;
  return true;
}

static __attribute__((unused)) void ${setMethodName(name, "erase_at")}(${mappedSet} *self, uintptr_t slot, uintptr_t index) {
  uintptr_t last = self->values.length - 1;
  self->buckets.data[slot] = SIZE_MAX;
  self->tombstones += 1;
  if (index != last) {
    self->values.data[index] = self->values.data[last];
    uintptr_t movedSlot = ${setMethodName(name, "hash")}(self->values.data[index]) & (self->buckets.length - 1);
    while (self->buckets.data[movedSlot] != last + 1) movedSlot = (movedSlot + 1) & (self->buckets.length - 1);
    self->buckets.data[movedSlot] = index + 1;
  }
  self->values.data[last] = ${mapZeroValue(set.elementType, structs, enums, semanticInfo.foreignNamedTypes)};
  self->values.length = last;
  if (self->values.length == 0) {
    for (uintptr_t cleared = 0; cleared < self->buckets.length; cleared += 1) self->buckets.data[cleared] = 0;
    self->tombstones = 0;
  } else if (self->tombstones > self->values.length) {
    ${setMethodName(name, "rehash")}(self, self->buckets.length);
  }
}

static __attribute__((unused)) ${mappedValueOption} ${setMethodName(name, "remove")}(${mappedSet} *self, ${mappedElement} value) {
  if (self->buckets.length == 0) return ${noneValue};
  uintptr_t slot = ${setMethodName(name, "hash")}(value) & (self->buckets.length - 1);
  for (uintptr_t probe = 0; probe < self->buckets.length; probe += 1) {
    uintptr_t stored = self->buckets.data[slot];
    if (stored == 0) return ${noneValue};
    if (stored == SIZE_MAX || !${setEqualityName(name)}(self->values.data[stored - 1], value)) {
      slot = (slot + 1) & (self->buckets.length - 1);
      continue;
    }
    uintptr_t index = stored - 1;
    ${mappedValueOption} result = ${someValue};
    self->values.data[index] = ${mapZeroValue(set.elementType, structs, enums, semanticInfo.foreignNamedTypes)};
    ${setMethodName(name, "erase_at")}(self, slot, index);
    return result;
  }
  return ${noneValue};
}

static __attribute__((unused)) bool ${setMethodName(name, "delete")}(${mappedSet} *self, ${mappedElement} value) {
  if (self->buckets.length == 0) return false;
  uintptr_t slot = ${setMethodName(name, "hash")}(value) & (self->buckets.length - 1);
  for (uintptr_t probe = 0; probe < self->buckets.length; probe += 1) {
    uintptr_t stored = self->buckets.data[slot];
    if (stored == 0) return false;
    if (stored == SIZE_MAX || !${setEqualityName(name)}(self->values.data[stored - 1], value)) {
      slot = (slot + 1) & (self->buckets.length - 1);
      continue;
    }
    uintptr_t index = stored - 1;
${storedElementCleanup ? `${indent(storedElementCleanup, 4)}\n` : ""}    self->values.data[index] = ${mapZeroValue(set.elementType, structs, enums, semanticInfo.foreignNamedTypes)};
    ${setMethodName(name, "erase_at")}(self, slot, index);
    return true;
  }
  return false;
}

static __attribute__((unused)) void ${setMethodName(name, "clear")}(${mappedSet} *self) {
  ${deinitName(name)}(self);
  *self = (${mappedSet}){ 0 };
}`;
}

function mapZeroValue(
  type: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const mapped = mapType(type, structs, enums, foreignNamedTypes);
  if (mapped.endsWith("*") || mapped === "id") return "NULL";
  if (["bool", "int8_t", "uint8_t", "int16_t", "uint16_t", "int32_t", "uint32_t", "int64_t", "uint64_t", "intptr_t", "uintptr_t", "float", "double"].includes(mapped)) return "0";
  return `(${mapped}){ 0 }`;
}

function generateClassConstructorSignature(
  declaration: StructDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const parameters = declaration.constructor
    ? declaration.constructor.parameters.map((parameter) => {
      const type = mapType(parameter.type.name, structs, enums, foreignNamedTypes);
      if (parameter.type.name === "TaskScope") {
        if (parameter.mode === "inout" || parameter.mode === "out") return `${type} *${cBindingName(parameter.name)}`;
        return `${type} ${cBindingName(parameter.name)}`;
      }
      const aggregate = structs.get(parameter.type.name);
      if (parseSliceType(parameter.type.name)) return `${type} ${cBindingName(parameter.name)}`;
      if (foreignNamedTypes.get(parameter.type.name)?.kind === "object") {
        if (parameter.mode === "inout" || parameter.mode === "out") return `${type} *${cBindingName(parameter.name)}`;
      } else if (aggregate?.kind === "class") {
        if (parameter.mode === "in") return `const ${structName(aggregate.name)} *${cBindingName(parameter.name)}`;
        if (parameter.mode === "inout" || parameter.mode === "out") return `${structName(aggregate.name)} **${cBindingName(parameter.name)}`;
      } else if (parameter.mode === "in") return `const ${type} *${cBindingName(parameter.name)}`;
      else if (parameter.mode === "inout" || parameter.mode === "out") return `${type} *${cBindingName(parameter.name)}`;
      return `${type} ${cBindingName(parameter.name)}`;
    })
    : declaration.fields.map((field) => (
      `${mapType(field.type.name, structs, enums, foreignNamedTypes)} ${field.name}`
    ));
  const result = declaration.constructor?.errorType
    ? mapType(resultTypeName(declaration.name, declaration.constructor.errorType.name), structs, enums, foreignNamedTypes)
    : `${structName(declaration.name)} *`;
  const separator = result.endsWith("*") ? "" : " ";
  const unused = declaration.name.startsWith("__z_module_") ? "__attribute__((unused)) " : "";
  return `static ${unused}${result}${separator}${constructorName(declaration.name)}(${parameters.join(", ") || "void"})`;
}

function generateClassLifecycle(
  declaration: StructDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  functions: Map<string, FunctionDeclaration>,
  semanticInfo: SemanticInfo,
): string {
  const cName = structName(declaration.name);
  const unused = declaration.name.startsWith("__z_module_") ? "__attribute__((unused)) " : "";
  const shareable = semanticInfo.shareableClasses.has(declaration.name);
  const constructor = declaration.constructor
    ? generateUserClassConstructor(declaration, structs, enums, functions, semanticInfo)
    : `${generateClassConstructorSignature(declaration, structs, enums, semanticInfo.foreignNamedTypes)} {
  ${cName} *self = (${cName} *)calloc(1, sizeof(${cName}));
  if (self == NULL) abort();
  self->_z_refcount = 1;
  self->_z_weak = NULL;
${declaration.fields.map((field) => `  self->${field.name} = ${field.name};`).join("\n")}
  return self;
}`;
  const retain = shareable
    ? "if (value != NULL) __atomic_add_fetch(&value->_z_refcount, 1, __ATOMIC_RELAXED);"
    : "if (value != NULL) value->_z_refcount += 1;";
  const release = shareable
    ? `if (__atomic_sub_fetch(&value->_z_refcount, 1, __ATOMIC_ACQ_REL) != 0) return;
  Z_WeakControl *weak = value->_z_weak;
  if (weak != NULL) weak->value = NULL;
  ${deinitName(declaration.name)}(value);
  if (weak != NULL) {
    weak->weak_count -= 1;
    if (weak->weak_count == 0) free(weak);
  }
  free(value);`
    : `value->_z_refcount -= 1;
  if (value->_z_refcount == 0) {
    Z_WeakControl *weak = value->_z_weak;
    if (weak != NULL) weak->value = NULL;
    ${deinitName(declaration.name)}(value);
    if (weak != NULL) {
      weak->weak_count -= 1;
      if (weak->weak_count == 0) free(weak);
    }
    free(value);
  }`;
  return `static ${unused}${cName} *${retainName(declaration.name)}(${cName} *value) {
  ${retain}
  return value;
}

static ${unused}void ${releaseName(declaration.name)}(${cName} *value) {
  if (value == NULL) return;
  ${release}
}

static ${unused}__attribute__((unused)) Z_Weak ${weakMakeName(declaration.name)}(const ${cName} *borrowed) {
  ${cName} *value = (${cName} *)borrowed;
  if (value->_z_weak == NULL) {
    value->_z_weak = (Z_WeakControl *)malloc(sizeof(Z_WeakControl));
    if (value->_z_weak == NULL) abort();
    value->_z_weak->value = value;
    value->_z_weak->weak_count = 1;
  }
  Z_Weak weak = { .control = value->_z_weak };
  weak.control->weak_count += 1;
  return weak;
}

static ${unused}__attribute__((unused)) ${enumName(weakResultTypeName(declaration.name))} ${weakUpgradeName(declaration.name)}(Z_Weak weak) {
  ${cName} *value = (${cName} *)weak.control->value;
  if (value == NULL) {
    return (${enumName(weakResultTypeName(declaration.name))}){
      .tag = ${variantTag(weakResultTypeName(declaration.name), "failure")},
      .data.failure = (${structName(weakExpiredType)}){}
    };
  }
  return (${enumName(weakResultTypeName(declaration.name))}){
    .tag = ${variantTag(weakResultTypeName(declaration.name), "success")},
    .data.success = ${retainName(declaration.name)}(value)
  };
}

${constructor}`;
}

function generateUserClassConstructor(
  declaration: StructDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  functions: Map<string, FunctionDeclaration>,
  semanticInfo: SemanticInfo,
): string {
  const constructor = declaration.constructor!;
  const owner: FunctionDeclaration = {
    kind: "function",
    name: "constructor",
    receiverMode: "inout",
    parameters: constructor.parameters,
    returnType: { name: declaration.name, location: constructor.location },
    errorType: constructor.errorType,
    body: constructor.body,
    location: constructor.location,
  };
  const localTypes = new Map(constructor.parameters.map((parameter) => [parameter.name, parameter.type.name]));
  localTypes.set("this", declaration.name);
  const liveFlagCounter = { value: 0 };
  const liveFlags = new Map<string, string>();
  const parameterCleanup = constructor.parameters
    .filter((parameter) => parameter.mode === "value" && hasCleanupType(parameter.type.name, structs, enums, semanticInfo.foreignTypes))
    .map((parameter) => {
      const liveFlag = nextLiveFlag(parameter.name, liveFlagCounter);
      liveFlags.set(parameter.name, liveFlag);
      return { name: parameter.name, type: parameter.type.name, liveFlag };
    });
  const fieldFlags = new Map<string, string>();
  const fieldCleanup = declaration.fields.flatMap((field) => {
    if (!constructor.errorType) return [];
    if (!hasCleanupType(field.type.name, structs, enums, semanticInfo.foreignTypes)
      && semanticInfo.foreignNamedTypes.get(field.type.name)?.kind !== "object") return [];
    const liveFlag = nextLiveFlag(`field_${field.name}`, liveFlagCounter);
    fieldFlags.set(field.name, liveFlag);
    return [{ name: field.name, value: `self->${field.name}`, type: field.type.name, liveFlag }];
  });
  const context: GenerationContext = {
    structs,
    enums,
    functions,
    localTypes,
    parameterModes: new Map(constructor.parameters.map((parameter) => [parameter.name, parameter.mode])),
    receiver: declaration,
    owner,
    matchCounter: { value: 0 },
    tryCounter: { value: 0 },
    valueCounter: { value: 0 },
    returnCounter: { value: 0 },
    loopCounter: { value: 0 },
    loopStack: [],
    valueSelectionStack: [],
    cleanupCounter: { value: 0 },
    cleanupScopes: [fieldCleanup, parameterCleanup],
    liveFlags,
    liveFlagCounter,
    expressionOverrides: new Map(),
    semanticInfo,
    constructorSelf: "self",
    constructorFieldFlags: fieldFlags,
  };
  const cName = structName(declaration.name);
  const body = [
    `  ${cName} *self = (${cName} *)calloc(1, sizeof(${cName}));`,
    "  if (self == NULL) abort();",
    "  self->_z_refcount = 1;",
    "  self->_z_weak = NULL;",
    ...parameterCleanup.map((parameter) => `  bool ${parameter.liveFlag} = true;`),
    ...fieldCleanup.map((field) => `  bool ${field.liveFlag} = false;`),
  ];
  for (const statement of constructor.body) {
    body.push(indent(generateStatement(statement, context), 2));
    recordVariableType(statement, context);
  }
  const parameterCleanupCode = generateCleanup([parameterCleanup], context);
  if (parameterCleanupCode) body.push(indent(parameterCleanupCode, 2));
  if (constructor.errorType) {
    const result = resultTypeName(declaration.name, constructor.errorType.name);
    body.push(`  return ${generateCompilerVariantConstruction(result, "success", "self", context)};`);
  } else {
    body.push("  return self;");
  }
  return `${generateClassConstructorSignature(declaration, structs, enums, semanticInfo.foreignNamedTypes)} {\n${body.join("\n")}\n}`;
}

function generateEnum(
  declaration: EnumDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  if (nicheOptionPayload(declaration, foreignNamedTypes)) return "";
  if (requiresNativeMove(declaration.name, structs, enums, foreignNamedTypes)) {
    return generateNativeMoveEnum(declaration, structs, enums, foreignNamedTypes);
  }
  const tag = declaration.variants.map((variant) => `  ${variantTag(declaration.name, variant.name)},`).join("\n");
  const payloads = declaration.variants.filter((variant) => variant.payload)
    .map((variant) => `    ${mapType(variant.payload!.name, structs, enums, foreignNamedTypes)} ${variant.name};`).join("\n");
  const storageKind = declaration.variants.some((variant) => (
    variant.payload && containsObjCStrongStorage(variant.payload.name, structs, enums, foreignNamedTypes)
  )) ? "struct" : "union";
  const storage = payloads ? `\n  ${storageKind} {\n${payloads}\n  } data;` : "";
  return `typedef enum {\n${tag}\n} ${enumName(declaration.name)}_Tag;\n\nstruct ${enumName(declaration.name)} {\n  ${enumName(declaration.name)}_Tag tag;${storage}\n};`;
}

function containsObjCStrongStorage(
  type: string,
  structs: ReadonlyMap<string, StructDeclaration>,
  enums: ReadonlyMap<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
  visiting = new Set<string>(),
): boolean {
  if (foreignNamedTypes.get(type)?.kind === "object") return true;
  if (visiting.has(type)) return false;
  const declaration = structs.get(type);
  const enumeration = enums.get(type);
  if (!declaration && !enumeration) return false;
  visiting.add(type);
  const result = declaration
    ? declaration.fields.some((field) => (
        containsObjCStrongStorage(field.type.name, structs, enums, foreignNamedTypes, visiting)
      ))
    : enumeration!.variants.some((variant) => (
        variant.payload
        && containsObjCStrongStorage(variant.payload.name, structs, enums, foreignNamedTypes, visiting)
      ));
  visiting.delete(type);
  return result;
}

function generateNativeMoveEnum(
  declaration: EnumDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const name = enumName(declaration.name);
  const invalid = `${name}_invalid`;
  const tags = [invalid, ...declaration.variants.map((variant) => variantTag(declaration.name, variant.name))]
    .map((tag) => `  ${tag},`)
    .join("\n");
  const payloads = declaration.variants.filter((variant) => variant.payload);
  const fields = payloads.map((variant) => (
    `    ${mapType(variant.payload!.name, structs, enums, foreignNamedTypes)} ${variant.name};`
  )).join("\n");
  const moveCases = payloads.map((variant) => {
    const payload = variant.payload!.name;
    const value = requiresNativeMove(payload, structs, enums, foreignNamedTypes)
      ? `std::move(other.data.${variant.name})`
      : `other.data.${variant.name}`;
    return `      case ${variantTag(declaration.name, variant.name)}:\n        std::construct_at(&data.${variant.name}, ${value});\n        break;`;
  }).join("\n");
  const destroyCases = payloads.filter((variant) => (
    requiresNativeMove(variant.payload!.name, structs, enums, foreignNamedTypes)
  )).map((variant) => (
    `      case ${variantTag(declaration.name, variant.name)}:\n        std::destroy_at(&data.${variant.name});\n        break;`
  )).join("\n");
  const factories = declaration.variants.map((variant) => {
    const factory = `make_${nativeSymbolPart(variant.name)}`;
    if (!variant.payload) {
      return `  static ${name} ${factory}() {\n    ${name} result;\n    result.tag = ${variantTag(declaration.name, variant.name)};\n    return result;\n  }`;
    }
    const payload = variant.payload.name;
    const type = mapType(payload, structs, enums, foreignNamedTypes);
    const value = requiresNativeMove(payload, structs, enums, foreignNamedTypes) ? "std::move(value)" : "value";
    return `  static ${name} ${factory}(${type} value) {\n    ${name} result;\n    result.tag = ${variantTag(declaration.name, variant.name)};\n    std::construct_at(&result.data.${variant.name}, ${value});\n    return result;\n  }`;
  }).join("\n\n");
  const moveSwitch = moveCases
    ? `    switch (other.tag) {\n${moveCases}\n      default:\n        break;\n    }`
    : "    (void)other;";
  const destroySwitch = destroyCases
    ? `    switch (tag) {\n${destroyCases}\n      default:\n        break;\n    }`
    : "    (void)tag;";
  return `typedef enum {\n${tags}\n} ${name}_Tag;

struct ${name} {
  ${name}_Tag tag;
  union Data {
${fields}
    Data() {}
    ~Data() {}
  } data;

  ${name}() : tag(${invalid}), data() {}
  ${name}(const ${name} &) = delete;
  ${name} &operator=(const ${name} &) = delete;

  ${name}(${name} &&other) : tag(other.tag), data() {
${moveSwitch}
  }

  ${name} &operator=(${name} &&other) {
    if (this != &other) {
      destroy_active();
      tag = other.tag;
${indent(moveSwitch, 6)}
    }
    return *this;
  }

  ~${name}() {
    destroy_active();
  }

${factories}

private:
  void destroy_active() {
${destroySwitch}
    tag = ${invalid};
  }
};`;
}

function nicheOptionPayload(
  declaration: EnumDeclaration,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string | null {
  const option = parseOptionType(declaration.name);
  if (!option) return null;
  if (parseOptionalViewType(declaration.name)) return option.target;
  if (foreignNamedTypes.get(option.target)?.kind === "object") return option.target;
  const pointer = parsePointerTypeName(option.target);
  return pointer && !pointer.nullable ? option.target : null;
}

function nicheOptionNull(payloadType: string): "nil" | "NULL" {
  return parseViewType(payloadType) || parsePointerTypeName(payloadType) ? "NULL" : "nil";
}

function generateGeneratorRuntime(
  type: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const generator = parseGeneratorType(type)!;
  const advanceSuccessType = generator.returnType
    ? generatorStepTypeName(generator.elementType, generator.returnType)
    : optionTypeName(generator.elementType);
  const advanceType = generator.errorType
    ? resultTypeName(advanceSuccessType, generator.errorType)
    : advanceSuccessType;
  const generatorName = generatorCName(type);
  const advanceName = mapType(advanceType, structs, enums, foreignNamedTypes);
  const none = `(${mapType(advanceSuccessType, structs, enums, foreignNamedTypes)}){ .tag = ${variantTag(advanceSuccessType, "none")} }`;
  const successfulExhaustion = generator.errorType
    ? `(${advanceName}){ .tag = ${variantTag(advanceType, "success")}, .data.success = ${none} }`
    : none;
  const exhausted = generator.returnType
    ? "abort();"
    : `return ${successfulExhaustion};`;
  return `struct ${generatorName} {
  void *context;
  ${advanceName} (*advance)(void *context);
  void (*destroy)(void *context);
};

static __attribute__((unused)) ${advanceName} ${generatorNextName(type)}(${generatorName} *self) {
  if (self->context == NULL) ${exhausted}
  return self->advance(self->context);
}

static __attribute__((unused)) void ${generatorDeinitName(type)}(${generatorName} *self) {
  if (self->context == NULL) return;
  self->destroy(self->context);
  self->context = NULL;
  self->advance = NULL;
  self->destroy = NULL;
}`;
}

type GeneratorFrameField = {
  readonly name: string;
  readonly type: string | null;
  readonly rawCType?: string;
  readonly parameter: boolean;
};

function collectGeneratorFrameFields(
  declaration: FunctionDeclaration,
  semanticInfo: SemanticInfo,
): GeneratorFrameField[] {
  const fields: GeneratorFrameField[] = declaration.parameters.map((parameter) => ({
    name: parameter.name,
    type: parameter.type.name,
    parameter: true,
  }));
  const names = new Set(fields.map((field) => field.name));
  const visit = (statement: Statement): void => {
    if (statement.kind === "variable") {
      if (names.has(statement.name)) {
        throw new Error(`generator frame cannot represent shadowed binding ${JSON.stringify(statement.name)}`);
      }
      names.add(statement.name);
      const type = statement.type?.name ?? semanticInfo.bindingTypes.get(statement.nameLocation.offset);
      if (!type) throw new Error(`missing generator frame type for ${JSON.stringify(statement.name)}`);
      fields.push({ name: statement.name, type, parameter: false });
      return;
    }
    if (statement.kind === "block") {
      statement.statements.forEach(visit);
      return;
    }
    if (statement.kind === "if") {
      visit(statement.thenBranch);
      if (statement.elseBranch) visit(statement.elseBranch);
      return;
    }
    if (statement.kind === "while" || statement.kind === "for") {
      visit(statement.body);
      return;
    }
    if (statement.kind === "match") {
      statement.arms.forEach((arm) => visit(arm.body));
    }
  };
  declaration.body.forEach(visit);
  return fields;
}

function generatorFrameName(declaration: FunctionDeclaration): string {
  return `Z_GeneratorFrame_${nativeSymbolPart(declaration.name)}`;
}

function generatorAdvanceName(declaration: FunctionDeclaration): string {
  return `${generatorFrameName(declaration)}_advance`;
}

function generatorDestroyName(declaration: FunctionDeclaration): string {
  return `${generatorFrameName(declaration)}_destroy`;
}

function generatorResumeLabel(state: number): string {
  return `_z_generator_resume_${state}`;
}

function registerGeneratorFrameField(
  context: GenerationContext,
  field: GeneratorFrameField,
): string {
  const generatorFrame = context.generatorFrame;
  if (!generatorFrame) throw new Error("persistent generator storage requires a generator frame");
  if (!generatorFrame.fields.some((candidate) => candidate.name === field.name)) {
    generatorFrame.fields.push(field);
  }
  return `frame->${cBindingName(field.name)}`;
}

function withGeneratorStorage(
  context: GenerationContext,
  bindings: ReadonlyMap<string, string>,
): GenerationContext {
  if (!context.generatorFrame) return context;
  const storage = new Map(context.generatorFrame.storage);
  for (const [name, value] of bindings) storage.set(name, value);
  return {
    ...context,
    generatorFrame: {
      ...context.generatorFrame,
      storage,
    },
  };
}

function generateGeneratorFunction(
  declaration: FunctionDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  functions: Map<string, FunctionDeclaration>,
  semanticInfo: SemanticInfo,
): string {
  const generator = parseGeneratorType(declaration.returnType.name)!;
  const advanceSuccessType = generator.returnType
    ? generatorStepTypeName(generator.elementType, generator.returnType)
    : optionTypeName(generator.elementType);
  const advanceType = generator.errorType
    ? resultTypeName(advanceSuccessType, generator.errorType)
    : advanceSuccessType;
  const frameName = generatorFrameName(declaration);
  const fields = collectGeneratorFrameFields(declaration, semanticInfo);
  const storage = new Map(fields.map((field) => [field.name, `frame->${cBindingName(field.name)}`]));
  const liveFlags = new Map<string, string>();
  for (const field of fields) {
    if (field.type && hasSemanticCleanupType(field.type, structs, enums, semanticInfo)) {
      liveFlags.set(field.name, `frame->${cBindingName(field.name)}_live`);
    }
  }
  const parameterCleanup: CleanupLocal[] = declaration.parameters.flatMap((parameter) => {
    const liveFlag = liveFlags.get(parameter.name);
    return liveFlag ? [{ name: parameter.name, type: parameter.type.name, liveFlag }] : [];
  });
  const context: GenerationContext = {
    structs,
    enums,
    functions,
    localTypes: new Map(declaration.parameters.map((parameter) => [parameter.name, parameter.type.name])),
    parameterModes: new Map(declaration.parameters.map((parameter) => [parameter.name, parameter.mode])),
    receiver: null,
    owner: declaration,
    matchCounter: { value: 0 },
    tryCounter: { value: 0 },
    valueCounter: { value: 0 },
    returnCounter: { value: 0 },
    loopCounter: { value: 0 },
    loopStack: [],
    valueSelectionStack: [],
    cleanupCounter: { value: 0 },
    cleanupScopes: [parameterCleanup],
    liveFlags,
    liveFlagCounter: { value: 0 },
    expressionOverrides: new Map(),
    semanticInfo,
    generatorFrame: { storage, fields, liveFlags, stateCounter: { value: 1 } },
  };
  const body = declaration.body.map((statement) => {
    const generated = generateStatement(statement, context);
    recordVariableType(statement, context);
    return indent(generated, 6);
  });
  const completionCleanup = generateCleanup(context.cleanupScopes, context);
  const none = generator.returnType
    ? null
    : generateCompilerVariantConstruction(advanceSuccessType, "none", null, context);
  const successfulExhaustion = none && generator.errorType
    ? generateCompilerVariantConstruction(advanceType, "success", none, context)
    : none;
  const exhausted = generator.returnType
    ? "abort();"
    : `return ${successfulExhaustion};`;
  body.push(indent(`${completionCleanup ? `${completionCleanup}\n` : ""}frame->state = -1;\n${exhausted}`, 6));

  const frameFields = fields.flatMap((field) => {
    const mapped = field.rawCType ?? mapType(field.type!, structs, enums, semanticInfo.foreignNamedTypes);
    const lines = [`  ${mapped} ${cBindingName(field.name)};`];
    if (liveFlags.has(field.name)) lines.push(`  bool ${cBindingName(field.name)}_live;`);
    return lines;
  });
  const destroyCleanup = [...fields].reverse().flatMap((field) => {
    const liveFlag = liveFlags.get(field.name);
    if (!liveFlag || !field.type) return [];
    return [indent(generateValueCleanup(`frame->${cBindingName(field.name)}`, field.type, liveFlag, context), 2)];
  });
  const factoryInitializers = declaration.parameters.flatMap((parameter) => {
    const field = `frame->${cBindingName(parameter.name)}`;
    const parameterName = cBindingName(parameter.name);
    return [
      `  ${field} = ${requiresNativeMove(parameter.type.name, structs, enums, semanticInfo.foreignNamedTypes) ? `std::move(${parameterName})` : parameterName};`,
      ...(liveFlags.has(parameter.name) ? [`  frame->${cBindingName(parameter.name)}_live = true;`] : []),
    ];
  });
  const resumeDispatch = Array.from(
    { length: context.generatorFrame.stateCounter.value - 1 },
    (_, index) => `    case ${index + 1}: goto ${generatorResumeLabel(index + 1)};`,
  );
  const signature = generateFunctionSignature(declaration, structs, enums, null, semanticInfo.foreignNamedTypes);
  return `typedef struct ${frameName} {
  int32_t state;
${frameFields.join("\n")}
} ${frameName};

static ${mapType(advanceType, structs, enums, semanticInfo.foreignNamedTypes)} ${generatorAdvanceName(declaration)}(void *context) {
  ${frameName} *frame = (${frameName} *)context;
  switch (frame->state) {
    case -1:
      ${exhausted}
    case 0: goto _z_generator_start;
${resumeDispatch.join("\n")}
    default:
      abort();
  }
_z_generator_start: ;
${body.join("\n")}
}

static void ${generatorDestroyName(declaration)}(void *context) {
  ${frameName} *frame = (${frameName} *)context;
${destroyCleanup.join("\n")}
  free(frame);
}

${signature} {
  ${frameName} *frame = (${frameName} *)calloc(1, sizeof(${frameName}));
  if (frame == NULL) abort();
  frame->state = 0;
${factoryInitializers.join("\n")}
  return (${generatorCName(declaration.returnType.name)}){
    .context = frame,
    .advance = ${generatorAdvanceName(declaration)},
    .destroy = ${generatorDestroyName(declaration)}
  };
}`;
}

function generateFunction(
  declaration: FunctionDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  functions: Map<string, FunctionDeclaration>,
  receiver: StructDeclaration | null,
  semanticInfo: SemanticInfo,
): string {
  if (!receiver && isGeneratorFunction(declaration)) {
    return generateGeneratorFunction(declaration, structs, enums, functions, semanticInfo);
  }
  const instanceReceiver = receiver && !declaration.static ? receiver : null;
  const localTypes = new Map(declaration.parameters.map((parameter) => [parameter.name, parameter.type.name]));
  if (instanceReceiver) localTypes.set("this", instanceReceiver.name);
  const liveFlagCounter = { value: 0 };
  const liveFlags = new Map<string, string>();
  const ownedReceiverCleanup = instanceReceiver
    && declaration.receiverMode === "move"
    && hasCleanupType(instanceReceiver.name, structs, enums)
    ? [{ name: "self", type: instanceReceiver.name, liveFlag: nextLiveFlag("this", liveFlagCounter) }]
    : [];
  if (ownedReceiverCleanup.length > 0) liveFlags.set("this", ownedReceiverCleanup[0].liveFlag);
  const parameterCleanup = ownedReceiverCleanup.concat(declaration.parameters
    .filter((parameter) => parameter.mode === "value" && hasCleanupType(parameter.type.name, structs, enums))
    .map((parameter) => {
      const liveFlag = nextLiveFlag(parameter.name, liveFlagCounter);
      liveFlags.set(parameter.name, liveFlag);
      return { name: parameter.name, type: parameter.type.name, liveFlag };
    }));
  const outParameterFlags = declaration.parameters
    .filter((parameter) => parameter.mode === "out" && hasCleanupType(parameter.type.name, structs, enums, semanticInfo.foreignTypes))
    .map((parameter) => {
      const liveFlag = nextLiveFlag(parameter.name, liveFlagCounter);
      liveFlags.set(parameter.name, liveFlag);
      return liveFlag;
    });
  const context: GenerationContext = {
    structs,
    enums,
    functions,
    localTypes,
    parameterModes: new Map(declaration.parameters.map((parameter) => [parameter.name, parameter.mode])),
    receiver: instanceReceiver,
    owner: declaration,
    matchCounter: { value: 0 },
    tryCounter: { value: 0 },
    valueCounter: { value: 0 },
    returnCounter: { value: 0 },
    loopCounter: { value: 0 },
    loopStack: [],
    valueSelectionStack: [],
    cleanupCounter: { value: 0 },
    cleanupScopes: [parameterCleanup],
    liveFlags,
    liveFlagCounter,
    expressionOverrides: new Map(),
    semanticInfo,
  };
  const bodyParts = [
    ...(!receiver && declaration.name === "main"
      ? [
          "(void)argc;",
          "(void)argv;",
          ...([...semanticInfo.standardFunctionReferences.values()].some((name) => name.startsWith("process."))
            ? ["z_process_set_arguments(argc, argv);"]
            : []),
        ]
      : []),
    ...(instanceReceiver ? ["(void)self;"] : []),
    ...declaration.parameters.map((parameter) => `(void)${cBindingName(parameter.name)};`),
    ...parameterCleanup.map((parameter) => indent(`bool ${parameter.liveFlag} = true;`, 2)),
    ...outParameterFlags.map((liveFlag) => indent(`bool ${liveFlag} = false;`, 2)),
  ];
  bodyParts.push(...declaration.body.map((statement) => {
    const generated = generateStatement(statement, context);
    recordVariableType(statement, context);
    return indent(generated, 2);
  }));
  if (declaration.returnType.name === "void" && !statementListTerminates(declaration.body)) {
    const cleanup = generateCleanup(context.cleanupScopes, context);
    if (cleanup) bodyParts.push(indent(cleanup, 2));
    if (declaration.errorType) {
      const result = resultTypeName("void", declaration.errorType.name);
      bodyParts.push(indent(`return ${generateCompilerVariantConstruction(result, "success", null, context)};`, 2));
    }
  }
  const body = bodyParts.join("\n");
  const signature = generateFunctionSignature(declaration, structs, enums, receiver, semanticInfo.foreignNamedTypes);
  if (!receiver && declaration.name === "main" && semanticInfo.objectiveC) {
    return `${signature} {\n  @autoreleasepool {\n${indent(body, 2)}\n  }\n}`;
  }
  return `${signature} {\n${body}\n}`;
}

function generateDeinit(
  declaration: StructDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  functions: Map<string, FunctionDeclaration>,
  semanticInfo: SemanticInfo,
): string {
  const lifecycle = declaration.deinitializer;
  const owner: FunctionDeclaration = {
    kind: "function",
    name: "deinit",
    receiverMode: null,
    parameters: [],
    returnType: { name: "void", location: lifecycle?.location ?? declaration.location },
    errorType: null,
    body: lifecycle?.body ?? [],
    location: lifecycle?.location ?? declaration.location,
  };
  const context: GenerationContext = {
    structs,
    enums,
    functions,
    localTypes: new Map([["this", declaration.name]]),
    parameterModes: new Map(),
    receiver: declaration,
    owner,
    matchCounter: { value: 0 },
    tryCounter: { value: 0 },
    valueCounter: { value: 0 },
    returnCounter: { value: 0 },
    loopCounter: { value: 0 },
    loopStack: [],
    valueSelectionStack: [],
    cleanupCounter: { value: 0 },
    cleanupScopes: [[]],
    liveFlags: new Map(),
    liveFlagCounter: { value: 0 },
    expressionOverrides: new Map(),
    semanticInfo,
  };
  const body = ["  (void)self;", ...owner.body.map((statement) => {
    const generated = generateStatement(statement, context);
    recordVariableType(statement, context);
    return indent(generated, 2);
  })];
  const localCleanup = generateCleanup(context.cleanupScopes, context);
  if (localCleanup) body.push(indent(localCleanup, 2));
  for (const field of [...declaration.fields].reverse()) {
    if (hasSemanticCleanupType(field.type.name, structs, enums, semanticInfo)) {
      body.push(indent(generateValueCleanup(`self->${field.name}`, field.type.name, null, context), 2));
    }
  }
  const unused = declaration.name.startsWith("__z_module_") ? "__attribute__((unused)) " : "";
  return `static ${unused}void ${deinitName(declaration.name)}(${structName(declaration.name)} *self) {\n${body.join("\n")}\n}`;
}

function generateFunctionSignature(
  declaration: FunctionDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  receiver: StructDeclaration | null,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const moduleGenerated = (receiver?.name ?? declaration.name).startsWith("__z_module_");
  const storage = receiver || declaration.name !== "main"
    ? `static ${moduleGenerated ? "__attribute__((unused)) " : ""}`
    : "";
  const name = receiver ? methodName(receiver.name, declaration.name) : declaration.name;
  const parameters = declaration.parameters.map((parameter) => {
    const name = cBindingName(parameter.name);
    const type = mapType(parameter.type.name, structs, enums, foreignNamedTypes);
    if (parseSliceType(parameter.type.name)) return `${type} ${name}`;
    if (parameter.type.name === "TaskScope") {
      if (parameter.mode === "inout" || parameter.mode === "out") return `${type} *${name}`;
      return `${type} ${name}`;
    }
    const aggregate = structs.get(parameter.type.name);
    if (foreignNamedTypes.get(parameter.type.name)?.kind === "object") {
      if (parameter.mode === "inout" || parameter.mode === "out") return `${type} *${name}`;
      return `${type}${name}`;
    }
    if (aggregate?.kind === "class") {
      if (parameter.mode === "in") return `const ${structName(aggregate.name)} *${name}`;
      if (parameter.mode === "inout" || parameter.mode === "out") return `${structName(aggregate.name)} **${name}`;
      return `${type}${name}`;
    }
    if (parameter.mode === "in") return `const ${type} *${name}`;
    if (parameter.mode === "inout" || parameter.mode === "out") return `${type} *${name}`;
    return `${type} ${name}`;
  });
  if (!receiver && declaration.name === "main") {
    parameters.push("int argc", "char **argv");
  }
  if (receiver && !declaration.static) {
    if (receiver.kind === "class") {
      const receiverConst = declaration.receiverMode === "inout" ? "" : "const ";
      parameters.unshift(`${receiverConst}${structName(receiver.name)} *self`);
    } else if (declaration.receiverMode === "move") parameters.unshift(`${structName(receiver.name)} self`);
    else {
      const receiverConst = declaration.receiverMode === "inout" ? "" : "const ";
      parameters.unshift(`${receiverConst}${structName(receiver.name)} *self`);
    }
  }
  const returnName = declaration.errorType && !isGeneratorFunction(declaration)
    ? resultTypeName(declaration.returnType.name, declaration.errorType.name)
    : declaration.returnType.name;
  return `${storage}${mapType(returnName, structs, enums, foreignNamedTypes)} ${name}(${parameters.join(", ") || "void"})`;
}

function generateStatement(statement: Statement, context: GenerationContext): string {
  switch (statement.kind) {
    case "variable": {
      const zType = statement.type?.name
        ?? (statement.initializer
          ? directValueType(statement.initializer, context)
          : context.semanticInfo.bindingTypes.get(statement.nameLocation.offset));
      if (!zType) throw new Error(`missing inferred type for uninitialized binding ${JSON.stringify(statement.name)}`);
      if (context.generatorFrame) {
        const target = generateStoredValue(statement.name, context);
        if (!statement.initializer) return "(void)0;";
        const initialized = generateDirectValue(statement.initializer, context, (value) => `${target} = ${value};`);
        const liveFlag = hasCleanupType(zType, context.structs, context.enums, context.semanticInfo.foreignTypes)
          ? context.liveFlags.get(statement.name)
          : null;
        return `${initialized}\n(void)${target};${liveFlag ? `\n${liveFlag} = true;` : ""}`;
      }
      if (statement.initializer?.kind === "closure") {
        const closure = context.semanticInfo.closures.get(statement.initializer.location.offset)!;
        if (statement.type && parseFunctionType(statement.type.name)) {
          const declaration = generateLocalDeclaration(
            statement.type.name,
            statement.name,
            false,
            context.structs,
            context.enums,
            context.semanticInfo.foreignNamedTypes,
          );
          const functionType = parseFunctionType(statement.type.name)!;
          if (!closure.owned) {
            const liveFlag = ensureLiveFlag(statement.name, context);
            return `${declaration} = ${functionValueLiteral(functionType, closureAdapterName(closure))};\nbool ${liveFlag} = true;`;
          }
          const environmentType = closureEnvironmentName(closure);
          const environment = `_z_closure_environment_${closure.declaration.location.offset}`;
          const captures = closure.captures.map((capture) => {
            return `${environment}->${capture.name} = ${generateOwnedClosureCaptureValue(capture, context)};`;
          });
          const value = functionValueLiteral(
            functionType,
            closureAdapterName(closure),
            environment,
            closureEnvironmentRetainName(closure),
            closureEnvironmentReleaseName(closure),
          );
          const liveFlag = ensureLiveFlag(statement.name, context);
          return `${environmentType} *${environment} = (${environmentType} *)calloc(1, sizeof(${environmentType}));
if (${environment} == NULL) abort();
${environment}->refcount = 1;
${captures.join("\n")}
${declaration} = ${value};
bool ${liveFlag} = true;`;
        }
        const snapshots = closure.captures.filter((capture) => capture.moved).map((capture) => {
          const name = closureCaptureStorageName(closure, capture.name);
          const declaration = generateLocalDeclaration(
            capture.type,
            name,
            capture.mode === "inout",
            context.structs,
            context.enums,
            context.semanticInfo.foreignNamedTypes,
          );
          return `${declaration} = ${generateStoredValue(capture.name, context)};`;
        });
        return [...snapshots, "(void)0;"].join("\n");
      }
      const declaration = generateLocalDeclaration(zType, statement.name, statement.mutable, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
      if (!statement.initializer) {
        if (!hasCleanupType(zType, context.structs, context.enums, context.semanticInfo.foreignTypes)) return `${declaration};`;
        const liveFlag = ensureLiveFlag(statement.name, context);
        const initialization = context.semanticInfo.foreignTypes.has(zType) ? " = NULL" : "";
        return `${declaration}${initialization};\nbool ${liveFlag} = false;`;
      }
      let initialized: string;
      if (
        statement.initializer.kind === "matchExpression"
        || statement.initializer.kind === "ifExpression"
        || statement.initializer.kind === "whileExpression"
        || statement.initializer.kind === "forExpression"
        || (statement.initializer.kind === "conditional" && requiresStatementValue(statement.initializer, context))
      ) {
        const temporary = `_z_value_${context.valueCounter.value++}`;
        const temporaryDeclaration = generateLocalDeclaration(zType, temporary, true, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
        initialized = `${temporaryDeclaration};\n${generateDirectValue(statement.initializer, context, (value) => `${temporary} = ${value};`)}\n${declaration} = ${temporary};`;
      } else {
        initialized = generateDirectValue(statement.initializer, context, (value) => `${declaration} = ${value};`);
      }
      initialized = `${initialized}\n(void)${cBindingName(statement.name)};`;
      if (!hasCleanupType(zType, context.structs, context.enums, context.semanticInfo.foreignTypes)) return initialized;
      const liveFlag = ensureLiveFlag(statement.name, context);
      return `${initialized}\nbool ${liveFlag} = true;`;
    }
    case "destructure":
      return generateObjectDestructure(statement, context);
    case "assignment": {
      const objcProperty = context.semanticInfo.objcProperties.get(statement.target.location.offset);
      if (objcProperty?.setter && statement.target.kind === "member") {
        const receiver = generateExpression(statement.target.object, context);
        if (context.semanticInfo.cstringConversions.has(statement.expression.location.offset)) {
          return generateBorrowedCStringValue(
            statement.expression,
            context,
            (value) => `(void)${generateObjCMessage(receiver, objcProperty.setter!, [value])};`,
          );
        }
        return generateDirectValue(
          statement.expression,
          context,
          (value) => `(void)${generateObjCMessage(receiver, objcProperty.setter!, [value])};`,
        );
      }
      const targetType = inferExpressionType(statement.target, context);
      if (
        context.semanticInfo.constructorFieldInitializations.has(statement.location.offset)
        && statement.target.kind === "member"
        && statement.target.object.kind === "identifier"
        && statement.target.object.name === "this"
      ) {
        const liveFlag = context.constructorFieldFlags?.get(statement.target.property);
        return generateDirectValue(
          statement.expression,
          context,
          (value) => `${generateAssignmentTarget(statement.target, context)} = ${value};${liveFlag ? `\n${liveFlag} = true;` : ""}`,
        );
      }
      if (hasCleanupType(targetType, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
        return generateCleanupAwareAssignment(statement, targetType, context);
      }
      return generateDirectValue(
        statement.expression,
        context,
        (value) => `${generateAssignmentTarget(statement.target, context)} = ${value};`,
      );
    }
    case "return":
      if (context.generatorFrame) {
        const generator = parseGeneratorType(context.owner.returnType.name)!;
        if (!generator.returnType) {
          if (statement.expression) throw new Error("simple generator return values must be rejected by semantic analysis");
          const cleanup = generateCleanup(context.cleanupScopes, context);
          const option = optionTypeName(generator.elementType);
          const none = generateCompilerVariantConstruction(option, "none", null, context);
          return `${cleanup ? `${cleanup}\n` : ""}frame->state = -1;\nreturn ${none};`;
        }
        if (!statement.expression) throw new Error("terminal generator return requires a value");
        return generateDirectValue(statement.expression, context, (value, valueContext) => {
          const temporary = `_z_generator_return_${valueContext.returnCounter.value++}`;
          const declaration = generateLocalDeclaration(
            generator.returnType!,
            temporary,
            false,
            valueContext.structs,
            valueContext.enums,
            valueContext.semanticInfo.foreignNamedTypes,
          );
          const cleanup = generateCleanup(valueContext.cleanupScopes, valueContext);
          const step = generatorStepTypeName(generator.elementType, generator.returnType!);
          const completed = generateCompilerVariantConstruction(step, "complete", temporary, valueContext);
          const returned = generator.errorType
            ? generateCompilerVariantConstruction(
                resultTypeName(step, generator.errorType),
                "success",
                completed,
                valueContext,
              )
            : completed;
          return `${declaration} = ${value};\n${cleanup ? `${cleanup}\n` : ""}frame->state = -1;\nreturn ${returned};`;
        }, true);
      }
      if (!statement.expression) {
        const cleanup = generateCleanup(context.cleanupScopes, context);
        if (context.owner.errorType) {
          const result = resultTypeName("void", context.owner.errorType.name);
          const returned = `return ${generateCompilerVariantConstruction(result, "success", null, context)};`;
          return cleanup ? `${cleanup}\n${returned}` : returned;
        }
        return cleanup ? `${cleanup}\nreturn;` : "return;";
      }
      return generateDirectValue(
        statement.expression,
        context,
        (value, valueContext) => generateSuccessReturn(
          value,
          valueContext,
          context.semanticInfo.viewReturnExpressions.has(statement.expression!.location.offset),
        ),
        true,
      );
    case "throw": {
      const generator = context.generatorFrame ? parseGeneratorType(context.owner.returnType.name) : null;
      const generatorSuccess = generator
        ? generator.returnType
          ? generatorStepTypeName(generator.elementType, generator.returnType)
          : optionTypeName(generator.elementType)
        : null;
      const result = generatorSuccess
        ? resultTypeName(generatorSuccess, context.owner.errorType!.name)
        : resultTypeName(context.owner.returnType.name, context.owner.errorType!.name);
      return generateDirectValue(statement.expression, context, (value, valueContext) => {
        const cleanup = generateCleanup(valueContext.cleanupScopes, valueContext);
        const releaseSelf = valueContext.constructorSelf ? `free(${valueContext.constructorSelf});\n` : "";
        if (!cleanup && !releaseSelf) {
          return `return ${generateCompilerVariantConstruction(result, "failure", value, valueContext)};`;
        }
        const temporary = `_z_error_${valueContext.returnCounter.value++}`;
        const declaration = generateLocalDeclaration(
          valueContext.owner.errorType!.name,
          temporary,
          false,
          valueContext.structs,
          valueContext.enums,
          valueContext.semanticInfo.foreignNamedTypes,
        );
        const failureValue = requiresNativeMove(
          valueContext.owner.errorType!.name,
          valueContext.structs,
          valueContext.enums,
          valueContext.semanticInfo.foreignNamedTypes,
        ) ? `std::move(${temporary})` : temporary;
        const returned = generateCompilerVariantConstruction(result, "failure", failureValue, valueContext);
        const finishGenerator = generator ? "frame->state = -1;\n" : "";
        return `${declaration} = ${value};\n${cleanup ? `${cleanup}\n` : ""}${releaseSelf}${finishGenerator}return ${returned};`;
      }, true);
    }
    case "yield": {
      if (!context.generatorFrame) throw new Error("yield lowering requires a generator frame");
      const generator = parseGeneratorType(context.owner.returnType.name)!;
      const advanceType = generator.returnType
        ? generatorStepTypeName(generator.elementType, generator.returnType)
        : optionTypeName(generator.elementType);
      const variant = generator.returnType ? "yielded" : "some";
      const resume = context.generatorFrame.stateCounter.value++;
      return generateDirectValue(statement.expression, context, (value) => {
        const yielded = generateCompilerVariantConstruction(advanceType, variant, value, context);
        const returned = generator.errorType
          ? generateCompilerVariantConstruction(
              resultTypeName(advanceType, generator.errorType),
              "success",
              yielded,
              context,
            )
          : yielded;
        return `frame->state = ${resume};\nreturn ${returned};\n${generatorResumeLabel(resume)}: ;`;
      }, true);
    }
    case "select": {
      const selection = context.valueSelectionStack.at(-1);
      if (!selection) throw new Error("select must be lowered by its enclosing value-producing block");
      return generateDirectValue(statement.expression, context, (value, valueContext) => {
        const selected = selection.consumeValue(value, valueContext);
        if (selection.consumeTerminates) return selected;
        const cleanup = generateCleanup(
          valueContext.cleanupScopes.slice(selection.cleanupDepth),
          valueContext,
        );
        return [selected, cleanup, `goto ${selection.label};`].filter(Boolean).join("\n");
      }, selection.consumeTerminates);
    }
    case "break":
      return generateLoopTransfer("break", context);
    case "continue":
      return generateLoopTransfer("continue", context);
    case "block":
      return generateBlock(statement.statements, context);
    case "if":
      return generateIf(statement, context);
    case "while":
      return generateWhile(statement, context);
    case "for":
      return generateFor(statement, context);
    case "expressionStatement":
      if (statement.expression.kind === "executorPlacement") {
        if (statement.expression.mode !== "sync") {
          throw new Error("asynchronous executor placement must be lowered through task frames");
        }
        const final = statement.expression.body.statements.at(-1);
        if (final?.kind === "select") {
          return generateValueArm(statement.expression.body, context, (value) => `(void)${value};`, false);
        }
        return generateBlock(statement.expression.body.statements, context);
      }
      if (statement.expression.kind === "call" && context.semanticInfo.consoleCalls.has(statement.expression.location.offset)) {
        return generateConsoleCall(statement.expression, context);
      }
      if (statement.expression.kind === "template") {
        return generateDirectValue(statement.expression, context, (value) => (
          `(void)${value};\n${generateValueCleanup(value, "String", null, context)}`
        ));
      }
      return generateDirectValue(statement.expression, context, (value) => `(void)${value};`);
    case "match":
      return generateMatch(statement, context);
  }
}

function generateConsoleCall(
  expression: Extract<Expression, { kind: "call" }>,
  context: GenerationContext,
): string {
  if (expression.callee.kind !== "member") throw new Error("console lowering requires a member call");
  const stream = expression.callee.property === "log" || expression.callee.property === "write" ? "stdout" : "stderr";
  const lines: string[] = [];
  expression.arguments.forEach((argument, index) => {
    if (index > 0) lines.push(`fputc(' ', ${stream});`);
    if (argument.kind === "template") {
      for (const part of argument.parts) {
        if (part.kind === "text") {
          if (part.value) lines.push(`fputs(${JSON.stringify(part.value)}, ${stream});`);
        } else {
          lines.push(...generateConsoleExpression(part.expression, stream, context));
        }
      }
    } else if (argument.kind === "string") {
      lines.push(`fputs(${JSON.stringify(argument.value)}, ${stream});`);
    } else {
      lines.push(...generateConsoleExpression(argument, stream, context));
    }
  });
  if (expression.callee.property !== "write") lines.push(`fputc('\\n', ${stream});`);
  lines.push(`fflush(${stream});`);
  return lines.join("\n");
}

function generateConsoleExpression(expression: Expression, stream: "stdout" | "stderr", context: GenerationContext): string[] {
  const type = context.semanticInfo.expressionTypes.get(expression.location.offset) ?? inferExpressionType(expression, context);
  if (hasCleanupType(type, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
    return renderConsoleValue(generateExpression(expression, context), type, stream, context);
  }
  const temporary = `_z_console_${context.valueCounter.value++}`;
  if (type === "null") return [`fputs("null", ${stream});`];
  const declaration = generateLocalDeclaration(
    type,
    temporary,
    false,
    context.structs,
    context.enums,
    context.semanticInfo.foreignNamedTypes,
  );
  return [
    `${declaration} = ${generateExpression(expression, context)};`,
    ...renderConsoleValue(temporary, type, stream, context),
  ];
}

function renderConsoleValue(
  value: string,
  type: string,
  stream: "stdout" | "stderr",
  context: GenerationContext,
): string[] {
  if (["i8", "i16", "i32", "i64", "isize"].includes(type)) {
    return [`fprintf(${stream}, "%lld", (long long)(${value}));`];
  }
  if (["u8", "u16", "u32", "u64", "usize"].includes(type)) {
    return [`fprintf(${stream}, "%llu", (unsigned long long)(${value}));`];
  }
  if (type === "f32" || type === "f64") {
    return [`fprintf(${stream}, "%g", (double)(${value}));`];
  }
  if (type === "boolean") return [`fputs((${value}) ? "true" : "false", ${stream});`];
  if (type === "cstring") return [`fputs((${value}) != NULL ? (${value}) : "null", ${stream});`];
  if (type === "String") return [`if ((${value}).length > 0) fwrite((${value}).data, 1, (${value}).length, ${stream});`];
  if (type === "null") return [`fputs("null", ${stream});`];

  const foreign = context.semanticInfo.foreignNamedTypes.get(type);
  if (foreign?.kind === "scalar" || foreign?.kind === "enum") {
    return renderConsoleValue(value, foreign.underlying, stream, context);
  }
  if (context.semanticInfo.foreignTypes.has(type)) {
    return [`fprintf(${stream}, "%p", (void *)(${value}));`];
  }
  if (foreign?.kind === "object" || type.startsWith("__z_objc:")) {
    if (isObjCStringType(type, context)) {
      const length = `_z_console_nsstring_length_${context.valueCounter.value++}`;
      const bytes = `_z_console_nsstring_bytes_${context.valueCounter.value++}`;
      return [
        `if ((${value}) == nil) {`,
        `  fputs("null", ${stream});`,
        `} else {`,
        `  const NSUInteger ${length} = [(${value}) lengthOfBytesUsingEncoding:NSUTF8StringEncoding];`,
        `  const char *${bytes} = [(${value}) UTF8String];`,
        `  if (${bytes} == NULL && ${length} != 0) abort();`,
        `  if (${length} > 0) fwrite(${bytes}, 1, ${length}, ${stream});`,
        `}`,
      ];
    }
    const displayName = foreign?.kind === "object"
      ? foreign.exportName
      : type.replace(/^__z_objc:(?:nullable|nonnull):/, "").split(".").at(-1) ?? "Objective-C object";
    return [`fprintf(${stream}, ${JSON.stringify(`${displayName}@%p`)}, (__bridge void *)(${value}));`];
  }
  if (type.startsWith("__z_objc_class:")) return [`fputs("<Objective-C class>", ${stream});`];

  const fixed = parseFixedArrayType(type);
  const dynamic = parseDynamicArrayType(type);
  const slice = parseSliceType(type);
  const collection = fixed ?? dynamic ?? slice;
  if (collection) {
    const index = `_z_console_index_${context.valueCounter.value++}`;
    const length = fixed ? String(fixed.length) : `(${value}).length`;
    const element = `((${value}).data[${index}])`;
    return [
      `fputc('[', ${stream});`,
      `for (uintptr_t ${index} = 0; ${index} < ${length}; ${index} += 1) {`,
      `  if (${index} > 0) fputs(", ", ${stream});`,
      ...renderConsoleValue(element, collection.elementType, stream, context).map((line) => indent(line, 2)),
      "}",
      `fputc(']', ${stream});`,
    ];
  }

  const declaration = context.structs.get(type);
  if (declaration?.kind === "class") {
    const displayName = context.semanticInfo.typeDisplayNames.get(declaration.name) ?? declaration.name;
    return [`fprintf(${stream}, ${JSON.stringify(`${displayName}@%p`)}, (void *)(${value}));`];
  }
  const recordFields = declaration?.fields
    ?? (foreign?.kind === "record" ? foreign.fields.map((field) => ({ name: field.name, type: { name: field.typeName } })) : null);
  if (recordFields) {
    const displayName = declaration
      ? context.semanticInfo.typeDisplayNames.get(declaration.name) ?? declaration.name
      : foreign?.kind === "record" ? foreign.exportName : type;
    const lines = [`fputs(${JSON.stringify(`${displayName} { `)}, ${stream});`];
    recordFields.forEach((field, index) => {
      if (index > 0) lines.push(`fputs(", ", ${stream});`);
      lines.push(`fputs(${JSON.stringify(`${field.name}: `)}, ${stream});`);
      lines.push(...renderConsoleValue(`(${value}).${field.name}`, field.type.name, stream, context));
    });
    lines.push(`fputs(" }", ${stream});`);
    return lines;
  }

  const enumDeclaration = context.enums.get(type);
  if (enumDeclaration) {
    const displayName = context.semanticInfo.typeDisplayNames.get(enumDeclaration.name) ?? enumDeclaration.name;
    const niche = nicheOptionPayload(enumDeclaration, context.semanticInfo.foreignNamedTypes);
    if (niche) {
      const absent = nicheOptionNull(niche);
      return [
        `if (${value} == ${absent}) {`,
        `  fputs(${JSON.stringify(`${displayName}.none`)}, ${stream});`,
        `} else {`,
        `  fputs(${JSON.stringify(`${displayName}.some(`)}, ${stream});`,
        ...renderConsoleValue(value, niche, stream, context).map((line) => indent(line, 2)),
        `  fputc(')', ${stream});`,
        `}`,
      ];
    }
    const lines = [`switch ((${value}).tag) {`];
    for (const variant of enumDeclaration.variants) {
      lines.push(`  case ${variantTag(type, variant.name)}:`);
      lines.push(`    fputs(${JSON.stringify(`${displayName}.${variant.name}`)}, ${stream});`);
      if (variant.payload) {
        lines.push(`    fputc('(', ${stream});`);
        lines.push(...renderConsoleValue(`(${value}).data.${variant.name}`, variant.payload.name, stream, context).map((line) => indent(line, 4)));
        lines.push(`    fputc(')', ${stream});`);
      }
      lines.push("    break;");
    }
    lines.push("}");
    return lines;
  }
  throw new Error(`console lowering does not support ${JSON.stringify(type)}`);
}

function isObjCStringType(type: string, context: GenerationContext): boolean {
  let interfaceName = type.replace(/^__z_objc:(?:nullable|nonnull):/, "");
  while (true) {
    const declaration = context.semanticInfo.foreignInterfaces.get(interfaceName);
    if (!declaration) return false;
    if (declaration.className === "NSString") return true;
    if (!declaration.superName) return false;
    const separator = interfaceName.lastIndexOf(".");
    if (separator < 0) return false;
    interfaceName = `${interfaceName.slice(0, separator)}.${declaration.superName}`;
  }
}

function renderStringValue(
  value: string,
  type: string,
  target: string,
  context: GenerationContext,
): string[] {
  if (["i8", "i16", "i32", "i64", "isize"].includes(type)) {
    return [`z_string_append_signed(&${target}, (long long)(${value}));`];
  }
  if (["u8", "u16", "u32", "u64", "usize"].includes(type)) {
    return [`z_string_append_unsigned(&${target}, (unsigned long long)(${value}));`];
  }
  if (type === "f32" || type === "f64") {
    return [`z_string_append_float(&${target}, (double)(${value}));`];
  }
  if (type === "boolean") {
    return [`z_string_append_bytes(&${target}, (${value}) ? "true" : "false", (${value}) ? 4 : 5);`];
  }
  if (type === "cstring") return [`z_string_append_cstring(&${target}, ${value});`];
  if (type === "String") return [`z_string_append_bytes(&${target}, (${value}).data, (${value}).length);`];
  if (type === "null") return [`z_string_append_bytes(&${target}, "null", 4);`];

  const foreign = context.semanticInfo.foreignNamedTypes.get(type);
  if (foreign?.kind === "scalar" || foreign?.kind === "enum") {
    return renderStringValue(value, foreign.underlying, target, context);
  }
  if (context.semanticInfo.foreignTypes.has(type)) {
    return [`z_string_append_pointer(&${target}, (void *)(${value}));`];
  }
  if (foreign?.kind === "object" || type.startsWith("__z_objc:")) {
    if (isObjCStringType(type, context)) {
      const length = `_z_string_nsstring_length_${context.valueCounter.value++}`;
      const bytes = `_z_string_nsstring_bytes_${context.valueCounter.value++}`;
      return [
        `if ((${value}) == nil) {`,
        `  z_string_append_bytes(&${target}, "null", 4);`,
        `} else {`,
        `  const NSUInteger ${length} = [(${value}) lengthOfBytesUsingEncoding:NSUTF8StringEncoding];`,
        `  const char *${bytes} = [(${value}) UTF8String];`,
        `  if (${bytes} == NULL && ${length} != 0) abort();`,
        `  z_string_append_bytes(&${target}, ${bytes} != NULL ? ${bytes} : "", (uintptr_t)${length});`,
        `}`,
      ];
    }
    return [`z_string_append_bytes(&${target}, "<Objective-C object>", 20);`];
  }
  if (type.startsWith("__z_objc_class:")) {
    return [`z_string_append_bytes(&${target}, "<Objective-C class>", 19);`];
  }

  const fixed = parseFixedArrayType(type);
  const dynamic = parseDynamicArrayType(type);
  const slice = parseSliceType(type);
  const collection = fixed ?? dynamic ?? slice;
  if (collection) {
    const index = `_z_string_index_${context.valueCounter.value++}`;
    const length = fixed ? String(fixed.length) : `(${value}).length`;
    const element = `((${value}).data[${index}])`;
    return [
      `z_string_append_bytes(&${target}, "[", 1);`,
      `for (uintptr_t ${index} = 0; ${index} < ${length}; ${index} += 1) {`,
      `  if (${index} > 0) z_string_append_bytes(&${target}, ", ", 2);`,
      ...renderStringValue(element, collection.elementType, target, context).map((line) => indent(line, 2)),
      "}",
      `z_string_append_bytes(&${target}, "]", 1);`,
    ];
  }

  const declaration = context.structs.get(type);
  if (declaration?.kind === "class") {
    const displayName = context.semanticInfo.typeDisplayNames.get(declaration.name) ?? declaration.name;
    return [
      `z_string_append_bytes(&${target}, ${JSON.stringify(`${displayName}@`)}, ${displayName.length + 1});`,
      `z_string_append_pointer(&${target}, (void *)(${value}));`,
    ];
  }
  const recordFields = declaration?.fields
    ?? (foreign?.kind === "record" ? foreign.fields.map((field) => ({ name: field.name, type: { name: field.typeName } })) : null);
  if (recordFields) {
    const displayName = declaration
      ? context.semanticInfo.typeDisplayNames.get(declaration.name) ?? declaration.name
      : foreign?.kind === "record" ? foreign.exportName : type;
    const prefix = `${displayName} { `;
    const lines = [`z_string_append_bytes(&${target}, ${JSON.stringify(prefix)}, sizeof(${JSON.stringify(prefix)}) - 1);`];
    recordFields.forEach((field, index) => {
      if (index > 0) lines.push(`z_string_append_bytes(&${target}, ", ", 2);`);
      const label = `${field.name}: `;
      lines.push(`z_string_append_bytes(&${target}, ${JSON.stringify(label)}, sizeof(${JSON.stringify(label)}) - 1);`);
      lines.push(...renderStringValue(`(${value}).${field.name}`, field.type.name, target, context));
    });
    lines.push(`z_string_append_bytes(&${target}, " }", 2);`);
    return lines;
  }

  const enumDeclaration = context.enums.get(type);
  if (enumDeclaration) {
    const displayName = context.semanticInfo.typeDisplayNames.get(enumDeclaration.name) ?? enumDeclaration.name;
    const niche = nicheOptionPayload(enumDeclaration, context.semanticInfo.foreignNamedTypes);
    if (niche) {
      const absent = nicheOptionNull(niche);
      const none = `${displayName}.none`;
      const some = `${displayName}.some(`;
      return [
        `if (${value} == ${absent}) {`,
        `  z_string_append_bytes(&${target}, ${JSON.stringify(none)}, sizeof(${JSON.stringify(none)}) - 1);`,
        `} else {`,
        `  z_string_append_bytes(&${target}, ${JSON.stringify(some)}, sizeof(${JSON.stringify(some)}) - 1);`,
        ...renderStringValue(value, niche, target, context).map((line) => indent(line, 2)),
        `  z_string_append_bytes(&${target}, ")", 1);`,
        `}`,
      ];
    }
    const lines = [`switch ((${value}).tag) {`];
    for (const variant of enumDeclaration.variants) {
      const label = `${displayName}.${variant.name}`;
      lines.push(`  case ${variantTag(type, variant.name)}:`);
      lines.push(`    z_string_append_bytes(&${target}, ${JSON.stringify(label)}, sizeof(${JSON.stringify(label)}) - 1);`);
      if (variant.payload) {
        lines.push(`    z_string_append_bytes(&${target}, "(", 1);`);
        lines.push(...renderStringValue(`(${value}).data.${variant.name}`, variant.payload.name, target, context).map((line) => indent(line, 4)));
        lines.push(`    z_string_append_bytes(&${target}, ")", 1);`);
      }
      lines.push("    break;");
    }
    lines.push("}");
    return lines;
  }
  throw new Error(`String formatting does not support ${JSON.stringify(type)}`);
}

function generateWhile(statement: Extract<Statement, { kind: "while" }>, context: GenerationContext): string {
  const index = context.loopCounter.value++;
  const frame: LoopGenerationFrame = {
    breakLabel: `_z_loop_break_${index}`,
    continueLabel: `_z_loop_continue_${index}`,
    cleanupDepth: context.cleanupScopes.length,
    usedBreak: false,
    usedContinue: false,
  };
  context.loopStack.push(frame);
  let body: string;
  try {
    body = generateBlock(statement.body.statements, context);
  } finally {
    context.loopStack.pop();
  }
  if (frame.usedContinue) body = body.replace(/\n}$/, `\n  ${frame.continueLabel}: ;\n}`);
  const breakLabel = frame.usedBreak ? `\n${frame.breakLabel}: ;` : "";
  return `while ${controlCondition(generateExpression(statement.condition, context))} ${body}${breakLabel}`;
}

function generateObjectDestructure(
  statement: Extract<Statement, { kind: "destructure" }>,
  context: GenerationContext,
): string {
  const sourceType = statement.type?.name ?? directValueType(statement.initializer, context);
  const declaration = context.structs.get(sourceType);
  if (!declaration || declaration.kind !== "struct") throw new Error("object destructuring requires a value struct");
  const temporary = `_z_destructure_${context.valueCounter.value++}`;
  const temporaryDeclaration = generateLocalDeclaration(
    sourceType,
    temporary,
    true,
    context.structs,
    context.enums,
    context.semanticInfo.foreignNamedTypes,
  );
  return generateDirectValue(statement.initializer, context, (value, valueContext) => {
    const lines = [`${temporaryDeclaration} = ${value};`];
    for (const binding of statement.objectBindings) {
      const field = declaration.fields.find((candidate) => candidate.name === binding.fieldName)!;
      const local = generateLocalDeclaration(
        field.type.name,
        binding.bindingName,
        statement.mutable,
        valueContext.structs,
        valueContext.enums,
        valueContext.semanticInfo.foreignNamedTypes,
      );
      lines.push(`${local} = ${temporary}.${field.name};`);
      if (hasCleanupType(field.type.name, valueContext.structs, valueContext.enums, valueContext.semanticInfo.foreignTypes)) {
        lines.push(`${temporary}.${field.name} = ${mapZeroValue(field.type.name, valueContext.structs, valueContext.enums, valueContext.semanticInfo.foreignNamedTypes)};`);
        lines.push(`bool ${ensureLiveFlag(binding.bindingName, valueContext)} = true;`);
      }
    }
    if (hasCleanupType(sourceType, valueContext.structs, valueContext.enums, valueContext.semanticInfo.foreignTypes)) {
      lines.push(generateValueCleanup(temporary, sourceType, null, valueContext));
    }
    return lines.join("\n");
  });
}

function generateFor(statement: Extract<Statement, { kind: "for" }>, context: GenerationContext): string {
  if (statement.asynchronous) {
    throw new Error("for await must be lowered by the async backend");
  }
  if (statement.errorMode !== "none") {
    throw new Error("try for await must be lowered by the async backend");
  }
  const index = context.loopCounter.value++;
  const iterableType = inferExpressionType(statement.iterable, context);
  const iteratorElement = context.semanticInfo.iteratorElementTypes.get(iterableType);
  if (iteratorElement) {
    return generateIteratorFor(statement, iterableType, iteratorElement, index, context);
  }
  const map = parseMapType(iterableType);
  const set = parseSetType(iterableType);
  const collection = parseFixedArrayType(iterableType)
    ?? parseDynamicArrayType(iterableType)
    ?? parseSliceType(iterableType)
    ?? (map ? { elementType: mapEntryTypeName(map.keyType, map.valueType) } : null)
    ?? (set ? { elementType: set.elementType } : null);
  if (!collection) throw new Error("for...of lowering requires an array, Slice, Map, or Set");
  const iterable = generateExpression(statement.iterable, context);
  const storage = map ? `(${iterable}).entries` : set ? `(${iterable}).values` : `(${iterable})`;
  const length = "length" in collection ? String(collection.length) : `${storage}.length`;
  let item = `((${storage}.data[_z_for_index_${index}]))`;
  const borrowedElement = Boolean(map || set)
    || hasCleanupType(collection.elementType, context.structs, context.enums, context.semanticInfo.foreignTypes);
  const loopTypes = new Map(context.localTypes);
  const loopModes = new Map(context.parameterModes);
  if (statement.binding) {
    loopTypes.set(statement.binding, collection.elementType);
    if (borrowedElement) loopModes.set(statement.binding, "in");
  }
  const elementOwner = statement.objectBindings ? context.structs.get(collection.elementType) : null;
  for (const binding of statement.objectBindings ?? []) {
    const field = elementOwner!.fields.find((candidate) => candidate.name === binding.fieldName)!;
    loopTypes.set(binding.bindingName, field.type.name);
    if (borrowedElement && hasCleanupType(field.type.name, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
      loopModes.set(binding.bindingName, "in");
    }
  }
  let loopContext: GenerationContext = { ...context, localTypes: loopTypes, parameterModes: loopModes };
  let persistentIndex: string | null = null;
  const persistentBindings: string[] = [];
  if (context.generatorFrame) {
    persistentIndex = registerGeneratorFrameField(context, {
      name: `_z_for_index_${index}`,
      type: null,
      rawCType: "uintptr_t",
      parameter: false,
    });
    item = `((${storage}.data[${persistentIndex}]))`;
    const storageOverrides = new Map<string, string>();
    if (statement.binding && statement.bindingLocation) {
      const fieldName = `_z_for_binding_${statement.bindingLocation.offset}`;
      if (borrowedElement && context.structs.get(collection.elementType)?.kind !== "class") {
        const elementType = mapType(
          collection.elementType,
          context.structs,
          context.enums,
          context.semanticInfo.foreignNamedTypes,
        );
        const field = registerGeneratorFrameField(context, {
          name: fieldName,
          type: null,
          rawCType: `const ${elementType} *`,
          parameter: false,
        });
        storageOverrides.set(statement.binding, `(*${field})`);
        persistentBindings.push(`${field} = &(${item});`);
      } else {
        const field = registerGeneratorFrameField(context, {
          name: fieldName,
          type: collection.elementType,
          parameter: false,
        });
        storageOverrides.set(statement.binding, field);
        persistentBindings.push(`${field} = ${item};`);
      }
    }
    for (const binding of statement.objectBindings ?? []) {
      const field = elementOwner!.fields.find((candidate) => candidate.name === binding.fieldName)!;
      const fieldValue = `((${item}).${field.name})`;
      const borrowedField = borrowedElement
        && hasCleanupType(field.type.name, context.structs, context.enums, context.semanticInfo.foreignTypes);
      const frameFieldName = `_z_for_binding_${binding.bindingLocation.offset}`;
      if (borrowedField && context.structs.get(field.type.name)?.kind !== "class") {
        const fieldType = mapType(
          field.type.name,
          context.structs,
          context.enums,
          context.semanticInfo.foreignNamedTypes,
        );
        const frameField = registerGeneratorFrameField(context, {
          name: frameFieldName,
          type: null,
          rawCType: `const ${fieldType} *`,
          parameter: false,
        });
        storageOverrides.set(binding.bindingName, `(*${frameField})`);
        persistentBindings.push(`${frameField} = &(${fieldValue});`);
      } else {
        const frameField = registerGeneratorFrameField(context, {
          name: frameFieldName,
          type: field.type.name,
          parameter: false,
        });
        storageOverrides.set(binding.bindingName, frameField);
        persistentBindings.push(`${frameField} = ${fieldValue};`);
      }
    }
    loopContext = withGeneratorStorage(loopContext, storageOverrides);
  }
  const frame: LoopGenerationFrame = {
    breakLabel: `_z_loop_break_${index}`,
    continueLabel: `_z_loop_continue_${index}`,
    cleanupDepth: context.cleanupScopes.length,
    usedBreak: false,
    usedContinue: false,
  };
  context.loopStack.push(frame);
  let body: string;
  try {
    body = generateBlock(statement.body.statements, loopContext);
  } finally {
    context.loopStack.pop();
  }
  const bindingDeclarations: string[] = [];
  if (statement.binding && !context.generatorFrame) {
    const elementType = mapType(collection.elementType, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
    bindingDeclarations.push(borrowedElement
      ? context.structs.get(collection.elementType)?.kind === "class"
        ? `${elementType} const ${statement.binding} = ${item};`
        : `const ${elementType} *${statement.binding} = &(${item});`
      : `${generateLocalDeclaration(collection.elementType, statement.binding, false, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)} = ${item};`);
  }
  for (const binding of context.generatorFrame ? [] : statement.objectBindings ?? []) {
    const field = elementOwner!.fields.find((candidate) => candidate.name === binding.fieldName)!;
    const fieldType = mapType(field.type.name, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
    const fieldValue = `((${item}).${field.name})`;
    const borrowedField = borrowedElement
      && hasCleanupType(field.type.name, context.structs, context.enums, context.semanticInfo.foreignTypes);
    bindingDeclarations.push(borrowedField
      ? context.structs.get(field.type.name)?.kind === "class"
        ? `${fieldType} const ${binding.bindingName} = ${fieldValue};`
        : `const ${fieldType} *${binding.bindingName} = &(${fieldValue});`
      : `${generateLocalDeclaration(field.type.name, binding.bindingName, false, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)} = ${fieldValue};`);
  }
  const bindings = context.generatorFrame ? persistentBindings : bindingDeclarations;
  body = body.replace("{\n", `{\n${bindings.map((line) => `  ${line}`).join("\n")}\n`);
  if (frame.usedContinue) body = body.replace(/\n}$/, `\n  ${frame.continueLabel}: ;\n}`);
  if (persistentIndex) {
    body = body.replace(/\n}$/, `\n  ${persistentIndex} += 1;\n}`);
  }
  const breakLabel = frame.usedBreak ? `\n${frame.breakLabel}: ;` : "";
  return persistentIndex
    ? `${persistentIndex} = 0;\nwhile (${persistentIndex} < ${length}) ${body}${breakLabel}`
    : `for (uintptr_t _z_for_index_${index} = 0; _z_for_index_${index} < ${length}; _z_for_index_${index} += 1) ${body}${breakLabel}`;
}

function generateIteratorFor(
  statement: Extract<Statement, { kind: "for" }>,
  iteratorType: string,
  elementType: string,
  index: number,
  context: GenerationContext,
): string {
  const generator = parseGeneratorType(iteratorType);
  const iteratorDeclaration = context.structs.get(iteratorType);
  const storedGenerator = Boolean(
    generator
    && (statement.iterable.kind === "identifier"
      || statement.iterable.kind === "member"
      || statement.iterable.kind === "index"),
  );
  const temporaryIterator = statement.mode === "auto" && !storedGenerator;
  const iteratorName = `_z_iterator_${index}`;
  const iteratorStorage = temporaryIterator
    ? iteratorName
    : generateAssignmentTarget(statement.iterable, context);
  const iteratorArgument = iteratorDeclaration?.kind === "class"
    ? iteratorStorage
    : `&(${iteratorStorage})`;
  const prefix: string[] = [];
  let iteratorContext = context;
  let iteratorCleanup = "";
  if (temporaryIterator) {
    const declaration = generateLocalDeclaration(
      iteratorType,
      iteratorName,
      true,
      context.structs,
      context.enums,
      context.semanticInfo.foreignNamedTypes,
    );
    prefix.push(`${declaration} = ${generateExpression(statement.iterable, context)};`);
    if (hasCleanupType(iteratorType, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
      const liveFlag = nextLiveFlag(iteratorName, context.liveFlagCounter);
      prefix.push(`bool ${liveFlag} = true;`);
      iteratorContext = {
        ...context,
        liveFlags: new Map(context.liveFlags).set(iteratorName, liveFlag),
        cleanupScopes: [
          ...context.cleanupScopes,
          [{ name: iteratorName, type: iteratorType, liveFlag, value: iteratorName }],
        ],
      };
      iteratorCleanup = generateValueCleanup(iteratorName, iteratorType, liveFlag, iteratorContext);
    }
  }

  const optionType = optionTypeName(elementType);
  const optionDeclaration = context.enums.get(optionType)!;
  const niche = nicheOptionPayload(optionDeclaration, context.semanticInfo.foreignNamedTypes);
  const nextName = `_z_iterator_next_${index}`;
  const nextType = mapType(optionType, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
  const nextCall = generator
    ? `${generatorNextName(iteratorType)}(${iteratorArgument})`
    : `${methodName(iteratorType, "next")}(${iteratorArgument})`;
  const exhausted = niche
    ? `${nextName} == ${nicheOptionNull(niche)}`
    : `${nextName}.tag == ${variantTag(optionType, "none")}`;
  const payload = niche ? nextName : `${nextName}.data.some`;

  const loopTypes = new Map(iteratorContext.localTypes);
  const loopModes = new Map(iteratorContext.parameterModes);
  const bindingScope: CleanupLocal[] = [];
  const bindingContext: GenerationContext = {
    ...iteratorContext,
    localTypes: loopTypes,
    parameterModes: loopModes,
    liveFlags: new Map(iteratorContext.liveFlags),
    cleanupScopes: [...iteratorContext.cleanupScopes, bindingScope],
  };
  const bindingDeclarations: string[] = [];
  if (statement.binding) {
    loopTypes.set(statement.binding, elementType);
    bindingDeclarations.push(
      `${generateLocalDeclaration(elementType, statement.binding, false, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)} = ${payload};`,
      `(void)${cBindingName(statement.binding)};`,
    );
    if (hasCleanupType(elementType, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
      const liveFlag = ensureLiveFlag(statement.binding, bindingContext);
      bindingDeclarations.push(`bool ${liveFlag} = true;`);
      bindingScope.push({ name: statement.binding, type: elementType, liveFlag });
    }
  } else {
    const elementOwner = context.structs.get(elementType)!;
    const hidden = `_z_iterator_value_${index}`;
    bindingDeclarations.push(
      `${generateLocalDeclaration(elementType, hidden, false, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)} = ${payload};`,
    );
    for (const binding of statement.objectBindings ?? []) {
      const field = elementOwner.fields.find((candidate) => candidate.name === binding.fieldName)!;
      loopTypes.set(binding.bindingName, field.type.name);
      bindingDeclarations.push(
        `${generateLocalDeclaration(field.type.name, binding.bindingName, false, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)} = ${hidden}.${field.name};`,
        `(void)${cBindingName(binding.bindingName)};`,
      );
    }
  }
  if (!niche) bindingDeclarations.push(`${nextName}.tag = ${variantTag(optionType, "none")};`);

  const frame: LoopGenerationFrame = {
    breakLabel: `_z_loop_break_${index}`,
    continueLabel: `_z_loop_continue_${index}`,
    cleanupDepth: iteratorContext.cleanupScopes.length,
    usedBreak: false,
    usedContinue: false,
  };
  context.loopStack.push(frame);
  let body: string;
  try {
    body = generateBlock(statement.body.statements, bindingContext);
  } finally {
    context.loopStack.pop();
  }
  const normalBindingCleanup = generateCleanup([bindingScope], bindingContext);
  body = body.replace("{\n", `{\n${bindingDeclarations.map((line) => `  ${line}`).join("\n")}\n`);
  if (normalBindingCleanup) body = body.replace(/\n}$/, `\n${indent(normalBindingCleanup, 2)}\n}`);
  if (frame.usedContinue) body = body.replace(/\n}$/, `\n  ${frame.continueLabel}: ;\n}`);
  const breakLabel = frame.usedBreak ? `\n${frame.breakLabel}: ;` : "";
  const loop = `while (true) {\n  ${nextType} ${nextName} = ${nextCall};\n  if (${exhausted}) break;\n${indent(body, 2)}\n}${breakLabel}`;
  return [...prefix, loop, iteratorCleanup].filter(Boolean).join("\n");
}

function generateLoopTransfer(kind: "break" | "continue", context: GenerationContext): string {
  const frame = context.loopStack.at(-1);
  if (!frame) throw new Error(`${kind} lowering requires an enclosing loop`);
  const cleanup = generateCleanup(context.cleanupScopes.slice(frame.cleanupDepth), context);
  if (kind === "break") frame.usedBreak = true;
  else frame.usedContinue = true;
  const target = kind === "break" ? frame.breakLabel : frame.continueLabel;
  return cleanup ? `${cleanup}\ngoto ${target};` : `goto ${target};`;
}

function generateIf(statement: Extract<Statement, { kind: "if" }>, context: GenerationContext): string {
  const condition = generateExpression(statement.condition, context);
  const thenBranch = generateBlock(statement.thenBranch.statements, context);
  if (!statement.elseBranch) return `if ${controlCondition(condition)} ${thenBranch}`;
  const elseBranch = statement.elseBranch.kind === "if"
    ? generateIf(statement.elseBranch, context)
    : generateBlock(statement.elseBranch.statements, context);
  return `if ${controlCondition(condition)} ${thenBranch} else ${elseBranch}`;
}

function controlCondition(value: string): string {
  return value.startsWith("(") && value.endsWith(")") ? value : `(${value})`;
}

function generateDirectValue(
  expression: Expression,
  context: GenerationContext,
  consumeValue: (value: string, context: GenerationContext) => string,
  consumeTerminates = false,
): string {
  if (context.expressionOverrides.has(expression.location.offset)) {
    return consumeValue(generateExpression(expression, context), context);
  }
  if (expression.kind === "closure") {
    return generateClosureValue(expression, context, consumeValue);
  }
  if (expression.kind === "template") {
    return generateTemplateValue(expression, context, (value, valueContext) => (
      consumeValue(generateBridgedStringValue(expression, value, valueContext), valueContext)
    ));
  }
  if (expression.kind === "new" && expression.arguments.some((argument) => requiresStatementValue(argument, context))) {
    return generateLoweredAggregate(expression, expression.arguments, context, consumeValue, consumeTerminates);
  }
  if (expression.kind === "conditional" && requiresStatementValue(expression, context)) {
    return generateConditionalValue(expression, context, (value, valueContext) => (
      consumeValue(generateBridgedStringValue(expression, value, valueContext), valueContext)
    ), consumeTerminates);
  }
  if (expression.kind === "call" && expression.arguments.some((argument) => callArgumentNeedsLowering(argument, context))) {
    return generateLoweredCall(expression, context, consumeValue, consumeTerminates);
  }
  if ((expression.kind === "structExpression" || expression.kind === "objectExpression") && expression.fields.some((field) => requiresStatementValue(field.expression, context))) {
    return generateLoweredAggregate(expression, expression.fields.map((field) => field.expression), context, consumeValue, consumeTerminates);
  }
  if (expression.kind === "arrayExpression" && expression.elements.some((element) => requiresStatementValue(element, context))) {
    return generateLoweredAggregate(expression, expression.elements, context, consumeValue, consumeTerminates);
  }
  if (expression.kind === "variantExpression" && requiresStatementValue(expression.payload, context)) {
    return generateLoweredAggregate(expression, [expression.payload], context, consumeValue, consumeTerminates);
  }
  if (expression.kind === "attempt" && requiresStatementValue(expression.expression, context)) {
    return generateDirectValue(expression.expression, context, (value, valueContext) => (
      consumeValue(generateBridgedStringValue(expression, value, valueContext), valueContext)
    ), consumeTerminates);
  }
  if (expression.kind === "call" && hasNativeOutArguments(expression, context)) {
    return generateNativeOutCall(expression, context, consumeValue);
  }
  if (expression.kind === "call" && context.semanticInfo.foreignStatusCalls.has(expression.location.offset)) {
    return generateForeignStatusCall(expression, context, consumeValue);
  }
  if (expression.kind === "try") return generateTry(expression, context, consumeValue);
  if (expression.kind === "matchExpression") {
    return generateMatchExpression(expression, context, (value, valueContext) => (
      consumeValue(generateBridgedStringValue(expression, value, valueContext), valueContext)
    ), consumeTerminates);
  }
  if (expression.kind === "ifExpression") {
    return generateIfExpression(expression, context, (value, valueContext) => (
      consumeValue(generateBridgedStringValue(expression, value, valueContext), valueContext)
    ), consumeTerminates);
  }
  if (expression.kind === "whileExpression" || expression.kind === "forExpression") {
    return generateLoopExpression(
      expression,
      context,
      (value, valueContext) => (
        consumeValue(generateBridgedStringValue(expression, value, valueContext), valueContext)
      ),
      consumeTerminates,
    );
  }
  if (expression.kind === "executorPlacement") {
    if (expression.mode !== "sync") {
      throw new Error("asynchronous executor placement must be lowered through task frames");
    }
    return generateValueArm(expression.body, context, consumeValue, consumeTerminates);
  }
  return consumeValue(generateExpression(expression, context), context);
}

function generateBridgedStringValue(expression: Expression, value: string, context: GenerationContext): string {
  if (context.semanticInfo.objcStringsToNative.has(expression.location.offset)) return `z_nsstring_from_string(${value})`;
  if (context.semanticInfo.objcStringsToZ.has(expression.location.offset)) return `z_string_from_nsstring(${value})`;
  if (context.semanticInfo.swiftStringsToZ.has(expression.location.offset)) return `z_string_from_swift(${value})`;
  return value;
}

function requiresStatementValue(expression: Expression, context: GenerationContext): boolean {
  if (context.expressionOverrides.has(expression.location.offset)) return false;
  if (["template", "try", "matchExpression", "ifExpression", "whileExpression", "forExpression"].includes(expression.kind)) return true;
  if (expression.kind === "conditional") {
    return requiresStatementValue(expression.thenExpression, context)
      || requiresStatementValue(expression.elseExpression, context);
  }
  if (expression.kind === "new") return expression.arguments.some((argument) => requiresStatementValue(argument, context));
  if (expression.kind === "call") {
    return context.semanticInfo.foreignStatusCalls.has(expression.location.offset)
      || expression.arguments.some((argument) => requiresStatementValue(argument, context));
  }
  if (expression.kind === "structExpression" || expression.kind === "objectExpression") {
    return expression.fields.some((field) => requiresStatementValue(field.expression, context));
  }
  if (expression.kind === "arrayExpression") {
    return expression.elements.some((element) => requiresStatementValue(element, context));
  }
  if (expression.kind === "variantExpression") return requiresStatementValue(expression.payload, context);
  if (expression.kind === "attempt") return requiresStatementValue(expression.expression, context);
  return false;
}

function callArgumentNeedsLowering(expression: Expression, context: GenerationContext): boolean {
  if (context.expressionOverrides.has(expression.location.offset)) return false;
  if (context.semanticInfo.foreignCallbackTargets.has(expression.location.offset)) return false;
  if (expression.kind === "closure") return true;
  if (requiresStatementValue(expression, context)) return true;
  const access = context.semanticInfo.nativeArgumentAccesses.get(expression.location.offset);
  const type = temporaryValueType(expression, context);
  if (
    access === "in"
    && expression.kind !== "string"
    && !isStableStorageExpression(expression)
    && hasCleanupType(type, context.structs, context.enums, context.semanticInfo.foreignTypes)
  ) return true;
  return context.semanticInfo.cstringConversions.has(expression.location.offset)
    && expression.kind !== "string"
    && !isStableStorageExpression(expression);
}

function generateClosureValue(
  expression: Extract<Expression, { kind: "closure" }>,
  context: GenerationContext,
  consumeValue: (value: string, context: GenerationContext) => string,
): string {
  const closure = context.semanticInfo.closures.get(expression.location.offset)!;
  const functionType = closureFunctionType(closure);
  if (!closure.owned && closure.captures.length === 0) {
    return consumeValue(functionValueLiteral(functionType, closureAdapterName(closure)), context);
  }
  const environmentType = closureEnvironmentName(closure);
  const environment = closure.owned
    ? `_z_closure_environment_${closure.declaration.location.offset}`
    : `_z_borrowed_closure_environment_${closure.declaration.location.offset}`;
  const captures = closure.captures.map((capture) => {
    const captured: Expression = { kind: "identifier", name: capture.name, location: capture.location };
    const value = closure.owned
      ? generateOwnedClosureCaptureValue(capture, context)
      : generateExpression(captured, context);
    const borrowedPointer = !closure.owned
      && capture.mode !== "value"
      && !(capture.mode === "in" && closureCaptureHasReferenceIdentity(capture.type, context.structs, context.semanticInfo.foreignNamedTypes));
    const target = closure.owned ? `${environment}->${capture.name}` : `${environment}.${capture.name}`;
    return `${target} = ${borrowedPointer ? `&(${value})` : value};`;
  });
  const value = functionValueLiteral(
    functionType,
    closureAdapterName(closure),
    closure.owned ? environment : `&(${environment})`,
    closure.owned ? closureEnvironmentRetainName(closure) : "NULL",
    closure.owned ? closureEnvironmentReleaseName(closure) : "NULL",
  );
  if (!closure.owned) {
    return `${environmentType} ${environment};
${captures.join("\n")}
${consumeValue(value, context)}`;
  }
  return `${environmentType} *${environment} = (${environmentType} *)calloc(1, sizeof(${environmentType}));
if (${environment} == NULL) abort();
${environment}->refcount = 1;
${captures.join("\n")}
${consumeValue(value, context)}`;
}

function generateOwnedClosureCaptureValue(
  capture: ClosureInfo["captures"][number],
  context: GenerationContext,
): string {
  const captured: Expression = { kind: "identifier", name: capture.name, location: capture.location };
  let value = generateExpression(captured, context);
  const capturedClass = context.structs.get(capture.type);
  const capturedFunction = parseFunctionType(capture.type);
  if (capture.type === "TaskScope") value = `z_task_scope_retain(${value})`;
  else if (capturedClass?.kind === "class") value = `${retainName(capture.type)}(${value})`;
  else if (capturedFunction) value = `${functionTypeRetainName(capturedFunction)}(${value})`;
  else if (parseWeakType(capture.type)) value = `z_weak_retain(${value})`;
  return value;
}

function isStableStorageExpression(expression: Expression): boolean {
  if (expression.kind === "identifier") return true;
  return (expression.kind === "member" || expression.kind === "index")
    && isStableStorageExpression(expression.object);
}

function withExpressionOverrides(
  context: GenerationContext,
  overrides: ReadonlyMap<number, string>,
): GenerationContext {
  return {
    ...context,
    expressionOverrides: new Map([...context.expressionOverrides, ...overrides]),
  };
}

function temporaryValueType(expression: Expression, context: GenerationContext): string {
  return context.semanticInfo.numericLiteralTypes.get(expression.location.offset)
    ?? context.semanticInfo.expressionTypes.get(expression.location.offset)
    ?? inferExpressionType(expression, context);
}

export function generateObjCBlockArgument(
  block: ForeignBlockType,
  functionValue: string,
  box: string,
  nativeBlock: string,
): string[] {
  const parameters = block.parameters.map((parameter, index) => ({
    type: parameter.cName,
    name: `_z_block_argument_${index + 1}`,
  }));
  const parameterTypes = parameters.map((parameter) => parameter.type).join(", ") || "void";
  const parameterDeclarations = parameters.map((parameter) => `${parameter.type} ${parameter.name}`).join(", ") || "void";
  const arguments_ = parameters.map((parameter) => parameter.name);
  const invoke = `(${functionValue}).call(${box}->_z_context${arguments_.length ? `, ${arguments_.join(", ")}` : ""})`;
  const body = block.returnType.kind === "z" && block.returnType.name === "void"
    ? `${invoke};`
    : `return ${invoke};`;
  return [
    `Z_ObjCClosureBox * const ${box} = [[Z_ObjCClosureBox alloc] initWithContext:(${functionValue}).context retainFunction:(${functionValue}).retain releaseFunction:(${functionValue}).release];`,
    `${block.returnType.cName} (^const ${nativeBlock})(${parameterTypes}) = ^${block.returnType.cName}(${parameterDeclarations}) { ${body} };`,
  ];
}

function generateLoweredCall(
  expression: Extract<Expression, { kind: "call" }>,
  context: GenerationContext,
  consumeValue: (value: string, context: GenerationContext) => string,
  consumeTerminates: boolean,
): string {
  const lines: string[] = [];
  const overrides = new Map<number, string>();
  const borrowedTemporaries: Array<{ readonly name: string; readonly type: string }> = [];
  for (let argumentIndex = 0; argumentIndex < expression.arguments.length; argumentIndex += 1) {
    const argument = expression.arguments[argumentIndex];
    if (context.semanticInfo.taskScopeSpawnCalls.has(expression.location.offset) && argumentIndex === 0) {
      continue;
    }
    if (
      !callArgumentNeedsLowering(argument, context)
      && ["number", "string", "boolean", "null"].includes(argument.kind)
    ) {
      continue;
    }
    const access = context.semanticInfo.nativeArgumentAccesses.get(argument.location.offset)
      ?? context.semanticInfo.foreignArgumentAccesses.get(argument.location.offset)
      ?? (context.semanticInfo.cstringConversions.has(argument.location.offset) ? "in" : undefined);
    const borrowedTemplate = access === "in" && callArgumentNeedsLowering(argument, context);
    if (
      argument.kind === "argumentReference"
      || (access && !borrowedTemplate)
      || context.semanticInfo.sliceConversions.has(argument.location.offset)
    ) {
      continue;
    }
    const type = temporaryValueType(argument, context);
    if (type === "null") continue;
    const temporary = `_z_argument_${context.valueCounter.value++}`;
    lines.push(`${generateLocalDeclaration(type, temporary, true, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)};`);
    lines.push(generateDirectValue(argument, context, (value) => `${temporary} = ${value};`));
    const objcBlock = context.semanticInfo.objcBlockArguments.get(argument.location.offset);
    if (objcBlock) {
      const box = `_z_objc_block_box_${context.valueCounter.value++}`;
      const nativeBlock = `_z_objc_block_${context.valueCounter.value++}`;
      lines.push(...generateObjCBlockArgument(objcBlock, temporary, box, nativeBlock));
      overrides.set(argument.location.offset, nativeBlock);
    } else {
      overrides.set(argument.location.offset, temporary);
    }
    if (borrowedTemplate && hasCleanupType(type, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
      borrowedTemporaries.push({ name: temporary, type });
    }
  }
  const loweredContext = withExpressionOverrides(context, overrides);
  if (borrowedTemporaries.length === 0) {
    lines.push(generateDirectValue(expression, loweredContext, consumeValue, consumeTerminates));
    return lines.join("\n");
  }
  const cleanup = [...borrowedTemporaries]
    .reverse()
    .map((temporary) => generateValueCleanup(temporary.name, temporary.type, null, context))
    .join("\n");
  const resultType = temporaryValueType(expression, loweredContext);
  lines.push(generateDirectValue(expression, loweredContext, (value, valueContext) => {
    if (resultType === "void") return `(void)${value};\n${cleanup}`;
    const result = `_z_call_result_${context.valueCounter.value++}`;
    const declaration = generateLocalDeclaration(
      resultType,
      result,
      false,
      context.structs,
      context.enums,
      context.semanticInfo.foreignNamedTypes,
    );
    return `${declaration} = ${value};\n${cleanup}\n${consumeValue(result, valueContext)}`;
  }, consumeTerminates));
  return lines.join("\n");
}

function generateLoweredAggregate(
  expression: Extract<Expression, { kind: "structExpression" | "objectExpression" | "arrayExpression" | "variantExpression" }>,
  values: readonly Expression[],
  context: GenerationContext,
  consumeValue: (value: string, context: GenerationContext) => string,
  consumeTerminates: boolean,
): string {
  const lines: string[] = [];
  const overrides = new Map<number, string>();
  for (const valueExpression of values) {
    const type = temporaryValueType(valueExpression, context);
    const temporary = `_z_aggregate_${context.valueCounter.value++}`;
    lines.push(`${generateLocalDeclaration(type, temporary, true, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)};`);
    lines.push(generateDirectValue(valueExpression, context, (value) => `${temporary} = ${value};`));
    overrides.set(valueExpression.location.offset, temporary);
  }
  const loweredContext = withExpressionOverrides(context, overrides);
  lines.push(generateDirectValue(expression, loweredContext, consumeValue, consumeTerminates));
  return lines.join("\n");
}

function generateConditionalValue(
  expression: Extract<Expression, { kind: "conditional" }>,
  context: GenerationContext,
  consumeValue: (value: string, context: GenerationContext) => string,
  consumeTerminates: boolean,
): string {
  const condition = generateExpression(expression.condition, context);
  const thenBranch = generateDirectValue(expression.thenExpression, context, consumeValue, consumeTerminates);
  const elseBranch = generateDirectValue(expression.elseExpression, context, consumeValue, consumeTerminates);
  return `if ${controlCondition(condition)} {\n${indent(thenBranch, 2)}\n} else {\n${indent(elseBranch, 2)}\n}`;
}

function generateTemplateValue(
  expression: Extract<Expression, { kind: "template" }>,
  context: GenerationContext,
  consumeValue: (value: string, context: GenerationContext) => string,
): string {
  const temporary = `_z_string_${context.valueCounter.value++}`;
  const lines = [`Z_String ${temporary} = z_string_new();`];
  for (const part of expression.parts) {
    if (part.kind === "text") {
      if (part.value) {
        const literal = JSON.stringify(part.value);
        lines.push(`z_string_append_bytes(&${temporary}, ${literal}, sizeof(${literal}) - 1);`);
      }
      continue;
    }
    const type = context.semanticInfo.expressionTypes.get(part.expression.location.offset)
      ?? inferExpressionType(part.expression, context);
    lines.push(generateDirectValue(part.expression, context, (value) => {
      if (hasCleanupType(type, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
        return renderStringValue(value, type, temporary, context).join("\n");
      }
      const valueTemporary = `_z_string_value_${context.valueCounter.value++}`;
      const declaration = generateLocalDeclaration(
        type,
        valueTemporary,
        false,
        context.structs,
        context.enums,
        context.semanticInfo.foreignNamedTypes,
      );
      return [
        `${declaration} = ${value};`,
        ...renderStringValue(valueTemporary, type, temporary, context),
      ].join("\n");
    }));
  }
  lines.push(consumeValue(temporary, context));
  return lines.join("\n");
}

function generateBorrowedCStringValue(
  expression: Expression,
  context: GenerationContext,
  consumeValue: (value: string) => string,
): string {
  if (expression.kind === "string") return consumeValue(JSON.stringify(expression.value));
  if (isStableStorageExpression(expression)) {
    const value = generateExpression(expression, context);
    return consumeValue(`((${value}).data != NULL ? (${value}).data : "")`);
  }
  const temporary = `_z_cstring_${context.valueCounter.value++}`;
  const declaration = generateLocalDeclaration(
    "String",
    temporary,
    true,
    context.structs,
    context.enums,
    context.semanticInfo.foreignNamedTypes,
  );
  return `${declaration};\n`
    + generateDirectValue(expression, context, (value) => `${temporary} = ${value};`)
    + `\n${consumeValue(`((${temporary}).data != NULL ? (${temporary}).data : "")`)}\n`
    + generateValueCleanup(temporary, "String", null, context);
}

function hasNativeOutArguments(
  expression: Extract<Expression, { kind: "call" }>,
  context: GenerationContext,
): boolean {
  return expression.arguments.some(
    (argument) => context.semanticInfo.nativeArgumentAccesses.get(argument.location.offset) === "out"
      || context.semanticInfo.foreignArgumentAccesses.get(argument.location.offset) === "out",
  );
}

function generateNativeOutCall(
  expression: Extract<Expression, { kind: "call" }>,
  context: GenerationContext,
  consumeValue: (value: string, context: GenerationContext) => string,
): string {
  const before: string[] = [];
  const after: string[] = [];
  for (const argument of expression.arguments) {
    const access = context.semanticInfo.nativeArgumentAccesses.get(argument.location.offset)
      ?? context.semanticInfo.foreignArgumentAccesses.get(argument.location.offset);
    if (access !== "out") continue;
    if (argument.kind !== "argumentReference") throw new Error("native out argument must name storage");
    const type = context.localTypes.get(argument.name)!;
    if (!hasCleanupType(type, context.structs, context.enums, context.semanticInfo.foreignTypes)) continue;
    const value = generateStoredValue(argument.name, context);
    const liveFlag = context.liveFlags.get(argument.name) ?? null;
    before.push(generateValueCleanup(value, type, liveFlag, context));
    if (liveFlag) {
      before.push(`${liveFlag} = false;`);
      after.push(`${liveFlag} = true;`);
    }
  }

  const call = generateExpression(expression, context);
  const status = context.semanticInfo.foreignStatusCalls.get(expression.location.offset);
  if (status) {
    const nativeStatus = `_z_native_status_${context.valueCounter.value++}`;
    const declaration = generateLocalDeclaration(
      status.errorType,
      nativeStatus,
      false,
      context.structs,
      context.enums,
      context.semanticInfo.foreignNamedTypes,
    );
    return [
      ...before,
      `${declaration} = ${call};`,
      ...after,
      consumeValue(foreignStatusResultValue(nativeStatus, status, context), context),
    ].join("\n");
  }
  const returnType = inferExpressionType(expression, context);
  if (returnType === "void") return [...before, `${call};`, ...after].join("\n");

  const temporary = `_z_out_result_${context.valueCounter.value++}`;
  const declaration = generateLocalDeclaration(returnType, temporary, false, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
  return [
    ...before,
    `${declaration} = ${call};`,
    ...after,
    consumeValue(temporary, context),
  ].join("\n");
}

function generateForeignStatusCall(
  expression: Extract<Expression, { kind: "call" }>,
  context: GenerationContext,
  consumeValue: (value: string, context: GenerationContext) => string,
): string {
  const status = context.semanticInfo.foreignStatusCalls.get(expression.location.offset)!;
  const nativeStatus = `_z_native_status_${context.valueCounter.value++}`;
  const declaration = generateLocalDeclaration(
    status.errorType,
    nativeStatus,
    false,
    context.structs,
    context.enums,
    context.semanticInfo.foreignNamedTypes,
  );
  return `${declaration} = ${generateExpression(expression, context)};\n`
    + consumeValue(foreignStatusResultValue(nativeStatus, status, context), context);
}

function foreignStatusResultValue(
  nativeStatus: string,
  status: ForeignStatusCallInfo,
  context: GenerationContext,
): string {
  const result = resultTypeName("void", status.errorType);
  const success = status.success
    .map((value) => `${nativeStatus} == ${value}`)
    .join(" || ");
  return `((${success})`
    + ` ? ${generateCompilerVariantConstruction(result, "success", null, context)}`
    + ` : ${generateCompilerVariantConstruction(result, "failure", nativeStatus, context)})`;
}

function generateStoredValue(name: string, context: GenerationContext): string {
  if (name === "this") {
    if (context.receiver?.kind === "class") return "self";
    return context.owner.receiverMode === "move" ? "self" : "(*self)";
  }
  const generatorStorage = context.generatorFrame?.storage.get(name);
  if (generatorStorage) return generatorStorage;
  const emittedName = cBindingName(name);
  const type = context.localTypes.get(name);
  if (type && parseSliceType(type)) return emittedName;
  if (type && context.structs.get(type)?.kind === "class" && context.parameterModes.get(name) === "in") return emittedName;
  const mode = context.parameterModes.get(name);
  return mode === "in" || mode === "inout" || mode === "out" ? `(*${emittedName})` : emittedName;
}

function generateBlock(statements: Statement[], context: GenerationContext): string {
  const blockTypes = new Map(context.localTypes);
  const blockContext = {
    ...context,
    localTypes: blockTypes,
    liveFlags: new Map(context.liveFlags),
    cleanupScopes: [...context.cleanupScopes, []],
  };
  const body = statements.map((statement) => {
    const generated = generateStatement(statement, blockContext);
    recordVariableType(statement, blockContext);
    return indent(generated, 2);
  });
  if (!statementListTerminates(statements)) {
    const cleanup = generateCleanup([blockContext.cleanupScopes.at(-1)!], blockContext);
    if (cleanup) body.push(indent(cleanup, 2));
  }
  return `{\n${body.join("\n")}\n}`;
}

function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function recordVariableType(statement: Statement, context: GenerationContext): void {
  if (statement.kind === "destructure") {
    for (const binding of statement.objectBindings) {
      const type = context.semanticInfo.bindingTypes.get(binding.bindingLocation.offset);
      if (!type) throw new Error(`missing inferred type for destructured binding ${JSON.stringify(binding.bindingName)}`);
      context.localTypes.set(binding.bindingName, type);
      if (hasCleanupType(type, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
        context.cleanupScopes.at(-1)!.push({ name: binding.bindingName, type, liveFlag: ensureLiveFlag(binding.bindingName, context) });
      }
    }
    return;
  }
  if (statement.kind !== "variable") return;
  const type = statement.type?.name
    ?? (statement.initializer
      ? directValueType(statement.initializer, context)
      : context.semanticInfo.bindingTypes.get(statement.nameLocation.offset));
  if (!type) throw new Error(`missing inferred type for uninitialized binding ${JSON.stringify(statement.name)}`);
  context.localTypes.set(statement.name, type);
  if (hasCleanupType(type, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
    context.cleanupScopes.at(-1)!.push({ name: statement.name, type, liveFlag: ensureLiveFlag(statement.name, context) });
  }
}

function ensureLiveFlag(name: string, context: GenerationContext): string {
  const existing = context.liveFlags.get(name);
  if (existing) return existing;
  const generated = nextLiveFlag(name, context.liveFlagCounter);
  context.liveFlags.set(name, generated);
  return generated;
}

function generateCleanup(scopes: CleanupLocal[][], context: GenerationContext): string {
  const calls: string[] = [];
  for (const scope of [...scopes].reverse()) {
    for (const local of [...scope].reverse()) {
      const cleanup = generateValueCleanup(local.value ?? generateStoredValue(local.name, context), local.type, local.liveFlag, context);
      calls.push(context.generatorFrame ? `${cleanup}\n${local.liveFlag} = false;` : cleanup);
    }
  }
  return calls.join("\n");
}

function generateAssignmentTarget(expression: Expression, context: GenerationContext): string {
  if (expression.kind === "identifier") return generateStoredValue(expression.name, context);
  if (expression.kind === "member") {
    if (expression.object.kind === "identifier" && expression.object.name === "this") {
      if (context.receiver?.kind === "class" || context.owner.receiverMode !== "move") return `self->${expression.property}`;
      return `self.${expression.property}`;
    }
    const ownerType = inferExpressionType(expression.object, context);
    const owner = context.structs.get(ownerType);
    const access = owner?.kind === "class" ? "->" : ".";
    const object = expression.object.kind === "identifier"
      || expression.object.kind === "member"
      || expression.object.kind === "index"
      ? generateAssignmentTarget(expression.object, context)
      : generateExpression(expression.object, context);
    return `(${object})${access}${expression.property}`;
  }
  if (expression.kind === "index") {
    const ownerType = inferExpressionType(expression.object, context);
    const array = parseFixedArrayType(ownerType);
    const owner = expression.object.kind === "identifier"
      || expression.object.kind === "member"
      || expression.object.kind === "index"
      ? generateAssignmentTarget(expression.object, context)
      : generateExpression(expression.object, context);
    const length = array ? String(array.length) : `(${owner}).length`;
    return `((${owner}).data[z_bounds_index((uintptr_t)(${generateExpression(expression.index, context)}), ${length})])`;
  }
  return generateExpression(expression, context);
}

function generateCleanupAwareAssignment(
  statement: Extract<Statement, { kind: "assignment" }>,
  targetType: string,
  context: GenerationContext,
): string {
  const temporary = `_z_replacement_${context.valueCounter.value++}`;
  const temporaryDeclaration = generateLocalDeclaration(
    targetType,
    temporary,
    true,
    context.structs,
    context.enums,
    context.semanticInfo.foreignNamedTypes,
  );
  const target = generateAssignmentTarget(statement.target, context);
  const liveFlag = statement.target.kind === "identifier"
    ? context.liveFlags.get(statement.target.name) ?? null
    : null;
  const replacement = generateDirectValue(
    statement.expression,
    context,
    (value) => `${temporary} = ${value};`,
  );
  const cleanup = generateValueCleanup(target, targetType, liveFlag, context);
  const revive = liveFlag ? `\n${liveFlag} = true;` : "";
  const transferred = requiresNativeMove(
    targetType,
    context.structs,
    context.enums,
    context.semanticInfo.foreignNamedTypes,
  ) ? `std::move(${temporary})` : temporary;
  return `${temporaryDeclaration};\n${replacement}\n${cleanup}\n${target} = ${transferred};${revive}`;
}

function generateValueCleanup(
  value: string,
  type: string,
  liveFlag: string | null,
  context: GenerationContext,
): string {
  if (parseGeneratorType(type)) {
    const release = `${generatorDeinitName(type)}(&(${value}));`;
    return liveFlag ? `if (${liveFlag}) ${release}` : release;
  }
  const functionType = parseFunctionType(type);
  if (functionType) {
    const release = `${functionTypeReleaseName(functionType)}(${value});`;
    return liveFlag ? `if (${liveFlag}) ${release}` : release;
  }
  if (parseWeakType(type)) {
    const release = `z_weak_release(${value});`;
    return liveFlag ? `if (${liveFlag}) ${release}` : release;
  }
  if (type === "String" || type === "TextBuffer") {
    const capacity = `(${value}).capacity > 0`;
    const condition = liveFlag ? `${liveFlag} && ${capacity}` : capacity;
    return `if (${condition}) free((void *)(${value}).data);`;
  }
  if (type === "Arena") {
    const reset = `z_arena_reset(&(${value}));`;
    return liveFlag ? `if (${liveFlag}) ${reset}` : reset;
  }
  if (type === "TaskScope") {
    const release = `z_task_scope_release(${value});`;
    return liveFlag ? `if (${liveFlag}) ${release}` : release;
  }
  if (context.semanticInfo.foreignNamedTypes.get(type)?.kind === "object") {
    const release = `${value} = nil;`;
    return liveFlag ? `if (${liveFlag}) ${release}` : release;
  }
  const dynamic = parseDynamicArrayType(type);
  if (dynamic) {
    const lines: string[] = [];
    if (requiresNativeMove(dynamic.elementType, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)) {
      const index = `_z_cleanup_index_${context.cleanupCounter.value++}`;
      const element = `(${value}).data[${index} - 1]`;
      const managedCleanup = hasSemanticCleanupType(dynamic.elementType, context.structs, context.enums, context.semanticInfo)
        ? `${generateValueCleanup(element, dynamic.elementType, null, context)}\n`
        : "";
      lines.push(`for (uintptr_t ${index} = (${value}).length; ${index} > 0; ${index} -= 1) {\n${indent(`${managedCleanup}std::destroy_at(&${element});`, 2)}\n}`);
      lines.push(`::operator delete((${value}).data);`);
      const cleanup = lines.join("\n");
      return liveFlag ? `if (${liveFlag}) {\n${indent(cleanup, 2)}\n}` : cleanup;
    }
    if (hasSemanticCleanupType(dynamic.elementType, context.structs, context.enums, context.semanticInfo)) {
      const index = `_z_cleanup_index_${context.cleanupCounter.value++}`;
      const element = `(${value}).data[${index} - 1]`;
      const elementCleanup = generateValueCleanup(element, dynamic.elementType, null, context);
      lines.push(`for (uintptr_t ${index} = (${value}).length; ${index} > 0; ${index} -= 1) {\n${indent(elementCleanup, 2)}\n}`);
    }
    lines.push(`free((${value}).data);`);
    const cleanup = lines.join("\n");
    return liveFlag ? `if (${liveFlag}) {\n${indent(cleanup, 2)}\n}` : cleanup;
  }
  const array = parseFixedArrayType(type);
  if (array) {
    const index = `_z_cleanup_index_${context.cleanupCounter.value++}`;
    const element = `(${value}).data[${index} - 1]`;
    const elementCleanup = generateValueCleanup(element, array.elementType, null, context);
    const cleanup = `for (uintptr_t ${index} = ${array.length}; ${index} > 0; ${index} -= 1) {\n${indent(elementCleanup, 2)}\n}`;
    return liveFlag ? `if (${liveFlag}) {\n${indent(cleanup, 2)}\n}` : cleanup;
  }
  const enumDeclaration = context.enums.get(type);
  if (enumDeclaration) {
    const niche = nicheOptionPayload(enumDeclaration, context.semanticInfo.foreignNamedTypes);
    const foreign = niche ? context.semanticInfo.foreignTypes.get(niche) : null;
    if (foreign?.ownership === "owned") {
      const conditions = [liveFlag, `${value} != NULL`].filter(Boolean);
      return `if (${conditions.join(" && ")}) ${foreign.release}(${value});`;
    }
    if (niche) return "";
    const cases = enumDeclaration.variants.flatMap((variant) => {
      if (!variant.payload || !hasSemanticCleanupType(
        variant.payload.name,
        context.structs,
        context.enums,
        context.semanticInfo,
      )) return [];
      const payloadCleanup = generateValueCleanup(`(${value}).data.${variant.name}`, variant.payload.name, null, context);
      return [`case ${variantTag(type, variant.name)}:\n${indent(payloadCleanup, 2)}\n  break;`];
    });
    const cleanup = `switch ((${value}).tag) {\n${indent(cases.join("\n"), 2)}\n  default:\n    break;\n}`;
    return liveFlag ? `if (${liveFlag}) {\n${indent(cleanup, 2)}\n}` : cleanup;
  }
  const foreign = context.semanticInfo.foreignTypes.get(type);
  if (foreign?.ownership === "owned") {
    const conditions = [liveFlag, foreign.nullable ? `${value} != NULL` : null].filter(Boolean);
    const release = `${foreign.release}(${value});`;
    return conditions.length > 0 ? `if (${conditions.join(" && ")}) ${release}` : release;
  }
  const declaration = context.structs.get(type);
  if (declaration?.kind === "class") {
    const release = `${releaseName(type)}(${value});`;
    return liveFlag ? `if (${liveFlag}) ${release}` : release;
  }
  const cleanup = `${deinitName(type)}(&(${value}));`;
  return liveFlag ? `if (${liveFlag}) ${cleanup}` : cleanup;
}

function generateSuccessReturn(value: string, context: GenerationContext, view = false): string {
  const cleanup = generateCleanup(context.cleanupScopes, context);
  if (view) {
    const returned = `return &(${value});`;
    return cleanup ? `${cleanup}\n${returned}` : returned;
  }
  if (!cleanup) {
    if (!context.owner.errorType) {
      // C++ implicitly moves a named local or value parameter from a return
      // statement. Keeping an explicit std::move here triggers
      // -Wredundant-move under Z's warning-as-error native build.
      const nativeReturn = requiresNativeMove(
        context.owner.returnType.name,
        context.structs,
        context.enums,
        context.semanticInfo.foreignNamedTypes,
      );
      const redundant = nativeReturn ? /^std::move\(([^()]+)\)$/.exec(value) : null;
      return `return ${redundant ? redundant[1] : value};`;
    }
    const result = resultTypeName(context.owner.returnType.name, context.owner.errorType.name);
    return `return ${generateCompilerVariantConstruction(result, "success", value, context)};`;
  }
  const temporary = `_z_return_${context.returnCounter.value++}`;
  const declaration = generateLocalDeclaration(context.owner.returnType.name, temporary, false, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
  const returned = context.owner.errorType
    ? `return ${generateCompilerVariantConstruction(
        resultTypeName(context.owner.returnType.name, context.owner.errorType.name),
        "success",
        requiresNativeMove(
          context.owner.returnType.name,
          context.structs,
          context.enums,
          context.semanticInfo.foreignNamedTypes,
        ) ? `std::move(${temporary})` : temporary,
        context,
      )};`
    : `return ${temporary};`;
  return `${declaration} = ${value};\n${cleanup}\n${returned}`;
}

function generateTry(
  expression: Extract<Expression, { kind: "try" }>,
  context: GenerationContext,
  consumeSuccess: (value: string, context: GenerationContext) => string,
): string {
  const resultType = throwingCallResultType(expression.expression, context);
  const temporary = `_z_try_${context.tryCounter.value++}`;
  const generator = context.generatorFrame ? parseGeneratorType(context.owner.returnType.name) : null;
  const generatorSuccess = generator
    ? generator.returnType
      ? generatorStepTypeName(generator.elementType, generator.returnType)
      : optionTypeName(generator.elementType)
    : null;
  const ownerResult = resultTypeName(
    generatorSuccess ?? context.owner.returnType.name,
    context.owner.errorType!.name,
  );
  const cleanup = generateCleanup(context.cleanupScopes, context);
  const releaseSelf = context.constructorSelf ? `free(${context.constructorSelf});\n` : "";
  const propagatedError = context.owner.errorType && requiresNativeMove(
    context.owner.errorType.name,
    context.structs,
    context.enums,
    context.semanticInfo.foreignNamedTypes,
  ) ? `std::move(${temporary}.data.failure)` : `${temporary}.data.failure`;
  const finishGenerator = generator ? "frame->state = -1;\n" : "";
  const failureReturn = `${releaseSelf}${finishGenerator}return ${generateCompilerVariantConstruction(ownerResult, "failure", propagatedError, context)};`;
  const successType = trySuccessType(expression, context);
  const successValue = successType === "void"
    ? "0"
    : requiresNativeMove(successType, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)
      ? `std::move(${temporary}.data.success)`
      : `${temporary}.data.success`;
  return generateDirectValue(expression.expression, context, (value) => (
    `${generateLocalDeclaration(resultType, temporary, false, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)} = ${value};\n`
      + `if (${temporary}.tag == ${variantTag(resultType, "failure")}) {\n`
      + `${cleanup ? `${indent(cleanup, 2)}\n` : ""}`
      + `${indent(failureReturn, 2)}\n`
      + `}\n`
      + consumeSuccess(successValue, context)
  ));
}

function trySuccessType(expression: Extract<Expression, { kind: "try" }>, context: GenerationContext): string {
  const result = context.enums.get(throwingCallResultType(expression.expression, context))!;
  return result.variants.find((variant) => variant.name === "success")!.payload?.name ?? "void";
}

function throwingCallResultType(expression: Expression, context: GenerationContext): string {
  if (expression.kind === "call") {
    const status = context.semanticInfo.foreignStatusCalls.get(expression.location.offset);
    if (status) return resultTypeName("void", status.errorType);
  }
  if (expression.kind === "new") {
    const constructor = context.structs.get(expression.typeName)?.constructor;
    if (!constructor?.errorType) throw new Error("try lowering expected a throwing constructor");
    return resultTypeName(expression.typeName, constructor.errorType.name);
  }
  if (expression.kind === "call" && expression.callee.kind === "identifier") {
    const closure = closureForType(context.localTypes.get(expression.callee.name), context.semanticInfo);
    if (closure?.declaration.errorType) {
      return resultTypeName(closure.declaration.returnType.name, closure.declaration.errorType.name);
    }
    const target = context.functions.get(expression.callee.name)!;
    return resultTypeName(target.returnType.name, target.errorType!.name);
  }
  if (expression.kind === "call" && expression.callee.kind === "member") {
    const standard = context.semanticInfo.standardFunctionReferences.get(expression.callee.location.offset);
    if (standard) {
      const signature = standardFunctionSignature(standard);
      if (!signature.errorType) throw new Error("try lowering expected a throwing standard call");
      return resultTypeName(signature.returnType, signature.errorType);
    }
    if (expression.callee.object.kind === "identifier") {
      const owner = context.structs.get(expression.callee.object.name);
      const method = owner?.methods.find((candidate) => candidate.static && candidate.name === expression.callee.property);
      if (method) return resultTypeName(method.returnType.name, method.errorType!.name);
    }
    const receiverType = inferExpressionType(expression.callee.object, context);
    const generator = parseGeneratorType(receiverType);
    if (generator && expression.callee.property === "next" && generator.errorType) {
      const success = generator.returnType
        ? generatorStepTypeName(generator.elementType, generator.returnType)
        : optionTypeName(generator.elementType);
      return resultTypeName(success, generator.errorType);
    }
    const weak = parseWeakType(receiverType);
    if (weak && expression.callee.property === "upgrade") return weakResultTypeName(weak.target);
    const receiver = context.structs.get(receiverType)!;
    const method = receiver.methods.find((candidate) => candidate.name === expression.callee.property)!;
    return resultTypeName(method.returnType.name, method.errorType!.name);
  }
  throw new Error("try lowering expected a throwing call");
}

function generateLocalDeclaration(
  type: string,
  name: string,
  mutable: boolean,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  name = cBindingName(name);
  if (type === objcConnectionTypeName) {
    const cType = mapType(type, structs, enums, foreignNamedTypes);
    const declaration = mutable ? `${cType}${name}` : `${cType} const ${name}`;
    return `__attribute__((objc_precise_lifetime, unused)) ${declaration}`;
  }
  if (type === "cstring") {
    return mutable ? `const char *${name}` : `const char * const ${name}`;
  }
  if (parseViewType(type)) {
    const cType = mapType(type, structs, enums, foreignNamedTypes);
    return mutable ? `${cType} ${name}` : `${cType} const ${name}`;
  }
  if (type.startsWith("__z_ffi:")) {
    const cType = mapType(type, structs, enums, foreignNamedTypes);
    return mutable ? `${cType}${name}` : `${cType} const ${name}`;
  }
  if (type.startsWith("__z_objc:")) {
    const cType = mapType(type, structs, enums, foreignNamedTypes);
    return mutable ? `${cType}${name}` : `${cType} const ${name}`;
  }
  if (foreignNamedTypes.get(type)?.kind === "object") {
    const cType = mapType(type, structs, enums, foreignNamedTypes);
    return mutable ? `${cType}${name}` : `${cType} const ${name}`;
  }
  if (requiresNativeMove(type, structs, enums, foreignNamedTypes)) {
    // Z still treats a const binding as immutable. C++ move construction,
    // however, requires a non-const source object for its rvalue reference.
    return `${mapType(type, structs, enums, foreignNamedTypes)} ${name}`;
  }
  const declaration = structs.get(type);
  if (declaration?.kind === "class") {
    const cType = mapType(type, structs, enums, foreignNamedTypes);
    return mutable ? `${cType}${name}` : `${cType} const ${name}`;
  }
  if (hasCleanupType(type, structs, enums)) return `${mapType(type, structs, enums, foreignNamedTypes)} ${name}`;
  return `${mutable ? "" : "const "}${mapType(type, structs, enums, foreignNamedTypes)} ${name}`;
}

function generateMatch(statement: Extract<Statement, { kind: "match" }>, context: GenerationContext): string {
  const type = inferExpressionType(statement.expression, context);
  const declaration = context.enums.get(type)!;
  const niche = nicheOptionPayload(declaration, context.semanticInfo.foreignNamedTypes);
  if (niche) return generateNicheOptionMatch(statement, context, declaration, niche);
  const temporary = `_z_match_${context.matchCounter.value++}`;
  const subject = generateExpression(statement.expression, context);
  const borrowed = context.semanticInfo.borrowedMatches.has(statement.location.offset);
  let access = borrowed ? `${temporary}->` : `${temporary}.`;
  let subjectStorage: string;
  if (context.generatorFrame) {
    if (borrowed) {
      access = `(&(${subject}))->`;
      subjectStorage = "";
    } else {
      const persistentSubject = registerGeneratorFrameField(context, {
        name: `_z_match_subject_${statement.location.offset}`,
        type,
        parameter: false,
      });
      access = `${persistentSubject}.`;
      subjectStorage = `${persistentSubject} = ${subject};`;
    }
  } else {
    subjectStorage = borrowed
      ? `const ${enumName(type)} *${temporary} = &(${subject});`
      : `${requiresNativeMove(type, context.structs, context.enums, context.semanticInfo.foreignNamedTypes) ? "" : "const "}${enumName(type)} ${temporary} = ${subject};`;
  }
  const arms = statement.arms.map((arm) => {
    const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName)!;
    const armTypes = new Map(context.localTypes);
    const armModes = new Map(context.parameterModes);
    if (variant.payload && arm.binding) armTypes.set(arm.binding, variant.payload.name);
    const payloadDeclaration = variant.payload ? context.structs.get(variant.payload.name) : null;
    for (const fieldBinding of arm.objectBindings ?? []) {
      const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
      armTypes.set(fieldBinding.bindingName, field.type.name);
      if (hasCleanupType(field.type.name, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
        armModes.set(fieldBinding.bindingName, "in");
      }
    }
    const borrowedPayload = Boolean(borrowed && variant.payload && (
      hasCleanupType(variant.payload.name, context.structs, context.enums, context.semanticInfo.foreignTypes)
      || requiresNativeMove(variant.payload.name, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)
    ));
    if (borrowedPayload && arm.binding) armModes.set(arm.binding, "in");
    let armContext: GenerationContext = {
      ...context,
      localTypes: armTypes,
      parameterModes: armModes,
      liveFlags: new Map(context.liveFlags),
      cleanupScopes: [...context.cleanupScopes, []],
    };
    let binding = "";
    if (context.generatorFrame) {
      const storageOverrides = new Map<string, string>();
      const bindingLines: string[] = [];
      if (variant.payload && arm.binding && arm.bindingLocation) {
        const persistent = registerPersistentGeneratorBinding(
          context,
          `_z_match_binding_${arm.bindingLocation.offset}`,
          variant.payload.name,
          `${access}data.${variant.name}`,
          borrowedPayload,
        );
        storageOverrides.set(arm.binding, persistent.storage);
        bindingLines.push(persistent.initialization, `(void)${persistent.storage};`);
        if (persistent.liveFlag) {
          armContext.liveFlags.set(arm.binding, persistent.liveFlag);
          armContext.cleanupScopes.at(-1)!.push({
            name: arm.binding,
            type: variant.payload.name,
            liveFlag: persistent.liveFlag,
            value: persistent.storage,
          });
        }
      }
      if (variant.payload && arm.objectBindings) {
        const hiddenName = `_z_match_payload_${arm.location.offset}`;
        const hidden = registerPersistentGeneratorBinding(
          context,
          hiddenName,
          variant.payload.name,
          `${access}data.${variant.name}`,
          borrowedPayload,
        );
        bindingLines.push(hidden.initialization);
        const hiddenAccess = payloadDeclaration?.kind === "class"
          ? `${hidden.storage}->`
          : `(${hidden.storage}).`;
        for (const fieldBinding of arm.objectBindings) {
          const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
          const fieldBorrowed = hasCleanupType(field.type.name, context.structs, context.enums, context.semanticInfo.foreignTypes)
            || requiresNativeMove(field.type.name, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
          const persistent = registerPersistentGeneratorBinding(
            context,
            `_z_match_binding_${fieldBinding.bindingLocation.offset}`,
            field.type.name,
            `${hiddenAccess}${field.name}`,
            fieldBorrowed,
          );
          storageOverrides.set(fieldBinding.bindingName, persistent.storage);
          bindingLines.push(persistent.initialization, `(void)${persistent.storage};`);
        }
        if (hidden.liveFlag) {
          armContext.cleanupScopes.at(-1)!.push({
            name: hiddenName,
            type: variant.payload.name,
            liveFlag: hidden.liveFlag,
            value: hidden.storage,
          });
        }
      }
      armContext = withGeneratorStorage(armContext, storageOverrides);
      if (bindingLines.length > 0) binding = `\n    ${bindingLines.join("\n    ")}`;
    } else {
      binding = variant.payload && arm.binding
        ? `\n    ${generateMatchBinding(variant.payload.name, arm.binding, `${access}data.${variant.name}`, borrowedPayload, context)}\n    (void)${cBindingName(arm.binding)};`
        : "";
      if (!borrowed && variant.payload && arm.binding && hasCleanupType(variant.payload.name, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
        const liveFlag = ensureLiveFlag(arm.binding, armContext);
        armContext.cleanupScopes.at(-1)!.push({ name: arm.binding, type: variant.payload.name, liveFlag });
        binding += `\n    bool ${liveFlag} = true;`;
      }
      if (variant.payload && arm.objectBindings) {
        const hidden = `${temporary}_${variant.name}_payload`;
        binding += `\n    ${generateMatchBinding(variant.payload.name, hidden, `${access}data.${variant.name}`, borrowedPayload, context)}`;
        const hiddenAccess = payloadDeclaration?.kind === "class" || borrowedPayload ? `${hidden}->` : `${hidden}.`;
        for (const fieldBinding of arm.objectBindings) {
          const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
          const fieldBorrowed = hasCleanupType(field.type.name, context.structs, context.enums, context.semanticInfo.foreignTypes)
            || requiresNativeMove(field.type.name, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
          binding += `\n    ${generateMatchBinding(field.type.name, fieldBinding.bindingName, `${hiddenAccess}${field.name}`, fieldBorrowed, context)}`;
          binding += `\n    (void)${cBindingName(fieldBinding.bindingName)};`;
        }
        if (!borrowedPayload && hasCleanupType(variant.payload.name, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
          const liveFlag = ensureLiveFlag(hidden, armContext);
          armContext.cleanupScopes.at(-1)!.push({ name: hidden, type: variant.payload.name, liveFlag });
          binding += `\n    bool ${liveFlag} = true;`;
        }
      }
    }
    const body = generateStatement(arm.body, armContext);
    recordVariableType(arm.body, armContext);
    const cleanup = statementTerminates(arm.body)
      ? ""
      : generateCleanup([armContext.cleanupScopes.at(-1)!], armContext);
    const lines = [body, cleanup, statementTerminates(arm.body) ? "" : "break;"].filter(Boolean).join("\n");
    return `  case ${variantTag(type, variant.name)}: {${binding}\n${indent(lines, 4)}\n  }`;
  }).join("\n");
  const invalid = requiresNativeMove(type, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)
    ? "\n  default:\n    abort();"
    : "";
  return `${subjectStorage ? `${subjectStorage}\n` : ""}switch (${access}tag) {\n${arms}${invalid}\n}`;
}

function generateMatchExpression(
  expression: Extract<Expression, { kind: "matchExpression" }>,
  context: GenerationContext,
  consumeValue: (value: string, context: GenerationContext) => string,
  consumeTerminates: boolean,
): string {
  const type = inferExpressionType(expression.expression, context);
  const declaration = context.enums.get(type)!;
  const niche = nicheOptionPayload(declaration, context.semanticInfo.foreignNamedTypes);
  if (niche) {
    return generateNicheOptionMatchExpression(expression, context, declaration, niche, consumeValue, consumeTerminates);
  }
  const temporary = `_z_match_${context.matchCounter.value++}`;
  const subject = generateExpression(expression.expression, context);
  const borrowed = context.semanticInfo.borrowedMatches.has(expression.location.offset);
  const access = borrowed ? `${temporary}->` : `${temporary}.`;
  const arms = expression.arms.map((arm) => {
    const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName)!;
    const armTypes = new Map(context.localTypes);
    const armModes = new Map(context.parameterModes);
    if (variant.payload && arm.binding) armTypes.set(arm.binding, variant.payload.name);
    const payloadDeclaration = variant.payload ? context.structs.get(variant.payload.name) : null;
    for (const fieldBinding of arm.objectBindings ?? []) {
      const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
      armTypes.set(fieldBinding.bindingName, field.type.name);
      if (hasCleanupType(field.type.name, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
        armModes.set(fieldBinding.bindingName, "in");
      }
    }
    const borrowedPayload = Boolean(borrowed && variant.payload && (
      hasCleanupType(variant.payload.name, context.structs, context.enums, context.semanticInfo.foreignTypes)
      || requiresNativeMove(variant.payload.name, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)
    ));
    if (borrowedPayload && arm.binding) armModes.set(arm.binding, "in");
    const armContext = {
      ...context,
      localTypes: armTypes,
      parameterModes: armModes,
      liveFlags: new Map(context.liveFlags),
      cleanupScopes: [...context.cleanupScopes, []],
    };
    let binding = variant.payload && arm.binding
      ? `\n    ${generateMatchBinding(variant.payload.name, arm.binding, `${access}data.${variant.name}`, borrowedPayload, context)}\n    (void)${cBindingName(arm.binding)};`
      : "";
    if (!borrowed && variant.payload && arm.binding && hasCleanupType(variant.payload.name, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
      const liveFlag = ensureLiveFlag(arm.binding, armContext);
      armContext.cleanupScopes.at(-1)!.push({ name: arm.binding, type: variant.payload.name, liveFlag });
      binding += `\n    bool ${liveFlag} = true;`;
    }
    if (variant.payload && arm.objectBindings) {
      const hidden = `${temporary}_${variant.name}_payload`;
      binding += `\n    ${generateMatchBinding(variant.payload.name, hidden, `${access}data.${variant.name}`, borrowedPayload, context)}`;
      const hiddenAccess = payloadDeclaration?.kind === "class" || borrowedPayload ? `${hidden}->` : `${hidden}.`;
      for (const fieldBinding of arm.objectBindings) {
        const field = payloadDeclaration!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
        const fieldBorrowed = hasCleanupType(field.type.name, context.structs, context.enums, context.semanticInfo.foreignTypes)
          || requiresNativeMove(field.type.name, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
        binding += `\n    ${generateMatchBinding(field.type.name, fieldBinding.bindingName, `${hiddenAccess}${field.name}`, fieldBorrowed, context)}`;
        binding += `\n    (void)${cBindingName(fieldBinding.bindingName)};`;
      }
      if (!borrowedPayload && hasCleanupType(variant.payload.name, context.structs, context.enums, context.semanticInfo.foreignTypes)) {
        const liveFlag = ensureLiveFlag(hidden, armContext);
        armContext.cleanupScopes.at(-1)!.push({ name: hidden, type: variant.payload.name, liveFlag });
        binding += `\n    bool ${liveFlag} = true;`;
      }
    }
    const body = generateValueArm(arm.body, armContext, consumeValue, consumeTerminates);
    const cleanup = consumeTerminates || valueArmTerminates(arm.body)
      ? ""
      : generateCleanup([armContext.cleanupScopes.at(-1)!], armContext);
    const lines = [
      body,
      cleanup,
      consumeTerminates || valueArmTerminates(arm.body) ? "" : "break;",
    ].filter(Boolean).join("\n");
    return `  case ${variantTag(type, variant.name)}: {${binding}\n${indent(lines, 4)}\n  }`;
  }).join("\n");
  const storage = borrowed
    ? `const ${enumName(type)} *${temporary} = &(${subject});`
    : `${requiresNativeMove(type, context.structs, context.enums, context.semanticInfo.foreignNamedTypes) ? "" : "const "}${enumName(type)} ${temporary} = ${subject};`;
  const invalid = requiresNativeMove(type, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)
    ? "\n  default:\n    abort();"
    : "";
  return `${storage}\nswitch (${access}tag) {\n${arms}${invalid}\n}`;
}

function generateNicheOptionMatch(
  statement: Extract<Statement, { kind: "match" }>,
  context: GenerationContext,
  declaration: EnumDeclaration,
  payloadType: string,
): string {
  const type = declaration.name;
  const temporary = `_z_match_${context.matchCounter.value++}`;
  const borrowed = context.semanticInfo.borrowedMatches.has(statement.location.offset);
  const cleanupBearing = hasCleanupType(
    payloadType,
    context.structs,
    context.enums,
    context.semanticInfo.foreignTypes,
  );
  const localDeclaration = generateLocalDeclaration(
    type,
    temporary,
    requiresStatementValue(statement.expression, context),
    context.structs,
    context.enums,
    context.semanticInfo.foreignNamedTypes,
  );
  let matchValue = temporary;
  let storage: string;
  if (context.generatorFrame) {
    matchValue = registerGeneratorFrameField(context, {
      name: `_z_match_subject_${statement.location.offset}`,
      type,
      parameter: false,
    });
    storage = requiresStatementValue(statement.expression, context)
      ? generateDirectValue(statement.expression, context, (value) => `${matchValue} = ${value};`)
      : `${matchValue} = ${generateExpression(statement.expression, context)};`;
  } else {
    storage = requiresStatementValue(statement.expression, context)
      ? `${localDeclaration};\n${generateDirectValue(statement.expression, context, (value) => `${temporary} = ${value};`)}`
      : `${localDeclaration} = ${generateExpression(statement.expression, context)};`;
  }
  const some = statement.arms.find((arm) => arm.variantName === "some")!;
  const none = statement.arms.find((arm) => arm.variantName === "none")!;
  const renderArm = (arm: typeof some, present: boolean): string => {
    const localTypes = new Map(context.localTypes);
    const parameterModes = new Map(context.parameterModes);
    if (present && arm.binding) localTypes.set(arm.binding, payloadType);
    const payloadBorrowed = borrowed && cleanupBearing;
    if (present && arm.binding && payloadBorrowed) parameterModes.set(arm.binding, "in");
    let armContext: GenerationContext = {
      ...context,
      localTypes,
      parameterModes,
      liveFlags: new Map(context.liveFlags),
      cleanupScopes: [...context.cleanupScopes, []],
    };
    let binding = "";
    if (present && arm.binding && arm.bindingLocation && context.generatorFrame) {
      const persistent = registerPersistentGeneratorBinding(
        context,
        `_z_match_binding_${arm.bindingLocation.offset}`,
        payloadType,
        matchValue,
        payloadBorrowed,
      );
      armContext = withGeneratorStorage(
        armContext,
        new Map([[arm.binding, persistent.storage]]),
      );
      binding = `${persistent.initialization}\n(void)${persistent.storage};`;
      if (persistent.liveFlag) {
        armContext.liveFlags.set(arm.binding, persistent.liveFlag);
        armContext.cleanupScopes.at(-1)!.push({
          name: arm.binding,
          type: payloadType,
          liveFlag: persistent.liveFlag,
          value: persistent.storage,
        });
      }
    } else {
      binding = present && arm.binding
        ? `${generateMatchBinding(payloadType, arm.binding, temporary, payloadBorrowed, context)}\n(void)${cBindingName(arm.binding)};`
        : "";
      if (present && arm.binding && !borrowed && cleanupBearing) {
        const liveFlag = ensureLiveFlag(arm.binding, armContext);
        armContext.cleanupScopes.at(-1)!.push({ name: arm.binding, type: payloadType, liveFlag });
        binding += `\nbool ${liveFlag} = true;`;
      }
    }
    const body = generateStatement(arm.body, armContext);
    recordVariableType(arm.body, armContext);
    const cleanup = statementTerminates(arm.body)
      ? ""
      : generateCleanup([armContext.cleanupScopes.at(-1)!], armContext);
    return `{\n${indent([binding, body, cleanup].filter(Boolean).join("\n"), 2)}\n}`;
  };
  return `${storage}\nif (${matchValue} != ${nicheOptionNull(payloadType)}) ${renderArm(some, true)} else ${renderArm(none, false)}`;
}

function generateNicheOptionMatchExpression(
  expression: Extract<Expression, { kind: "matchExpression" }>,
  context: GenerationContext,
  declaration: EnumDeclaration,
  payloadType: string,
  consumeValue: (value: string, context: GenerationContext) => string,
  consumeTerminates: boolean,
): string {
  const type = declaration.name;
  const temporary = `_z_match_${context.matchCounter.value++}`;
  const borrowed = context.semanticInfo.borrowedMatches.has(expression.location.offset);
  const cleanupBearing = hasCleanupType(
    payloadType,
    context.structs,
    context.enums,
    context.semanticInfo.foreignTypes,
  );
  const needsLowering = requiresStatementValue(expression.expression, context);
  const localDeclaration = generateLocalDeclaration(
    type,
    temporary,
    needsLowering,
    context.structs,
    context.enums,
    context.semanticInfo.foreignNamedTypes,
  );
  const storage = needsLowering
    ? `${localDeclaration};\n${generateDirectValue(expression.expression, context, (value) => `${temporary} = ${value};`)}`
    : `${localDeclaration} = ${generateExpression(expression.expression, context)};`;
  const some = expression.arms.find((arm) => arm.variantName === "some")!;
  const none = expression.arms.find((arm) => arm.variantName === "none")!;
  const renderArm = (arm: typeof some, present: boolean): string => {
    const localTypes = new Map(context.localTypes);
    const parameterModes = new Map(context.parameterModes);
    if (present && arm.binding) localTypes.set(arm.binding, payloadType);
    const payloadBorrowed = borrowed && cleanupBearing;
    if (present && arm.binding && payloadBorrowed) parameterModes.set(arm.binding, "in");
    const armContext = {
      ...context,
      localTypes,
      parameterModes,
      liveFlags: new Map(context.liveFlags),
      cleanupScopes: [...context.cleanupScopes, []],
    };
    let binding = present && arm.binding
      ? `${generateMatchBinding(payloadType, arm.binding, temporary, payloadBorrowed, context)}\n(void)${cBindingName(arm.binding)};`
      : "";
    if (present && arm.binding && !borrowed && cleanupBearing) {
      const liveFlag = ensureLiveFlag(arm.binding, armContext);
      armContext.cleanupScopes.at(-1)!.push({ name: arm.binding, type: payloadType, liveFlag });
      binding += `\nbool ${liveFlag} = true;`;
    }
    const body = generateValueArm(arm.body, armContext, consumeValue, consumeTerminates);
    const cleanup = consumeTerminates || valueArmTerminates(arm.body)
      ? ""
      : generateCleanup([armContext.cleanupScopes.at(-1)!], armContext);
    return `{\n${indent([binding, body, cleanup].filter(Boolean).join("\n"), 2)}\n}`;
  };
  return `${storage}\nif (${temporary} != ${nicheOptionNull(payloadType)}) ${renderArm(some, true)} else ${renderArm(none, false)}`;
}

type PersistentGeneratorBinding = {
  readonly storage: string;
  readonly initialization: string;
  readonly liveFlag: string | null;
};

function registerPersistentGeneratorBinding(
  context: GenerationContext,
  fieldName: string,
  type: string,
  payload: string,
  borrowed: boolean,
): PersistentGeneratorBinding {
  if (!context.generatorFrame) throw new Error("persistent pattern binding requires a generator frame");
  const borrowedReferenceIdentity = borrowed && (
    closureCaptureHasReferenceIdentity(type, context.structs, context.semanticInfo.foreignNamedTypes)
    || Boolean(parsePointerTypeName(type))
    || Boolean(parseViewType(type))
  );
  if (borrowed && !borrowedReferenceIdentity) {
    const mapped = mapType(type, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
    const field = registerGeneratorFrameField(context, {
      name: fieldName,
      type: null,
      rawCType: `const ${mapped} *`,
      parameter: false,
    });
    return {
      storage: `(*${field})`,
      initialization: `${field} = &(${payload});`,
      liveFlag: null,
    };
  }

  const field = registerGeneratorFrameField(context, {
    name: fieldName,
    type,
    parameter: false,
  });
  const value = !borrowed && requiresNativeMove(
    type,
    context.structs,
    context.enums,
    context.semanticInfo.foreignNamedTypes,
  )
    ? `std::move(${payload})`
    : payload;
  const cleanupBearing = !borrowed
    && hasCleanupType(type, context.structs, context.enums, context.semanticInfo.foreignTypes);
  const liveFlag = cleanupBearing ? `frame->${cBindingName(fieldName)}_live` : null;
  if (liveFlag) context.generatorFrame.liveFlags.set(fieldName, liveFlag);
  return {
    storage: field,
    initialization: `${field} = ${value};${liveFlag ? `\n    ${liveFlag} = true;` : ""}`,
    liveFlag,
  };
}

function generateMatchBinding(
  type: string,
  name: string,
  payload: string,
  borrowed: boolean,
  context: GenerationContext,
): string {
  if (!borrowed) {
    const value = requiresNativeMove(type, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)
      ? `std::move(${payload})`
      : payload;
    return `${generateLocalDeclaration(type, name, false, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)} = ${value};`;
  }
  if (context.structs.get(type)?.kind === "class") {
    return `${generateLocalDeclaration(type, name, false, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)} = ${payload};`;
  }
  const mapped = mapType(type, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
  return `${mapped} const *${cBindingName(name)} = &(${payload});`;
}

function generateIfExpression(
  expression: Extract<Expression, { kind: "ifExpression" }>,
  context: GenerationContext,
  consumeValue: (value: string, context: GenerationContext) => string,
  consumeTerminates: boolean,
): string {
  const condition = generateExpression(expression.condition, context);
  const thenBranch = generateValueArm(expression.thenBranch, context, consumeValue, consumeTerminates);
  const elseBranch = expression.elseBranch.kind === "ifExpression"
    ? generateIfExpression(expression.elseBranch, context, consumeValue, consumeTerminates)
    : generateValueArm(expression.elseBranch, context, consumeValue, consumeTerminates);
  return `if ${controlCondition(condition)} {\n${indent(thenBranch, 2)}\n} else ${
    expression.elseBranch.kind === "ifExpression"
      ? elseBranch
      : `{\n${indent(elseBranch, 2)}\n}`
  }`;
}

function generateLoopExpression(
  expression: Extract<Expression, { kind: "whileExpression" | "forExpression" }>,
  context: GenerationContext,
  consumeValue: (value: string, context: GenerationContext) => string,
  consumeTerminates: boolean,
): string {
  const label = `_z_loop_value_${context.valueCounter.value++}`;
  const selection: ValueSelectionGenerationFrame = {
    label,
    cleanupDepth: context.cleanupScopes.length,
    consumeValue,
    consumeTerminates,
  };
  context.valueSelectionStack.push(selection);
  let loop: string;
  try {
    loop = expression.kind === "whileExpression"
      ? generateWhile({
          kind: "while",
          condition: expression.condition,
          body: expression.body,
          location: expression.location,
        }, context)
      : generateFor({
          kind: "for",
          asynchronous: false,
          errorMode: "none",
          mode: expression.mode,
          binding: expression.binding,
          bindingLocation: expression.bindingLocation,
          objectBindings: expression.objectBindings,
          iterable: expression.iterable,
          body: expression.body,
          location: expression.location,
        }, context);
  } finally {
    context.valueSelectionStack.pop();
  }
  const exhausted = generateValueArm(
    expression.elseBranch,
    context,
    consumeValue,
    consumeTerminates,
  );
  return `${loop}\n${exhausted}\n${label}: ;`;
}

function generateValueArm(
  statement: Statement,
  context: GenerationContext,
  consumeValue: (value: string, context: GenerationContext) => string,
  consumeTerminates: boolean,
): string {
  if (statement.kind === "expressionStatement" || statement.kind === "select") {
    return generateDirectValue(statement.expression, context, consumeValue, consumeTerminates);
  }
  if (statement.kind === "return" || statement.kind === "throw") {
    return generateStatement(statement, context);
  }
  if (statement.kind === "block") {
    const blockTypes = new Map(context.localTypes);
    const blockContext = {
      ...context,
      localTypes: blockTypes,
      liveFlags: new Map(context.liveFlags),
      cleanupScopes: [...context.cleanupScopes, []],
    };
    const prefix = statement.statements.slice(0, -1).map((nested) => {
      const generated = generateStatement(nested, blockContext);
      recordVariableType(nested, blockContext);
      return generated;
    });
    const final = generateValueArm(statement.statements.at(-1)!, blockContext, consumeValue, consumeTerminates);
    const cleanup = consumeTerminates || valueArmTerminates(statement.statements.at(-1)!)
      ? ""
      : generateCleanup([blockContext.cleanupScopes.at(-1)!], blockContext);
    return [...prefix, final, cleanup].filter(Boolean).join("\n");
  }
  if (statement.kind === "match") {
    return generateMatchExpression(
      { ...statement, kind: "matchExpression" },
      context,
      consumeValue,
      consumeTerminates,
    );
  }
  throw new Error("invalid value-producing match arm");
}

function valueArmTerminates(statement: Statement): boolean {
  if (statement.kind === "return" || statement.kind === "throw") return true;
  if (statement.kind === "block") return valueArmTerminates(statement.statements.at(-1)!);
  return false;
}

function statementTerminates(statement: Statement | undefined): boolean {
  if (!statement) return false;
  if (
    statement.kind === "return"
    || statement.kind === "throw"
    || statement.kind === "break"
    || statement.kind === "continue"
  ) return true;
  if (statement.kind === "block") return statementTerminates(statement.statements.at(-1));
  if (statement.kind === "if") {
    return Boolean(statement.elseBranch)
      && statementTerminates(statement.thenBranch)
      && statementTerminates(statement.elseBranch!);
  }
  return statement.kind === "match" && statement.arms.length > 0
    && statement.arms.every((arm) => statementTerminates(arm.body));
}

function statementListTerminates(statements: Statement[]): boolean {
  return statements.length > 0 && statementTerminates(statements.at(-1)!);
}

function generateExpression(expression: Expression, context: GenerationContext): string {
  const override = context.expressionOverrides.get(expression.location.offset);
  let value = override ?? generateExpressionInner(expression, context);
  if (context.semanticInfo.viewLoadExpressions.has(expression.location.offset)) {
    value = `(*(${value}))`;
  }
  if (context.semanticInfo.objcStringsToNative.has(expression.location.offset)) {
    return `z_nsstring_from_string(${value})`;
  }
  if (context.semanticInfo.objcStringsToZ.has(expression.location.offset)) {
    return `z_string_from_nsstring(${value})`;
  }
  if (context.semanticInfo.swiftStringsToZ.has(expression.location.offset)) {
    return `z_string_from_swift(${value})`;
  }
  return value;
}

function generateExpressionInner(expression: Expression, context: GenerationContext): string {
  switch (expression.kind) {
    case "number":
      return generateNumericLiteral(
        expression.value,
        context.semanticInfo.numericLiteralTypes.get(expression.location.offset),
      );
    case "string":
      if (context.semanticInfo.objcStringLiterals.has(expression.location.offset)) {
        return `@${JSON.stringify(expression.value)}`;
      }
      if (context.semanticInfo.cstringConversions.has(expression.location.offset)) {
        return JSON.stringify(expression.value);
      }
      return `(Z_String){ .data = ${JSON.stringify(expression.value)}, .length = sizeof(${JSON.stringify(expression.value)}) - 1, .capacity = 0 }`;
    case "template":
      throw new Error("template literal must be lowered by a console method");
    case "boolean":
      return expression.value ? "true" : "false";
    case "null":
      return "NULL";
    case "argumentReference":
      if (expression.name === "this") return context.owner.receiverMode === "move" ? "&(self)" : "self";
      if (parseSliceType(context.localTypes.get(expression.name) ?? "")) return cBindingName(expression.name);
      if (context.parameterModes.get(expression.name) === "inout" || context.parameterModes.get(expression.name) === "out") return cBindingName(expression.name);
      return `&(${generateStoredValue(expression.name, context)})`;
    case "unary": {
      const explicitCopy = context.semanticInfo.explicitCopies.get(expression.location.offset);
      if (explicitCopy) {
        const source = generateExpression(expression.operand, context);
        const value = explicitCopy.sourceIsView ? `(*(${source}))` : source;
        if (explicitCopy.kind === "string") return `z_string_copy(${value})`;
        if (explicitCopy.kind === "aggregate") return `${explicitCopyName(explicitCopy.type)}(${value})`;
        return value;
      }
      if (expression.operator === "move") return generateExpression(expression.operand, context);
      const contextualType = context.semanticInfo.numericLiteralTypes.get(expression.location.offset);
      if (
        contextualType
        && expression.operand.kind === "number"
        && (expression.operator === "+" || expression.operator === "-")
      ) {
        return generateContextualSignedLiteral(expression.operator, expression.operand.value, contextualType);
      }
      const integerOperation = context.semanticInfo.integerOperations.get(expression.location.offset);
      if (integerOperation) {
        return `${integerOperationName(integerOperation)}(${generateExpression(expression.operand, context)})`;
      }
      return `(${expression.operator}${generateExpression(expression.operand, context)})`;
    }
    case "identifier":
      if (context.semanticInfo.standardFunctionReferences.has(expression.location.offset)) {
        const name = context.semanticInfo.standardFunctionReferences.get(expression.location.offset)!;
        const signature = standardFunctionSignature(name);
        const functionType = parseFunctionType(inferExpressionType(expression, context));
        if (functionType) return functionValueLiteral(functionType, standardFunctionAdapterName(name));
        return signature.cName;
      }
      if (context.semanticInfo.foreignFunctionNames.has(expression.location.offset)) {
        return context.semanticInfo.foreignFunctionNames.get(expression.location.offset)!;
      }
      if (context.semanticInfo.foreignConstantNames.has(expression.location.offset)) {
        return context.semanticInfo.foreignConstantNames.get(expression.location.offset)!;
      }
      if (context.functions.has(expression.name)) {
        const functionType = parseFunctionType(inferExpressionType(expression, context));
        if (functionType) return functionValueLiteral(functionType, functionAdapterName(expression.name));
      }
      if (expression.name === "this") {
        const value = context.receiver?.kind === "class"
          ? "self"
          : context.owner.receiverMode === "move" ? "self" : "(*self)";
        if (!context.semanticInfo.movedExpressions.has(expression.location.offset)) {
          return maybeRetainClass(expression, value, context);
        }
        if (context.receiver && requiresNativeMove(
          context.receiver.name,
          context.structs,
          context.enums,
          context.semanticInfo.foreignNamedTypes,
        )) {
          const moved = `std::move(${value})`;
          const nativeLiveFlag = context.liveFlags.get("this");
          return nativeLiveFlag ? `(${nativeLiveFlag} = false, ${moved})` : moved;
        }
        const liveFlag = context.liveFlags.get("this");
        if (!liveFlag) throw new Error("missing ownership flag for moved receiver `this`");
        return `(${liveFlag} = false, ${value})`;
      }
      const generatorStorage = context.generatorFrame?.storage.get(expression.name);
      if (generatorStorage) {
        if (context.semanticInfo.movedExpressions.has(expression.location.offset)) {
          const type = context.localTypes.get(expression.name);
          if (type && requiresNativeMove(
            type,
            context.structs,
            context.enums,
            context.semanticInfo.foreignNamedTypes,
          )) {
            const moved = `std::move(${generatorStorage})`;
            const nativeLiveFlag = context.liveFlags.get(expression.name);
            return nativeLiveFlag ? `(${nativeLiveFlag} = false, ${moved})` : moved;
          }
          const liveFlag = context.liveFlags.get(expression.name);
          if (!liveFlag) throw new Error(`missing ownership flag for moved value ${JSON.stringify(expression.name)}`);
          return `(${liveFlag} = false, ${generatorStorage})`;
        }
        return maybeRetainClass(expression, generatorStorage, context);
      }
      if (
        context.parameterModes.get(expression.name) === "in"
        || context.parameterModes.get(expression.name) === "inout"
        || context.parameterModes.get(expression.name) === "out"
      ) {
        const emittedName = cBindingName(expression.name);
        const type = context.localTypes.get(expression.name);
        if (type && parseSliceType(type)) return emittedName;
        const value = type
          && closureCaptureHasReferenceIdentity(type, context.structs, context.semanticInfo.foreignNamedTypes)
          && context.parameterModes.get(expression.name) === "in"
          ? emittedName
          : `(*${emittedName})`;
        return maybeRetainClass(expression, value, context);
      }
      if (context.semanticInfo.movedExpressions.has(expression.location.offset)) {
        const type = context.localTypes.get(expression.name);
        if (type && requiresNativeMove(type, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)) {
          const moved = `std::move(${generateStoredValue(expression.name, context)})`;
          const nativeLiveFlag = context.liveFlags.get(expression.name);
          return nativeLiveFlag ? `(${nativeLiveFlag} = false, ${moved})` : moved;
        }
        const liveFlag = context.liveFlags.get(expression.name);
        if (!liveFlag) throw new Error(`missing ownership flag for moved value ${JSON.stringify(expression.name)}`);
        return `(${liveFlag} = false, ${generateStoredValue(expression.name, context)})`;
      }
      if (
        context.semanticInfo.managedCopies.has(expression.location.offset)
        && inferExpressionType(expression, context) === "TaskScope"
      ) {
        return `z_task_scope_retain(${generateStoredValue(expression.name, context)})`;
      }
      return maybeRetainClass(
        expression,
        context.localTypes.has(expression.name) ? generateStoredValue(expression.name, context) : expression.name,
        context,
      );
    case "binary": {
      const integerOperation = context.semanticInfo.integerOperations.get(expression.location.offset);
      if (integerOperation) {
        return `${integerOperationName(integerOperation)}(${generateExpression(expression.left, context)}, ${generateExpression(expression.right, context)})`;
      }
      if (
        (expression.operator === "==" || expression.operator === "!=")
        && inferExpressionType(expression.left, context) === "String"
        && inferExpressionType(expression.right, context) === "String"
      ) {
        const comparison = `z_string_equal(${generateExpression(expression.left, context)}, ${generateExpression(expression.right, context)})`;
        return expression.operator === "==" ? comparison : `(!${comparison})`;
      }
      const leftType = inferExpressionType(expression.left, context);
      const comparableEnum = context.enums.get(leftType);
      if (
        (expression.operator === "==" || expression.operator === "!=")
        && comparableEnum
        && comparableEnum.variants.every((variant) => variant.payload === null)
      ) {
        return `((${generateExpression(expression.left, context)}).tag ${expression.operator} (${generateExpression(expression.right, context)}).tag)`;
      }
      return `(${generateExpression(expression.left, context)} ${expression.operator} ${generateExpression(expression.right, context)})`;
    }
    case "conditional":
      return `(${generateExpression(expression.condition, context)} ? ${generateExpression(expression.thenExpression, context)} : ${generateExpression(expression.elseExpression, context)})`;
    case "new":
      if (!context.structs.get(expression.typeName)?.constructor) {
        return generateExpression(expression.arguments[0], context);
      }
      return `${constructorName(expression.typeName)}(${expression.arguments.map((argument) => generateCallArgument(argument, context)).join(", ")})`;
    case "weak": {
      const type = parseWeakType(inferExpressionType(expression, context));
      if (!type) throw new Error("weak expression is missing its target type");
      return `${weakMakeName(type.target)}(${generateExpression(expression.expression, context)})`;
    }
    case "closure":
      throw new Error("closure must be lowered from its const binding");
    case "arrayExpression": {
      const type = context.semanticInfo.expressionTypes.get(expression.location.offset)!;
      const elements = expression.elements.map((element) => generateExpression(element, context)).join(", ");
      return `(${mapType(type, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)}){ .data = { ${elements} } }`;
    }
    case "dynamicArrayExpression": {
      const type = dynamicArrayTypeName(expression.elementType);
      const mapped = mapType(type, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
      return `(${mapped}){ .data = NULL, .length = 0, .capacity = 0 }`;
    }
    case "index": {
      const ownerType = inferExpressionType(expression.object, context);
      const ownerView = parseViewType(ownerType);
      const ownerValueType = ownerView?.target ?? ownerType;
      const array = parseFixedArrayType(ownerValueType);
      const slice = parseSliceType(ownerValueType);
      const dynamic = parseDynamicArrayType(ownerValueType);
      const owner = generateExpression(expression.object, context);
      const storage = ownerView ? `(*(${owner}))` : `(${owner})`;
      const length = array ? String(array.length) : `${storage}.length`;
      const value = `(${storage}.data[z_bounds_index((uintptr_t)(${generateExpression(expression.index, context)}), ${length})])`;
      return maybeRetainClass(expression, value, context);
    }
    case "structExpression": {
      const declaration = context.structs.get(expression.typeName);
      if (declaration?.kind === "class") {
        const provided = new Map(expression.fields.map((field) => [field.name, field.expression]));
        const fields = declaration.fields.map((field) => generateExpression(provided.get(field.name)!, context));
        return `${constructorName(declaration.name)}(${fields.join(", ")})`;
      }
      const fields = expression.fields
        .map((field) => `.${field.name} = ${generateExpression(field.expression, context)}`)
        .join(", ");
      const type = expression.typeName.includes(".")
        ? mapType(expression.typeName, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)
        : context.semanticInfo.foreignNamedTypes.has(expression.typeName)
          ? mapType(expression.typeName, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)
          : structName(expression.typeName);
      return `(${type}){ ${fields} }`;
    }
    case "objectExpression": {
      const typeName = context.semanticInfo.expressionTypes.get(expression.location.offset)!;
      const declaration = context.structs.get(typeName);
      if (declaration?.kind === "class") {
        const provided = new Map(expression.fields.map((field) => [field.name, field.expression]));
        const fields = declaration.fields.map((field) => generateExpression(provided.get(field.name)!, context));
        return `${constructorName(typeName)}(${fields.join(", ")})`;
      }
      const fields = expression.fields
        .map((field) => `.${field.name} = ${generateExpression(field.expression, context)}`)
        .join(", ");
      const mapped = context.semanticInfo.foreignNamedTypes.has(typeName)
        ? mapType(typeName, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)
        : structName(typeName);
      return `(${mapped}){ ${fields} }`;
    }
    case "variantExpression": {
      const declaration = context.enums.get(expression.enumName);
      if (declaration && nicheOptionPayload(declaration, context.semanticInfo.foreignNamedTypes)) {
        return generateExpression(expression.payload, context);
      }
      if (!declaration) throw new Error(`missing enum ${JSON.stringify(expression.enumName)}`);
      return generateEnumVariantConstruction(
        declaration,
        expression.variantName,
        generateViewPayload(expression.payload, context),
        context,
      );
    }
    case "attempt":
      return generateExpression(expression.expression, context);
    case "try":
      throw new Error("try must be lowered from its containing statement");
    case "executorPlacement":
      throw new DiagnosticError(
        expression.location.fileName ?? "<source>",
        expression.location,
        "executor placement must be lowered from a direct value-producing position",
        {
          code: "Z0713",
          helps: ["bind the `on thread.main { ... }` result before composing it into a larger expression"],
        },
      );
    case "matchExpression":
      throw new Error("match must be lowered from its containing statement");
    case "ifExpression":
      throw new Error("if must be lowered from its containing statement");
    case "whileExpression":
      throw new Error("while must be lowered from its containing statement");
    case "forExpression":
      throw new Error("for must be lowered from its containing statement");
    case "member": {
      const foreignFunctionName = context.semanticInfo.foreignFunctionNames.get(expression.location.offset);
      if (foreignFunctionName) return foreignFunctionName;
      const foreignConstantName = context.semanticInfo.foreignConstantNames.get(expression.location.offset);
      if (foreignConstantName) return foreignConstantName;
      const ownerType = inferExpressionType(expression.object, context);
      const ownerView = parseViewType(ownerType);
      const ownerValueType = ownerView?.target ?? ownerType;
      if (ownerValueType === objcConnectionTypeName) throw new Error("objc.Connection has no source-level members");
      const array = parseFixedArrayType(ownerValueType);
      const slice = parseSliceType(ownerValueType);
      const dynamic = parseDynamicArrayType(ownerValueType);
      const map = parseMapType(ownerValueType);
      const set = parseSetType(ownerValueType);
      if (ownerValueType === "TextBuffer") {
        const owner = generateExpression(expression.object, context);
        const value = ownerView ? `(*(${owner}))` : `(${owner})`;
        if (expression.property === "byteLength") return `${value}.length`;
        if (expression.property === "isEmpty") return `(${value}.length == 0)`;
      }
      if (ownerValueType === "String") {
        const owner = generateExpression(expression.object, context);
        const value = ownerView ? `(*(${owner}))` : `(${owner})`;
        if (expression.property === "byteLength") return `${value}.length`;
        if (expression.property === "isEmpty") return `(${value}.length == 0)`;
      }
      if (array || slice || dynamic) {
        const owner = generateExpression(expression.object, context);
        const value = ownerView ? `(*(${owner}))` : `(${owner})`;
        if (dynamic) {
          return `${value}.${expression.property}`;
        }
        if (slice) return `${value}.length`;
        return `((void)(${owner}), (uintptr_t)${array.length})`;
      }
      if (map && expression.property === "length") {
        const owner = generateExpression(expression.object, context);
        return `((${owner}).entries.length)`;
      }
      if (set && expression.property === "length") {
        const owner = generateExpression(expression.object, context);
        return `((${owner}).values.length)`;
      }
      const objcClassName = context.semanticInfo.objcClassNames.get(expression.location.offset);
      if (objcClassName) return objcClassName;
      const objcProperty = context.semanticInfo.objcProperties.get(expression.location.offset);
      if (objcProperty) return `[${generateExpression(expression.object, context)} ${objcProperty.getter}]`;
      if (expression.object.kind === "identifier") {
        const declaration = context.enums.get(expression.object.name);
        const variant = declaration?.variants.find((candidate) => candidate.name === expression.property);
        if (declaration && variant) {
          const niche = nicheOptionPayload(declaration, context.semanticInfo.foreignNamedTypes);
          if (niche) return nicheOptionNull(niche);
          return generateEnumVariantConstruction(declaration, variant.name, null, context);
        }
      }
      if (isForeignMember(expression, context)) return expression.property;
      if (expression.object.kind === "identifier" && expression.object.name === "this") {
        const value = context.receiver?.kind === "class"
          ? `self->${expression.property}`
          : context.owner.receiverMode === "move"
          ? `self.${expression.property}`
          : `self->${expression.property}`;
        return maybeRetainClass(expression, value, context);
      }
      const owner = context.structs.get(ownerValueType);
      const access = ownerView || owner?.kind === "class" ? "->" : ".";
      return maybeRetainClass(
        expression,
        `(${generateExpression(expression.object, context)})${access}${expression.property}`,
        context,
      );
    }
    case "call": {
      const integerConversion = context.semanticInfo.integerConversions.get(expression.location.offset);
      if (integerConversion) {
        const value = generateExpression(expression.arguments[0], context);
        const targetType = primitiveTypeNames[integerConversion.targetType];
        if (!targetType) throw new Error(`unsupported integer conversion target ${JSON.stringify(integerConversion.targetType)}`);
        return integerConversion.checked
          ? `${integerConversionName(integerConversion)}(${value})`
          : `((${targetType})(${value}))`;
      }
      if (context.semanticInfo.optionFromNullable.has(expression.location.offset)) {
        return generateExpression(expression.arguments[0], context);
      }
      if (context.semanticInfo.objcConnectionCalls.has(expression.location.offset)) {
        return `z_objc_connect(${generateExpression(expression.arguments[0], context)}, ${generateExpression(expression.arguments[1], context)})`;
      }
      const objcBinding = context.semanticInfo.objcBindingCalls.get(expression.location.offset);
      if (objcBinding) {
        const owners = new Map<string, Expression>();
        for (const binding of objcBinding.bindings) {
          const expression = binding.ownerExpression;
          if (expression.kind !== "identifier") throw new Error("objc.bind owner must be an identifier");
          owners.set(`${binding.ownerType}:${expression.name}`, expression);
        }
        return `${objcBindingHelperName(expression.location.offset)}(${[
          generateExpression(expression.arguments[0], context),
          ...[...owners.values()].map((owner) => generateExpression(owner, context)),
        ].join(", ")})`;
      }
      const integerOperation = context.semanticInfo.integerOperations.get(expression.location.offset);
      if (integerOperation && expression.callee.kind === "member") {
        return `${integerOperationName(integerOperation)}(${generateExpression(expression.callee.object, context)}, ${generateExpression(expression.arguments[0], context)})`;
      }
      if (
        context.semanticInfo.taskScopeSpawnCalls.has(expression.location.offset)
        && expression.callee.kind === "member"
      ) {
        const scope = generateExpression(expression.callee.object, context);
        const operation = generateExpression(expression.arguments[1], context);
        return `z_task_scope_spawn(${scope}, (${operation}).call, (${operation}).context, (${operation}).retain, (${operation}).release)`;
      }
      const referencedStandard = context.semanticInfo.standardFunctionReferences.get(expression.callee.location.offset);
      if (referencedStandard) {
        const signature = standardFunctionSignature(referencedStandard);
        const arguments_ = expression.arguments.map((argument, index) => (
          signature.parameters[index]?.abi === "value"
            ? generateExpression(argument, context)
            : generateCallArgument(argument, context)
        ));
        return `${signature.cName}(${arguments_.join(", ")})`;
      }
      const hasherAddType = context.semanticInfo.hasherAddTypes.get(expression.location.offset);
      if (hasherAddType && expression.callee.kind === "member") {
        const receiver = generateExpression(expression.callee.object, context);
        const argument = generateExpression(expression.arguments[0], context);
        if (hasherAddType === "String") return `z_hasher_add_string(&(${receiver}), ${argument})`;
        const zEnum = context.enums.get(hasherAddType);
        if (zEnum?.variants.every((variant) => variant.payload === null)) {
          return `z_hasher_add_u64(&(${receiver}), (uint64_t)((${argument}).tag))`;
        }
        if (context.structs.get(hasherAddType)?.implements.some((trait) => trait.name === "Hashable")) {
          return `${methodName(hasherAddType, "hash")}(&(${argument}), &(${receiver}))`;
        }
        return `z_hasher_add_u64(&(${receiver}), (uint64_t)(${argument}))`;
      }
      if (expression.callee.kind === "identifier") {
        const map = parseMapType(expression.callee.name);
        if (map) {
          const mapped = mapType(expression.callee.name, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
          return requiresNativeMove(
            expression.callee.name,
            context.structs,
            context.enums,
            context.semanticInfo.foreignNamedTypes,
          ) ? `${mapped}{}` : `(${mapped}){ 0 }`;
        }
        const set = parseSetType(expression.callee.name);
        if (set) {
          return `(${mapType(expression.callee.name, context.structs, context.enums, context.semanticInfo.foreignNamedTypes)}){ 0 }`;
        }
        const standardType = context.semanticInfo.standardTypeBindings.get(expression.callee.name);
        if (standardType === "TextBuffer") return "z_string_new()";
        if (standardType === "Arena") {
          const capacity = expression.arguments[0]?.kind === "objectExpression"
            ? expression.arguments[0].fields[0]?.expression
            : null;
          return `z_arena_new(${capacity ? `(uintptr_t)(${generateExpression(capacity, context)})` : "0"})`;
        }
        if (context.structs.get(expression.callee.name)?.kind === "struct") {
          return generateExpression(expression.arguments[0], context);
        }
        if (expression.arguments[0]?.kind === "objectExpression") {
          const objectType = context.semanticInfo.expressionTypes.get(expression.arguments[0].location.offset);
          if (objectType && context.semanticInfo.foreignNamedTypes.get(objectType)?.kind === "record") {
            return generateExpression(expression.arguments[0], context);
          }
        }
      }
      if (expression.callee.kind === "member" && expression.arguments[0]?.kind === "objectExpression") {
        const objectType = context.semanticInfo.expressionTypes.get(expression.arguments[0].location.offset);
        if (objectType && context.semanticInfo.foreignNamedTypes.get(objectType)?.kind === "record") {
          return generateExpression(expression.arguments[0], context);
        }
      }
      if (
        expression.callee.kind === "member"
        && expression.callee.object.kind === "identifier"
        && expression.callee.object.name === "String"
        && expression.callee.property === "from"
      ) {
        const argument = expression.arguments[0];
        const value = generateExpression(argument, context);
        const nativeText = context.semanticInfo.foreignTypes.get(inferExpressionType(argument, context));
        return nativeText?.stringView
          ? `z_string_from_cstring((const char *)(${value}))`
          : `z_string_from_cstring(${value})`;
      }
      const objcCall = context.semanticInfo.objcCalls.get(expression.location.offset);
      if (objcCall && expression.callee.kind === "member") {
        const receiver = generateExpression(expression.callee.object, context);
        const args = expression.arguments.map((argument) => generateCallArgument(argument, context));
        return generateObjCMessage(receiver, objcCall.selector, args);
      }
      const cxxMethod = context.semanticInfo.foreignCxxMethodCalls.get(expression.location.offset);
      if (cxxMethod && expression.callee.kind === "member") {
        const generatedReceiver = generateExpression(expression.callee.object, context);
        const receiver = parseViewType(inferExpressionType(expression.callee.object, context))
          ? `(*${generatedReceiver})`
          : generatedReceiver;
        const plan = context.semanticInfo.foreignCallArgumentPlans.get(expression.location.offset);
        const args = plan
          ? plan.map((argument) => generateForeignCallArgument(argument, expression.arguments, context))
          : expression.arguments.map((argument) => generateCallArgument(argument, context));
        return `${receiver}.${cxxMethod.name}(${args.join(", ")})`;
      }
      const foreignArgumentPlan = context.semanticInfo.foreignCallArgumentPlans.get(expression.location.offset);
      const foreignFunctionName = context.semanticInfo.foreignFunctionNames.get(expression.callee.location.offset);
      if (foreignFunctionName) {
        const args = foreignArgumentPlan
          ? foreignArgumentPlan.map((argument) => generateForeignCallArgument(argument, expression.arguments, context))
          : expression.arguments.map((argument) => generateCallArgument(argument, context));
        return `${foreignFunctionName}(${args.join(", ")})`;
      }
      if (foreignArgumentPlan) {
        const args = foreignArgumentPlan.map((argument) => (
          generateForeignCallArgument(argument, expression.arguments, context)
        ));
        return `${generateExpression(expression.callee, context)}(${args.join(", ")})`;
      }
      if (expression.callee.kind === "member" && !isForeignMember(expression.callee, context)) {
        if (expression.callee.object.kind === "identifier") {
          const owner = context.structs.get(expression.callee.object.name);
          const staticMethod = owner?.methods.find((candidate) => candidate.static && candidate.name === expression.callee.property);
          if (owner && staticMethod) {
            const args = expression.arguments.map((argument) => generateCallArgument(argument, context));
            return `${methodName(owner.name, staticMethod.name)}(${args.join(", ") || ""})`;
          }
          const declaration = context.enums.get(expression.callee.object.name);
          const variant = declaration?.variants.find((candidate) => candidate.name === expression.callee.property);
          if (declaration && variant) {
            const niche = nicheOptionPayload(declaration, context.semanticInfo.foreignNamedTypes);
            if (niche) {
              return variant.payload ? generateViewPayload(expression.arguments[0], context) : nicheOptionNull(niche);
            }
            return generateEnumVariantConstruction(
              declaration,
              variant.name,
              variant.payload ? generateViewPayload(expression.arguments[0], context) : null,
              context,
            );
          }
        }
        const receiverType = inferExpressionType(expression.callee.object, context);
        const receiverView = parseViewType(receiverType);
        const receiverValueType = receiverView?.target ?? receiverType;
        const generator = parseGeneratorType(receiverValueType);
        if (generator) {
          const receiver = generateExpression(expression.callee.object, context);
          return `${generatorNextName(receiverValueType)}(&(${receiver}))`;
        }
        const map = parseMapType(receiverValueType);
        if (map) {
          const receiver = generateExpression(expression.callee.object, context);
          const args = expression.arguments.map((argument) => generateCallArgument(argument, context));
          return `${mapMethodName(receiverValueType, expression.callee.property)}(&(${receiver})${args.length ? `, ${args.join(", ")}` : ""})`;
        }
        const set = parseSetType(receiverValueType);
        if (set) {
          const receiver = generateExpression(expression.callee.object, context);
          const args = expression.arguments.map((argument) => generateCallArgument(argument, context));
          return `${setMethodName(receiverValueType, expression.callee.property)}(&(${receiver})${args.length ? `, ${args.join(", ")}` : ""})`;
        }
        if (receiverValueType === "Arena") {
          const receiver = generateExpression(expression.callee.object, context);
          if (context.semanticInfo.arenaResetCalls.has(expression.location.offset)) {
            return `z_arena_reset(&(${receiver}))`;
          }
          const storedType = context.semanticInfo.arenaCreateCalls.get(expression.location.offset);
          if (storedType) {
            const argument = generateExpression(expression.arguments[0], context);
            return `${arenaCreateName(storedType)}(&(${receiver}), ${argument})`;
          }
        }
        if (receiverValueType === "TextBuffer") {
          const receiver = generateExpression(expression.callee.object, context);
          if (expression.callee.property === "append") {
            return `z_text_buffer_append(&(${receiver}), ${generateExpression(expression.arguments[0], context)})`;
          }
          if (expression.callee.property === "appendBytes") {
            return `z_text_buffer_append_bytes(&(${receiver}), ${generateExpression(expression.arguments[0], context)}, ${generateExpression(expression.arguments[1], context)}, ${generateExpression(expression.arguments[2], context)})`;
          }
          if (expression.callee.property === "appendAscii") {
            return `z_text_buffer_append_ascii(&(${receiver}), ${generateExpression(expression.arguments[0], context)})`;
          }
          if (expression.callee.property === "finish") return receiver;
        }
        if (receiverValueType === "String") {
          const receiver = generateExpression(expression.callee.object, context);
          const value = receiverView ? `(*(${receiver}))` : receiver;
          if (expression.callee.property === "byteAt") {
            return `z_string_byte_at(${value}, ${generateExpression(expression.arguments[0], context)})`;
          }
          if (expression.callee.property === "copyBytes") {
            return `z_string_copy_bytes(${value}, ${generateExpression(expression.arguments[0], context)}, ${generateExpression(expression.arguments[1], context)})`;
          }
        }
        if (parseDynamicArrayType(receiverValueType)) {
          const receiver = generateExpression(expression.callee.object, context);
          const argument = generateCallArgument(expression.arguments[0], context);
          return `${dynamicArrayPushName(receiverValueType)}(&(${receiver}), ${argument})`;
        }
        const weak = parseWeakType(receiverValueType);
        if (weak) {
          const receiver = generateExpression(expression.callee.object, context);
          const value = receiverView ? `(*(${receiver}))` : receiver;
          return `${weakUpgradeName(weak.target)}(${value})`;
        }
        const declaration = context.structs.get(receiverValueType);
        if (!declaration) {
          throw new Error(`missing receiver lowering for ${receiverValueType}.${expression.callee.property} at ${expression.location.offset}`);
        }
        const field = declaration.fields.find((candidate) => candidate.name === expression.callee.property);
        if (field && parseFunctionType(field.type.name)) {
          return generateFunctionValueCall(
            generateExpression(expression.callee, context),
            expression.arguments.map((argument) => generateCallArgument(argument, context)),
          );
        }
        const method = declaration.methods.find((candidate) => candidate.name === expression.callee.property)!;
        const receiver = generateExpression(expression.callee.object, context);
        const receiverArgument = declaration.kind === "class"
          ? receiver
          : receiverView
          ? receiver
          : method.receiverMode === "move"
          ? receiver
          : expression.callee.object.kind === "identifier" && expression.callee.object.name === "this"
            ? context.owner.receiverMode === "move" ? "&(self)" : "self"
            : `&(${receiver})`;
        const args = [receiverArgument, ...expression.arguments.map((argument) => generateCallArgument(argument, context))];
        return `${methodName(receiverValueType, expression.callee.property)}(${args.join(", ")})`;
      }
      if (expression.callee.kind === "identifier") {
        const closure = closureForType(context.localTypes.get(expression.callee.name), context.semanticInfo);
        if (closure) {
          const hidden = closure.captures.map((capture) => {
            const stored = capture.moved
              ? closureCaptureStorageName(closure, capture.name)
              : generateStoredValue(capture.name, context);
            if (capture.mode === "value") return stored;
            if (capture.mode === "in" && closureCaptureHasReferenceIdentity(capture.type, context.structs, context.semanticInfo.foreignNamedTypes)) return stored;
            return `&(${stored})`;
          });
          const args = [...hidden, ...expression.arguments.map((argument) => generateCallArgument(argument, context))];
          return `${closure.declaration.name}(${args.join(", ") || ""})`;
        }
        if (context.functions.has(expression.callee.name)) {
          return `${expression.callee.name}(${expression.arguments.map((argument) => generateCallArgument(argument, context)).join(", ")})`;
        }
        const functionType = parseFunctionType(context.localTypes.get(expression.callee.name) ?? "");
        if (functionType) {
          return generateFunctionValueCall(
            generateStoredValue(expression.callee.name, context),
            expression.arguments.map((argument) => generateCallArgument(argument, context)),
          );
        }
      }
      return `${generateExpression(expression.callee, context)}(${expression.arguments.map((argument) => generateCallArgument(argument, context)).join(", ")})`;
    }
  }
}

function closureCaptureHasReferenceIdentity(
  type: string,
  structs: ReadonlyMap<string, StructDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): boolean {
  return type === "TaskScope"
    || structs.get(type)?.kind === "class"
    || foreignNamedTypes.get(type)?.kind === "object";
}

function generateViewPayload(expression: Expression, context: GenerationContext): string {
  const value = generateExpression(expression, context);
  return context.semanticInfo.viewReturnExpressions.has(expression.location.offset) ? `&(${value})` : value;
}

function generateEnumVariantConstruction(
  declaration: EnumDeclaration,
  variant: string,
  payload: string | null,
  context: GenerationContext,
): string {
  if (requiresNativeMove(
    declaration.name,
    context.structs,
    context.enums,
    context.semanticInfo.foreignNamedTypes,
  )) {
    return `${enumName(declaration.name)}::make_${nativeSymbolPart(variant)}(${payload ?? ""})`;
  }
  const initializedPayload = payload === null ? "" : `, .data.${variant} = ${payload}`;
  return `(${enumName(declaration.name)}){ .tag = ${variantTag(declaration.name, variant)}${initializedPayload} }`;
}

function generateCompilerVariantConstruction(
  enumType: string,
  variant: string,
  payload: string | null,
  context: GenerationContext,
): string {
  const declaration = context.enums.get(enumType);
  if (!declaration) throw new Error(`missing compiler enum ${JSON.stringify(enumType)}`);
  return generateEnumVariantConstruction(declaration, variant, payload, context);
}

function generateFunctionValueCall(value: string, arguments_: readonly string[]): string {
  return `(${value}).call((${value}).context${arguments_.length ? `, ${arguments_.join(", ")}` : ""})`;
}

function generateForeignCallArgument(
  plan: ForeignCallArgumentPlan,
  arguments_: readonly Expression[],
  context: GenerationContext,
): string {
  if (plan.kind === "fixed") return plan.expression;
  const expression = arguments_[plan.source];
  if (plan.kind === "argument") return generateCallArgument(expression, context);
  if (plan.kind === "callback") return foreignCallbackAdapterName(plan);
  if (plan.kind === "release") return foreignCallbackBoxReleaseName(plan);
  if (plan.callback.lifetime === "escape") {
    return `${foreignCallbackBoxName(plan)}(${generateExpression(expression, context)})`;
  }
  return `(void *)&(${generateExpression(expression, context)})`;
}

function maybeRetainClass(expression: Expression, value: string, context: GenerationContext): string {
  if (!context.semanticInfo.managedCopies.has(expression.location.offset)) return value;
  const type = inferExpressionType(expression, context);
  if (parseWeakType(type)) return `z_weak_retain(${value})`;
  const functionType = parseFunctionType(type);
  if (functionType) return `${functionTypeRetainName(functionType)}(${value})`;
  const declaration = context.structs.get(type);
  if (declaration?.kind !== "class") return value;
  return `${retainName(type)}(${value})`;
}

function generateCallArgument(expression: Expression, context: GenerationContext): string {
  const callbackTarget = context.semanticInfo.foreignCallbackTargets.get(expression.location.offset);
  if (callbackTarget) return callbackTarget;
  if (context.semanticInfo.cstringConversions.has(expression.location.offset)) {
    if (expression.kind === "string") return JSON.stringify(expression.value);
    const value = generateExpression(expression, context);
    return `((${value}).data != NULL ? (${value}).data : "")`;
  }
  const conversion = context.semanticInfo.sliceConversions.get(expression.location.offset);
  if (conversion) {
    const source = parseFixedArrayType(conversion.sourceType);
    const dynamic = parseDynamicArrayType(conversion.sourceType);
    const value = expression.kind === "argumentReference"
      ? generateStoredValue(expression.name, context)
      : generateExpression(expression, context);
    const target = mapType(conversion.targetType, context.structs, context.enums, context.semanticInfo.foreignNamedTypes);
    const length = source ? String(source.length) : `(${value}).length`;
    if (!source && !dynamic) throw new Error("slice conversion requires fixed or growable array storage");
    return `(${target}){ .data = (${value}).data, .length = ${length} }`;
  }
  if (context.semanticInfo.foreignCxxArgumentAccesses.has(expression.location.offset)) {
    return expression.kind === "argumentReference"
      ? generateStoredValue(expression.name, context)
      : generateExpression(expression, context);
  }
  const value = generateExpression(expression, context);
  if (context.semanticInfo.objcBlockArguments.has(expression.location.offset)) return value;
  const nativeIn = context.semanticInfo.nativeArgumentAccesses.get(expression.location.offset) === "in";
  if (nativeIn && parseViewType(inferExpressionType(expression, context))) return value;
  const classIn = nativeIn && context.structs.get(inferExpressionType(expression, context))?.kind === "class";
  return context.semanticInfo.foreignArgumentAccesses.get(expression.location.offset) === "in"
    || (nativeIn && !classIn)
    ? `&(${value})`
    : value;
}

function generateSleepRuntime(): string {
  return `static void z_sleep_ms(uint64_t milliseconds) {
#if defined(_WIN32)
  while (milliseconds > UINT32_MAX) {
    Sleep(UINT32_MAX);
    milliseconds -= UINT32_MAX;
  }
  Sleep((DWORD)milliseconds);
#else
  while (milliseconds > 0) {
    const uint64_t chunk = milliseconds > UINT64_C(86400000) ? UINT64_C(86400000) : milliseconds;
    struct timespec remaining = {
      .tv_sec = (time_t)(chunk / UINT64_C(1000)),
      .tv_nsec = (long)((chunk % UINT64_C(1000)) * UINT64_C(1000000)),
    };
    while (nanosleep(&remaining, &remaining) == -1) {
      if (errno != EINTR) abort();
    }
    milliseconds -= chunk;
  }
#endif
}`;
}

function generateArenaRuntime(): string {
  return `typedef void (*Z_ArenaCleanupFunction)(void *value);

typedef struct Z_ArenaPage {
  struct Z_ArenaPage *next;
  unsigned char *data;
  uintptr_t used;
  uintptr_t capacity;
} Z_ArenaPage;

typedef struct Z_ArenaCleanup {
  struct Z_ArenaCleanup *next;
  void *value;
  Z_ArenaCleanupFunction function;
} Z_ArenaCleanup;

typedef struct Z_Arena {
  Z_ArenaPage *pages;
  Z_ArenaCleanup *cleanups;
  uintptr_t initial_capacity;
} Z_Arena;

#if defined(__cplusplus)
#define Z_ALIGNOF(type) alignof(type)
#else
#define Z_ALIGNOF(type) _Alignof(type)
#endif

static inline __attribute__((unused)) Z_Arena z_arena_new(uintptr_t initial_capacity) {
  Z_Arena value = { NULL, NULL, initial_capacity };
  return value;
}

static void *z_arena_allocate(Z_Arena *arena, uintptr_t size, uintptr_t alignment) {
  if (size == 0) size = 1;
  if (alignment == 0 || (alignment & (alignment - 1)) != 0) abort();
  Z_ArenaPage *page = arena->pages;
  if (page != NULL) {
    const uintptr_t current = (uintptr_t)(page->data + page->used);
    if (current <= UINTPTR_MAX - (alignment - 1)) {
      const uintptr_t aligned = (current + alignment - 1) & ~(alignment - 1);
      const uintptr_t padding = aligned - current;
      if (padding <= page->capacity - page->used && size <= page->capacity - page->used - padding) {
        page->used += padding + size;
        return (void *)aligned;
      }
    }
  }

  uintptr_t capacity = page == NULL && arena->initial_capacity > 0
    ? arena->initial_capacity
    : 4096;
  if (size > UINTPTR_MAX - alignment) abort();
  const uintptr_t required = size + alignment;
  if (capacity < required) capacity = required;
  if (capacity > UINTPTR_MAX - sizeof(Z_ArenaPage)) abort();
  Z_ArenaPage *created = (Z_ArenaPage *)malloc(sizeof(Z_ArenaPage) + capacity);
  if (created == NULL) abort();
  created->next = page;
  created->data = (unsigned char *)(created + 1);
  created->used = 0;
  created->capacity = capacity;
  arena->pages = created;
  return z_arena_allocate(arena, size, alignment);
}

static inline __attribute__((unused)) void z_arena_register_cleanup(
  Z_Arena *arena,
  void *value,
  Z_ArenaCleanupFunction function
) {
  Z_ArenaCleanup *cleanup = (Z_ArenaCleanup *)z_arena_allocate(
    arena,
    sizeof(Z_ArenaCleanup),
    Z_ALIGNOF(Z_ArenaCleanup)
  );
  cleanup->next = arena->cleanups;
  cleanup->value = value;
  cleanup->function = function;
  arena->cleanups = cleanup;
}

static void z_arena_reset(Z_Arena *arena) {
  Z_ArenaCleanup *cleanup = arena->cleanups;
  while (cleanup != NULL) {
    Z_ArenaCleanup *next = cleanup->next;
    cleanup->function(cleanup->value);
    cleanup = next;
  }
  Z_ArenaPage *page = arena->pages;
  while (page != NULL) {
    Z_ArenaPage *next = page->next;
    free(page);
    page = next;
  }
  arena->cleanups = NULL;
  arena->pages = NULL;
}`;
}

function generateHasherRuntime(includeString: boolean): string {
  return `typedef struct {
  uint64_t state;
} Z_Hasher;

static inline __attribute__((unused)) Z_Hasher z_hasher_new(void) {
  return (Z_Hasher){ .state = UINT64_C(14695981039346656037) };
}

static inline __attribute__((unused)) void z_hasher_add_bytes(Z_Hasher *self, const char *bytes, uintptr_t length) {
  for (uintptr_t index = 0; index < length; index += 1) {
    self->state ^= (unsigned char)bytes[index];
    self->state *= UINT64_C(1099511628211);
  }
}

static inline __attribute__((unused)) void z_hasher_add_u64(Z_Hasher *self, uint64_t value) {
  unsigned char bytes[8];
  for (uintptr_t index = 0; index < 8; index += 1) bytes[index] = (unsigned char)(value >> (index * 8));
  z_hasher_add_bytes(self, (const char *)bytes, 8);
}

${includeString ? `static inline __attribute__((unused)) void z_hasher_add_string(Z_Hasher *self, Z_String value) {
  z_hasher_add_u64(self, (uint64_t)value.length);
  z_hasher_add_bytes(self, value.data != NULL ? value.data : "", value.length);
}
` : ""}

static inline __attribute__((unused)) uintptr_t z_hasher_finish(Z_Hasher self) {
  uint64_t hash = self.state;
  hash ^= hash >> 33;
  hash *= UINT64_C(0xff51afd7ed558ccd);
  hash ^= hash >> 33;
  hash *= UINT64_C(0xc4ceb9fe1a85ec53);
  hash ^= hash >> 33;
  return (uintptr_t)hash;
}`;
}

function arenaCreateName(type: string): string {
  return `z_arena_create_${nativeSymbolPart(type)}`;
}

function generateArenaCreateSignature(
  type: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
): string {
  const mapped = mapType(type, structs, enums, foreignNamedTypes);
  return `static const ${mapped} *${arenaCreateName(type)}(Z_Arena *arena, ${mapped} value)`;
}

function generateArenaCreate(
  type: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  semanticInfo: SemanticInfo,
): string {
  const mapped = mapType(type, structs, enums, semanticInfo.foreignNamedTypes);
  const native = requiresNativeLifetime(type, structs, enums, semanticInfo.foreignNamedTypes);
  const nativeMove = requiresNativeMove(type, structs, enums, semanticInfo.foreignNamedTypes);
  const managed = hasCleanupType(type, structs, enums, semanticInfo.foreignTypes);
  const cleanupName = `${arenaCreateName(type)}_cleanup`;
  const managedCleanup = managed
    ? generateOwnedEnvironmentCleanup("(*stored)", type, structs, enums, semanticInfo, { value: 0 })
    : "";
  const cleanup = managed || native
    ? `static void ${cleanupName}(void *raw) {
  ${mapped} *stored = (${mapped} *)raw;
${managedCleanup ? `${indent(managedCleanup, 2)}\n` : ""}${native ? "  std::destroy_at(stored);\n" : ""}}

`
    : "";
  const construct = native
    ? `std::construct_at(stored, ${nativeMove ? "std::move(value)" : "value"});`
    : `*stored = value;`;
  const register = managed || native
    ? `\n  z_arena_register_cleanup(arena, stored, ${cleanupName});`
    : "";
  return `${cleanup}${generateArenaCreateSignature(type, structs, enums, semanticInfo.foreignNamedTypes)} {
  ${mapped} *stored = (${mapped} *)z_arena_allocate(arena, sizeof(${mapped}), Z_ALIGNOF(${mapped}));
  ${construct}${register}
  return stored;
}`;
}

function generateSystemStandardRuntime(used: ReadonlySet<StandardFunctionName>): string {
  const sections: string[] = [];
  const stringResult = enumName(resultTypeName("String", "String"));
  const voidResult = enumName(resultTypeName("void", "String"));
  const processResult = enumName(resultTypeName("i32", "String"));
  const stringSuccess = variantTag(resultTypeName("String", "String"), "success");
  const stringFailure = variantTag(resultTypeName("String", "String"), "failure");
  const voidSuccess = variantTag(resultTypeName("void", "String"), "success");
  const voidFailure = variantTag(resultTypeName("void", "String"), "failure");
  const processSuccess = variantTag(resultTypeName("i32", "String"), "success");
  const processFailure = variantTag(resultTypeName("i32", "String"), "failure");

  if ([...used].some((name) => name.startsWith("fs.")) || used.has("process.run")) {
    sections.push(`static bool z_standard_string_is_cstring(const Z_String *value) {
  return value != NULL && (value->length == 0 || (value->data != NULL && memchr(value->data, '\\0', value->length) == NULL));
}`);
  }
  if (used.has("fs.readText") || used.has("fs.writeText") || used.has("process.run")) {
    sections.push(`static Z_String z_standard_error(const char *message) {
  return z_string_from_cstring(message != NULL ? message : "unknown operating-system error");
}`);
  }

  if (used.has("fs.readText")) {
    sections.push(`static ${stringResult} z_fs_read_text(Z_String path) {
  if (!z_standard_string_is_cstring(&path)) {
    return (${stringResult}){ .tag = ${stringFailure}, .data.failure = z_standard_error("path contains an embedded null byte") };
  }
  const char *native_path = path.data != NULL ? path.data : "";
  FILE *file = fopen(native_path, "rb");
  if (file == NULL) {
    return (${stringResult}){ .tag = ${stringFailure}, .data.failure = z_standard_error(strerror(errno)) };
  }
  if (fseek(file, 0, SEEK_END) != 0) {
    const int code = errno;
    fclose(file);
    return (${stringResult}){ .tag = ${stringFailure}, .data.failure = z_standard_error(strerror(code)) };
  }
  const long measured = ftell(file);
  if (measured < 0 || fseek(file, 0, SEEK_SET) != 0) {
    const int code = errno;
    fclose(file);
    return (${stringResult}){ .tag = ${stringFailure}, .data.failure = z_standard_error(strerror(code)) };
  }
  Z_String contents = z_string_new();
  if (measured > 0) {
    z_string_reserve(&contents, (uintptr_t)measured);
    const size_t count = fread((void *)contents.data, 1, (size_t)measured, file);
    if (count != (size_t)measured) {
      const int code = ferror(file) ? errno : EIO;
      fclose(file);
      if (contents.capacity > 0) free((void *)contents.data);
      return (${stringResult}){ .tag = ${stringFailure}, .data.failure = z_standard_error(strerror(code)) };
    }
    contents.length = (uintptr_t)count;
    ((char *)contents.data)[contents.length] = '\\0';
  }
  if (fclose(file) != 0) {
    const int code = errno;
    if (contents.capacity > 0) free((void *)contents.data);
    return (${stringResult}){ .tag = ${stringFailure}, .data.failure = z_standard_error(strerror(code)) };
  }
  if (!z_string_is_valid_utf8(contents.data != NULL ? contents.data : "", contents.length)) {
    if (contents.capacity > 0) free((void *)contents.data);
    return (${stringResult}){ .tag = ${stringFailure}, .data.failure = z_standard_error("file is not valid UTF-8") };
  }
  return (${stringResult}){ .tag = ${stringSuccess}, .data.success = contents };
}`);
  }

  if (used.has("fs.writeText")) {
    sections.push(`static ${voidResult} z_fs_write_text(Z_String path, Z_String contents) {
  if (!z_standard_string_is_cstring(&path)) {
    return (${voidResult}){ .tag = ${voidFailure}, .data.failure = z_standard_error("path contains an embedded null byte") };
  }
  const char *native_path = path.data != NULL ? path.data : "";
  FILE *file = fopen(native_path, "wb");
  if (file == NULL) {
    return (${voidResult}){ .tag = ${voidFailure}, .data.failure = z_standard_error(strerror(errno)) };
  }
  const char *data = contents.data != NULL ? contents.data : "";
  if (contents.length > 0 && fwrite(data, 1, (size_t)contents.length, file) != (size_t)contents.length) {
    const int code = errno;
    fclose(file);
    return (${voidResult}){ .tag = ${voidFailure}, .data.failure = z_standard_error(strerror(code)) };
  }
  if (fclose(file) != 0) {
    return (${voidResult}){ .tag = ${voidFailure}, .data.failure = z_standard_error(strerror(errno)) };
  }
  return (${voidResult}){ .tag = ${voidSuccess} };
}`);
  }

  if (used.has("fs.exists")) {
    sections.push(`static bool z_fs_exists(Z_String path) {
  if (!z_standard_string_is_cstring(&path)) return false;
  const char *native_path = path.data != NULL ? path.data : "";
#if defined(_WIN32)
  return _access(native_path, 0) == 0;
#else
  return access(native_path, F_OK) == 0;
#endif
}`);
  }

  if ([...used].some((name) => name.startsWith("process."))) {
    const array = dynamicArrayName(dynamicArrayTypeName("String"));
    sections.push(`static int z_process_argc = 0;
static char **z_process_argv = NULL;

static void z_process_set_arguments(int argc, char **argv) {
  z_process_argc = argc;
  z_process_argv = argv;
}`);
    if (used.has("process.args")) {
      sections.push(`static ${array} z_process_args(void) {
  ${array} result = { .data = NULL, .length = 0, .capacity = 0 };
  if (z_process_argc <= 1 || z_process_argv == NULL) return result;
  result.length = (uintptr_t)(z_process_argc - 1);
  result.capacity = result.length;
  result.data = (Z_String *)calloc(result.capacity, sizeof(Z_String));
  if (result.data == NULL) abort();
  for (uintptr_t index = 0; index < result.length; index += 1) {
    result.data[index] = z_string_from_cstring(z_process_argv[index + 1]);
  }
  return result;
}`);
    }
  }

  if (used.has("process.run")) {
    const slice = sliceName(sliceTypeName("String"));
    sections.push(`static ${processResult} z_process_run(Z_String program, ${slice} arguments) {
  if (!z_standard_string_is_cstring(&program)) {
    return (${processResult}){ .tag = ${processFailure}, .data.failure = z_standard_error("program contains an embedded null byte") };
  }
  for (uintptr_t index = 0; index < arguments.length; index += 1) {
    if (!z_standard_string_is_cstring(&arguments.data[index])) {
      return (${processResult}){ .tag = ${processFailure}, .data.failure = z_standard_error("process argument contains an embedded null byte") };
    }
  }
  if (arguments.length > SIZE_MAX / sizeof(char *) - 2) abort();
  char **argv = (char **)calloc(arguments.length + 2, sizeof(char *));
  if (argv == NULL) abort();
  argv[0] = (char *)(program.data != NULL ? program.data : "");
  for (uintptr_t index = 0; index < arguments.length; index += 1) {
    argv[index + 1] = (char *)(arguments.data[index].data != NULL ? arguments.data[index].data : "");
  }
#if defined(_WIN32)
  const intptr_t status = _spawnvp(_P_WAIT, argv[0], (const char * const *)argv);
  if (status == -1) {
    const int code = errno;
    free(argv);
    return (${processResult}){ .tag = ${processFailure}, .data.failure = z_standard_error(strerror(code)) };
  }
  free(argv);
  return (${processResult}){ .tag = ${processSuccess}, .data.success = (int32_t)status };
#else
  int error_pipe[2];
  if (pipe(error_pipe) != 0) {
    const int code = errno;
    free(argv);
    return (${processResult}){ .tag = ${processFailure}, .data.failure = z_standard_error(strerror(code)) };
  }
  if (fcntl(error_pipe[1], F_SETFD, FD_CLOEXEC) == -1) {
    const int code = errno;
    close(error_pipe[0]);
    close(error_pipe[1]);
    free(argv);
    return (${processResult}){ .tag = ${processFailure}, .data.failure = z_standard_error(strerror(code)) };
  }
  const pid_t child = fork();
  if (child < 0) {
    const int code = errno;
    close(error_pipe[0]);
    close(error_pipe[1]);
    free(argv);
    return (${processResult}){ .tag = ${processFailure}, .data.failure = z_standard_error(strerror(code)) };
  }
  if (child == 0) {
    close(error_pipe[0]);
    execvp(argv[0], argv);
    const int code = errno;
    (void)write(error_pipe[1], &code, sizeof(code));
    close(error_pipe[1]);
    _exit(127);
  }
  close(error_pipe[1]);
  int exec_error = 0;
  ssize_t error_bytes;
  do {
    error_bytes = read(error_pipe[0], &exec_error, sizeof(exec_error));
  } while (error_bytes < 0 && errno == EINTR);
  const int pipe_error = error_bytes < 0 ? errno : 0;
  close(error_pipe[0]);
  int status = 0;
  pid_t waited;
  do {
    waited = waitpid(child, &status, 0);
  } while (waited < 0 && errno == EINTR);
  free(argv);
  if (waited < 0) {
    return (${processResult}){ .tag = ${processFailure}, .data.failure = z_standard_error(strerror(errno)) };
  }
  if (pipe_error != 0) {
    return (${processResult}){ .tag = ${processFailure}, .data.failure = z_standard_error(strerror(pipe_error)) };
  }
  if (error_bytes == (ssize_t)sizeof(exec_error)) {
    return (${processResult}){ .tag = ${processFailure}, .data.failure = z_standard_error(strerror(exec_error)) };
  }
  const int32_t exit_code = WIFEXITED(status)
    ? (int32_t)WEXITSTATUS(status)
    : WIFSIGNALED(status) ? (int32_t)(128 + WTERMSIG(status)) : 1;
  return (${processResult}){ .tag = ${processSuccess}, .data.success = exit_code };
#endif
}`);
  }

  return sections.join("\n\n");
}

function generateIntegerRuntime(
  operations: ReadonlyMap<number, IntegerOperation>,
  conversions: ReadonlyMap<number, IntegerConversion>,
  contextualLiterals: ReadonlyMap<number, string>,
): string[] {
  const uniqueOperations = new Map<string, IntegerOperation>();
  for (const [offset, operation] of operations) {
    if (contextualLiterals.has(offset)) continue;
    uniqueOperations.set(`${operation.kind}:${operation.type}`, operation);
  }
  const generatedOperations = [...uniqueOperations.values()]
    .sort((left, right) => integerOperationName(left).localeCompare(integerOperationName(right)))
    .flatMap((operation) => [generateIntegerOperation(operation), ""]);
  const uniqueConversions = new Map<string, IntegerConversion>();
  for (const conversion of conversions.values()) {
    if (!conversion.checked) continue;
    uniqueConversions.set(`${conversion.sourceType}:${conversion.targetType}`, conversion);
  }
  const generatedConversions = [...uniqueConversions.values()]
    .sort((left, right) => integerConversionName(left).localeCompare(integerConversionName(right)))
    .flatMap((conversion) => [generateIntegerConversion(conversion), ""]);
  return [...generatedOperations, ...generatedConversions];
}

function integerConversionName(conversion: IntegerConversion): string {
  return `z_checked_convert_${conversion.sourceType}_to_${conversion.targetType}`;
}

function generateIntegerConversion(conversion: IntegerConversion): string {
  const sourceCType = primitiveTypeNames[conversion.sourceType];
  const targetCType = primitiveTypeNames[conversion.targetType];
  if (!sourceCType || !targetCType) {
    throw new Error(`unsupported integer conversion ${conversion.sourceType} to ${conversion.targetType}`);
  }
  const limits: Readonly<Record<string, { readonly minimum?: string; readonly maximum: string }>> = {
    i8: { minimum: "INT8_MIN", maximum: "INT8_MAX" },
    u8: { maximum: "UINT8_MAX" },
    i16: { minimum: "INT16_MIN", maximum: "INT16_MAX" },
    u16: { maximum: "UINT16_MAX" },
    i32: { minimum: "INT32_MIN", maximum: "INT32_MAX" },
    u32: { maximum: "UINT32_MAX" },
    i64: { minimum: "INT64_MIN", maximum: "INT64_MAX" },
    u64: { maximum: "UINT64_MAX" },
    isize: { minimum: "INTPTR_MIN", maximum: "INTPTR_MAX" },
    usize: { maximum: "UINTPTR_MAX" },
  };
  const source = limits[conversion.sourceType]!;
  const target = limits[conversion.targetType]!;
  const sourceSigned = Boolean(source.minimum);
  const targetSigned = Boolean(target.minimum);
  const sourceBounds = integerRuntimeBounds(conversion.sourceType);
  const targetBounds = integerRuntimeBounds(conversion.targetType);
  const checks: string[] = [];
  if (sourceSigned && !targetSigned) checks.push("value < 0");
  if (targetBounds.maximum < sourceBounds.maximum) {
    checks.push(`value > (${sourceCType})${target.maximum}`);
  }
  if (sourceSigned && targetSigned && targetBounds.minimum > sourceBounds.minimum) {
    checks.push(`value < (${sourceCType})${target.minimum}`);
  }
  if (checks.length === 0) {
    throw new Error(`checked integer conversion ${conversion.sourceType} to ${conversion.targetType} has no range check`);
  }
  return [
    `static inline ${targetCType} ${integerConversionName(conversion)}(${sourceCType} value) {`,
    `  if (${checks.join(" || ")}) abort();`,
    `  return (${targetCType})value;`,
    "}",
  ].join("\n");
}

function integerRuntimeBounds(type: string): { readonly minimum: bigint; readonly maximum: bigint } {
  const widths: Readonly<Record<string, number>> = {
    i8: 8,
    u8: 8,
    i16: 16,
    u16: 16,
    i32: 32,
    u32: 32,
    i64: 64,
    u64: 64,
    isize: process.arch.includes("64") ? 64 : 32,
    usize: process.arch.includes("64") ? 64 : 32,
  };
  const width = widths[type];
  if (!width) throw new Error(`unknown integer type ${JSON.stringify(type)}`);
  const unsigned = type.startsWith("u");
  return {
    minimum: unsigned ? 0n : -(1n << BigInt(width - 1)),
    maximum: unsigned ? (1n << BigInt(width)) - 1n : (1n << BigInt(width - 1)) - 1n,
  };
}

function integerOperationName(operation: IntegerOperation): string {
  const names: Readonly<Record<IntegerOperation["kind"], string>> = {
    checkedAdd: "checked_add",
    checkedSubtract: "checked_subtract",
    checkedMultiply: "checked_multiply",
    checkedDivide: "checked_divide",
    checkedRemainder: "checked_remainder",
    checkedNegate: "checked_negate",
    checkedShiftLeft: "checked_shift_left",
    checkedShiftRight: "checked_shift_right",
    wrappingAdd: "wrapping_add",
    wrappingSubtract: "wrapping_subtract",
    wrappingMultiply: "wrapping_multiply",
    saturatingAdd: "saturating_add",
    saturatingSubtract: "saturating_subtract",
    saturatingMultiply: "saturating_multiply",
  };
  return `z_${names[operation.kind]}_${operation.type}`;
}

function generateIntegerOperation(operation: IntegerOperation): string {
  const cType = primitiveTypeNames[operation.type];
  if (!cType) throw new Error(`unsupported integer operation type ${JSON.stringify(operation.type)}`);
  const name = integerOperationName(operation);
  const signed = !operation.type.startsWith("u");
  const limits: Readonly<Record<string, { readonly minimum?: string; readonly maximum: string }>> = {
    i8: { minimum: "INT8_MIN", maximum: "INT8_MAX" },
    u8: { maximum: "UINT8_MAX" },
    i16: { minimum: "INT16_MIN", maximum: "INT16_MAX" },
    u16: { maximum: "UINT16_MAX" },
    i32: { minimum: "INT32_MIN", maximum: "INT32_MAX" },
    u32: { maximum: "UINT32_MAX" },
    i64: { minimum: "INT64_MIN", maximum: "INT64_MAX" },
    u64: { maximum: "UINT64_MAX" },
    isize: { minimum: "INTPTR_MIN", maximum: "INTPTR_MAX" },
    usize: { maximum: "UINTPTR_MAX" },
  };
  const limit = limits[operation.type]!;
  const binaryHeader = `static inline ${cType} ${name}(${cType} left, ${cType} right) {`;
  const result = `  ${cType} result;`;
  if (operation.kind === "checkedNegate") {
    return [
      `static inline ${cType} ${name}(${cType} value) {`,
      result,
      "  if (__builtin_sub_overflow(0, value, &result)) abort();",
      "  return result;",
      "}",
    ].join("\n");
  }
  if (operation.kind === "checkedAdd" || operation.kind === "checkedSubtract" || operation.kind === "checkedMultiply") {
    const builtin = operation.kind === "checkedAdd"
      ? "__builtin_add_overflow"
      : operation.kind === "checkedSubtract"
        ? "__builtin_sub_overflow"
        : "__builtin_mul_overflow";
    return [binaryHeader, result, `  if (${builtin}(left, right, &result)) abort();`, "  return result;", "}"].join("\n");
  }
  if (operation.kind === "checkedDivide" || operation.kind === "checkedRemainder") {
    return [
      binaryHeader,
      "  if (right == 0) abort();",
      ...(signed ? [`  if (left == ${limit.minimum} && right == -1) abort();`] : []),
      `  return left ${operation.kind === "checkedDivide" ? "/" : "%"} right;`,
      "}",
    ].join("\n");
  }
  if (operation.kind === "checkedShiftLeft" || operation.kind === "checkedShiftRight") {
    const rangeCheck = signed
      ? "  if (right < 0 || (uint64_t)right >= sizeof(left) * 8) abort();"
      : "  if ((uint64_t)right >= sizeof(left) * 8) abort();";
    if (operation.kind === "checkedShiftRight") {
      return [binaryHeader, rangeCheck, "  return left >> right;", "}"].join("\n");
    }
    return [
      binaryHeader,
      rangeCheck,
      result,
      "  uint64_t factor = UINT64_C(1) << (uint64_t)right;",
      "  if (__builtin_mul_overflow(left, factor, &result)) abort();",
      "  return result;",
      "}",
    ].join("\n");
  }
  const wrappingBuiltin = operation.kind.endsWith("Add")
    ? "__builtin_add_overflow"
    : operation.kind.endsWith("Subtract")
      ? "__builtin_sub_overflow"
      : "__builtin_mul_overflow";
  if (operation.kind.startsWith("wrapping")) {
    return [
      binaryHeader,
      result,
      `  (void)${wrappingBuiltin}(left, right, &result);`,
      "  return result;",
      "}",
    ].join("\n");
  }
  const saturation = !signed
    ? operation.kind === "saturatingSubtract" ? "0" : limit.maximum
    : operation.kind === "saturatingAdd"
      ? `(right > 0 ? ${limit.maximum} : ${limit.minimum})`
      : operation.kind === "saturatingSubtract"
        ? `(right > 0 ? ${limit.minimum} : ${limit.maximum})`
        : `((left < 0) != (right < 0) ? ${limit.minimum} : ${limit.maximum})`;
  return [
    binaryHeader,
    result,
    `  if (${wrappingBuiltin}(left, right, &result)) return ${saturation};`,
    "  return result;",
    "}",
  ].join("\n");
}

function generateNumericLiteral(value: string, type: string | undefined): string {
  const isFloating = /[.eE]/.test(value);
  if (type === "f32") return `${value}${isFloating ? "F" : ".0F"}`;
  if (type === "f64") return isFloating ? value : `${value}.0`;
  if (type === "u32") return `${value}U`;
  if (type === "u64" || type === "usize") return `${value}ULL`;
  if (type === "i64" || type === "isize") return `${value}LL`;
  return value;
}

function generateContextualSignedLiteral(operator: "+" | "-", value: string, type: string): string {
  if (operator === "+") return generateNumericLiteral(value, type);
  if (/[.eE]/.test(value)) return `(-${generateNumericLiteral(value, type)})`;
  const widths: Readonly<Record<string, number>> = {
    i8: 8,
    i16: 16,
    i32: 32,
    i64: 64,
    isize: process.arch.includes("64") ? 64 : 32,
  };
  const minimumMacros: Readonly<Record<string, string>> = {
    i8: "INT8_MIN",
    i16: "INT16_MIN",
    i32: "INT32_MIN",
    i64: "INT64_MIN",
    isize: "INTPTR_MIN",
  };
  const width = widths[type];
  if (width && -BigInt(value) === -(1n << BigInt(width - 1))) return minimumMacros[type];
  return `(-${generateNumericLiteral(value, type)})`;
}

function inferExpressionType(expression: Expression, context: GenerationContext): string {
  const integerOperation = context.semanticInfo.integerOperations.get(expression.location.offset);
  if (integerOperation) return integerOperation.type;
  const analyzedType = context.semanticInfo.expressionTypes.get(expression.location.offset);
  if (analyzedType && (
    analyzedType === "String"
    || analyzedType === "TextBuffer"
    || analyzedType === "Arena"
    || analyzedType === "TaskScope"
    || analyzedType === "boolean"
    || analyzedType === "u8"
    || analyzedType === "usize"
    || parseFunctionType(analyzedType)
    || parseWeakType(analyzedType)
    || parseWeakResultType(analyzedType)
    || parseViewType(analyzedType)
    || context.structs.has(analyzedType)
    || context.enums.has(analyzedType)
    || context.semanticInfo.foreignNamedTypes.has(analyzedType)
  )) return analyzedType;
  const foreignExpressionType = context.semanticInfo.foreignExpressionTypes.get(expression.location.offset);
  if (foreignExpressionType) return foreignExpressionType;
  const foreignCallType = expression.kind === "call"
    ? context.semanticInfo.foreignCallTypes.get(expression.location.offset)
    : null;
  if (foreignCallType) return foreignCallType;
  switch (expression.kind) {
    case "number":
      return /[.eE]/.test(expression.value) ? "f64" : "i32";
    case "string":
      return "String";
    case "template":
      return "String";
    case "boolean":
    case "null":
      return expression.kind === "null" ? "null" : "boolean";
    case "unary":
      return context.semanticInfo.expressionTypes.get(expression.location.offset)
        ?? (expression.operator === "!" ? "boolean" : inferExpressionType(expression.operand, context));
    case "binary":
      return ["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>"].includes(expression.operator) ? "i32" : "boolean";
    case "conditional":
      return inferExpressionType(expression.thenExpression, context);
    case "new":
      return expression.typeName;
    case "weak":
      return context.semanticInfo.expressionTypes.get(expression.location.offset)!;
    case "closure":
      return `__z_closure_${expression.location.offset}`;
    case "identifier":
      return context.localTypes.get(expression.name) ?? "i32";
    case "argumentReference":
      return context.localTypes.get(expression.name) ?? "i32";
    case "structExpression":
      return expression.typeName;
    case "objectExpression":
      return context.semanticInfo.expressionTypes.get(expression.location.offset)!;
    case "arrayExpression":
      return context.semanticInfo.expressionTypes.get(expression.location.offset)!;
    case "dynamicArrayExpression":
      return dynamicArrayTypeName(expression.elementType);
    case "index": {
      const ownerType = inferExpressionType(expression.object, context);
      return (parseFixedArrayType(ownerType) ?? parseSliceType(ownerType) ?? parseDynamicArrayType(ownerType))?.elementType ?? "i32";
    }
    case "variantExpression":
      return expression.enumName;
    case "attempt": {
      return throwingCallResultType(expression.expression, context);
    }
    case "try":
      return trySuccessType(expression, context);
    case "executorPlacement":
      return context.semanticInfo.expressionTypes.get(expression.location.offset)!;
    case "matchExpression":
      return matchExpressionType(expression, context);
    case "ifExpression":
      return ifExpressionType(expression, context);
    case "whileExpression":
    case "forExpression":
      return loopExpressionType(expression, context);
    case "member": {
      const ownerType = inferExpressionType(expression.object, context);
      const ownerValueType = parseViewType(ownerType)?.target ?? ownerType;
      if (parseMapType(ownerValueType) || parseSetType(ownerValueType)) return "usize";
      if (parseFixedArrayType(ownerValueType) || parseSliceType(ownerValueType) || parseDynamicArrayType(ownerValueType)) return "usize";
      if (expression.object.kind === "identifier" && context.enums.has(expression.object.name)) {
        return expression.object.name;
      }
      if (isForeignMember(expression, context)) return "i32";
      const owner = context.structs.get(ownerValueType);
      return owner?.fields.find((field) => field.name === expression.property)?.type.name ?? "i32";
    }
    case "call": {
      const standard = context.semanticInfo.standardFunctionReferences.get(expression.callee.location.offset);
      if (standard) {
        const signature = standardFunctionSignature(standard);
        return signature.errorType
          ? resultTypeName(signature.returnType, signature.errorType)
          : signature.returnType;
      }
      if (expression.callee.kind === "identifier") {
        if (context.structs.get(expression.callee.name)?.kind === "struct") return expression.callee.name;
        const closure = closureForType(context.localTypes.get(expression.callee.name), context.semanticInfo);
        if (closure) return closure.declaration.errorType
          ? resultTypeName(closure.declaration.returnType.name, closure.declaration.errorType.name)
          : closure.declaration.returnType.name;
        return context.functions.get(expression.callee.name)?.returnType.name ?? "i32";
      }
      if (expression.callee.kind === "member"
        && expression.callee.object.kind === "identifier"
        && expression.callee.object.name === "String") {
        return "String";
      }
      if (expression.callee.kind === "member" && !isForeignMember(expression.callee, context)) {
        if (expression.callee.object.kind === "identifier") {
          const owner = context.structs.get(expression.callee.object.name);
          const method = owner?.methods.find((candidate) => candidate.static && candidate.name === expression.callee.property);
          if (method) return method.returnType.name;
        }
        if (expression.callee.object.kind === "identifier" && context.enums.has(expression.callee.object.name)) {
          return expression.callee.object.name;
        }
        const receiverType = inferExpressionType(expression.callee.object, context);
        const map = parseMapType(receiverType);
        if (map) {
          if (expression.callee.property === "has") return "boolean";
          if (expression.callee.property === "get") {
            return optionTypeName(mapValueHasReferenceIdentity(map.valueType, context.structs, context.semanticInfo)
              ? map.valueType
              : viewTypeName(map.valueType));
          }
          if (expression.callee.property === "remove") return optionTypeName(map.valueType);
          return "void";
        }
        const set = parseSetType(receiverType);
        if (set) {
          if (expression.callee.property === "has" || expression.callee.property === "add") return "boolean";
          if (expression.callee.property === "remove") return optionTypeName(set.elementType);
          return "void";
        }
        if (parseDynamicArrayType(receiverType)) return "void";
        const weak = parseWeakType(receiverType);
        if (weak && expression.callee.property === "upgrade") return weakResultTypeName(weak.target);
        const owner = context.structs.get(receiverType);
        return owner?.methods.find((method) => method.name === expression.callee.property)?.returnType.name ?? "i32";
      }
      return "i32";
    }
  }
}

function closureForType(type: string | undefined, semanticInfo: SemanticInfo) {
  if (!type) return null;
  return [...semanticInfo.closures.values()].find((closure) => closure.type === type) ?? null;
}

function closureCaptureStorageName(closure: ClosureInfo, name: string): string {
  return `_z_capture_${closure.declaration.location.offset}_${name}`;
}

function directValueType(expression: Expression, context: GenerationContext): string {
  let type: string;
  if (expression.kind === "try") type = trySuccessType(expression, context);
  else if (expression.kind === "matchExpression") type = matchExpressionType(expression, context);
  else if (expression.kind === "ifExpression") type = ifExpressionType(expression, context);
  else if (expression.kind === "whileExpression" || expression.kind === "forExpression") {
    type = loopExpressionType(expression, context);
  }
  else type = inferExpressionType(expression, context);
  if (context.semanticInfo.viewLoadExpressions.has(expression.location.offset)) {
    return parseViewType(type)?.target ?? type;
  }
  return type;
}

function ifExpressionType(expression: Extract<Expression, { kind: "ifExpression" }>, context: GenerationContext): string {
  return valueArmType(expression.thenBranch, context)
    ?? (expression.elseBranch.kind === "ifExpression"
      ? ifExpressionType(expression.elseBranch, context)
      : valueArmType(expression.elseBranch, context))
    ?? "i32";
}

function matchExpressionType(expression: Extract<Expression, { kind: "matchExpression" }>, context: GenerationContext): string {
  const subjectType = inferExpressionType(expression.expression, context);
  const declaration = context.enums.get(subjectType)!;
  for (const arm of expression.arms) {
    const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName)!;
    const armTypes = new Map(context.localTypes);
    if (variant.payload && arm.binding) armTypes.set(arm.binding, variant.payload.name);
    const payload = variant.payload ? context.structs.get(variant.payload.name) : null;
    for (const fieldBinding of arm.objectBindings ?? []) {
      const field = payload!.fields.find((candidate) => candidate.name === fieldBinding.fieldName)!;
      armTypes.set(fieldBinding.bindingName, field.type.name);
    }
    const type = valueArmType(arm.body, { ...context, localTypes: armTypes });
    if (type) return type;
  }
  return "i32";
}

function loopExpressionType(
  expression: Extract<Expression, { kind: "whileExpression" | "forExpression" }>,
  context: GenerationContext,
): string {
  return context.semanticInfo.expressionTypes.get(expression.location.offset)
    ?? valueArmType(expression.elseBranch, context)
    ?? "i32";
}

function valueArmType(statement: Statement, context: GenerationContext): string | null {
  if (statement.kind === "expressionStatement" || statement.kind === "select") {
    return directValueType(statement.expression, context);
  }
  if (statement.kind === "block") return valueArmType(statement.statements.at(-1)!, context);
  if (statement.kind === "match") return matchExpressionType({ ...statement, kind: "matchExpression" }, context);
  return null;
}

function isForeignMember(
  expression: Extract<Expression, { kind: "member" }>,
  context: GenerationContext,
): boolean {
  return expression.object.kind === "identifier"
    && !context.localTypes.has(expression.object.name)
    && !context.structs.has(expression.object.name)
    && !context.enums.has(expression.object.name);
}

function mapType(
  name: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"] = new Map(),
): string {
  const view = parseViewType(name);
  if (view) return `const ${mapType(view.target, structs, enums, foreignNamedTypes)} *`;
  const functionType = parseFunctionType(name);
  if (functionType) return functionTypeCName(functionType);
  if (parseWeakType(name)) return "Z_Weak";
  if (parseGeneratorType(name)) return generatorCName(name);
  const primitive = primitiveTypeNames[name];
  if (primitive) return primitive;
  if (parseFixedArrayType(name)) return arrayName(name);
  if (parseSliceType(name)) return sliceName(name);
  if (parseDynamicArrayType(name)) return dynamicArrayName(name);
  const aggregate = structs.get(name);
  if (aggregate) return aggregate.kind === "class" ? `${structName(name)} *` : structName(name);
  if (enums.has(name)) return enumName(name);
  const foreignNamed = foreignNamedTypes.get(name);
  if (foreignNamed) return foreignNamed.cName;
  if (name.startsWith("__z_ffi:")) return name.split(":").slice(3).join(":");
  if (name.startsWith("__z_objc:")) {
    const baseName = name.replace(/^__z_objc:(?:nullable|nonnull):/, "");
    if (baseName === "id") return "id";
    return `${baseName.slice(baseName.lastIndexOf(".") + 1)} *`;
  }
  if (name.includes(".")) return name.slice(name.lastIndexOf(".") + 1);
  throw new Error(`unsupported bootstrap type ${JSON.stringify(name)}`);
}

function requiresNativeMove(
  name: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(name)) return false;
  const foreign = foreignNamedTypes.get(name);
  if (foreign?.kind === "value") return foreign.lifecycle.move && !foreign.lifecycle.copy;
  const array = parseFixedArrayType(name);
  if (array) return requiresNativeMove(array.elementType, structs, enums, foreignNamedTypes, visiting);
  const dynamic = parseDynamicArrayType(name);
  if (dynamic) return requiresNativeMove(dynamic.elementType, structs, enums, foreignNamedTypes, visiting);
  const declaration = structs.get(name);
  const enumDeclaration = enums.get(name);
  if (!declaration && !enumDeclaration) return false;
  if (declaration?.kind === "class") return false;
  visiting.add(name);
  const result = declaration
    ? declaration.fields.some((field) => requiresNativeMove(field.type.name, structs, enums, foreignNamedTypes, visiting))
    : enumDeclaration!.variants.some((variant) => (
      variant.payload && requiresNativeMove(variant.payload.name, structs, enums, foreignNamedTypes, visiting)
    ));
  visiting.delete(name);
  return Boolean(result);
}

function requiresNativeLifetime(
  name: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: SemanticInfo["foreignNamedTypes"],
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(name)) return false;
  if (foreignNamedTypes.get(name)?.kind === "value") return true;
  const array = parseFixedArrayType(name);
  if (array) return requiresNativeLifetime(array.elementType, structs, enums, foreignNamedTypes, visiting);
  const dynamic = parseDynamicArrayType(name);
  if (dynamic) return requiresNativeLifetime(dynamic.elementType, structs, enums, foreignNamedTypes, visiting);
  const declaration = structs.get(name);
  const enumDeclaration = enums.get(name);
  if (!declaration && !enumDeclaration) return false;
  if (declaration?.kind === "class") return false;
  visiting.add(name);
  const result = declaration
    ? declaration.fields.some((field) => requiresNativeLifetime(field.type.name, structs, enums, foreignNamedTypes, visiting))
    : enumDeclaration!.variants.some((variant) => (
      variant.payload && requiresNativeLifetime(variant.payload.name, structs, enums, foreignNamedTypes, visiting)
    ));
  visiting.delete(name);
  return Boolean(result);
}

function mapValueHasReferenceIdentity(
  type: string,
  structs: ReadonlyMap<string, StructDeclaration>,
  semanticInfo: Pick<SemanticInfo, "foreignNamedTypes">,
): boolean {
  return structs.get(type)?.kind === "class" || semanticInfo.foreignNamedTypes.get(type)?.kind === "object";
}

export function generateObjCMessage(receiver: string, selector: string, args: string[]): string {
  if (args.length === 0) return `[${receiver} ${selector}]`;
  const parts = selector.split(":");
  const message = args.map((argument, index) => `${parts[index]}:${argument}`).join(" ");
  return `[${receiver} ${message}]`;
}

function enumName(name: string): string {
  return `Z_${nativeSymbolPart(name.replace(/^__z_/, ""))}`;
}

function variantTag(owner: string, variant: string): string {
  return `${enumName(owner)}_${variant}`;
}

function structName(name: string): string {
  return `Z_${nativeSymbolPart(name)}`;
}

function arrayName(name: string): string {
  return `Z_Array_${nativeSymbolPart(name)}`;
}

function sliceName(name: string): string {
  return `Z_Slice_${nativeSymbolPart(name)}`;
}

function dynamicArrayName(name: string): string {
  return `Z_DynamicArray_${nativeSymbolPart(name)}`;
}

function generatorCName(name: string): string {
  return `Z_Generator_${nativeSymbolPart(name)}`;
}

function generatorNextName(name: string): string {
  return `${generatorCName(name)}_next`;
}

function generatorDeinitName(name: string): string {
  return `${generatorCName(name)}_deinit`;
}

function dynamicArrayPushName(name: string): string {
  return `${dynamicArrayName(name)}_push`;
}

function mapMethodName(name: string, method: string): string {
  return `Z_Map_${nativeSymbolPart(name)}_${method}`;
}

function mapEqualityName(name: string): string {
  return `Z_Map_${nativeSymbolPart(name)}_key_equal`;
}

function setMethodName(name: string, method: string): string {
  return `Z_Set_${nativeSymbolPart(name)}_${method}`;
}

function setEqualityName(name: string): string {
  return `Z_Set_${nativeSymbolPart(name)}_element_equal`;
}

function nativeSymbolPart(name: string): string {
  return [...name].map((character) => (
    /[A-Za-z0-9_]/.test(character) ? character : `_${character.codePointAt(0)!.toString(16)}_`
  )).join("");
}

function methodName(owner: string, method: string): string {
  return `${structName(owner)}_${method}`;
}

function deinitName(owner: string): string {
  return `${structName(owner)}_deinit`;
}

function constructorName(owner: string): string {
  return `${structName(owner)}_new`;
}

function retainName(owner: string): string {
  return `${structName(owner)}_retain`;
}

function releaseName(owner: string): string {
  return `${structName(owner)}_release`;
}

function weakMakeName(owner: string): string {
  return `${structName(owner)}_weak`;
}

function weakUpgradeName(owner: string): string {
  return `${structName(owner)}_weak_upgrade`;
}

function nextLiveFlag(name: string, counter: { value: number }): string {
  return `_z_live_${name}_${counter.value++}`;
}

const cReservedWords = new Set(`
  alignas alignof and and_eq asm atomic_cancel atomic_commit atomic_noexcept auto bitand bitor bool break
  case catch char char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue
  co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false
  float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq
  private protected public reflexpr register reinterpret_cast requires return short signed sizeof static static_assert
  static_cast struct switch synchronized template this thread_local throw true try typedef typeid typename union
  unsigned using virtual void volatile wchar_t while xor xor_eq _Alignas _Alignof _Atomic _Bool _Complex
  _Generic _Imaginary _Noreturn _Static_assert _Thread_local
`.trim().split(/\s+/));

function cBindingName(name: string): string {
  return cReservedWords.has(name) ? `z_${name}` : name;
}

function hasCleanupType(
  type: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignTypes: SemanticInfo["foreignTypes"] = new Map(),
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(type)) return false;
  if (type === "String" || type === "TextBuffer" || type === "Arena" || type === "TaskScope") return true;
  if (parseGeneratorType(type)) return true;
  if (parseWeakType(type)) return true;
  if (parseFunctionType(type)) return true;
  if (foreignTypes.get(type)?.ownership === "owned") return true;
  if (parseDynamicArrayType(type)) return true;
  const declaration = structs.get(type);
  const enumDeclaration = enums.get(type);
  const array = parseFixedArrayType(type);
  if (array) return hasCleanupType(array.elementType, structs, enums, foreignTypes, visiting);
  if (!declaration && !enumDeclaration) return false;
  if (declaration?.kind === "class") return true;
  if (declaration?.deinitializer) return true;
  visiting.add(type);
  const result = declaration
    ? declaration.fields.some((field) => hasCleanupType(field.type.name, structs, enums, foreignTypes, visiting))
    : enumDeclaration!.variants.some((variant) => (
      variant.payload && hasCleanupType(variant.payload.name, structs, enums, foreignTypes, visiting)
    ));
  visiting.delete(type);
  return result;
}

function hasSemanticCleanupType(
  type: string,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  semanticInfo: Pick<SemanticInfo, "foreignTypes" | "foreignNamedTypes">,
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(type)) return false;
  if (parseGeneratorType(type)) return true;
  if (semanticInfo.foreignNamedTypes.get(type)?.kind === "object") return true;
  if (hasCleanupType(type, structs, enums, semanticInfo.foreignTypes)) return true;
  const dynamic = parseDynamicArrayType(type);
  if (dynamic) return hasSemanticCleanupType(dynamic.elementType, structs, enums, semanticInfo, visiting);
  const array = parseFixedArrayType(type);
  if (array) return hasSemanticCleanupType(array.elementType, structs, enums, semanticInfo, visiting);
  const declaration = structs.get(type);
  const enumeration = enums.get(type);
  if (!declaration && !enumeration) return false;
  visiting.add(type);
  const result = declaration
    ? declaration.fields.some((field) => hasSemanticCleanupType(field.type.name, structs, enums, semanticInfo, visiting))
    : enumeration!.variants.some((variant) => (
      variant.payload && hasSemanticCleanupType(variant.payload.name, structs, enums, semanticInfo, visiting)
    ));
  visiting.delete(type);
  return Boolean(result);
}
