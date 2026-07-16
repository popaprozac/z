export type FunctionTypeParameter = {
  readonly name: string;
  readonly mode: "value" | "in" | "inout" | "out";
  readonly type: string;
};

export type FunctionType = {
  readonly parameters: readonly FunctionTypeParameter[];
  readonly returnType: string;
};

const prefix = "__z_function:";

export function functionTypeName(
  parameters: readonly FunctionTypeParameter[],
  returnType: string,
): string {
  return `${prefix}${encodeURIComponent(JSON.stringify({ parameters, returnType }))}`;
}

export function parseFunctionType(name: string): FunctionType | null {
  if (!name.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(name.slice(prefix.length))) as FunctionType;
    if (!Array.isArray(parsed.parameters) || typeof parsed.returnType !== "string") return null;
    if (parsed.parameters.some((parameter) => (
      typeof parameter.name !== "string"
      || !["value", "in", "inout", "out"].includes(parameter.mode)
      || typeof parameter.type !== "string"
    ))) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function functionTypesCompatible(left: FunctionType, right: FunctionType): boolean {
  return left.returnType === right.returnType
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
  return `(${parameters.join(", ")}) => ${display(functionType.returnType)}`;
}

export function functionTypeAbiKey(functionType: FunctionType): string {
  return JSON.stringify({
    parameters: functionType.parameters.map((parameter) => ({ mode: parameter.mode, type: parameter.type })),
    returnType: functionType.returnType,
  });
}
