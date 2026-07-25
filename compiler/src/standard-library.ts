import { dynamicArrayTypeName, sliceTypeName } from "./array-types.ts";
import type { ImportDeclaration } from "./ast.ts";

export function isStandardModuleSpecifier(specifier: string): boolean {
  return specifier === "std" || specifier.startsWith("std/");
}

export type StandardModuleName = "fs" | "process" | "thread" | "scheduler" | "objc";

export const objcConnectionTypeName = "__z_std_objc_Connection";
export const objcBindingTypeName = "__z_std_objc_Binding";
export const objcSelectorTypeName = "__z_std_objc_Selector";

export type StandardFunctionName =
  | "sleep"
  | "delay"
  | "scheduler.yield"
  | "fs.readText"
  | "fs.writeText"
  | "fs.exists"
  | "process.args"
  | "process.run";

export type StandardFunctionSignature = {
  readonly cName: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly mode: "value" | "in" | "inout" | "out";
    readonly type: string;
    readonly abi?: "value";
  }[];
  readonly returnType: string;
  readonly errorType?: string;
  readonly async?: boolean;
};

const standardFunctions: Record<StandardFunctionName, StandardFunctionSignature> = {
  sleep: {
    cName: "z_sleep_ms",
    parameters: [{ name: "milliseconds", mode: "value", type: "u64" }],
    returnType: "void",
  },
  delay: {
    cName: "z_async_schedule_delay",
    parameters: [{ name: "milliseconds", mode: "value", type: "u64" }],
    returnType: "void",
    async: true,
  },
  "scheduler.yield": {
    cName: "z_async_scheduler_yield",
    parameters: [],
    returnType: "void",
    async: true,
  },
  "fs.readText": {
    cName: "z_fs_read_text",
    parameters: [{ name: "path", mode: "in", type: "String", abi: "value" }],
    returnType: "String",
    errorType: "String",
  },
  "fs.writeText": {
    cName: "z_fs_write_text",
    parameters: [
      { name: "path", mode: "in", type: "String", abi: "value" },
      { name: "contents", mode: "in", type: "String", abi: "value" },
    ],
    returnType: "void",
    errorType: "String",
  },
  "fs.exists": {
    cName: "z_fs_exists",
    parameters: [{ name: "path", mode: "in", type: "String", abi: "value" }],
    returnType: "boolean",
  },
  "process.args": {
    cName: "z_process_args",
    parameters: [],
    returnType: dynamicArrayTypeName("String"),
  },
  "process.run": {
    cName: "z_process_run",
    parameters: [
      { name: "program", mode: "in", type: "String", abi: "value" },
      { name: "arguments", mode: "value", type: sliceTypeName("String") },
    ],
    returnType: "i32",
    errorType: "String",
  },
};

export function standardFunctionSignature(name: StandardFunctionName): StandardFunctionSignature {
  return standardFunctions[name];
}

const standardModuleMembers: Record<StandardModuleName, Readonly<Record<string, StandardFunctionName>>> = {
  fs: {
    readText: "fs.readText",
    writeText: "fs.writeText",
    exists: "fs.exists",
  },
  process: {
    args: "process.args",
    run: "process.run",
  },
  thread: {},
  scheduler: {
    yield: "scheduler.yield",
  },
  objc: {},
};

export function standardModuleFunction(
  module: StandardModuleName,
  member: string,
): StandardFunctionName | null {
  return standardModuleMembers[module][member] ?? null;
}

export function standardModuleFunctions(module: StandardModuleName): readonly StandardFunctionName[] {
  return Object.values(standardModuleMembers[module]);
}

export function standardModuleMemberNames(module: StandardModuleName): readonly string[] {
  if (module === "thread") return ["spawn", "main"];
  if (module === "objc") return ["connect", "bind", "Connection", "Binding"];
  return Object.keys(standardModuleMembers[module]);
}

export function importedStandardFunctions(imports: readonly ImportDeclaration[]): readonly StandardFunctionName[] {
  const names = new Set<StandardFunctionName>();
  for (const declaration of imports) {
    if (declaration.header === "std/time" && declaration.bindings) {
      for (const binding of declaration.bindings) {
        if (binding.importedName === "sleep" || binding.importedName === "delay") names.add(binding.importedName);
      }
    }
    if (declaration.header === "std/fs" && !declaration.bindings) {
      for (const name of standardModuleFunctions("fs")) names.add(name);
    }
    if (declaration.header === "std/process" && !declaration.bindings) {
      for (const name of standardModuleFunctions("process")) names.add(name);
    }
  }
  return [...names];
}
