import { requireNumericLiteralRange } from "./semantic-expression-types.zs";
import { numberLiteralType } from "./semantic-intrinsics.zs";
import {
  AggregateDeclaration,
  ConstructorDeclaration,
  DeclarationKind,
  EnumDeclaration,
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  FunctionDeclaration,
  ParameterMode,
  ReceiverMode,
  StatementArena,
  TraitDeclaration,
  TypeParameter,
  TypeReference,
} from "./parser.zs";
import {
  ParsedModule,
  embedBytesInitializer,
  moduleSymbolIndex,
} from "./module-symbols.zs";
import {
  rebaseTypeName,
  sourceTypeDisplayName,
  transparentTypeName,
  typeSatisfiesTrait,
  typeSymbolLocation,
} from "./semantic-type-identities.zs";
import {
  NativeFixedArrayShape,
  NativeGenericTypeShape,
  fixedArrayShape,
  genericTypeShape,
  isIntrinsicTypeName,
  isTypeSymbolKind,
  nativeFunctionSignature,
  nativeObjCObjectTypeName,
  nullableTargetType,
  qualifiedTypeBase,
  qualifiedTypeMember,
  stringStartsWith,
} from "./semantic-type-shapes.zs";
import {
  ModuleResolveError,
  ModuleResolveErrorKind,
  ModuleSymbolKind,
  ModuleTypeSignature,
  ResolvedModule,
  moduleResolutionError,
} from "./semantic-model.zs";
import {
  typeContainsStoredView,
  typeContainsSlice,
  typeIsArenaOwnerBundle,
  typeIsNativeObjCReference,
  typeIsRetainedParameterViewAggregate,
  typeIsThreadTransferable,
  typeIsThreadShareable,
  typeNameIsArena,
} from "./semantic-type-ownership.zs";

struct NativeTypeArity {
  minimum: usize;
  maximum: usize;
}

function moduleImportsThreadCapability(in module: ParsedModule): boolean {
  for (const declaration of module.program.imports) {
    if (declaration.header != "std/thread" || !declaration.selective) continue;
    for (const binding of declaration.bindings) {
      if (
        binding.importedName == "thread"
        && binding.localName == "thread"
      ) return true;
    }
  }
  return false;
}

struct NativeTypeParameterBinding {
  name: String;
  constraints: Array<String>;
}

function validationError(
  kind: ModuleResolveErrorKind,
  in path: String,
  in message: String,
  line: usize,
  column: usize
): ModuleResolveError {
  return moduleResolutionError(kind, path, message, line, column);
}

function moduleHasVisibleType(
  in owner: ResolvedModule,
  in requester: ResolvedModule,
  in name: String
): boolean {
  const index = moduleSymbolIndex(owner, name);
  return index < owner.symbols.length
    && (
      owner.symbols[index].exported
      || (
        owner.symbols[index].packageVisible
        && owner.packageIdentity.byteLength > 0
        && owner.packageIdentity == requester.packageIdentity
      )
    )
    && isTypeSymbolKind(owner.symbols[index].kind);
}

function hasTypeName(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<NativeTypeParameterBinding>,
  in name: String
): boolean {
  const base = qualifiedTypeBase(name);
  const member = qualifiedTypeMember(name);
  if (member.byteLength == 0 && isIntrinsicTypeName(base)) return true;
  if (member.byteLength == 0) {
    for (const binding of typeBindings) {
      if (binding.name == base) return true;
    }
  }
  for (const symbol of modules[moduleIndex].symbols) {
    if (symbol.name != base) continue;
    if (member.byteLength > 0) {
      if (symbol.kind != ModuleSymbolKind.namespaceSymbol) {
        if (symbol.kind == ModuleSymbolKind.importedSymbol) {
          return match (in symbol.targetModule) {
            some(target) => false;
            none => true;
          };
        }
        return false;
      }
      return match (in symbol.targetModule) {
        some(target) => moduleHasVisibleType(
          modules[target],
          modules[moduleIndex],
          member
        );
        none => true;
      };
    }
    if (isTypeSymbolKind(symbol.kind)) return true;
    if (symbol.kind != ModuleSymbolKind.importedSymbol) return false;
    return match (in symbol.targetModule) {
      some(target) => moduleHasVisibleType(
        modules[target],
        modules[moduleIndex],
        symbol.importedName
      );
      none => true;
    };
  }
  return false;
}

function copyTypeParameterBindings(
  in bindings: Array<NativeTypeParameterBinding>
): Array<NativeTypeParameterBinding> {
  let copied = Array<NativeTypeParameterBinding>();
  for (const binding of bindings) {
    let constraints = Array<String>();
    for (const constraint of binding.constraints) {
      constraints.push(constraint.copyBytes(0, constraint.byteLength));
    }
    copied.push(NativeTypeParameterBinding({
      name: binding.name.copyBytes(0, binding.name.byteLength),
      constraints,
    }));
  }
  return copied;
}

function intrinsicTypeArity(in name: String): Option<NativeTypeArity> {
  if (
    name == "Array"
    || name == "Slice"
    || name == "Option"
    || name == "Set"
    || name == "Weak"
    || name == "Once"
    || name == "OnceLifetime"
    || name == "Mutex"
    || name == "Channel"
    || name == "Sender"
    || name == "Receiver"
    || name == "SyncSender"
    || name == "SyncReceiver"
    || name == "ChannelClosed"
    || name == "Channel.Endpoints"
  ) return Option.some(NativeTypeArity({ minimum: 1, maximum: 1 }));
  if (name == "Map") {
    return Option.some(NativeTypeArity({ minimum: 2, maximum: 2 }));
  }
  if (name == "Result") {
    return Option.some(NativeTypeArity({ minimum: 2, maximum: 2 }));
  }
  if (name == "Task") {
    return Option.some(NativeTypeArity({ minimum: 1, maximum: 2 }));
  }
  if (isIntrinsicTypeName(name)) {
    return Option.some(NativeTypeArity({ minimum: 0, maximum: 0 }));
  }
  return Option<NativeTypeArity>.none;
}

function invalidTypeArityMessage(
  in name: String,
  in arity: NativeTypeArity,
  received: usize
): String {
  if (arity.minimum == arity.maximum) {
    return `${name} expects ${arity.minimum} type argument(s), received ${received}`;
  }
  return `${name} expects ${arity.minimum} or ${arity.maximum} type argument(s), received ${received}`;
}

function requireTypeArity(
  in module: ParsedModule,
  in name: String,
  in arity: NativeTypeArity,
  received: usize,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  if (received >= arity.minimum && received <= arity.maximum) return;
  const message = invalidTypeArityMessage(name, arity, received);
  throw validationError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    message,
    line,
    column
  );
}

function mutexPayloadTypeSupported(in name: String): boolean {
  if (
    name == "void"
    || stringStartsWith(name, "view ")
    || stringStartsWith(name, "Slice<")
  ) return false;
  match (genericTypeShape(name)) {
    some(generic) => {
      if (
        generic.base == "Once"
        || generic.base == "OnceLifetime"
        || generic.base == "Mutex"
        || generic.base == "Channel"
        || generic.base == "Sender"
        || generic.base == "Receiver"
        || generic.base == "SyncSender"
        || generic.base == "SyncReceiver"
        || generic.base == "Channel.Endpoints"
        || generic.base == "Task"
      ) return false;
      for (const argument of generic.arguments) {
        if (!mutexPayloadTypeSupported(argument)) return false;
      }
    }
    none => {}
  }
  return true;
}

function typeParameterSatisfiesTrait(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in bindings: Array<NativeTypeParameterBinding>,
  in parameter: String,
  in requiredTrait: String
): boolean {
  const requiredLocation = match (typeSymbolLocation(
    modules,
    moduleIndex,
    requiredTrait
  )) {
    some(location) => location;
    none => return false;
  };
  let bindingIndex = bindings.length;
  while (bindingIndex > 0) {
    bindingIndex = bindingIndex - 1;
    if (bindings[bindingIndex].name != parameter) continue;
    for (const constraint of bindings[bindingIndex].constraints) {
      if (constraint == requiredTrait) return true;
      match (typeSymbolLocation(modules, moduleIndex, constraint)) {
        some(location) => {
          if (
            location.moduleIndex == requiredLocation.moduleIndex
            && location.symbolIndex == requiredLocation.symbolIndex
          ) return true;
        }
        none => {}
      }
    }
    return false;
  }
  return false;
}

function validateGenericTypeConstraints(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<NativeTypeParameterBinding>,
  in generic: NativeGenericTypeShape,
  in signature: ModuleTypeSignature,
  signatureModuleIndex: usize,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  for (const constraint of signature.typeParameterConstraints) {
    let argument = "";
    let parameterIndex: usize = 0;
    while (parameterIndex < signature.typeParameters.length) {
      if (signature.typeParameters[parameterIndex] == constraint.parameter) {
        argument = generic.arguments[parameterIndex].copyBytes(
          0,
          generic.arguments[parameterIndex].byteLength
        );
        break;
      }
      parameterIndex = parameterIndex + 1;
    }
    if (argument.byteLength == 0) continue;
    const requiredTrait = rebaseTypeName(
      modules,
      signatureModuleIndex,
      moduleIndex,
      constraint.traitName
    );
    if (
      typeSatisfiesTrait(modules, moduleIndex, argument, requiredTrait)
      || typeParameterSatisfiesTrait(
        modules,
        moduleIndex,
        typeBindings,
        argument,
        requiredTrait
      )
    ) continue;
    const displayedArgument = sourceTypeDisplayName(
      modules,
      moduleIndex,
      argument
    );
    const displayedTrait = sourceTypeDisplayName(
      modules,
      moduleIndex,
      requiredTrait
    );
    throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      `${displayedArgument} does not satisfy ${displayedTrait} for ${constraint.parameter} in "${generic.base}"`,
      line,
      column
    );
  }
}

// Mirrors Stage 0: `T | null` is an imported Objective-C reference or a
// nullable native handle; optional Z values use Option<T>. A foreign name
// with no attached contract stays unchecked here, as in hasTypeName.
function nullableTargetSupported(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in target: String
): boolean {
  if (typeIsNativeObjCReference(modules, moduleIndex, target)) return true;
  const actual = transparentTypeName(modules, moduleIndex, target);
  if (isIntrinsicTypeName(actual)) return false;
  match (genericTypeShape(actual)) {
    some(generic) => {
      if (isIntrinsicTypeName(generic.base)) return false;
    }
    none => {}
  }
  return match (typeSymbolLocation(modules, moduleIndex, actual)) {
    some(location) => match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
      some(signature) => signature.foreignKind == "handle";
      none => false;
    }
    none => true;
  };
}

function validateTypeNameShape(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<NativeTypeParameterBinding>,
  in name: String,
  line: usize,
  column: usize,
  allowInferredGeneric: boolean
): void throws ModuleResolveError {
  // `(A) => B | null` is a function type whose return is nullable.
  const functionType = match (nativeFunctionSignature(name)) {
    some(_) => true;
    none => false;
  };
  const nullableTarget = nullableTargetType(name);
  if (nullableTarget.byteLength > 0 && !functionType) {
    if (!nullableTargetSupported(modules, moduleIndex, nullableTarget)) {
      const resolvedTarget = transparentTypeName(modules, moduleIndex, nullableTarget);
      const displayed = sourceTypeDisplayName(modules, moduleIndex, resolvedTarget);
      throw validationError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `"${displayed} | null" currently requires an imported Objective-C reference type`,
        line,
        column
      );
    }
    try validateTypeNameShape(
      module,
      modules,
      moduleIndex,
      typeBindings,
      nullableTarget,
      line,
      column,
      false
    );
    return;
  }
  if (stringStartsWith(name, "view ")) {
    const target = name.copyBytes(5, name.byteLength);
    try validateTypeNameShape(
      module,
      modules,
      moduleIndex,
      typeBindings,
      target,
      line,
      column,
      false
    );
    return;
  }
  match (fixedArrayShape(name)) {
    some(array) => {
      const { elementType } = copy array;
      try validateTypeNameShape(
        module,
        modules,
        moduleIndex,
        typeBindings,
        elementType,
        line,
        column,
        false
      );
      return;
    }
    none => {}
  }
  match (nativeFunctionSignature(name)) {
    some(signature) => {
      if (
        signature.threadContract.byteLength > 0
        && !moduleImportsThreadCapability(module)
      ) throw validationError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        "`on thread.any` and `on thread.main` function types require `import { thread } from \"std/thread\"`",
        line,
        column
      );
      for (const parameterType of signature.parameterTypes) {
        try validateTypeNameShape(
          module,
          modules,
          moduleIndex,
          typeBindings,
          parameterType,
          line,
          column,
          false
        );
      }
      try validateTypeNameShape(
        module,
        modules,
        moduleIndex,
        typeBindings,
        signature.returnType,
        line,
        column,
        false
      );
      if (signature.errorType.byteLength > 0) try validateTypeNameShape(
        module,
        modules,
        moduleIndex,
        typeBindings,
        signature.errorType,
        line,
        column,
        false
      );
      return;
    }
    none => {}
  }
  match (genericTypeShape(name)) {
    some(generic) => {
      const genericBase = generic.base.copyBytes(0, generic.base.byteLength);
      const genericArgumentCount = generic.arguments.length;
      if (transparentTypeName(modules, moduleIndex, genericBase) == nativeObjCObjectTypeName) {
        try requireTypeArity(module, genericBase, NativeTypeArity({ minimum: 0, maximum: 0 }), genericArgumentCount, line, column);
      }
      for (const argument of generic.arguments) {
        try validateTypeNameShape(
          module,
          modules,
          moduleIndex,
          typeBindings,
          argument,
          line,
          column,
          false
        );
      }
      match (intrinsicTypeArity(genericBase)) {
        some(arity) => try requireTypeArity(
          module,
          genericBase,
          arity,
          genericArgumentCount,
          line,
          column
        );
        none => {}
      }
      if (
        genericBase == "Once"
        || genericBase == "OnceLifetime"
      ) {
        try requireSafeOncePayload(
          module,
          modules,
          moduleIndex,
          name,
          line,
          column
        );
      }
      if (
        genericBase == "Mutex"
        && genericArgumentCount == 1
        && !mutexPayloadTypeSupported(generic.arguments[0])
      ) {
        throw validationError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `Mutex cannot own ${generic.arguments[0]} in the first synchronization tier`,
          line,
          column
        );
      }
      match (typeSymbolLocation(modules, moduleIndex, genericBase)) {
        some(location) => {
          match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
            some(signature) => {
              try requireTypeArity(
                module,
                genericBase,
                NativeTypeArity({
                  minimum: signature.typeParameters.length,
                  maximum: signature.typeParameters.length,
                }),
                genericArgumentCount,
                line,
                column
              );
              try validateGenericTypeConstraints(
                module,
                modules,
                moduleIndex,
                typeBindings,
                generic,
                signature,
                location.moduleIndex,
                line,
                column
              );
            }
            none => {}
          }
        }
        none => {}
      }
      return;
    }
    none => {}
  }
  if (allowInferredGeneric) return;
  match (typeSymbolLocation(modules, moduleIndex, name)) {
    some(location) => {
      match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
        some(signature) => {
          try requireTypeArity(module, name, NativeTypeArity({ minimum: signature.typeParameters.length, maximum: signature.typeParameters.length }), 0, line, column);
          return;
        }
        none => {}
      }
    }
    none => {}
  }
  // A resolved source declaration (for example a user's Receiver class) owns
  // its arity. Only unresolved intrinsic names use the standard fallback.
  match (intrinsicTypeArity(name)) {
    some(arity) => try requireTypeArity(module, name, arity, 0, line, column);
    none => {}
  }
}

function validateTypeReferenceMode(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<NativeTypeParameterBinding>,
  in type: TypeReference,
  allowInferredGeneric: boolean
): void throws ModuleResolveError {
  for (const reference of type.references) {
    if (hasTypeName(modules, moduleIndex, typeBindings, reference.name)) continue;
    throw validationError(
      ModuleResolveErrorKind.unknownType,
      module.path,
      `unknown type ${reference.name}`,
      reference.line,
      reference.column
    );
  }
  const typeName = type.name.copyBytes(0, type.name.byteLength);
  const typeLine = type.line;
  const typeColumn = type.column;
  try validateTypeNameShape(
    module,
    modules,
    moduleIndex,
    typeBindings,
    typeName,
    typeLine,
    typeColumn,
    allowInferredGeneric
  );
}

function validateTypeReference(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<NativeTypeParameterBinding>,
  in type: TypeReference
): void throws ModuleResolveError {
  try validateTypeReferenceMode(
    module,
    modules,
    moduleIndex,
    typeBindings,
    type,
    false
  );
}

function typeParameterBindings(
  in inherited: Array<NativeTypeParameterBinding>,
  in parameters: Array<TypeParameter>
): Array<NativeTypeParameterBinding> {
  let bindings = copyTypeParameterBindings(inherited);
  for (const parameter of parameters) {
    let constraints = Array<String>();
    for (const constraint of parameter.constraints) {
      constraints.push(constraint.name.copyBytes(0, constraint.name.byteLength));
    }
    bindings.push(NativeTypeParameterBinding({
      name: parameter.name.copyBytes(0, parameter.name.byteLength),
      constraints,
    }));
  }
  return bindings;
}

function validateTypeParameters(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in inherited: Array<NativeTypeParameterBinding>,
  in parameters: Array<TypeParameter>
): Array<NativeTypeParameterBinding> throws ModuleResolveError {
  const bindings = typeParameterBindings(inherited, parameters);
  for (const parameter of parameters) {
    for (const constraint of parameter.constraints) {
      try validateTypeReference(module, modules, moduleIndex, bindings, constraint);
    }
  }
  return bindings;
}

function validateExpressionTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<NativeTypeParameterBinding>,
  in expression: ExpressionSyntax
): void throws ModuleResolveError {
  match (in expression.tree) {
    some(tree) => {
      let nodeIndex: usize = 0;
      while (nodeIndex < tree.nodes.length) {
        const allowInferredGeneric = tree.nodes[nodeIndex].kind == ExpressionKind.newExpression;
        for (const type of tree.nodes[nodeIndex].typeReferences) {
          try validateTypeReferenceMode(
            module,
            modules,
            moduleIndex,
            typeBindings,
            type,
            allowInferredGeneric
          );
        }
        nodeIndex = nodeIndex + 1;
      }
    }
    none => {}
  }
}

function validateArenaTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<NativeTypeParameterBinding>,
  in arena: StatementArena
): void throws ModuleResolveError {
  let index: usize = 0;
  while (index < arena.nodes.length) {
    match (in arena.nodes[index].typeAnnotation) {
      some(type) => try validateTypeReference(module, modules, moduleIndex, typeBindings, type);
      none => {}
    }
    match (in arena.nodes[index].expression) {
      some(expression) => try validateExpressionTypes(
        module,
        modules,
        moduleIndex,
        typeBindings,
        expression
      );
      none => {}
    }
    match (in arena.nodes[index].secondExpression) {
      some(expression) => try validateExpressionTypes(
        module,
        modules,
        moduleIndex,
        typeBindings,
        expression
      );
      none => {}
    }
    index = index + 1;
  }
}

function validateFunctionTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in inherited: Array<NativeTypeParameterBinding>,
  in declaration: FunctionDeclaration,
  method: boolean,
  valueStructMethod: boolean
): void throws ModuleResolveError {
  if (declaration.threadContract.byteLength > 0) {
    if (declaration.threadContract != "thread.any") throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "callable thread contracts currently support only `on thread.any`",
      declaration.line,
      declaration.column
    );
    if (!moduleImportsThreadCapability(module)) throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "`on thread.any` requires `import { thread } from \"std/thread\"`",
      declaration.line,
      declaration.column
    );
    if (method) throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "`on thread.any` methods are deferred in the first callable-contract tier",
      declaration.line,
      declaration.column
    );
    let suspending = declaration.asynchronous;
    match (genericTypeShape(declaration.returnType.name)) {
      some(generic) => {
        if (
          generic.base == "Generator"
          || generic.base == "AsyncGenerator"
        ) suspending = true;
      }
      none => {}
    }
    if (suspending) throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "`on thread.any` currently requires a synchronous function",
      declaration.line,
      declaration.column
    );
  }
  const bindings = try validateTypeParameters(
    module,
    modules,
    moduleIndex,
    inherited,
    declaration.typeParameters
  );
  for (const parameter of declaration.parameters) {
    try validateTypeReference(module, modules, moduleIndex, bindings, parameter.type);
    let parameterViewVisiting = Array<String>();
    if (typeContainsStoredView(
      modules,
      moduleIndex,
      parameter.type.name,
      parameterViewVisiting
    )) {
      const arenaBundle = typeIsArenaOwnerBundle(
        modules,
        moduleIndex,
        parameter.type.name
      );
      const directView = stringStartsWith(parameter.type.name, "view ");
      if (
        directView
        || declaration.asynchronous
        || (!arenaBundle && parameter.mode != ParameterMode.input)
        || (
          arenaBundle
          && parameter.mode != ParameterMode.input
          && parameter.mode != ParameterMode.value
        )
      ) {
        const message = directView
          ? "view is a receiver-tied return capability, not a parameter type"
          : arenaBundle && declaration.asynchronous
            ? "an Arena-owned graph bundle cannot cross async suspension in the first region tier"
            : arenaBundle
              ? "an Arena-owned graph bundle accepts only synchronous owned or immutable in parameters"
              : "a view-bearing value can only enter a synchronous immutable in parameter";
        throw validationError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          message,
          parameter.type.line,
          parameter.type.column
        );
      }
    }
  }
  try validateTypeReference(module, modules, moduleIndex, bindings, declaration.returnType);
  if (typeContainsSlice(modules, moduleIndex, declaration.returnType.name)) {
    throw validationError(ModuleResolveErrorKind.typeMismatch, module.path,
      "returning Slice values requires an explicit lifetime contract and is not implemented yet",
      declaration.returnType.line, declaration.returnType.column);
  }
  let returnViewVisiting = Array<String>();
  if (typeContainsStoredView(
    modules,
    moduleIndex,
    declaration.returnType.name,
    returnViewVisiting
  )) {
    const retainedParameterViewAggregate =
      typeIsRetainedParameterViewAggregate(
        modules,
        moduleIndex,
        declaration.returnType.name
      );
    let directReceiverView = stringStartsWith(
      declaration.returnType.name,
      "view "
    );
    match (genericTypeShape(declaration.returnType.name)) {
      some(generic) => {
        if (
          generic.base == "Option"
          && generic.arguments.length == 1
          && stringStartsWith(generic.arguments[0], "view ")
        ) directReceiverView = true;
      }
      none => {}
    }
    if (
      !directReceiverView
      && !typeIsArenaOwnerBundle(
        modules,
        moduleIndex,
        declaration.returnType.name
      )
      && !retainedParameterViewAggregate
    ) throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "view values cannot be nested inside returned storage",
      declaration.returnType.line,
      declaration.returnType.column
    );
    if (retainedParameterViewAggregate) {
      let throwing = false;
      match (in declaration.errorType) {
        some(_) => throwing = true;
        none => {}
      }
      if (
        declaration.asynchronous
        || throwing
        || (
          method
          && (
            !valueStructMethod
            || declaration.staticMethod
            || declaration.receiverMode == ReceiverMode.inputOutput
            || declaration.receiverMode == ReceiverMode.move
          )
        )
      ) {
        let message = "a retained parameter-provenanced view aggregate must be returned by a synchronous non-throwing function";
        if (method) {
          message = "a retained view-bearing aggregate return requires a synchronous, non-throwing borrowed value-struct method";
        }
        throw validationError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          message,
          declaration.returnType.line,
          declaration.returnType.column
        );
      }
    }
    if (
      declaration.asynchronous
      && typeIsArenaOwnerBundle(
        modules,
        moduleIndex,
        declaration.returnType.name
      )
    ) throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "an Arena-owned graph bundle cannot cross async suspension in the first region tier",
      declaration.returnType.line,
      declaration.returnType.column
    );
  }
  match (in declaration.errorType) {
    some(error) => try validateTypeReference(module, modules, moduleIndex, bindings, error);
    none => {}
  }
  try validateArenaTypes(module, modules, moduleIndex, bindings, declaration.body);
}

function validateConstructorTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeBindings: Array<NativeTypeParameterBinding>,
  in declaration: ConstructorDeclaration
): void throws ModuleResolveError {
  for (const parameter of declaration.parameters) {
    try validateTypeReference(module, modules, moduleIndex, typeBindings, parameter.type);
    let parameterViewVisiting = Array<String>();
    if (typeContainsStoredView(
      modules,
      moduleIndex,
      parameter.type.name,
      parameterViewVisiting
    )) {
      const directView = stringStartsWith(parameter.type.name, "view ");
      if (directView || parameter.mode != ParameterMode.input) {
        const message = directView
          ? "view is a receiver-tied return capability, not a parameter type"
          : "a view-bearing value can only enter a synchronous immutable in parameter";
        throw validationError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          message,
          parameter.type.line,
          parameter.type.column
        );
      }
    }
  }
  match (in declaration.errorType) {
    some(error) => try validateTypeReference(module, modules, moduleIndex, typeBindings, error);
    none => {}
  }
  try validateArenaTypes(module, modules, moduleIndex, typeBindings, declaration.body);
}

function validateTraitExecutorConformance(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in declaration: AggregateDeclaration,
  in implemented: TypeReference
): void throws ModuleResolveError {
  const location = match (typeSymbolLocation(
    modules,
    moduleIndex,
    implemented.name
  )) {
    some(value) => value;
    none => return;
  };
  const kind = modules[location.moduleIndex].symbols[location.symbolIndex].kind;
  if (kind != ModuleSymbolKind.traitSymbol) return;
  const traitName = modules[location.moduleIndex].symbols[
    location.symbolIndex
  ].name.copyBytes(
    0,
    modules[location.moduleIndex].symbols[
      location.symbolIndex
    ].name.byteLength
  );
  match (in modules[location.moduleIndex].symbols[
    location.symbolIndex
  ].typeSignature) {
    some(signature) => {
      for (const requirement of signature.methods) {
        if (requirement.staticMethod) continue;
        for (const method of declaration.methods) {
          if (method.staticMethod || method.name != requirement.name) continue;
          if (
            method.executorAffinity.byteLength > 0
            && requirement.signature.executorAffinity.byteLength == 0
          ) throw validationError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `method ${declaration.name}.${method.name} does not match trait requirement ${traitName}.${requirement.name}`,
            method.line,
            method.column
          );
        }
      }
    }
    none => {}
  }
}

function validateAggregateTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in declaration: AggregateDeclaration
): void throws ModuleResolveError {
  let empty = Array<NativeTypeParameterBinding>();
  const bindings = try validateTypeParameters(
    module,
    modules,
    moduleIndex,
    empty,
    declaration.typeParameters
  );
  for (const implemented of declaration.implementedTraits) {
    try validateTypeReference(module, modules, moduleIndex, bindings, implemented);
    try validateTraitExecutorConformance(
      module,
      modules,
      moduleIndex,
      declaration,
      implemented
    );
  }
  let directArenaFields: usize = 0;
  let carriesStoredViews = false;
  let allFieldsReadonly = true;
  for (const candidate of declaration.fields) {
    if (typeNameIsArena(
      modules,
      moduleIndex,
      candidate.type.name
    )) directArenaFields = directArenaFields + 1;
    else {
      let candidateVisiting = Array<String>();
      if (typeContainsStoredView(
        modules,
        moduleIndex,
        candidate.type.name,
        candidateVisiting
      )) carriesStoredViews = true;
    }
    if (!candidate.readonlyField) allFieldsReadonly = false;
  }
  if (
    declaration.kind == DeclarationKind.structDeclaration
    && directArenaFields > 0
    && carriesStoredViews
  ) {
    if (directArenaFields != 1) throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      `Arena-owned graph bundle "${declaration.name}" must declare exactly one direct Arena field`,
      declaration.line,
      declaration.column
    );
    if (!allFieldsReadonly) throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      `Arena-owned graph bundle "${declaration.name}" must be a readonly struct`,
      declaration.line,
      declaration.column
    );
  }
  for (const field of declaration.fields) {
    try validateTypeReference(module, modules, moduleIndex, bindings, field.type);
    if (typeContainsSlice(modules, moduleIndex, field.type.name)) {
      throw validationError(ModuleResolveErrorKind.typeMismatch, module.path,
        "Slice values cannot be stored in struct or class fields",
        field.type.line, field.type.column);
    }
    let fieldViewVisiting = Array<String>();
    if (typeContainsStoredView(
      modules,
      moduleIndex,
      field.type.name,
      fieldViewVisiting
    )) {
      if (declaration.kind == DeclarationKind.classDeclaration) {
        throw validationError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "ARC class fields cannot store owner-tied views",
          field.type.line,
          field.type.column
        );
      }
      if (!stringStartsWith(field.type.name, "view ")) {
        let nestedValueAggregate = false;
        let optionalAggregate = false;
        match (genericTypeShape(declaration.name)) {
          some(owner) => {
            if (owner.base == "Map" && owner.arguments.length == 2) {
              nestedValueAggregate = true;
            }
          }
          none => {}
        }
        match (genericTypeShape(field.type.name)) {
          some(container) => {
            if (
              declaration.kind == DeclarationKind.structDeclaration
              && directArenaFields == 1
              && (
                container.base == "Array"
                || container.base == "Map"
                || container.base == "Set"
              )
            ) nestedValueAggregate = true;
          }
          none => {}
        }
        match (genericTypeShape(field.type.name)) {
          some(shape) => {
            optionalAggregate = shape.base == "Option";
            if (
              optionalAggregate
              && shape.arguments.length == 1
              && stringStartsWith(shape.arguments[0], "view ")
            ) nestedValueAggregate = true;
          }
          none => {}
        }
        match (genericTypeShape(declaration.name)) {
          some(container) => {
            if (container.base == "Set") nestedValueAggregate = true;
          }
          none => {}
        }
        match (typeSymbolLocation(modules, moduleIndex, field.type.name)) {
          some(location) => {
            const nestedKind = modules[location.moduleIndex].symbols[
              location.symbolIndex
            ].kind;
            nestedValueAggregate = nestedValueAggregate
              || nestedKind == ModuleSymbolKind.structSymbol
              || (
                nestedKind == ModuleSymbolKind.enumSymbol
                && !optionalAggregate
              );
          }
          none => {}
        }
        if (!nestedValueAggregate) throw validationError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "this view-bearing field shape cannot be stored in fields in the first provenance tier",
          field.type.line,
          field.type.column
        );
      }
      match (in field.defaultValue) {
        some(_) => throw validationError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          "a view-bearing field cannot have a default value",
          field.line,
          field.column
        );
        none => {}
      }
    }
  }
  match (in declaration.constructorDeclaration) {
    some(initializer) => try validateConstructorTypes(
      module,
      modules,
      moduleIndex,
      bindings,
      initializer
    );
    none => {}
  }
  for (const method of declaration.methods) {
    try validateFunctionTypes(
      module,
      modules,
      moduleIndex,
      bindings,
      method,
      true,
      declaration.kind == DeclarationKind.structDeclaration
    );
  }
  match (in declaration.deinitializer) {
    some(deinitializer) => {
      if (deinitializer.threadContract.byteLength > 0) {
        if (
          deinitializer.threadContract != "thread.any"
          || !moduleImportsThreadCapability(module)
        ) throw validationError(
          ModuleResolveErrorKind.typeMismatch, module.path,
          "deinit on thread.any requires the imported thread capability from std/thread",
          deinitializer.line, deinitializer.column
        );
        let nativeBase = false;
        match (in declaration.nativeBase) { some(_) => nativeBase = true; none => {} }
        if (nativeBase || typeHasMainExecutorLifecycle(modules, moduleIndex, declaration.name)) {
          throw validationError(
            ModuleResolveErrorKind.typeMismatch, module.path,
            "deinit on thread.any cannot override executor-bound or native superclass destruction",
            deinitializer.line, deinitializer.column
          );
        }
        // Dependent fields are checked when the aggregate is specialized.
        if (declaration.typeParameters.length == 0) {
          for (const field of declaration.fields) {
            if (!typeIsThreadTransferable(modules, moduleIndex, field.type.name)) {
              throw validationError(
                ModuleResolveErrorKind.typeMismatch, module.path,
                `field "${field.name}" of "${declaration.name}" cannot be destroyed on an arbitrary thread`,
                field.line, field.column
              );
            }
          }
        }
      }
      try validateArenaTypes(module, modules, moduleIndex, bindings, deinitializer.body);
    }
    none => {}
  }
}

function validateTraitTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in declaration: TraitDeclaration
): void throws ModuleResolveError {
  let empty = Array<NativeTypeParameterBinding>();
  const bindings = try validateTypeParameters(
    module,
    modules,
    moduleIndex,
    empty,
    declaration.typeParameters
  );
  for (const method of declaration.methods) {
    try validateFunctionTypes(module, modules, moduleIndex, bindings, method, true, false);
    let returnViewVisiting = Array<String>();
    if (typeContainsStoredView(
      modules,
      moduleIndex,
      method.returnType.name,
      returnViewVisiting
    )) throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "trait requirements cannot expose receiver-tied views in the first view tier",
      method.returnType.line,
      method.returnType.column
    );
  }
}

function validateEnumTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in declaration: EnumDeclaration
): void throws ModuleResolveError {
  let empty = Array<NativeTypeParameterBinding>();
  for (const variant of declaration.variants) {
    match (in variant.payload) {
      some(payload) => {
        try validateTypeReference(module, modules, moduleIndex, empty, payload);
        if (typeContainsSlice(modules, moduleIndex, payload.name)) {
          throw validationError(ModuleResolveErrorKind.typeMismatch, module.path,
            "Slice values cannot be stored in enum payloads", payload.line, payload.column);
        }
        let payloadViewVisiting = Array<String>();
        if (typeContainsStoredView(
          modules,
          moduleIndex,
          payload.name,
          payloadViewVisiting
        )) {
          let valueStructPayload = false;
          match (typeSymbolLocation(modules, moduleIndex, payload.name)) {
            some(location) => {
              valueStructPayload = modules[location.moduleIndex].symbols[
                location.symbolIndex
              ].kind == ModuleSymbolKind.structSymbol;
            }
            none => {}
          }
          if (!valueStructPayload) throw validationError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            "a view-bearing enum payload must be a named value struct in the first stored-provenance tier",
            payload.line,
            payload.column
          );
        }
      }
      none => {}
    }
  }
}

function moduleConstantNumericType(in name: String): boolean {
  return name == "i8"
    || name == "i16"
    || name == "i32"
    || name == "i64"
    || name == "u8"
    || name == "u16"
    || name == "u32"
    || name == "u64"
    || name == "isize"
    || name == "usize"
    || name == "f32"
    || name == "f64";
}

function onceInitializerType(
  in tree: ExpressionTree
): String {
  const root = view tree.nodes[tree.root];
  if (
    root.kind != ExpressionKind.callExpression
    || root.children.length != 1
  ) return "";
  const callee = root.children[0];
  if (tree.nodes[callee].kind != ExpressionKind.identifierExpression) {
    return "";
  }
  match (genericTypeShape(tree.nodes[callee].value)) {
    some(generic) => {
      if (
        generic.base == "Once"
        && generic.arguments.length == 1
      ) return tree.nodes[callee].value.copyBytes(
        0,
        tree.nodes[callee].value.byteLength
      );
    }
    none => {}
  }
  return "";
}

function nativeTypeHasMainLifecycle(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  symbolIndex: usize,
  inout visiting: Array<String>
): boolean {
  const symbol = view modules[moduleIndex].symbols[symbolIndex];
  const key = `${moduleIndex}:${symbolIndex}`;
  for (const active of visiting) {
    if (active == key) return false;
  }
  visiting.push(key);
  return match (in symbol.typeSignature) {
    some(signature) => {
      if (signature.executorAffinity == "thread.main") return true;
      for (const field of signature.fields) {
        if (field.executorAffinity == "thread.main") return true;
        match (typeSymbolLocation(
          modules,
          moduleIndex,
          field.typeName
        )) {
          some(location) => {
            // ARC class fields store executor-routed handles rather than
            // inline executor-affine values. The class keeps its own lifecycle
            // and member contracts, but a containing value aggregate may
            // transport the reference without inheriting whole-value affinity.
            if (
              modules[location.moduleIndex].symbols[location.symbolIndex].kind
              == ModuleSymbolKind.classSymbol
            ) continue;
            if (nativeTypeHasMainLifecycle(
              modules,
              location.moduleIndex,
              location.symbolIndex,
              inout visiting
            )) return true;
          }
          none => {}
        }
      }
      return false;
    }
    none => return false;
  };
}

export function typeHasMainExecutorLifecycle(
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in typeName: String
): boolean {
  const location = match (typeSymbolLocation(
    modules,
    moduleIndex,
    typeName
  )) {
    some(location) => location;
    none => return false;
  };
  let visiting = Array<String>();
  return nativeTypeHasMainLifecycle(
    modules,
    location.moduleIndex,
    location.symbolIndex,
    inout visiting
  );
}

function requireSafeOncePayload(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  in onceType: String,
  line: usize,
  column: usize
): void throws ModuleResolveError {
  const generic = match (genericTypeShape(onceType)) {
    some(generic) => generic;
    none => throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      "Once<T> requires one class payload",
      line,
      column
    );
  };
  const payload = transparentTypeName(modules, moduleIndex, generic.arguments[0]);
  const location = match (typeSymbolLocation(
    modules,
    moduleIndex,
    payload
  )) {
    some(location) => location;
    none => throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      `Once<T> requires a thread.main-lifecycle or safely shareable Z class, found ${payload}`,
      line,
      column
    );
  };
  const symbol = view modules[location.moduleIndex].symbols[
    location.symbolIndex
  ];
  if (symbol.kind != ModuleSymbolKind.classSymbol) {
    throw validationError(
      ModuleResolveErrorKind.typeMismatch,
      module.path,
      `Once<T> requires a thread.main-lifecycle or safely shareable Z class, found ${payload}`,
      line,
      column
    );
  }
  let visiting = Array<String>();
  if (nativeTypeHasMainLifecycle(
    modules,
    location.moduleIndex,
    location.symbolIndex,
    inout visiting
  )) return;
  if (typeIsThreadShareable(modules, moduleIndex, payload)) return;
  throw validationError(
    ModuleResolveErrorKind.typeMismatch,
    module.path,
    `Once<T> requires a thread.main-lifecycle or safely shareable Z class, found ${payload}`,
    line,
    column
  );
}

function validateModuleConstantTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize,
  inout typeParameters: Array<NativeTypeParameterBinding>
): void throws ModuleResolveError {
  for (const declaration of module.program.constants) {
    let expected = "";
    match (in declaration.typeAnnotation) {
      some(type) => {
        try validateTypeReference(
          module,
          modules,
          moduleIndex,
          typeParameters,
          type
        );
        expected = type.name.copyBytes(0, type.name.byteLength);
      }
      none => {}
    }
    match (in declaration.initializer.tree) {
      some(tree) => {
        const root = view tree.nodes[tree.root];
        const onceType = onceInitializerType(tree);
        const embeddedBytes = embedBytesInitializer(module, tree);
        const numberLiteral = root.kind == ExpressionKind.numberExpression
          || (
            root.kind == ExpressionKind.unaryExpression
            && root.children.length == 1
            && (root.value == "+" || root.value == "-")
            && tree.nodes[root.children[0]].kind
              == ExpressionKind.numberExpression
          );
        const supported = root.kind == ExpressionKind.stringExpression
          || root.kind == ExpressionKind.booleanExpression
          || numberLiteral
          || onceType.byteLength > 0
          || embeddedBytes;
        if (!supported) throw validationError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `module constant ${declaration.name} requires a cleanup-free literal initializer in the first native tier`,
          declaration.line,
          declaration.column
        );
        if (onceType.byteLength > 0) {
          try validateTypeNameShape(
            module,
            modules,
            moduleIndex,
            typeParameters,
            onceType,
            declaration.line,
            declaration.column,
            false
          );
          try requireSafeOncePayload(
            module,
            modules,
            moduleIndex,
            onceType,
            declaration.line,
            declaration.column
          );
          if (
            expected.byteLength > 0
            && expected != onceType
          ) throw validationError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `module constant ${declaration.name} cannot initialize ${expected} from ${onceType}`,
            declaration.line,
            declaration.column
          );
          continue;
        }
        if (embeddedBytes) {
          if (
            expected.byteLength > 0
            && expected != "embed.StaticBytes"
          ) throw validationError(
            ModuleResolveErrorKind.typeMismatch,
            module.path,
            `module constant ${declaration.name} cannot initialize ${expected} from embed.StaticBytes`,
            declaration.line,
            declaration.column
          );
          continue;
        }
        if (numberLiteral) {
          let target = expected.copyBytes(0, expected.byteLength);
          if (target.byteLength == 0) {
            const operand = root.kind == ExpressionKind.numberExpression ? tree.root : root.children[0];
            target = numberLiteralType(tree.nodes[operand].value);
          }
          const rootIndex = tree.root;
          try requireNumericLiteralRange(module, tree, rootIndex, target);
        }
        if (expected.byteLength == 0) continue;
        const compatible = (
          root.kind == ExpressionKind.stringExpression
          && (expected == "String" || expected == "cstring")
        ) || (
          root.kind == ExpressionKind.booleanExpression
          && expected == "boolean"
        ) || (
          numberLiteral
          && moduleConstantNumericType(expected)
        );
        if (!compatible) throw validationError(
          ModuleResolveErrorKind.typeMismatch,
          module.path,
          `module constant ${declaration.name} cannot initialize ${expected} from this literal`,
          declaration.line,
          declaration.column
        );
      }
      none => throw validationError(
        ModuleResolveErrorKind.typeMismatch,
        module.path,
        `module constant ${declaration.name} has no initializer`,
        declaration.line,
        declaration.column
      );
    }
  }
}

export function validateModuleTypes(
  in module: ParsedModule,
  in modules: Array<ResolvedModule>,
  moduleIndex: usize
): void throws ModuleResolveError {
  let empty = Array<NativeTypeParameterBinding>();
  for (const declaration of module.program.typeAliases) {
    try validateTypeReference(
      module,
      modules,
      moduleIndex,
      empty,
      declaration.target
    );
  }
  try validateModuleConstantTypes(
    module,
    modules,
    moduleIndex,
    inout empty
  );
  for (const declaration of module.program.functions) {
    try validateFunctionTypes(module, modules, moduleIndex, empty, declaration, false, false);
  }
  for (const declaration of module.program.aggregates) {
    try validateAggregateTypes(module, modules, moduleIndex, declaration);
  }
  for (const declaration of module.program.traits) {
    try validateTraitTypes(module, modules, moduleIndex, declaration);
  }
  for (const declaration of module.program.enums) {
    try validateEnumTypes(module, modules, moduleIndex, declaration);
  }
}
