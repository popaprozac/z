import { readFileSync } from "node:fs";
import { CString, dlopen, FFIType, ptr } from "bun:ffi";
import {
  isNativeFrontendDiagnosticKind,
  NativeFrontendDiagnosticError,
} from "./native-frontend-diagnostics.ts";
import { decodeStage1ModuleGraphStream } from "./self-hosting.ts";
import type {
  Stage1ModuleBindingResolution,
  Stage1ModuleCallResolution,
  Stage1ModuleExpressionResolution,
  Stage1ModuleFunctionSignature,
  Stage1ModuleGraph,
  Stage1ModuleSymbol,
  Stage1ModuleTypeIdentity,
  Stage1ModuleTypeSignature,
} from "./self-hosting.ts";

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

export type NativeFrontendPhaseResult = {
  readonly summary: NativeFrontendGraphSummary;
  readonly graph: Stage1ModuleGraph;
};

type NativeFrontendSymbolStructure = Stage1ModuleSymbol;
type NativeFrontendFunctionSignatureStructure = Stage1ModuleFunctionSignature;
type NativeFrontendTypeSignatureStructure = Stage1ModuleTypeSignature;
type NativeFrontendTypeIdentityStructure = Stage1ModuleTypeIdentity;
type NativeFrontendCallResolutionStructure = Stage1ModuleCallResolution;
type NativeFrontendBindingResolutionStructure = Stage1ModuleBindingResolution;
type NativeFrontendExpressionResolutionStructure = Stage1ModuleExpressionResolution;
type MutableNativeFrontendModule = {
  path: string;
  dependencies: number[];
  symbols: NativeFrontendSymbolStructure[];
  callResolutions: NativeFrontendCallResolutionStructure[];
  bindingResolutions: NativeFrontendBindingResolutionStructure[];
  expressionResolutions: NativeFrontendExpressionResolutionStructure[];
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

export function emitWithNativeFrontendLibrary(
  libraryPath: string,
  entryPath: string,
  batch: Buffer,
): string {
  const library = dlopen(libraryPath, {
    z_stage1_emit: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.ptr,
    },
    z_stage1_free: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });
  try {
    const entryBytes = Buffer.from(entryPath, "utf8");
    const entryStorage = entryBytes.byteLength > 0 ? entryBytes : Buffer.alloc(1);
    const batchStorage = batch.byteLength > 0 ? batch : Buffer.alloc(1);
    const resultPointer = library.symbols.z_stage1_emit(
      ptr(entryStorage),
      entryBytes.byteLength,
      ptr(batchStorage),
      batch.byteLength,
    );
    if (!resultPointer) throw new Error("the native frontend library returned a null emitter response");
    try {
      const response = new CString(resultPointer).toString();
      if (response.startsWith("error\n")) {
        throw decodeNativeResolverError(response.slice("error\n".length));
      }
      if (!response.startsWith("ok\n")) throw new Error("the native frontend library returned a malformed emitter response");
      return response.slice("ok\n".length);
    } finally {
      library.symbols.z_stage1_free(resultPointer);
    }
  } finally {
    library.close();
  }
}

export function resolveStreamWithNativeFrontendLibrary(
  libraryPath: string,
  entryPath: string,
  batch: Buffer,
): NativeFrontendPhaseResult {
  const library = dlopen(libraryPath, {
    z_stage1_resolve_stream: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.ptr,
    },
    z_stage1_free: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });
  try {
    const entryBytes = Buffer.from(entryPath, "utf8");
    const entryStorage = entryBytes.byteLength > 0 ? entryBytes : Buffer.alloc(1);
    const batchStorage = batch.byteLength > 0 ? batch : Buffer.alloc(1);
    const resultPointer = library.symbols.z_stage1_resolve_stream(
      ptr(entryStorage),
      entryBytes.byteLength,
      ptr(batchStorage),
      batch.byteLength,
    );
    if (!resultPointer) throw new Error("the native frontend library returned a null resolver response");
    try {
      const response = new CString(resultPointer).toString();
      if (response.startsWith("error\n")) {
        throw decodeNativeResolverError(response.slice("error\n".length));
      }
      if (!response.startsWith("ok\n")) {
        throw new Error("the native frontend library returned a malformed resolver response");
      }
      const graph = decodeStage1ModuleGraphStream(response.slice("ok\n".length));
      let dependencyCount = 0;
      let symbolCount = 0;
      let callResolutionCount = 0;
      let bindingResolutionCount = 0;
      let expressionResolutionCount = 0;
      for (const module of graph.modules) {
        dependencyCount += module.dependencies.length;
        symbolCount += module.symbols.length;
        callResolutionCount += module.callResolutions.length;
        bindingResolutionCount += module.bindingResolutions.length;
        expressionResolutionCount += module.expressionResolutions.length;
      }
      return {
        graph,
        summary: {
          entry: graph.entry,
          moduleCount: graph.modules.length,
          dependencyCount,
          dependencyOrderCount: graph.dependencyOrder.length,
          symbolCount,
          callResolutionCount,
          bindingResolutionCount,
          expressionResolutionCount,
        },
      };
    } finally {
      library.symbols.z_stage1_free(resultPointer);
    }
  } finally {
    library.close();
  }
}

export function resolveWithNativeFrontendLibrary(
  libraryPath: string,
  entryPath: string,
  batch: Buffer,
): NativeFrontendPhaseResult {
  const library = dlopen(libraryPath, {
    z_stage1_resolve_api_version: {
      returns: FFIType.u64,
    },
    z_stage1_resolve: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.ptr,
    },
    z_stage1_resolve_success: {
      args: [FFIType.ptr],
      returns: FFIType.u8,
    },
    z_stage1_resolve_error_payload: {
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
    z_stage1_resolve_function_signature_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_function_signature_item_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_type_signature_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_type_signature_item_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_member_signature_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_member_signature_item_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_call_resolution_item_count: {
      args: [FFIType.ptr],
      returns: FFIType.u64,
    },
    z_stage1_resolve_type_identity_count: {
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
    z_stage1_resolve_copy_function_signature_records: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_copy_function_signature_item_records: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_copy_type_signature_records: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_copy_type_signature_item_records: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_copy_member_signature_records: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_copy_member_signature_item_records: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_copy_call_resolution_records: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_copy_call_resolution_item_records: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_copy_binding_resolution_records: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_copy_expression_resolution_records: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_copy_type_identity_records: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.u64,
    },
    z_stage1_resolve_free: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });
  try {
    const apiVersion = nativeUsize(
      library.symbols.z_stage1_resolve_api_version(),
      "resolver API version",
    );
    if (apiVersion !== 2) {
      throw new Error(`unsupported native frontend resolver API version ${apiVersion}`);
    }
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
      if (library.symbols.z_stage1_resolve_success(responsePointer) !== 1) {
        const payloadPointer = library.symbols.z_stage1_resolve_error_payload(responsePointer);
        if (!payloadPointer) {
          throw new Error("the native frontend library returned a null resolver error payload");
        }
        throw decodeNativeResolverError(new CString(payloadPointer).toString());
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
      const modules: MutableNativeFrontendModule[] = [];
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
          callResolutions: [],
          bindingResolutions: [],
          expressionResolutions: [],
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
      const symbolRecordWidth = 12 * 8;
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
          const nativeCExport = field(6, "C-export state");
          const hasTarget = field(7, "target state");
          if (exported > 1 || nativeCExport > 1 || hasTarget > 1) {
            throw new Error(`the native frontend returned invalid symbol flags for module ${moduleIndex}`);
          }
          modules[moduleIndex].symbols.push({
            name: nativeString(namePointer, nameLength, "symbol name"),
            kind: nativeSymbolKind(field(4, "kind")),
            exported: exported === 1,
            nativeCExport: nativeCExport === 1,
            targetModule: hasTarget === 1 ? field(8, "target module") : null,
            importedName: nativeString(
              importedNamePointer,
              importedNameLength,
              "imported symbol name",
            ),
            functionSignature: null,
            typeSignature: null,
            location: {
              offset: field(9, "offset"),
              line: field(10, "line"),
              column: field(11, "column"),
            },
          });
          recordIndex += 1;
        }
      }
      const functionSignatureCount = nativeUsize(
        library.symbols.z_stage1_resolve_function_signature_count(responsePointer),
        "function-signature count",
      );
      const functionSignatureItemCount = nativeUsize(
        library.symbols.z_stage1_resolve_function_signature_item_count(responsePointer),
        "function-signature item count",
      );
      const signatureRecordWidth = 12 * 8;
      const signatureRecords = Buffer.alloc(
        Math.max(1, functionSignatureCount * signatureRecordWidth),
      );
      const writtenSignatures = nativeUsize(
        library.symbols.z_stage1_resolve_copy_function_signature_records(
          responsePointer,
          ptr(signatureRecords),
          functionSignatureCount,
        ),
        "written function-signature count",
      );
      if (writtenSignatures !== functionSignatureCount) {
        throw new Error("the native frontend returned an incomplete function-signature batch");
      }
      type SignatureExpectation = {
        readonly signature: {
          typeParameters: string[];
          typeParameterConstraints: {
            parameter: string;
            traitName: string;
          }[];
          parameterModes: ("value" | "in" | "inout" | "out")[];
          parameterTypes: string[];
        };
        readonly typeParameterCount: number;
        readonly parameterCount: number;
        readonly constraintCount: number;
        typeParametersWritten: number;
        parametersWritten: number;
        constraintsWritten: number;
      };
      const signatureExpectations = new Map<string, SignatureExpectation>();
      let expectedSignatureItemCount = 0;
      for (
        let signatureIndex = 0;
        signatureIndex < functionSignatureCount;
        signatureIndex += 1
      ) {
        const recordOffset = signatureIndex * signatureRecordWidth;
        const field = (index: number, description: string): number => nativeUsize(
          signatureRecords.readBigUInt64LE(recordOffset + (index * 8)),
          `function signature ${signatureIndex} ${description}`,
        );
        const moduleIndex = field(0, "module index");
        const symbolIndex = field(1, "symbol index");
        const symbol = modules[moduleIndex]?.symbols[symbolIndex];
        if (!symbol || symbol.kind !== "function" || symbol.functionSignature !== null) {
          throw new Error("the native frontend returned a function signature for an invalid symbol");
        }
        const asynchronous = field(2, "async state");
        if (asynchronous > 1) {
          throw new Error("the native frontend returned an invalid function async state");
        }
        const returnType = nativeString(
          field(3, "return-type pointer"),
          field(4, "return-type length"),
          "function return type",
        );
        const errorType = nativeString(
          field(5, "error-type pointer"),
          field(6, "error-type length"),
          "function error type",
        );
        const executorAffinity = nativeString(
          field(7, "executor-affinity pointer"),
          field(8, "executor-affinity length"),
          "function executor affinity",
        );
        const typeParameterCount = field(9, "type-parameter count");
        const parameterCount = field(10, "parameter count");
        const constraintCount = field(11, "constraint count");
        const signature = {
          asynchronous: asynchronous === 1,
          executorAffinity: executorAffinity.length === 0 ? null : executorAffinity,
          typeParameters: new Array<string>(typeParameterCount),
          typeParameterConstraints: new Array<{
            parameter: string;
            traitName: string;
          }>(constraintCount),
          parameterModes: new Array<"value" | "in" | "inout" | "out">(parameterCount),
          parameterTypes: new Array<string>(parameterCount),
          returnType,
          errorType: errorType.length === 0 ? null : errorType,
        };
        (symbol as {
          functionSignature: NativeFrontendFunctionSignatureStructure | null;
        }).functionSignature = signature;
        const key = `${moduleIndex}:${symbolIndex}`;
        if (signatureExpectations.has(key)) {
          throw new Error("the native frontend returned duplicate function signatures");
        }
        signatureExpectations.set(key, {
          signature,
          typeParameterCount,
          parameterCount,
          constraintCount,
          typeParametersWritten: 0,
          parametersWritten: 0,
          constraintsWritten: 0,
        });
        expectedSignatureItemCount += typeParameterCount + parameterCount + constraintCount;
      }
      if (expectedSignatureItemCount !== functionSignatureItemCount) {
        throw new Error("the native frontend function-signature item counts do not match");
      }
      const signatureItemRecordWidth = 8 * 8;
      const signatureItemRecords = Buffer.alloc(
        Math.max(1, functionSignatureItemCount * signatureItemRecordWidth),
      );
      const writtenSignatureItems = nativeUsize(
        library.symbols.z_stage1_resolve_copy_function_signature_item_records(
          responsePointer,
          ptr(signatureItemRecords),
          functionSignatureItemCount,
        ),
        "written function-signature item count",
      );
      if (writtenSignatureItems !== functionSignatureItemCount) {
        throw new Error("the native frontend returned an incomplete function-signature item batch");
      }
      for (
        let itemRecordIndex = 0;
        itemRecordIndex < functionSignatureItemCount;
        itemRecordIndex += 1
      ) {
        const recordOffset = itemRecordIndex * signatureItemRecordWidth;
        const field = (index: number, description: string): number => nativeUsize(
          signatureItemRecords.readBigUInt64LE(recordOffset + (index * 8)),
          `function signature item ${itemRecordIndex} ${description}`,
        );
        const moduleIndex = field(0, "module index");
        const symbolIndex = field(1, "symbol index");
        const kind = field(2, "kind");
        const itemIndex = field(3, "index");
        const first = nativeString(
          field(4, "first pointer"),
          field(5, "first length"),
          "function-signature item",
        );
        const second = nativeString(
          field(6, "second pointer"),
          field(7, "second length"),
          "function-signature item",
        );
        const expectation = signatureExpectations.get(`${moduleIndex}:${symbolIndex}`);
        if (!expectation) {
          throw new Error("the native frontend returned an item without a function signature");
        }
        if (kind === 0) {
          if (
            itemIndex >= expectation.typeParameterCount
            || itemIndex in expectation.signature.typeParameters
            || second.length !== 0
          ) {
            throw new Error("the native frontend returned an invalid function type parameter");
          }
          expectation.signature.typeParameters[itemIndex] = first;
          expectation.typeParametersWritten += 1;
          continue;
        }
        if (kind === 1) {
          if (
            itemIndex >= expectation.parameterCount
            || itemIndex in expectation.signature.parameterModes
            || !isNativeParameterMode(first)
          ) {
            throw new Error("the native frontend returned an invalid function parameter");
          }
          expectation.signature.parameterModes[itemIndex] = first;
          expectation.signature.parameterTypes[itemIndex] = second;
          expectation.parametersWritten += 1;
          continue;
        }
        if (kind === 2) {
          if (
            itemIndex >= expectation.constraintCount
            || itemIndex in expectation.signature.typeParameterConstraints
          ) {
            throw new Error("the native frontend returned an invalid function constraint");
          }
          expectation.signature.typeParameterConstraints[itemIndex] = {
            parameter: first,
            traitName: second,
          };
          expectation.constraintsWritten += 1;
          continue;
        }
        throw new Error(`the native frontend returned invalid function-signature item kind ${kind}`);
      }
      for (const expectation of signatureExpectations.values()) {
        if (
          expectation.typeParametersWritten !== expectation.typeParameterCount
          || expectation.parametersWritten !== expectation.parameterCount
          || expectation.constraintsWritten !== expectation.constraintCount
        ) {
          throw new Error("the native frontend returned a sparse function signature");
        }
      }
      type TypeSignatureExpectation = {
        readonly signature: {
          typeParameters: string[];
          typeParameterConstraints: {
            parameter: string;
            traitName: string;
          }[];
          implementedTraits: string[];
          fields: {
            name: string;
            typeName: string;
            executorAffinity: string | null;
            visibility: "public" | "internal" | "private";
            readonlyField: boolean;
          }[];
          methods: {
            name: string;
            staticMethod: boolean;
            visibility: "public" | "internal" | "private";
            receiverMode: "in" | "inout" | "move";
            signature: NativeFrontendFunctionSignatureStructure;
          }[];
          variants: {
            name: string;
            payloadType: string | null;
          }[];
          constructorSignature: NativeFrontendFunctionSignatureStructure | null;
          customConstructor: boolean;
          constructorVisibility: "public" | "internal" | "private";
        };
        readonly typeParameterCount: number;
        readonly constraintCount: number;
        readonly implementedTraitCount: number;
        readonly fieldCount: number;
        readonly methodCount: number;
        readonly variantCount: number;
        typeParametersWritten: number;
        constraintsWritten: number;
        implementedTraitsWritten: number;
        fieldsWritten: number;
        variantsWritten: number;
      };
      const typeSignatureCount = nativeUsize(
        library.symbols.z_stage1_resolve_type_signature_count(responsePointer),
        "type-signature count",
      );
      const typeSignatureItemCount = nativeUsize(
        library.symbols.z_stage1_resolve_type_signature_item_count(responsePointer),
        "type-signature item count",
      );
      const typeSignatureRecordWidth = 16 * 8;
      const typeSignatureRecords = Buffer.alloc(
        Math.max(1, typeSignatureCount * typeSignatureRecordWidth),
      );
      const writtenTypeSignatures = nativeUsize(
        library.symbols.z_stage1_resolve_copy_type_signature_records(
          responsePointer,
          ptr(typeSignatureRecords),
          typeSignatureCount,
        ),
        "written type-signature count",
      );
      if (writtenTypeSignatures !== typeSignatureCount) {
        throw new Error("the native frontend returned an incomplete type-signature batch");
      }
      const typeSignatureExpectations = new Map<string, TypeSignatureExpectation>();
      let expectedTypeSignatureItemCount = 0;
      for (
        let typeSignatureIndex = 0;
        typeSignatureIndex < typeSignatureCount;
        typeSignatureIndex += 1
      ) {
        const recordOffset = typeSignatureIndex * typeSignatureRecordWidth;
        const field = (index: number, description: string): number => nativeUsize(
          typeSignatureRecords.readBigUInt64LE(recordOffset + (index * 8)),
          `type signature ${typeSignatureIndex} ${description}`,
        );
        const moduleIndex = field(0, "module index");
        const symbolIndex = field(1, "symbol index");
        const symbol = modules[moduleIndex]?.symbols[symbolIndex];
        if (
          !symbol
          || !isNativeAggregateSymbolKind(symbol.kind)
          || symbol.typeSignature !== null
        ) {
          throw new Error("the native frontend returned a type signature for an invalid symbol");
        }
        const executorAffinity = nativeString(
          field(2, "executor-affinity pointer"),
          field(3, "executor-affinity length"),
          "type executor affinity",
        );
        const nativeCName = nativeString(
          field(4, "native C name pointer"),
          field(5, "native C name length"),
          "type native C name",
        );
        const nativeCUnderlyingType = nativeString(
          field(6, "native C underlying-type pointer"),
          field(7, "native C underlying-type length"),
          "type native C underlying type",
        );
        const customDeinit = field(8, "custom-deinit state");
        const customConstructor = field(9, "custom-constructor state");
        if (customDeinit > 1 || customConstructor > 1) {
          throw new Error("the native frontend returned invalid type-signature flags");
        }
        const typeParameterCount = field(10, "type-parameter count");
        const constraintCount = field(11, "constraint count");
        const implementedTraitCount = field(12, "implemented-trait count");
        const fieldCount = field(13, "field count");
        const methodCount = field(14, "method count");
        const variantCount = field(15, "variant count");
        const signature = {
          nativeCName,
          nativeCUnderlyingType,
          typeParameters: new Array<string>(typeParameterCount),
          typeParameterConstraints: new Array<{
            parameter: string;
            traitName: string;
          }>(constraintCount),
          executorAffinity: executorAffinity.length === 0 ? null : executorAffinity,
          implementedTraits: new Array<string>(implementedTraitCount),
          fields: new Array<{
            name: string;
            typeName: string;
            executorAffinity: string | null;
            visibility: "public" | "internal" | "private";
            readonlyField: boolean;
          }>(fieldCount),
          methods: new Array<{
            name: string;
            staticMethod: boolean;
            visibility: "public" | "internal" | "private";
            receiverMode: "in" | "inout" | "move";
            signature: NativeFrontendFunctionSignatureStructure;
          }>(methodCount),
          variants: new Array<{
            name: string;
            payloadType: string | null;
          }>(variantCount),
          customDeinit: customDeinit === 1,
          customConstructor: customConstructor === 1,
          constructorVisibility: "public" as const,
          constructorSignature: null,
        };
        (symbol as {
          typeSignature: NativeFrontendTypeSignatureStructure | null;
        }).typeSignature = signature;
        const key = `${moduleIndex}:${symbolIndex}`;
        if (typeSignatureExpectations.has(key)) {
          throw new Error("the native frontend returned duplicate type signatures");
        }
        typeSignatureExpectations.set(key, {
          signature,
          typeParameterCount,
          constraintCount,
          implementedTraitCount,
          fieldCount,
          methodCount,
          variantCount,
          typeParametersWritten: 0,
          constraintsWritten: 0,
          implementedTraitsWritten: 0,
          fieldsWritten: 0,
          variantsWritten: 0,
        });
        expectedTypeSignatureItemCount += typeParameterCount
          + constraintCount
          + implementedTraitCount
          + fieldCount
          + variantCount;
      }
      if (expectedTypeSignatureItemCount !== typeSignatureItemCount) {
        throw new Error("the native frontend type-signature item counts do not match");
      }
      const typeSignatureItemRecordWidth = 13 * 8;
      const typeSignatureItemRecords = Buffer.alloc(
        Math.max(1, typeSignatureItemCount * typeSignatureItemRecordWidth),
      );
      const writtenTypeSignatureItems = nativeUsize(
        library.symbols.z_stage1_resolve_copy_type_signature_item_records(
          responsePointer,
          ptr(typeSignatureItemRecords),
          typeSignatureItemCount,
        ),
        "written type-signature item count",
      );
      if (writtenTypeSignatureItems !== typeSignatureItemCount) {
        throw new Error("the native frontend returned an incomplete type-signature item batch");
      }
      for (
        let itemRecordIndex = 0;
        itemRecordIndex < typeSignatureItemCount;
        itemRecordIndex += 1
      ) {
        const recordOffset = itemRecordIndex * typeSignatureItemRecordWidth;
        const field = (index: number, description: string): number => nativeUsize(
          typeSignatureItemRecords.readBigUInt64LE(recordOffset + (index * 8)),
          `type signature item ${itemRecordIndex} ${description}`,
        );
        const moduleIndex = field(0, "module index");
        const symbolIndex = field(1, "symbol index");
        const kind = field(2, "kind");
        const itemIndex = field(3, "index");
        const first = nativeString(
          field(4, "first pointer"),
          field(5, "first length"),
          "type-signature item",
        );
        const second = nativeString(
          field(6, "second pointer"),
          field(7, "second length"),
          "type-signature item",
        );
        const third = nativeString(
          field(8, "third pointer"),
          field(9, "third length"),
          "type-signature item",
        );
        const fourth = nativeString(
          field(10, "fourth pointer"),
          field(11, "fourth length"),
          "type-signature item",
        );
        const flag = field(12, "flag");
        const expectation = typeSignatureExpectations.get(`${moduleIndex}:${symbolIndex}`);
        if (!expectation) {
          throw new Error("the native frontend returned an item without a type signature");
        }
        if (kind === 0) {
          if (
            itemIndex >= expectation.typeParameterCount
            || itemIndex in expectation.signature.typeParameters
            || second.length !== 0
            || third.length !== 0
            || fourth.length !== 0
            || flag !== 0
          ) {
            throw new Error("the native frontend returned an invalid aggregate type parameter");
          }
          expectation.signature.typeParameters[itemIndex] = first;
          expectation.typeParametersWritten += 1;
          continue;
        }
        if (kind === 1) {
          if (
            itemIndex >= expectation.constraintCount
            || itemIndex in expectation.signature.typeParameterConstraints
            || third.length !== 0
            || fourth.length !== 0
            || flag !== 0
          ) {
            throw new Error("the native frontend returned an invalid aggregate constraint");
          }
          expectation.signature.typeParameterConstraints[itemIndex] = {
            parameter: first,
            traitName: second,
          };
          expectation.constraintsWritten += 1;
          continue;
        }
        if (kind === 2) {
          if (
            itemIndex >= expectation.implementedTraitCount
            || itemIndex in expectation.signature.implementedTraits
            || second.length !== 0
            || third.length !== 0
            || fourth.length !== 0
            || flag !== 0
          ) {
            throw new Error("the native frontend returned an invalid implemented trait");
          }
          expectation.signature.implementedTraits[itemIndex] = first;
          expectation.implementedTraitsWritten += 1;
          continue;
        }
        if (kind === 3) {
          if (
            itemIndex >= expectation.fieldCount
            || itemIndex in expectation.signature.fields
            || !isNativeVisibility(third)
            || flag > 1
          ) {
            throw new Error("the native frontend returned an invalid aggregate field");
          }
          expectation.signature.fields[itemIndex] = {
            name: first,
            typeName: second,
            executorAffinity: fourth.length === 0 ? null : fourth,
            visibility: third,
            readonlyField: flag === 1,
          };
          expectation.fieldsWritten += 1;
          continue;
        }
        if (kind === 4) {
          if (
            itemIndex >= expectation.variantCount
            || itemIndex in expectation.signature.variants
            || third.length !== 0
            || fourth.length !== 0
            || flag !== 0
          ) {
            throw new Error("the native frontend returned an invalid enum variant");
          }
          expectation.signature.variants[itemIndex] = {
            name: first,
            payloadType: second.length === 0 ? null : second,
          };
          expectation.variantsWritten += 1;
          continue;
        }
        throw new Error(`the native frontend returned invalid type-signature item kind ${kind}`);
      }
      for (const expectation of typeSignatureExpectations.values()) {
        if (
          expectation.typeParametersWritten !== expectation.typeParameterCount
          || expectation.constraintsWritten !== expectation.constraintCount
          || expectation.implementedTraitsWritten !== expectation.implementedTraitCount
          || expectation.fieldsWritten !== expectation.fieldCount
          || expectation.variantsWritten !== expectation.variantCount
        ) {
          throw new Error("the native frontend returned a sparse type signature");
        }
      }
      const memberSignatureCount = nativeUsize(
        library.symbols.z_stage1_resolve_member_signature_count(responsePointer),
        "member-signature count",
      );
      const memberSignatureItemCount = nativeUsize(
        library.symbols.z_stage1_resolve_member_signature_item_count(responsePointer),
        "member-signature item count",
      );
      const memberSignatureRecordWidth = 21 * 8;
      const memberSignatureRecords = Buffer.alloc(
        Math.max(1, memberSignatureCount * memberSignatureRecordWidth),
      );
      const writtenMemberSignatures = nativeUsize(
        library.symbols.z_stage1_resolve_copy_member_signature_records(
          responsePointer,
          ptr(memberSignatureRecords),
          memberSignatureCount,
        ),
        "written member-signature count",
      );
      if (writtenMemberSignatures !== memberSignatureCount) {
        throw new Error("the native frontend returned an incomplete member-signature batch");
      }
      const memberSignatureExpectations = new Map<string, SignatureExpectation>();
      let expectedMemberSignatureItemCount = 0;
      for (
        let memberSignatureIndex = 0;
        memberSignatureIndex < memberSignatureCount;
        memberSignatureIndex += 1
      ) {
        const recordOffset = memberSignatureIndex * memberSignatureRecordWidth;
        const field = (index: number, description: string): number => nativeUsize(
          memberSignatureRecords.readBigUInt64LE(recordOffset + (index * 8)),
          `member signature ${memberSignatureIndex} ${description}`,
        );
        const moduleIndex = field(0, "module index");
        const symbolIndex = field(1, "symbol index");
        const memberKind = field(2, "kind");
        const memberIndex = field(3, "index");
        const typeExpectation = typeSignatureExpectations.get(`${moduleIndex}:${symbolIndex}`);
        if (!typeExpectation) {
          throw new Error("the native frontend returned a member without a type signature");
        }
        const name = nativeString(
          field(4, "name pointer"),
          field(5, "name length"),
          "member name",
        );
        const staticMethod = field(6, "static state");
        const visibility = nativeString(
          field(7, "visibility pointer"),
          field(8, "visibility length"),
          "member visibility",
        );
        const receiverMode = nativeString(
          field(9, "receiver-mode pointer"),
          field(10, "receiver-mode length"),
          "member receiver mode",
        );
        const asynchronous = field(11, "async state");
        if (staticMethod > 1 || asynchronous > 1) {
          throw new Error("the native frontend returned invalid member-signature flags");
        }
        const returnType = nativeString(
          field(12, "return-type pointer"),
          field(13, "return-type length"),
          "member return type",
        );
        const errorType = nativeString(
          field(14, "error-type pointer"),
          field(15, "error-type length"),
          "member error type",
        );
        const executorAffinity = nativeString(
          field(16, "executor-affinity pointer"),
          field(17, "executor-affinity length"),
          "member executor affinity",
        );
        const typeParameterCount = field(18, "type-parameter count");
        const parameterCount = field(19, "parameter count");
        const constraintCount = field(20, "constraint count");
        const signature = {
          asynchronous: asynchronous === 1,
          executorAffinity: executorAffinity.length === 0 ? null : executorAffinity,
          typeParameters: new Array<string>(typeParameterCount),
          typeParameterConstraints: new Array<{
            parameter: string;
            traitName: string;
          }>(constraintCount),
          parameterModes: new Array<"value" | "in" | "inout" | "out">(parameterCount),
          parameterTypes: new Array<string>(parameterCount),
          returnType,
          errorType: errorType.length === 0 ? null : errorType,
        };
        if (memberKind === 0) {
          if (
            memberIndex !== 0
            || !typeExpectation.signature.customConstructor
            || typeExpectation.signature.constructorSignature !== null
            || name.length !== 0
            || staticMethod !== 0
            || !isNativeVisibility(visibility)
            || receiverMode.length !== 0
          ) {
            throw new Error("the native frontend returned an invalid constructor signature");
          }
          typeExpectation.signature.constructorVisibility = visibility;
          typeExpectation.signature.constructorSignature = signature;
        } else if (memberKind === 1) {
          if (
            memberIndex >= typeExpectation.methodCount
            || memberIndex in typeExpectation.signature.methods
            || !isNativeVisibility(visibility)
            || !isNativeReceiverMode(receiverMode)
          ) {
            throw new Error("the native frontend returned an invalid method signature");
          }
          typeExpectation.signature.methods[memberIndex] = {
            name,
            staticMethod: staticMethod === 1,
            visibility,
            receiverMode,
            signature,
          };
        } else {
          throw new Error(`the native frontend returned invalid member-signature kind ${memberKind}`);
        }
        const key = `${moduleIndex}:${symbolIndex}:${memberKind}:${memberIndex}`;
        if (memberSignatureExpectations.has(key)) {
          throw new Error("the native frontend returned duplicate member signatures");
        }
        memberSignatureExpectations.set(key, {
          signature,
          typeParameterCount,
          parameterCount,
          constraintCount,
          typeParametersWritten: 0,
          parametersWritten: 0,
          constraintsWritten: 0,
        });
        expectedMemberSignatureItemCount += typeParameterCount
          + parameterCount
          + constraintCount;
      }
      if (expectedMemberSignatureItemCount !== memberSignatureItemCount) {
        throw new Error("the native frontend member-signature item counts do not match");
      }
      const memberSignatureItemRecordWidth = 10 * 8;
      const memberSignatureItemRecords = Buffer.alloc(
        Math.max(1, memberSignatureItemCount * memberSignatureItemRecordWidth),
      );
      const writtenMemberSignatureItems = nativeUsize(
        library.symbols.z_stage1_resolve_copy_member_signature_item_records(
          responsePointer,
          ptr(memberSignatureItemRecords),
          memberSignatureItemCount,
        ),
        "written member-signature item count",
      );
      if (writtenMemberSignatureItems !== memberSignatureItemCount) {
        throw new Error("the native frontend returned an incomplete member-signature item batch");
      }
      for (
        let itemRecordIndex = 0;
        itemRecordIndex < memberSignatureItemCount;
        itemRecordIndex += 1
      ) {
        const recordOffset = itemRecordIndex * memberSignatureItemRecordWidth;
        const field = (index: number, description: string): number => nativeUsize(
          memberSignatureItemRecords.readBigUInt64LE(recordOffset + (index * 8)),
          `member signature item ${itemRecordIndex} ${description}`,
        );
        const moduleIndex = field(0, "module index");
        const symbolIndex = field(1, "symbol index");
        const memberKind = field(2, "member kind");
        const memberIndex = field(3, "member index");
        const itemKind = field(4, "item kind");
        const itemIndex = field(5, "item index");
        const first = nativeString(
          field(6, "first pointer"),
          field(7, "first length"),
          "member-signature item",
        );
        const second = nativeString(
          field(8, "second pointer"),
          field(9, "second length"),
          "member-signature item",
        );
        const expectation = memberSignatureExpectations.get(
          `${moduleIndex}:${symbolIndex}:${memberKind}:${memberIndex}`,
        );
        if (!expectation) {
          throw new Error("the native frontend returned an item without a member signature");
        }
        if (itemKind === 0) {
          if (
            itemIndex >= expectation.typeParameterCount
            || itemIndex in expectation.signature.typeParameters
            || second.length !== 0
          ) {
            throw new Error("the native frontend returned an invalid member type parameter");
          }
          expectation.signature.typeParameters[itemIndex] = first;
          expectation.typeParametersWritten += 1;
          continue;
        }
        if (itemKind === 1) {
          if (
            itemIndex >= expectation.parameterCount
            || itemIndex in expectation.signature.parameterModes
            || !isNativeParameterMode(first)
          ) {
            throw new Error("the native frontend returned an invalid member parameter");
          }
          expectation.signature.parameterModes[itemIndex] = first;
          expectation.signature.parameterTypes[itemIndex] = second;
          expectation.parametersWritten += 1;
          continue;
        }
        if (itemKind === 2) {
          if (
            itemIndex >= expectation.constraintCount
            || itemIndex in expectation.signature.typeParameterConstraints
          ) {
            throw new Error("the native frontend returned an invalid member constraint");
          }
          expectation.signature.typeParameterConstraints[itemIndex] = {
            parameter: first,
            traitName: second,
          };
          expectation.constraintsWritten += 1;
          continue;
        }
        throw new Error(`the native frontend returned invalid member-signature item kind ${itemKind}`);
      }
      for (const expectation of memberSignatureExpectations.values()) {
        if (
          expectation.typeParametersWritten !== expectation.typeParameterCount
          || expectation.parametersWritten !== expectation.parameterCount
          || expectation.constraintsWritten !== expectation.constraintCount
        ) {
          throw new Error("the native frontend returned a sparse member signature");
        }
      }
      for (const expectation of typeSignatureExpectations.values()) {
        if (
          !Array.from(
            { length: expectation.methodCount },
            (_, index) => index in expectation.signature.methods,
          ).every(Boolean)
          || (
            expectation.signature.customConstructor
            && expectation.signature.constructorSignature === null
          )
          || (
            !expectation.signature.customConstructor
            && expectation.signature.constructorSignature !== null
          )
        ) {
          throw new Error("the native frontend returned incomplete aggregate members");
        }
      }
      type CallResolutionExpectation = {
        readonly resolution: {
          typeParameters: string[];
          typeArguments: string[];
          parameterModes: ("value" | "in" | "inout" | "out" | "inValue" | "move")[];
          parameterTypes: string[];
        };
        readonly typeCount: number;
        readonly parameterCount: number;
        typesWritten: number;
        parametersWritten: number;
      };
      const callResolutionItemCount = nativeUsize(
        library.symbols.z_stage1_resolve_call_resolution_item_count(responsePointer),
        "call-resolution item count",
      );
      const callResolutionRecordWidth = 21 * 8;
      const callResolutionRecords = Buffer.alloc(
        Math.max(1, summary.callResolutionCount * callResolutionRecordWidth),
      );
      const writtenCallResolutions = nativeUsize(
        library.symbols.z_stage1_resolve_copy_call_resolution_records(
          responsePointer,
          ptr(callResolutionRecords),
          summary.callResolutionCount,
        ),
        "written call-resolution count",
      );
      if (writtenCallResolutions !== summary.callResolutionCount) {
        throw new Error("the native frontend returned an incomplete call-resolution batch");
      }
      const callResolutionExpectations = new Map<string, CallResolutionExpectation>();
      let expectedCallResolutionItemCount = 0;
      for (
        let callRecordIndex = 0;
        callRecordIndex < summary.callResolutionCount;
        callRecordIndex += 1
      ) {
        const recordOffset = callRecordIndex * callResolutionRecordWidth;
        const field = (index: number, description: string): number => nativeUsize(
          callResolutionRecords.readBigUInt64LE(recordOffset + (index * 8)),
          `call resolution ${callRecordIndex} ${description}`,
        );
        const moduleIndex = field(0, "module index");
        const resolutionIndex = field(1, "resolution index");
        const module = modules[moduleIndex];
        if (!module || resolutionIndex !== module.callResolutions.length) {
          throw new Error("the native frontend returned an out-of-order call resolution");
        }
        const kind = nativeString(
          field(7, "kind pointer"),
          field(8, "kind length"),
          "call-resolution kind",
        );
        if (!isNativeCallResolutionKind(kind)) {
          throw new Error(`the native frontend returned invalid call-resolution kind ${kind}`);
        }
        const asynchronous = field(11, "async state");
        if (asynchronous > 1) {
          throw new Error("the native frontend returned invalid call-resolution async state");
        }
        const errorType = nativeString(
          field(16, "error-type pointer"),
          field(17, "error-type length"),
          "call-resolution error type",
        );
        const callableTypeParameterCount = field(18, "callable type-parameter count");
        const typeCount = field(19, "type count");
        const parameterCount = field(20, "parameter count");
        if (callableTypeParameterCount > typeCount) {
          throw new Error("the native frontend returned an invalid callable type-parameter count");
        }
        const resolution = {
          offset: field(2, "offset"),
          line: field(3, "line"),
          column: field(4, "column"),
          targetModule: field(5, "target module"),
          targetSymbol: field(6, "target symbol"),
          kind,
          targetName: nativeString(
            field(9, "target-name pointer"),
            field(10, "target-name length"),
            "call-resolution target name",
          ),
          asynchronous: asynchronous === 1,
          receiverMode: nativeString(
            field(12, "receiver-mode pointer"),
            field(13, "receiver-mode length"),
            "call-resolution receiver mode",
          ),
          callableTypeParameterCount,
          typeParameters: new Array<string>(typeCount),
          typeArguments: new Array<string>(typeCount),
          parameterModes: new Array<"value" | "in" | "inout" | "out" | "inValue" | "move">(parameterCount),
          parameterTypes: new Array<string>(parameterCount),
          returnType: nativeString(
            field(14, "return-type pointer"),
            field(15, "return-type length"),
            "call-resolution return type",
          ),
          errorType: errorType.length === 0 ? null : errorType,
        };
        module.callResolutions.push(resolution);
        const key = `${moduleIndex}:${resolutionIndex}`;
        if (callResolutionExpectations.has(key)) {
          throw new Error("the native frontend returned duplicate call resolutions");
        }
        callResolutionExpectations.set(key, {
          resolution,
          typeCount,
          parameterCount,
          typesWritten: 0,
          parametersWritten: 0,
        });
        expectedCallResolutionItemCount += typeCount + parameterCount;
      }
      if (expectedCallResolutionItemCount !== callResolutionItemCount) {
        throw new Error("the native frontend call-resolution item counts do not match");
      }
      const callResolutionItemRecordWidth = 8 * 8;
      const callResolutionItemRecords = Buffer.alloc(
        Math.max(1, callResolutionItemCount * callResolutionItemRecordWidth),
      );
      const writtenCallResolutionItems = nativeUsize(
        library.symbols.z_stage1_resolve_copy_call_resolution_item_records(
          responsePointer,
          ptr(callResolutionItemRecords),
          callResolutionItemCount,
        ),
        "written call-resolution item count",
      );
      if (writtenCallResolutionItems !== callResolutionItemCount) {
        throw new Error("the native frontend returned an incomplete call-resolution item batch");
      }
      for (
        let itemRecordIndex = 0;
        itemRecordIndex < callResolutionItemCount;
        itemRecordIndex += 1
      ) {
        const recordOffset = itemRecordIndex * callResolutionItemRecordWidth;
        const field = (index: number, description: string): number => nativeUsize(
          callResolutionItemRecords.readBigUInt64LE(recordOffset + (index * 8)),
          `call resolution item ${itemRecordIndex} ${description}`,
        );
        const moduleIndex = field(0, "module index");
        const resolutionIndex = field(1, "resolution index");
        const kind = field(2, "kind");
        const itemIndex = field(3, "index");
        const first = nativeString(
          field(4, "first pointer"),
          field(5, "first length"),
          "call-resolution item",
        );
        const second = nativeString(
          field(6, "second pointer"),
          field(7, "second length"),
          "call-resolution item",
        );
        const expectation = callResolutionExpectations.get(`${moduleIndex}:${resolutionIndex}`);
        if (!expectation) {
          throw new Error("the native frontend returned an item without a call resolution");
        }
        if (kind === 0) {
          if (
            itemIndex >= expectation.typeCount
            || itemIndex in expectation.resolution.typeParameters
          ) {
            throw new Error("the native frontend returned an invalid call type argument");
          }
          expectation.resolution.typeParameters[itemIndex] = first;
          expectation.resolution.typeArguments[itemIndex] = second;
          expectation.typesWritten += 1;
          continue;
        }
        if (kind === 1) {
          if (
            itemIndex >= expectation.parameterCount
            || itemIndex in expectation.resolution.parameterModes
            || !isNativeCallParameterMode(first)
          ) {
            throw new Error("the native frontend returned an invalid call parameter");
          }
          expectation.resolution.parameterModes[itemIndex] = first;
          expectation.resolution.parameterTypes[itemIndex] = second;
          expectation.parametersWritten += 1;
          continue;
        }
        throw new Error(`the native frontend returned invalid call-resolution item kind ${kind}`);
      }
      for (const expectation of callResolutionExpectations.values()) {
        if (
          expectation.typesWritten !== expectation.typeCount
          || expectation.parametersWritten !== expectation.parameterCount
        ) {
          throw new Error("the native frontend returned a sparse call resolution");
        }
      }
      type IdentityExpectation = {
        readonly identities: NativeFrontendTypeIdentityStructure[];
        readonly count: number;
        written: number;
      };
      const identityExpectations = new Map<string, IdentityExpectation>();
      let expectedTypeIdentityCount = 0;
      const bindingResolutionRecordWidth = 11 * 8;
      const bindingResolutionRecords = Buffer.alloc(
        Math.max(1, summary.bindingResolutionCount * bindingResolutionRecordWidth),
      );
      const writtenBindingResolutions = nativeUsize(
        library.symbols.z_stage1_resolve_copy_binding_resolution_records(
          responsePointer,
          ptr(bindingResolutionRecords),
          summary.bindingResolutionCount,
        ),
        "written binding-resolution count",
      );
      if (writtenBindingResolutions !== summary.bindingResolutionCount) {
        throw new Error("the native frontend returned an incomplete binding-resolution batch");
      }
      for (
        let bindingRecordIndex = 0;
        bindingRecordIndex < summary.bindingResolutionCount;
        bindingRecordIndex += 1
      ) {
        const recordOffset = bindingRecordIndex * bindingResolutionRecordWidth;
        const field = (index: number, description: string): number => nativeUsize(
          bindingResolutionRecords.readBigUInt64LE(recordOffset + (index * 8)),
          `binding resolution ${bindingRecordIndex} ${description}`,
        );
        const moduleIndex = field(0, "module index");
        const resolutionIndex = field(1, "resolution index");
        const module = modules[moduleIndex];
        if (!module || resolutionIndex !== module.bindingResolutions.length) {
          throw new Error("the native frontend returned an out-of-order binding resolution");
        }
        const mutableBinding = field(7, "mutability");
        if (mutableBinding > 1) {
          throw new Error("the native frontend returned invalid binding mutability");
        }
        const identityCount = field(10, "identity count");
        const identities = new Array<NativeFrontendTypeIdentityStructure>(identityCount);
        module.bindingResolutions.push({
          offset: field(2, "offset"),
          line: field(3, "line"),
          column: field(4, "column"),
          name: nativeString(
            field(5, "name pointer"),
            field(6, "name length"),
            "binding-resolution name",
          ),
          mutableBinding: mutableBinding === 1,
          typeName: nativeString(
            field(8, "type-name pointer"),
            field(9, "type-name length"),
            "binding-resolution type name",
          ),
          typeIdentities: identities,
        });
        identityExpectations.set(`0:${moduleIndex}:${resolutionIndex}`, {
          identities,
          count: identityCount,
          written: 0,
        });
        expectedTypeIdentityCount += identityCount;
      }
      const expressionResolutionRecordWidth = 10 * 8;
      const expressionResolutionRecords = Buffer.alloc(
        Math.max(1, summary.expressionResolutionCount * expressionResolutionRecordWidth),
      );
      const writtenExpressionResolutions = nativeUsize(
        library.symbols.z_stage1_resolve_copy_expression_resolution_records(
          responsePointer,
          ptr(expressionResolutionRecords),
          summary.expressionResolutionCount,
        ),
        "written expression-resolution count",
      );
      if (writtenExpressionResolutions !== summary.expressionResolutionCount) {
        throw new Error("the native frontend returned an incomplete expression-resolution batch");
      }
      for (
        let expressionRecordIndex = 0;
        expressionRecordIndex < summary.expressionResolutionCount;
        expressionRecordIndex += 1
      ) {
        const recordOffset = expressionRecordIndex * expressionResolutionRecordWidth;
        const field = (index: number, description: string): number => nativeUsize(
          expressionResolutionRecords.readBigUInt64LE(recordOffset + (index * 8)),
          `expression resolution ${expressionRecordIndex} ${description}`,
        );
        const moduleIndex = field(0, "module index");
        const resolutionIndex = field(1, "resolution index");
        const module = modules[moduleIndex];
        if (!module || resolutionIndex !== module.expressionResolutions.length) {
          throw new Error("the native frontend returned an out-of-order expression resolution");
        }
        const identityCount = field(9, "identity count");
        const identities = new Array<NativeFrontendTypeIdentityStructure>(identityCount);
        module.expressionResolutions.push({
          offset: field(2, "offset"),
          line: field(3, "line"),
          column: field(4, "column"),
          typeName: nativeString(
            field(5, "type-name pointer"),
            field(6, "type-name length"),
            "expression-resolution type name",
          ),
          targetName: nativeString(
            field(7, "target-name pointer"),
            field(8, "target-name length"),
            "expression-resolution target name",
          ),
          typeIdentities: identities,
        });
        identityExpectations.set(`1:${moduleIndex}:${resolutionIndex}`, {
          identities,
          count: identityCount,
          written: 0,
        });
        expectedTypeIdentityCount += identityCount;
      }
      const typeIdentityCount = nativeUsize(
        library.symbols.z_stage1_resolve_type_identity_count(responsePointer),
        "type-identity count",
      );
      if (expectedTypeIdentityCount !== typeIdentityCount) {
        throw new Error("the native frontend type-identity counts do not match");
      }
      const typeIdentityRecordWidth = 8 * 8;
      const typeIdentityRecords = Buffer.alloc(
        Math.max(1, typeIdentityCount * typeIdentityRecordWidth),
      );
      const writtenTypeIdentities = nativeUsize(
        library.symbols.z_stage1_resolve_copy_type_identity_records(
          responsePointer,
          ptr(typeIdentityRecords),
          typeIdentityCount,
        ),
        "written type-identity count",
      );
      if (writtenTypeIdentities !== typeIdentityCount) {
        throw new Error("the native frontend returned an incomplete type-identity batch");
      }
      for (
        let identityRecordIndex = 0;
        identityRecordIndex < typeIdentityCount;
        identityRecordIndex += 1
      ) {
        const recordOffset = identityRecordIndex * typeIdentityRecordWidth;
        const field = (index: number, description: string): number => nativeUsize(
          typeIdentityRecords.readBigUInt64LE(recordOffset + (index * 8)),
          `type identity ${identityRecordIndex} ${description}`,
        );
        const moduleIndex = field(0, "module index");
        const evidenceKind = field(1, "evidence kind");
        const resolutionIndex = field(2, "resolution index");
        const identityIndex = field(3, "identity index");
        const targetModule = field(6, "target module");
        const targetSymbol = field(7, "target symbol");
        if (!modules[targetModule]?.symbols[targetSymbol]) {
          throw new Error("the native frontend returned an invalid type-identity target");
        }
        const expectation = identityExpectations.get(
          `${evidenceKind}:${moduleIndex}:${resolutionIndex}`,
        );
        if (
          !expectation
          || identityIndex >= expectation.count
          || identityIndex in expectation.identities
        ) {
          throw new Error("the native frontend returned an invalid type identity");
        }
        expectation.identities[identityIndex] = {
          path: nativeString(
            field(4, "path pointer"),
            field(5, "path length"),
            "type-identity path",
          ),
          targetModule,
          targetSymbol,
        };
        expectation.written += 1;
      }
      for (const expectation of identityExpectations.values()) {
        if (expectation.written !== expectation.count) {
          throw new Error("the native frontend returned sparse type identities");
        }
      }
      validateNativeFrontendPhaseGraph(summary, modules, dependencyOrder);
      return {
        summary,
        graph: {
          modules,
          dependencyOrder,
          entry: summary.entry,
        },
      };
    } finally {
      library.symbols.z_stage1_resolve_free(responsePointer);
    }
  } finally {
    library.close();
  }
}

function validateNativeFrontendPhaseGraph(
  summary: NativeFrontendGraphSummary,
  modules: readonly MutableNativeFrontendModule[],
  dependencyOrder: readonly number[],
): void {
  const dependencyCount = modules.reduce(
    (count, module) => count + module.dependencies.length,
    0,
  );
  const symbolCount = modules.reduce(
    (count, module) => count + module.symbols.length,
    0,
  );
  const callResolutionCount = modules.reduce(
    (count, module) => count + module.callResolutions.length,
    0,
  );
  const bindingResolutionCount = modules.reduce(
    (count, module) => count + module.bindingResolutions.length,
    0,
  );
  const expressionResolutionCount = modules.reduce(
    (count, module) => count + module.expressionResolutions.length,
    0,
  );
  if (
    summary.entry >= modules.length
    || summary.moduleCount !== modules.length
    || summary.dependencyCount !== dependencyCount
    || summary.dependencyOrderCount !== dependencyOrder.length
    || summary.symbolCount !== symbolCount
    || summary.callResolutionCount !== callResolutionCount
    || summary.bindingResolutionCount !== bindingResolutionCount
    || summary.expressionResolutionCount !== expressionResolutionCount
  ) {
    throw new Error("the native frontend phase summary does not match its graph");
  }
  for (const module of modules) {
    if (module.dependencies.some((dependency) => dependency >= modules.length)) {
      throw new Error("the native frontend returned an invalid module dependency");
    }
    if (module.symbols.some((symbol) => (
      symbol.targetModule !== null && symbol.targetModule >= modules.length
    ))) {
      throw new Error("the native frontend returned an invalid symbol target");
    }
    if (module.callResolutions.some((resolution) => (
      !modules[resolution.targetModule]?.symbols[resolution.targetSymbol]
    ))) {
      throw new Error("the native frontend returned an invalid call-resolution target");
    }
    if (module.symbols.some((symbol) => (
      symbol.typeSignature?.customConstructor === true
      && symbol.typeSignature.constructorSignature === null
    ))) {
      throw new Error("the native frontend returned a type without its custom constructor");
    }
  }
  if (dependencyOrder.some((moduleIndex) => moduleIndex >= modules.length)) {
    throw new Error("the native frontend returned an invalid dependency order");
  }
}

function nativeString(pointer: number, length: number, description: string): string {
  if (length === 0) return "";
  if (pointer === 0) throw new Error(`the native frontend returned a null ${description}`);
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

function isNativeAggregateSymbolKind(
  value: NativeFrontendSymbolStructure["kind"],
): value is "struct" | "class" | "trait" | "enum" {
  return value === "struct" || value === "class" || value === "trait" || value === "enum";
}

function isNativeCallResolutionKind(
  value: string,
): value is "function" | "method" | "staticMethod" | "constructor" {
  return value === "function" || value === "method" || value === "staticMethod" || value === "constructor";
}

function isNativeVisibility(value: string): value is "public" | "private" {
  return value === "public" || value === "private";
}

function isNativeReceiverMode(value: string): value is "in" | "inout" | "move" {
  return value === "in" || value === "inout" || value === "move";
}

function isNativeParameterMode(
  value: string,
): value is "value" | "in" | "inout" | "out" {
  return value === "value" || value === "in" || value === "inout" || value === "out";
}

function isNativeCallParameterMode(
  value: string,
): value is "value" | "in" | "inout" | "out" | "inValue" | "move" {
  return isNativeParameterMode(value) || value === "inValue" || value === "move";
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
  if (fields[0] === "diagnostic2") {
    if (
      fields.length !== 8
      || !isNativeFrontendDiagnosticKind(fields[1] ?? "")
      || !/^(?:[0-9a-f]{2})+$/.test(fields[2] ?? "")
      || !/^(?:[0-9a-f]{2})+$/.test(fields[3] ?? "")
      || !/^[0-9a-f]{16}$/.test(fields[4] ?? "")
      || !/^[0-9a-f]{16}$/.test(fields[5] ?? "")
      || !/^[0-9a-f]{16}$/.test(fields[6] ?? "")
      || !/^(?:[0-9a-f]{2})+$/.test(fields[7] ?? "")
    ) return new Error(payload);
    const code = Buffer.from(fields[2]!, "hex").toString("utf8");
    const line = Number.parseInt(fields[4]!, 16);
    const column = Number.parseInt(fields[5]!, 16);
    const length = Number.parseInt(fields[6]!, 16);
    if (
      !/^Z\d{4}$/.test(code)
      || !Number.isSafeInteger(line)
      || line < 1
      || !Number.isSafeInteger(column)
      || column < 1
      || !Number.isSafeInteger(length)
      || length < 1
    ) return new Error(payload);
    return new NativeFrontendDiagnosticError(
      fields[1]!,
      Buffer.from(fields[3]!, "hex").toString("utf8"),
      line,
      column,
      Buffer.from(fields[7]!, "hex").toString("utf8"),
      code as `Z${number}`,
      length,
    );
  }
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
