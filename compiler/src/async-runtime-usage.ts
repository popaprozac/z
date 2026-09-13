import type { FunctionDeclaration, Program } from "./ast.ts";
import type { SemanticInfo } from "./sema.ts";
import { parseDynamicArrayType, parseFixedArrayType, parseSliceType } from "./array-types.ts";
import { parseFunctionType } from "./function-types.ts";
import { parseGenericType } from "./generic-types.ts";
import { parseReadonlyType } from "./readonly-types.ts";
import { parseViewType } from "./view-types.ts";

/** Runtime handles need retain/release support even in a wholly synchronous
 * program. Importing their names alone does not require the scheduler. Use the
 * same predicate for forward declarations and runtime definitions. */
export function programUsesTaskScopeRuntime(program: Program, info: SemanticInfo): boolean {
  if (info.taskScopeConstructors.size > 0
    || info.taskScopeSpawnCalls.size > 0
    || info.taskScopeAsyncCalls.size > 0) return true;

  const seen = new Set<string>();
  const usesHandle = (name: string): boolean => {
    if (name === "TaskScope" || name === "TaskControl") return true;
    if (seen.has(name)) return false;
    seen.add(name);
    const element = parseFixedArrayType(name) ?? parseSliceType(name) ?? parseDynamicArrayType(name);
    if (element) return usesHandle(element.elementType);
    const qualified = parseReadonlyType(name) ?? parseViewType(name);
    if (qualified) return usesHandle(qualified.target);
    const generic = parseGenericType(name);
    if (generic) return generic.arguments.some(usesHandle);
    const callable = parseFunctionType(name);
    return Boolean(callable && (
      callable.parameters.some((parameter) => usesHandle(parameter.type))
      || usesHandle(callable.returnType)
      || (callable.errorType && usesHandle(callable.errorType))
    ));
  };
  const usesSignature = (declaration: FunctionDeclaration): boolean => (
    usesHandle(declaration.returnType.name)
    || Boolean(declaration.errorType && usesHandle(declaration.errorType.name))
    || declaration.parameters.some((parameter) => usesHandle(parameter.type.name))
  );
  if (program.functions.some(usesSignature)) return true;
  // Callable aliases/trait signatures also contribute emitted C function types,
  // including aliases that are not instantiated by a source expression.
  if (program.typeAliases.some((alias) => usesHandle(alias.target.name))) return true;
  if (program.traits.some((trait) => trait.methods.some(usesSignature))) return true;
  for (const declaration of program.structs) {
    if (declaration.fields.some((field) => usesHandle(field.type.name))
      || declaration.methods.some(usesSignature)
      || (declaration.constructor?.errorType && usesHandle(declaration.constructor.errorType.name))
      || declaration.constructor?.parameters.some((parameter) => usesHandle(parameter.type.name))) return true;
  }
  for (const declaration of program.enums) {
    if (declaration.variants.some((variant) => variant.payload && usesHandle(variant.payload.name))) return true;
  }
  for (const declaration of program.constants) {
    if (declaration.type && usesHandle(declaration.type.name)) return true;
  }
  for (const type of info.expressionTypes.values()) if (usesHandle(type)) return true;
  for (const type of info.bindingTypes.values()) if (usesHandle(type)) return true;
  return false;
}

export function programUsesAsyncRuntime(program: Program, info: SemanticInfo): boolean {
  return program.functions.some((declaration) => declaration.async)
    || program.structs.some((declaration) => declaration.methods.some((method) => method.async))
    || programUsesTaskScopeRuntime(program, info);
}
