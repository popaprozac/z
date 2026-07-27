import { readFileSync } from "node:fs";
import { CString, dlopen, FFIType, ptr } from "bun:ffi";
import {
  isNativeFrontendDiagnosticKind,
  NativeFrontendDiagnosticError,
} from "./native-frontend-diagnostics.ts";

export type NativeFrontendGraphSummary = {
  readonly entry: number;
  readonly moduleCount: number;
  readonly dependencyCount: number;
  readonly dependencyOrderCount: number;
  readonly symbolCount: number;
  readonly callResolutionCount: number;
  readonly bindingResolutionCount: number;
  readonly expressionResolutionCount: number;
};

export type NativeFrontendModuleStructure = {
  readonly path: string;
  readonly dependencies: readonly number[];
  readonly symbols: readonly NativeFrontendSymbolStructure[];
};

export type NativeFrontendSymbolStructure = {
  readonly name: string;
  readonly kind: "function" | "struct" | "class" | "trait" | "type" | "enum" | "namespace" | "imported";
  readonly exported: boolean;
  readonly targetModule: number | null;
  readonly importedName: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
};

export type NativeFrontendGraphStructure = {
  readonly modules: readonly NativeFrontendModuleStructure[];
  readonly dependencyOrder: readonly number[];
};

export type NativeFrontendResolverResponse = {
  readonly stream: string;
  readonly summary: NativeFrontendGraphSummary;
  readonly structure: NativeFrontendGraphStructure;
};

export function parseWithNativeFrontendLibrary(libraryPath: string, inputPaths: readonly string[]): string {
  const library = dlopen(libraryPath, {
    z_stage1_parse: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.ptr,
    },
    z_stage1_free: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });
  try {
    let stream = "";
    for (const inputPath of inputPaths) {
      const pathBytes = Buffer.from(inputPath, "utf8");
      const sourceBytes = Buffer.from(readFileSync(inputPath, "utf8"), "utf8");
      const pathStorage = pathBytes.byteLength > 0 ? pathBytes : Buffer.alloc(1);
      const sourceStorage = sourceBytes.byteLength > 0 ? sourceBytes : Buffer.alloc(1);
      const resultPointer = library.symbols.z_stage1_parse(
        ptr(pathStorage),
        pathBytes.byteLength,
        ptr(sourceStorage),
        sourceBytes.byteLength,
      );
      if (!resultPointer) throw new Error("the native frontend library returned a null parser response");
      try {
        const response = new CString(resultPointer).toString();
        if (response.startsWith("error\n")) throw new Error(response.slice("error\n".length));
        if (!response.startsWith("ok\n")) throw new Error("the native frontend library returned a malformed parser response");
        stream += response.slice("ok\n".length);
      } finally {
        library.symbols.z_stage1_free(resultPointer);
      }
    }
    return stream;
  } finally {
    library.close();
  }
}

export function resolveWithNativeFrontendLibrary(
  libraryPath: string,
  entryPath: string,
  batch: Buffer,
): NativeFrontendResolverResponse {
  const library = dlopen(libraryPath, {
    z_stage1_resolve: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.ptr,
    },
    z_stage1_resolve_success: {
      args: [FFIType.ptr],
      returns: FFIType.u8,
    },
    z_stage1_resolve_payload: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    z_stage1_resolve_entry: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_module_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_dependency_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_dependency_order_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_symbol_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_call_resolution_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_binding_resolution_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_expression_resolution_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_module_path_data: {
      args: [FFIType.ptr, FFIType.u64],
      returns: FFIType.ptr,
    },
    z_stage1_resolve_module_path_length: {
      args: [FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_module_dependency_count: {
      args: [FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_module_dependency: {
      args: [FFIType.ptr, FFIType.u64, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_dependency_order: {
      args: [FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_module_symbol_count: {
      args: [FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_copy_symbol_records: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_free: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });
  try {
    const entryBytes = Buffer.from(entryPath, "utf8");
    const entryStorage = entryBytes.byteLength > 0 ? entryBytes : Buffer.alloc(1);
    const batchStorage = batch.byteLength > 0 ? batch : Buffer.alloc(1);
    const responsePointer = library.symbols.z_stage1_resolve(
      ptr(entryStorage),
      entryBytes.byteLength,
      ptr(batchStorage),
      batch.byteLength,
    );
    if (!responsePointer) throw new Error("the native frontend library returned a null resolver response");
    try {
      const payloadPointer = library.symbols.z_stage1_resolve_payload(responsePointer);
      if (!payloadPointer) {
        throw new Error("the native frontend library returned a null resolver payload");
      }
      const payload = new CString(payloadPointer).toString();
      if (library.symbols.z_stage1_resolve_success(responsePointer) !== 1) {
        throw decodeNativeResolverError(payload);
      }
      const summary: NativeFrontendGraphSummary = {
        entry: nativeUsize(library.symbols.z_stage1_resolve_entry(responsePointer), "entry"),
        moduleCount: nativeUsize(
          library.symbols.z_stage1_resolve_module_count(responsePointer),
          "module count",
        ),
        dependencyCount: nativeUsize(
          library.symbols.z_stage1_resolve_dependency_count(responsePointer),
          "dependency count",
        ),
        dependencyOrderCount: nativeUsize(
          library.symbols.z_stage1_resolve_dependency_order_count(responsePointer),
          "dependency-order count",
        ),
        symbolCount: nativeUsize(
          library.symbols.z_stage1_resolve_symbol_count(responsePointer),
          "symbol count",
        ),
        callResolutionCount: nativeUsize(
          library.symbols.z_stage1_resolve_call_resolution_count(responsePointer),
          "call-resolution count",
        ),
        bindingResolutionCount: nativeUsize(
          library.symbols.z_stage1_resolve_binding_resolution_count(responsePointer),
          "binding-resolution count",
        ),
        expressionResolutionCount: nativeUsize(
          library.symbols.z_stage1_resolve_expression_resolution_count(responsePointer),
          "expression-resolution count",
        ),
      };
      const modules: {
        path: string;
        dependencies: number[];
        symbols: NativeFrontendSymbolStructure[];
      }[] = [];
      const moduleSymbolCounts: number[] = [];
      for (let moduleIndex = 0; moduleIndex < summary.moduleCount; moduleIndex += 1) {
        const pathLength = nativeUsize(
          library.symbols.z_stage1_resolve_module_path_length(responsePointer, moduleIndex),
          `module ${moduleIndex} path length`,
        );
        const pathPointer = library.symbols.z_stage1_resolve_module_path_data(
          responsePointer,
          moduleIndex,
        );
        if (!pathPointer && pathLength > 0) {
          throw new Error(`the native frontend returned a null path for module ${moduleIndex}`);
        }
        const dependencyCount = nativeUsize(
          library.symbols.z_stage1_resolve_module_dependency_count(
            responsePointer,
            moduleIndex,
          ),
          `module ${moduleIndex} dependency count`,
        );
        const dependencies: number[] = [];
        for (
          let dependencyIndex = 0;
          dependencyIndex < dependencyCount;
          dependencyIndex += 1
        ) {
          dependencies.push(nativeUsize(
            library.symbols.z_stage1_resolve_module_dependency(
              responsePointer,
              moduleIndex,
              dependencyIndex,
            ),
            `module ${moduleIndex} dependency ${dependencyIndex}`,
          ));
        }
        modules.push({
          path: pathPointer
            ? new CString(pathPointer, 0, pathLength).toString()
            : "",
          dependencies,
          symbols: [],
        });
        moduleSymbolCounts.push(nativeUsize(
          library.symbols.z_stage1_resolve_module_symbol_count(
            responsePointer,
            moduleIndex,
          ),
          `module ${moduleIndex} symbol count`,
        ));
      }
      const dependencyOrder: number[] = [];
      for (
        let orderIndex = 0;
        orderIndex < summary.dependencyOrderCount;
        orderIndex += 1
      ) {
        dependencyOrder.push(nativeUsize(
          library.symbols.z_stage1_resolve_dependency_order(
            responsePointer,
            orderIndex,
          ),
          `dependency-order entry ${orderIndex}`,
        ));
      }
      const structuralSymbolCount = moduleSymbolCounts.reduce(
        (count, moduleCount) => count + moduleCount,
        0,
      );
      if (structuralSymbolCount !== summary.symbolCount) {
        throw new Error("the native frontend symbol counts do not match its structural summary");
      }
      const symbolRecordWidth = 11 * 8;
      const symbolRecords = Buffer.alloc(
        Math.max(1, structuralSymbolCount * symbolRecordWidth),
      );
      const writtenSymbols = nativeUsize(
        library.symbols.z_stage1_resolve_copy_symbol_records(
          responsePointer,
          ptr(symbolRecords),
          structuralSymbolCount,
        ),
        "written symbol-record count",
      );
      if (writtenSymbols !== structuralSymbolCount) {
        throw new Error("the native frontend returned an incomplete structural symbol batch");
      }
      let recordIndex = 0;
      for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
        const symbolCount = moduleSymbolCounts[moduleIndex];
        for (let symbolIndex = 0; symbolIndex < symbolCount; symbolIndex += 1) {
          const recordOffset = recordIndex * symbolRecordWidth;
          const field = (index: number, description: string): number => nativeUsize(
            symbolRecords.readBigUInt64LE(recordOffset + (index * 8)),
            `module ${moduleIndex} symbol ${symbolIndex} ${description}`,
          );
          const namePointer = field(0, "name pointer");
          const nameLength = field(1, "name length");
          const importedNamePointer = field(2, "imported-name pointer");
          const importedNameLength = field(3, "imported-name length");
          const exported = field(5, "export state");
          const hasTarget = field(6, "target state");
          if (exported > 1 || hasTarget > 1) {
            throw new Error(`the native frontend returned invalid symbol flags for module ${moduleIndex}`);
          }
          modules[moduleIndex].symbols.push({
            name: nativeString(namePointer, nameLength, "symbol name"),
            kind: nativeSymbolKind(field(4, "kind")),
            exported: exported === 1,
            targetModule: hasTarget === 1 ? field(7, "target module") : null,
            importedName: nativeString(
              importedNamePointer,
              importedNameLength,
              "imported symbol name",
            ),
            offset: field(8, "offset"),
            line: field(9, "line"),
            column: field(10, "column"),
          });
          recordIndex += 1;
        }
      }
      return {
        stream: payload,
        summary,
        structure: { modules, dependencyOrder },
      };
    } finally {
      library.symbols.z_stage1_resolve_free(responsePointer);
    }
  } finally {
    library.close();
  }
}

function nativeString(pointer: number, length: number, description: string): string {
  if (pointer === 0) {
    if (length === 0) return "";
    throw new Error(`the native frontend returned a null ${description}`);
  }
  return new CString(pointer, 0, length).toString();
}

function nativeSymbolKind(code: number): NativeFrontendSymbolStructure["kind"] {
  const kinds = [
    "function",
    "struct",
    "class",
    "trait",
    "type",
    "enum",
    "namespace",
    "imported",
  ] as const;
  const kind = kinds[code];
  if (!kind) throw new Error(`the native frontend returned invalid symbol kind ${code}`);
  return kind;
}

function nativeUsize(value: number | bigint, description: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`the native frontend returned an invalid ${description}`);
  }
  return number;
}

function decodeNativeResolverError(payload: string): Error {
  const fields = payload.split("\t");
  if (
    fields.length !== 6
    || fields[0] !== "diagnostic"
    || !isNativeFrontendDiagnosticKind(fields[1])
    || !/^(?:[0-9a-f]{2})+$/.test(fields[2])
    || !/^[0-9a-f]{16}$/.test(fields[3])
    || !/^[0-9a-f]{16}$/.test(fields[4])
    || !/^(?:[0-9a-f]{2})+$/.test(fields[5])
  ) {
    return new Error(payload);
  }
  const line = Number.parseInt(fields[3], 16);
  const column = Number.parseInt(fields[4], 16);
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) {
    return new Error(payload);
  }
  return new NativeFrontendDiagnosticError(
    fields[1],
    Buffer.from(fields[2], "hex").toString("utf8"),
    line,
    column,
    Buffer.from(fields[5], "hex").toString("utf8"),
  );
}
