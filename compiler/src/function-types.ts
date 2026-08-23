export type FunctionTypeParameter = {
  readonly name: string;
  readonly mode: "value" | "in" | "inout" | "out";
  readonly type: string;
};

export type FunctionType = {
  readonly parameters: readonly FunctionTypeParameter[];
  readonly returnType: string;
  readonly errorType: string | null;
  /**
   * Where an owned callable environment may be invoked. `any` is a stronger
   * contract than the ordinary executor-local default and therefore affects
   * source compatibility without changing the native call ABI.
   */
  readonly thread: "local" | "main" | "any";
};

const prefix = "__z_function:";

export function functionTypeName(
  parameters: readonly FunctionTypeParameter[],
  returnType: string,
  errorType: string | null = null,
  thread: FunctionType["thread"] = "local",
): string {
  return `${prefix}${encodeURIComponent(JSON.stringify({ parameters, returnType, errorType, thread }))}`;
}

export function parseFunctionType(name: string): FunctionType | null {
  if (!name.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(name.slice(prefix.length))) as FunctionType;
    if (
      !Array.isArray(parsed.parameters)
      || typeof parsed.returnType !== "string"
      || (parsed.errorType !== undefined && parsed.errorType !== null && typeof parsed.errorType !== "string")
    ) return null;
    if (parsed.parameters.some((parameter) => (
      typeof parameter.name !== "string"
      || !["value", "in", "inout", "out"].includes(parameter.mode)
      || typeof parameter.type !== "string"
    ))) return null;
    if (
      parsed.thread !== undefined
      && parsed.thread !== "local"
      && parsed.thread !== "main"
      && parsed.thread !== "any"
    ) return null;
    return { ...parsed, errorType: parsed.errorType ?? null, thread: parsed.thread ?? "local" };
  } catch {
    return null;
  }
}

export function functionTypesCompatible(left: FunctionType, right: FunctionType): boolean {
  return left.returnType === right.returnType
    && left.errorType === right.errorType
    // The left side is the required type. An arbitrary-thread callable may
    // satisfy either a local or main-only destination. A main-only callable
    // remains distinct from an executor-local value so its placement proof
    // cannot be erased by storage or parameter passing.
    && (
      left.thread === right.thread
      || right.thread === "any"
    )
    && left.parameters.length === right.parameters.length
    && left.parameters.every((parameter, index) => (
      parameter.mode === right.parameters[index].mode
      && parameter.type === right.parameters[index].type
    ));
}

export function transformFunctionType(
  name: string,
  transform: (type: string) => string,
): string {
  const functionType = parseFunctionType(name);
  if (!functionType) return name;
  return functionTypeName(
    functionType.parameters.map((parameter) => ({ ...parameter, type: transform(parameter.type) })),
    transform(functionType.returnType),
    functionType.errorType ? transform(functionType.errorType) : null,
    functionType.thread,
  );
}

export function displayFunctionType(
  name: string,
  display: (type: string) => string = (type) => type,
): string | null {
  const functionType = parseFunctionType(name);
  if (!functionType) return null;
  const parameters = functionType.parameters.map((parameter) => {
    const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
    return `${capability}${parameter.name}: ${display(parameter.type)}`;
  });
  const throws = functionType.errorType ? ` throws ${display(functionType.errorType)}` : "";
  const thread = functionType.thread === "local" ? "" : ` on thread.${functionType.thread}`;
  return `(${parameters.join(", ")}) => ${display(functionType.returnType)}${throws}${thread}`;
}

export function functionTypeAbiKey(functionType: FunctionType): string {
  return JSON.stringify({
    parameters: functionType.parameters.map((parameter) => ({ mode: parameter.mode, type: parameter.type })),
    returnType: functionType.returnType,
    errorType: functionType.errorType,
  });
}
