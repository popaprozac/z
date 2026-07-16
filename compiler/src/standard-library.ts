export function isStandardModuleSpecifier(specifier: string): boolean {
  return specifier === "std" || specifier.startsWith("std/");
}

export type StandardFunctionName = "sleep";

export type StandardFunctionSignature = {
  readonly cName: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly mode: "value" | "in" | "inout" | "out";
    readonly type: string;
  }[];
  readonly returnType: string;
};

const standardFunctions: Record<StandardFunctionName, StandardFunctionSignature> = {
  sleep: {
    cName: "z_sleep_ms",
    parameters: [{ name: "milliseconds", mode: "value", type: "u64" }],
    returnType: "void",
  },
};

export function standardFunctionSignature(name: StandardFunctionName): StandardFunctionSignature {
  return standardFunctions[name];
}
