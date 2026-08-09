import {
  AggregateDeclaration,
  DeclarationKind,
  FunctionDeclaration,
  ReceiverMode,
  TypeReference,
} from "./parser.zs";
import { ParsedModule } from "./module-symbols.zs";
import {
  ModuleResolveError,
  ModuleResolveErrorKind,
  codedModuleResolutionError,
} from "./semantic-model.zs";

function loweringBoundary(
  in path: String,
  in code: String,
  in message: String,
  line: usize,
  column: usize,
  length: usize
): ModuleResolveError {
  return codedModuleResolutionError(
    ModuleResolveErrorKind.unsupportedLowering,
    code,
    path,
    message,
    line,
    column,
    length
  );
}

function typeIsFunctionValue(in name: String): boolean {
  return name.byteLength > 0 && name.byteAt(0) == 40;
}

function typeIsFixedArray(in name: String): boolean {
  if (name.byteLength < 4 || name.byteAt(name.byteLength - 1) != 93) {
    return false;
  }
  let open = name.byteLength - 2;
  while (open > 0 && name.byteAt(open) != 91) {
    open = open - 1;
  }
  if (name.byteAt(open) != 91 || open + 1 >= name.byteLength - 1) return false;
  let digit = open + 1;
  while (digit < name.byteLength - 1) {
    const byte = name.byteAt(digit);
    if (byte < 48 || byte > 57) return false;
    digit = digit + 1;
  }
  return true;
}

function validateNativeType(
  in path: String,
  in type: TypeReference
): void throws ModuleResolveError {
  if (typeIsFunctionValue(type.name)) {
    throw loweringBoundary(
      path,
      "Z1000",
      `function-value type "${type.name}" has no native representation yet`,
      type.line,
      type.column,
      type.name.byteLength
    );
  }
  if (typeIsFixedArray(type.name)) {
    throw loweringBoundary(
      path,
      "Z1000",
      `fixed-array type "${type.name}" has no native representation yet`,
      type.line,
      type.column,
      type.name.byteLength
    );
  }
}

function validateNativeFunction(
  in path: String,
  in declaration: FunctionDeclaration,
  in owner: String
): void throws ModuleResolveError {
  if (
    declaration.asynchronous
    && declaration.name != "main"
    && declaration.executorAffinity != "thread.main"
  ) {
    throw loweringBoundary(
      path,
      "Z0700",
      `ordinary async function "${declaration.name}" is not executable in the native compiler yet`,
      declaration.line,
      declaration.column,
      5
    );
  }
  if (owner.byteLength > 0 && declaration.staticMethod) {
    throw loweringBoundary(
      path,
      "Z1000",
      `static method "${owner}.${declaration.name}" is not executable in the native compiler yet`,
      declaration.line,
      declaration.column,
      8
    );
  }
  if (declaration.typeParameters.length > 0) {
    const subject = owner.byteLength > 0
      ? `generic method "${owner}.${declaration.name}"`
      : `generic function "${declaration.name}"`;
    throw loweringBoundary(
      path,
      "Z1000",
      `${subject} is not executable in the native compiler yet`,
      declaration.line,
      declaration.column,
      8
    );
  }
  if (owner.byteLength > 0 && declaration.receiverMode == ReceiverMode.move) {
    throw loweringBoundary(
      path,
      "Z1000",
      `consuming method "${owner}.${declaration.name}" is not executable in the native compiler yet`,
      declaration.line,
      declaration.column,
      8
    );
  }
  if (owner.byteLength > 0) {
    match (in declaration.errorType) {
      some(_) => throw loweringBoundary(
        path,
        "Z1000",
        `throwing method "${owner}.${declaration.name}" is not executable in the native compiler yet`,
        declaration.line,
        declaration.column,
        8
      );
      none => {}
    }
  }
  for (const parameter of declaration.parameters) {
    try validateNativeType(path, parameter.type);
  }
  try validateNativeType(path, declaration.returnType);
  match (in declaration.errorType) {
    some(error) => try validateNativeType(path, error);
    none => {}
  }
}

function aggregateKindName(in aggregate: AggregateDeclaration): String {
  return aggregate.kind == DeclarationKind.classDeclaration
    ? "class"
    : "struct";
}

function validateNativeAggregate(
  in path: String,
  in aggregate: AggregateDeclaration
): void throws ModuleResolveError {
  if (aggregate.typeParameters.length > 0) {
    const kind = aggregateKindName(aggregate);
    throw loweringBoundary(
      path,
      "Z1000",
      `generic ${kind} "${aggregate.name}" is not executable in the native compiler yet`,
      aggregate.line,
      aggregate.column,
      kind.byteLength
    );
  }
  match (in aggregate.constructorDeclaration) {
    some(initializer) => throw loweringBoundary(
      path,
      "Z1000",
      `constructor for "${aggregate.name}" is not executable in the native compiler yet`,
      initializer.line,
      initializer.column,
      11
    );
    none => {}
  }
  for (const field of aggregate.fields) {
    try validateNativeType(path, field.type);
  }
  for (const method of aggregate.methods) {
    try validateNativeFunction(path, method, aggregate.name);
  }
}

export function validateNativeLowerability(
  in modules: Array<ParsedModule>
): void throws ModuleResolveError {
  for (const module of modules) {
    if (module.program.traits.length > 0) {
      const declaration = view module.program.traits[0];
      throw loweringBoundary(
        module.path,
        "Z1000",
        `trait declaration "${declaration.name}" is not executable in the native compiler yet`,
        declaration.line,
        declaration.column,
        5
      );
    }
    if (module.program.typeAliases.length > 0) {
      const declaration = view module.program.typeAliases[0];
      throw loweringBoundary(
        module.path,
        "Z1000",
        `type alias "${declaration.name}" is not executable in the native compiler yet`,
        declaration.line,
        declaration.column,
        4
      );
    }
    for (const aggregate of module.program.aggregates) {
      try validateNativeAggregate(module.path, aggregate);
    }
    for (const declaration of module.program.enums) {
      for (const variant of declaration.variants) {
        match (in variant.payload) {
          some(payload) => try validateNativeType(module.path, payload);
          none => {}
        }
      }
    }
    for (const declaration of module.program.functions) {
      try validateNativeFunction(module.path, declaration, "");
    }
  }
}
