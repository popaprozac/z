import type { Expression, FunctionDeclaration } from "./ast.ts";

// This is evidence about one known implementation, not a property of `in` or
// of a callable ABI. Unknown/dynamic callees never inherit this proof.
export function callbackParameterDoesNotEscape(
  declaration: FunctionDeclaration,
  parameterIndex: number,
  resolve: (callee: Expression) => FunctionDeclaration | null,
  visiting = new Set<FunctionDeclaration>(),
): boolean {
  const parameter = declaration.parameters[parameterIndex];
  if (!parameter || parameter.mode !== "in" || declaration.async || declaration.rawBody
    || visiting.has(declaration) || visiting.size >= 64) return false;
  const name = parameter.name;
  const active = new Set(visiting).add(declaration);
  const shadowed = new Set(declaration.parameters.map((value) => value.name));
  const collectNames = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collectNames); return; }
    const node = value as Record<string, unknown>;
    if (typeof node.name === "string" && node.kind !== "identifier") shadowed.add(node.name);
    if (typeof node.binding === "string") shadowed.add(node.binding);
    if (typeof node.bindingName === "string") shadowed.add(node.bindingName);
    Object.values(node).forEach(collectNames);
  };
  collectNames(declaration.body);
  const references = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(references);
    const node = value as Record<string, unknown>;
    // Include explicit `using`/raw captures, even if the body never reads them.
    if (node.name === name || node.kind === "raw") return true;
    return Object.values(node).some(references);
  };
  const directReference = (value: Expression): boolean =>
    (value.kind === "identifier" && value.name === name)
    || (value.kind === "argumentReference" && value.name === name && value.access === "in");
  const safe = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return true;
    if (Array.isArray(value)) return value.every(safe);
    const node = value as Record<string, unknown>;
    if (node.kind === "yield" || node.kind === "raw") return false;
    if (["closure", "spawn", "executorPlacement", "await"].includes(String(node.kind))) return !references(node);
    if ((node.kind === "identifier" || node.kind === "argumentReference") && node.name === name) return false;
    if (node.kind === "call") {
      const call = node as unknown as Extract<Expression, { kind: "call" }>;
      if (call.callee.kind === "identifier" && call.callee.name === name) {
        return call.arguments.every(safe);
      }
      if (!safe(call.callee)) return false;
      const callee = call.callee.kind === "identifier" && !shadowed.has(call.callee.name)
        ? resolve(call.callee) : null;
      return call.arguments.every((argument, index) => directReference(argument)
        ? callee !== null && callbackParameterDoesNotEscape(callee, index, resolve, active)
        : safe(argument));
    }
    return Object.values(node).every(safe);
  };
  return safe(declaration.body);
}
