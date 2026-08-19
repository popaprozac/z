import {
  Declaration,
  DeclarationKind,
  ConstructorDeclaration,
  ExpressionKind,
  ExpressionTree,
  FunctionDeclaration,
  ParameterMode,
  Program,
  ReceiverMode,
  StatementKind,
  Visibility,
} from "./parser.zs";
import {
  ModuleFieldSignature,
  ModuleFunctionSignature,
  ModuleMethodSignature,
  ModuleSymbolKind,
  ModuleTypeParameterConstraint,
  ModuleTypeSignature,
  ModuleVariantSignature,
} from "./semantic-model.zs";

function parameterModeName(mode: ParameterMode): String {
  return match (mode) {
    value => "value";
    input => "in";
    inputOutput => "inout";
    output => "out";
  };
}

export function declarationSymbolKind(kind: DeclarationKind): ModuleSymbolKind {
  if (kind == DeclarationKind.constantDeclaration) return ModuleSymbolKind.constantSymbol;
  if (kind == DeclarationKind.functionDeclaration) return ModuleSymbolKind.functionSymbol;
  if (kind == DeclarationKind.structDeclaration) return ModuleSymbolKind.structSymbol;
  if (kind == DeclarationKind.classDeclaration) return ModuleSymbolKind.classSymbol;
  if (kind == DeclarationKind.traitDeclaration) return ModuleSymbolKind.traitSymbol;
  if (kind == DeclarationKind.typeAliasDeclaration) return ModuleSymbolKind.typeAliasSymbol;
  return ModuleSymbolKind.enumSymbol;
}

export function programFunctionSignature(
  in program: Program,
  in declaration: Declaration
): Option<ModuleFunctionSignature> {
  if (declaration.kind != DeclarationKind.functionDeclaration) {
    return Option<ModuleFunctionSignature>.none;
  }
  for (const functionDeclaration of program.functions) {
    if (functionDeclaration.name != declaration.name) continue;
    return Option.some(functionDeclarationSignature(program, functionDeclaration));
  }
  return Option<ModuleFunctionSignature>.none;
}

function functionDeclarationSignature(
  in program: Program,
  in declaration: FunctionDeclaration
): ModuleFunctionSignature {
  let typeParameters = Array<String>();
  let typeParameterConstraints = Array<ModuleTypeParameterConstraint>();
  for (const parameter of declaration.typeParameters) {
    typeParameters.push(parameter.name.copyBytes(0, parameter.name.byteLength));
    for (const constraint of parameter.constraints) {
      typeParameterConstraints.push(ModuleTypeParameterConstraint({
        parameter: parameter.name.copyBytes(0, parameter.name.byteLength),
        traitName: constraint.name.copyBytes(0, constraint.name.byteLength),
      }));
    }
  }
  let parameterTypes = Array<String>();
  let parameterModes = Array<String>();
  for (const parameter of declaration.parameters) {
    parameterModes.push(parameterModeName(parameter.mode));
    parameterTypes.push(parameter.type.name.copyBytes(0, parameter.type.name.byteLength));
  }
  let errorType = "";
  match (in declaration.errorType) {
    some(error) => errorType = error.name.copyBytes(0, error.name.byteLength);
    none => {}
  }
  return ModuleFunctionSignature({
    asynchronous: declaration.asynchronous,
    executorAffinity: declaration.executorAffinity.copyBytes(0, declaration.executorAffinity.byteLength),
    threadContract: declaration.threadContract.copyBytes(0, declaration.threadContract.byteLength),
    typeParameters,
    typeParameterConstraints,
    parameterModes,
    parameterTypes,
    viewParameter: Option<usize>.none,
    viewParameters: functionDeclarationViewParameters(program, declaration),
    invalidatesParameters: Array<usize>(),
    invalidatesLifetimes: Array<String>(),
    returnType: declaration.returnType.name.copyBytes(
      0,
      declaration.returnType.name.byteLength
    ),
    errorType,
  });
}

function retainedReturnViewFieldNames(
  in program: Program,
  in typeName: String
): Array<String> {
  let fields = Array<String>();
  for (const aggregate of program.aggregates) {
    if (
      aggregate.name != typeName
      || aggregate.kind != DeclarationKind.structDeclaration
      || aggregate.typeParameters.length > 0
    ) continue;
    for (const field of aggregate.fields) {
      if (
        field.type.name.byteLength <= 5
        || field.type.name.copyBytes(0, 5) != "view "
      ) continue;
      fields.push(field.name.copyBytes(0, field.name.byteLength));
    }
    return fields;
  }
  return fields;
}

function returnViewFieldSelected(
  in fields: Array<String>,
  in name: String
): boolean {
  for (const field of fields) {
    if (field == name) return true;
  }
  return false;
}

function returnTypeContainsDirectView(in typeName: String): boolean {
  if (typeName.byteLength > 5 && typeName.copyBytes(0, 5) == "view ") {
    return true;
  }
  return typeName.byteLength > 13
    && typeName.copyBytes(0, 12) == "Option<view "
    && typeName.byteAt(typeName.byteLength - 1) == 62;
}

function returnExpressionStorageRootName(
  in tree: ExpressionTree,
  index: usize
): String {
  const kind = tree.nodes[index].kind;
  if (
    kind == ExpressionKind.identifierExpression
    || kind == ExpressionKind.argumentReferenceExpression
  ) return tree.nodes[index].value.copyBytes(0, tree.nodes[index].value.byteLength);
  if (
    (
      kind == ExpressionKind.memberExpression
      || kind == ExpressionKind.indexExpression
    )
    && tree.nodes[index].children.length > 0
  ) {
    const child = tree.nodes[index].children[0];
    return returnExpressionStorageRootName(tree, child);
  }
  return "";
}

function appendReturnViewRoot(
  in tree: ExpressionTree,
  index: usize,
  inout roots: Array<String>
): void {
  const kind = tree.nodes[index].kind;
  if (
    kind == ExpressionKind.identifierExpression
    || kind == ExpressionKind.memberExpression
    || kind == ExpressionKind.indexExpression
  ) {
    const root = returnExpressionStorageRootName(tree, index);
    if (root.byteLength > 0) roots.push(root);
    return;
  }
  if (kind == ExpressionKind.variantExpression) {
    if (tree.nodes[index].children.length > 1) {
      const payload = tree.nodes[index].children[1];
      appendReturnViewRoot(
        tree,
        payload,
        inout roots
      );
    }
    return;
  }
  if (kind == ExpressionKind.callExpression) {
    if (tree.nodes[index].children.length == 0) return;
    const callee = tree.nodes[index].children[0];
    if (
      tree.nodes[callee].kind == ExpressionKind.memberExpression
      && tree.nodes[callee].children.length == 1
    ) {
      const receiver = tree.nodes[callee].children[0];
      if (
        tree.nodes[receiver].kind == ExpressionKind.identifierExpression
        && tree.nodes[receiver].value == "Option"
        && tree.nodes[callee].value == "some"
      ) {
        if (tree.nodes[index].children.length > 1) {
          const payload = tree.nodes[index].children[1];
          appendReturnViewRoot(
            tree,
            payload,
            inout roots
          );
        }
      } else {
        appendReturnViewRoot(tree, receiver, inout roots);
      }
      return;
    }
    let childIndex: usize = 1;
    while (childIndex < tree.nodes[index].children.length) {
      const argument = tree.nodes[index].children[childIndex];
      appendReturnViewRoot(
        tree,
        argument,
        inout roots
      );
      childIndex = childIndex + 1;
    }
    return;
  }
  if (
    kind == ExpressionKind.tryExpression
    || kind == ExpressionKind.attemptExpression
    || kind == ExpressionKind.awaitExpression
  ) {
    if (tree.nodes[index].children.length == 1) {
      const child = tree.nodes[index].children[0];
      appendReturnViewRoot(
        tree,
        child,
        inout roots
      );
    }
  }
}

function appendAggregateReturnViewRoots(
  in tree: ExpressionTree,
  index: usize,
  in returnType: String,
  in viewFields: Array<String>,
  inout roots: Array<String>
): void {
  if (
    tree.nodes[index].kind != ExpressionKind.callExpression
    || tree.nodes[index].children.length != 2
  ) return;
  const callee = tree.nodes[index].children[0];
  const initializer = tree.nodes[index].children[1];
  if (
    tree.nodes[callee].kind != ExpressionKind.identifierExpression
    || tree.nodes[callee].value != returnType
    || tree.nodes[initializer].kind != ExpressionKind.objectExpression
  ) return;
  let fieldIndex: usize = 0;
  while (
    fieldIndex < tree.nodes[initializer].children.length
    && fieldIndex < tree.nodes[initializer].labels.length
  ) {
    const candidate = tree.nodes[initializer].children[fieldIndex];
    const explicitView = tree.nodes[candidate].kind == ExpressionKind.unaryExpression
      && tree.nodes[candidate].value == "view"
      && tree.nodes[candidate].children.length == 1;
    if (
      returnViewFieldSelected(viewFields, tree.nodes[initializer].labels[fieldIndex])
      || (viewFields.length == 0 && explicitView)
    ) {
      let fieldExpression = tree.nodes[initializer].children[fieldIndex];
      if (
        tree.nodes[fieldExpression].kind == ExpressionKind.unaryExpression
        && tree.nodes[fieldExpression].value == "view"
        && tree.nodes[fieldExpression].children.length == 1
      ) fieldExpression = tree.nodes[fieldExpression].children[0];
      appendReturnViewRoot(tree, fieldExpression, inout roots);
    }
    fieldIndex = fieldIndex + 1;
  }
}

function functionDeclarationViewParameters(
  in program: Program,
  in declaration: FunctionDeclaration
): Array<usize> {
  const directView = returnTypeContainsDirectView(declaration.returnType.name);
  const aggregateViewFields = retainedReturnViewFieldNames(
    program,
    declaration.returnType.name
  );
  let roots = Array<String>();
  for (const statement of declaration.body.nodes) {
    if (statement.kind != StatementKind.returnStatement) continue;
    match (in statement.expression) {
      some(expression) => match (in expression.tree) {
        some(tree) => {
          const root = tree.root;
          if (directView) appendReturnViewRoot(tree, root, inout roots);
          else if (aggregateViewFields.length > 0) {
            const before = roots.length;
            appendAggregateReturnViewRoots(
              tree,
              root,
              declaration.returnType.name,
              aggregateViewFields,
              inout roots
            );
            if (roots.length == before) appendReturnViewRoot(
              tree,
              root,
              inout roots
            );
          }
        }
        none => {}
      }
      none => {}
    }
  }
  let selected = Array<usize>();
  for (const root of roots) {
    let index: usize = 0;
    while (index < declaration.parameters.length) {
      if (
        declaration.parameters[index].mode == ParameterMode.input
        && declaration.parameters[index].name == root
      ) {
        let present = false;
        for (const existing of selected) {
          if (existing == index) present = true;
        }
        if (!present) selected.push(index);
      }
      index = index + 1;
    }
  }
  return selected;
}

function constructorDeclarationSignature(
  in ownerName: String,
  in declaration: ConstructorDeclaration
): ModuleFunctionSignature {
  let parameterTypes = Array<String>();
  let parameterModes = Array<String>();
  for (const parameter of declaration.parameters) {
    parameterModes.push(parameterModeName(parameter.mode));
    parameterTypes.push(parameter.type.name.copyBytes(0, parameter.type.name.byteLength));
  }
  let errorType = "";
  match (in declaration.errorType) {
    some(error) => errorType = error.name.copyBytes(0, error.name.byteLength);
    none => {}
  }
  return ModuleFunctionSignature({
    asynchronous: false,
    executorAffinity: "",
    threadContract: "",
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    parameterModes,
    parameterTypes,
    viewParameter: Option<usize>.none,
    invalidatesParameters: Array<usize>(),
    invalidatesLifetimes: Array<String>(),
    returnType: ownerName.copyBytes(0, ownerName.byteLength),
    errorType,
  });
}

function receiverModeName(mode: ReceiverMode): String {
  if (mode == ReceiverMode.inputOutput) return "inout";
  if (mode == ReceiverMode.move) return "move";
  return "in";
}

function visibilityName(visibility: Visibility): String {
  if (visibility == Visibility.privateVisibility) return "private";
  return "public";
}

export function programTypeSignature(
  in program: Program,
  in declaration: Declaration
): Option<ModuleTypeSignature> {
  if (
    declaration.kind == DeclarationKind.structDeclaration
    || declaration.kind == DeclarationKind.classDeclaration
  ) {
    for (const aggregate of program.aggregates) {
      if (aggregate.name != declaration.name) continue;
      let typeParameters = Array<String>();
      let typeParameterConstraints = Array<ModuleTypeParameterConstraint>();
      for (const parameter of aggregate.typeParameters) {
        typeParameters.push(parameter.name.copyBytes(0, parameter.name.byteLength));
        for (const constraint of parameter.constraints) {
          typeParameterConstraints.push(ModuleTypeParameterConstraint({
            parameter: parameter.name.copyBytes(0, parameter.name.byteLength),
            traitName: constraint.name.copyBytes(0, constraint.name.byteLength),
          }));
        }
      }
      let implementedTraits = Array<String>();
      for (const implemented of aggregate.implementedTraits) {
        implementedTraits.push(implemented.name.copyBytes(0, implemented.name.byteLength));
      }
      let fields = Array<ModuleFieldSignature>();
      for (const field of aggregate.fields) {
        let hasDefault = field.optionalField;
        match (in field.defaultValue) {
          some(_) => hasDefault = true;
          none => {}
        }
        fields.push(ModuleFieldSignature({
          name: field.name.copyBytes(0, field.name.byteLength),
          typeName: field.type.name.copyBytes(0, field.type.name.byteLength),
          executorAffinity: field.executorAffinity.copyBytes(
            0,
            field.executorAffinity.byteLength
          ),
          visibility: visibilityName(field.visibility),
          readonlyField: field.readonlyField,
          hasDefault,
          optionalField: field.optionalField,
          viewLifetime: "",
        }));
      }
      let methods = Array<ModuleMethodSignature>();
      for (const method of aggregate.methods) {
        methods.push(ModuleMethodSignature({
          name: method.name.copyBytes(0, method.name.byteLength),
          staticMethod: method.staticMethod,
          visibility: visibilityName(method.visibility),
          receiverMode: receiverModeName(method.receiverMode),
          signature: functionDeclarationSignature(program, method),
        }));
      }
      let customDeinit = false;
      match (in aggregate.deinitializer) {
        some(deinitializer) => customDeinit = true;
        none => {}
      }
      let customConstructor = false;
      let constructorSignature = Option<ModuleFunctionSignature>.none;
      match (in aggregate.constructorDeclaration) {
        some(initializer) => {
          customConstructor = true;
          constructorSignature = Option.some(constructorDeclarationSignature(
            aggregate.name,
            initializer
          ));
        }
        none => {}
      }
      return Option.some(ModuleTypeSignature({
        nativeCName: aggregate.nativeCLayout
          ? aggregate.name.copyBytes(0, aggregate.name.byteLength)
          : "",
        nativeCUnderlyingType: "",
        typeParameters,
        typeParameterConstraints,
        executorAffinity: aggregate.executorAffinity.copyBytes(0, aggregate.executorAffinity.byteLength),
        implementedTraits,
        fields,
        methods,
        variants: Array<ModuleVariantSignature>(),
        customDeinit,
        customConstructor,
        constructorSignature,
        foreignKind: "",
        foreignLayout: "",
        foreignNativeName: "",
        foreignUnderlyingType: "",
        foreignResourceRelease: "",
      }));
    }
  }
  if (declaration.kind == DeclarationKind.traitDeclaration) {
    for (const traitDeclaration of program.traits) {
      if (traitDeclaration.name != declaration.name) continue;
      let methods = Array<ModuleMethodSignature>();
      for (const method of traitDeclaration.methods) {
        methods.push(ModuleMethodSignature({
          name: method.name.copyBytes(0, method.name.byteLength),
          staticMethod: false,
          visibility: "public",
          receiverMode: receiverModeName(method.receiverMode),
          signature: functionDeclarationSignature(program, method),
        }));
      }
      return Option.some(ModuleTypeSignature({
        nativeCName: "",
        nativeCUnderlyingType: "",
        typeParameters: Array<String>(),
        typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
        executorAffinity: "",
        implementedTraits: Array<String>(),
        fields: Array<ModuleFieldSignature>(),
        methods,
        variants: Array<ModuleVariantSignature>(),
        customDeinit: false,
        customConstructor: false,
        constructorSignature: Option<ModuleFunctionSignature>.none,
        foreignKind: "",
        foreignLayout: "",
        foreignNativeName: "",
        foreignUnderlyingType: "",
        foreignResourceRelease: "",
      }));
    }
  }
  if (declaration.kind == DeclarationKind.enumDeclaration) {
    for (const enumDeclaration of program.enums) {
      if (enumDeclaration.name != declaration.name) continue;
      let variants = Array<ModuleVariantSignature>();
      for (const variant of enumDeclaration.variants) {
        let payloadType = "";
        match (in variant.payload) {
          some(payload) => payloadType = payload.name.copyBytes(0, payload.name.byteLength);
          none => {}
        }
        variants.push(ModuleVariantSignature({
          name: variant.name.copyBytes(0, variant.name.byteLength),
          payloadType,
        }));
      }
      let nativeCUnderlyingType = "";
      if (enumDeclaration.nativeCLayout) {
        match (in enumDeclaration.underlyingType) {
          some(type) => {
            nativeCUnderlyingType = type.name.copyBytes(0, type.name.byteLength);
          }
          none => {}
        }
      }
      return Option.some(ModuleTypeSignature({
        nativeCName: enumDeclaration.nativeCLayout
          ? enumDeclaration.name.copyBytes(0, enumDeclaration.name.byteLength)
          : "",
        nativeCUnderlyingType,
        typeParameters: Array<String>(),
        typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
        executorAffinity: "",
        implementedTraits: Array<String>(),
        fields: Array<ModuleFieldSignature>(),
        methods: Array<ModuleMethodSignature>(),
        variants,
        customDeinit: false,
        customConstructor: false,
        constructorSignature: Option<ModuleFunctionSignature>.none,
        foreignKind: "",
        foreignLayout: "",
        foreignNativeName: "",
        foreignUnderlyingType: "",
        foreignResourceRelease: "",
      }));
    }
  }
  return Option<ModuleTypeSignature>.none;
}
