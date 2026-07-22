import { readFileSync } from "node:fs";
import { CString, dlopen, FFIType, ptr } from "bun:ffi";

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

export function resolveWithNativeFrontendLibrary(libraryPath: string, entryPath: string, batch: Buffer): string {
  const library = dlopen(libraryPath, {
    z_stage1_resolve: {
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
    const resultPointer = library.symbols.z_stage1_resolve(
      ptr(entryStorage),
      entryBytes.byteLength,
      ptr(batchStorage),
      batch.byteLength,
    );
    if (!resultPointer) throw new Error("the native frontend library returned a null resolver response");
    try {
      const response = new CString(resultPointer).toString();
      if (response.startsWith("error\n")) throw new Error(response.slice("error\n".length));
      if (!response.startsWith("ok\n")) throw new Error("the native frontend library returned a malformed resolver response");
      return response.slice("ok\n".length);
    } finally {
      library.symbols.z_stage1_free(resultPointer);
    }
  } finally {
    library.close();
  }
}
