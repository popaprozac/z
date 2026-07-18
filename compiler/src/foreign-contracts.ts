import type { SourceLocation } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { ApiNotes, PointerNote } from "./foreign-api-notes.ts";
import type {
  ForeignCallbackContextType,
  ForeignCallbackReleaseType,
  ForeignFunction,
  ForeignFunctionDeclaration,
  ForeignNamedType,
  ForeignPointerType,
  ForeignType,
  ForeignTypeSpelling,
} from "./foreign-ir.ts";

export type ForeignContractTypeMapper = {
  readonly mapType: (
    spelling: ForeignTypeSpelling,
    note: PointerNote | undefined,
    position: "return" | "parameter",
    pointerTypes: Map<string, ForeignPointerType>,
    namedTypes: ReadonlyMap<string, ForeignNamedType>,
  ) => ForeignType;
  readonly mapCallbackContext: (cName: string, callbackParameter: number) => ForeignCallbackContextType | ForeignType;
  readonly mapCallbackRelease: (cName: string, callbackParameter: number, contextParameter: number) => ForeignCallbackReleaseType | ForeignType;
};

export type NormalizedForeignContracts = {
  readonly functions: ReadonlyMap<string, ForeignFunction>;
  readonly pointerTypes: ReadonlyMap<string, ForeignPointerType>;
};

export function normalizeForeignContracts(
  declarations: ReadonlyMap<string, ForeignFunctionDeclaration>,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  notes: ApiNotes,
  mapper: ForeignContractTypeMapper,
  fileName: string,
  location: SourceLocation,
): NormalizedForeignContracts {
  validateNoteTargets(declarations, notes, fileName, location);
  const functions = new Map<string, ForeignFunction>();
  const pointerTypes = new Map<string, ForeignPointerType>();
  for (const declaration of declarations.values()) {
    const functionNotes = notes.functions?.[declaration.name];
    const callbackContexts = new Map<number, number>();
    const callbackReleases = new Map<number, { callbackParameter: number; releaseContextParameter: number }>();
    for (let callbackParameter = 0; callbackParameter < declaration.parameters.length; callbackParameter += 1) {
      const callback = functionNotes?.parameters?.[String(callbackParameter)]?.callback;
      if (!callback) continue;
      validateCallbackContract(
        declaration,
        callbackParameter,
        callback,
        callbackContexts,
        callbackReleases,
        fileName,
        location,
      );
    }
    const parameters = declaration.parameters.map((parameter, index) => ({
      name: parameter.name,
      type: callbackContexts.has(index)
        ? mapper.mapCallbackContext(parameter.type.canonicalNativeName ?? parameter.type.nativeName, callbackContexts.get(index)!)
        : callbackReleases.has(index)
          ? mapper.mapCallbackRelease(
            parameter.type.canonicalNativeName ?? parameter.type.nativeName,
            callbackReleases.get(index)!.callbackParameter,
            callbackReleases.get(index)!.releaseContextParameter,
          )
          : mapper.mapType(
            parameter.type,
            functionNotes?.parameters?.[String(index)],
            "parameter",
            pointerTypes,
            namedTypes,
          ),
    }));
    for (let index = 0; index < parameters.length; index += 1) {
      const type = parameters[index].type;
      if (type.kind !== "callback" || !type.context) continue;
      const paired = parameters[type.context.parameter]?.type;
      if (paired?.kind !== "callbackContext" || paired.callbackParameter !== index) {
        throw contractError(fileName, location, `API notes for ${JSON.stringify(declaration.name)} do not describe a valid callback and void * context pair`);
      }
      if (type.lifetime === "escape") {
        const release = type.release ? parameters[type.release.parameter]?.type : null;
        if (release?.kind !== "callbackRelease" || release.callbackParameter !== index) {
          throw contractError(fileName, location, `API notes for ${JSON.stringify(declaration.name)} do not describe a valid escaping callback release pair`);
        }
      }
    }
    functions.set(declaration.name, {
      name: declaration.name,
      cName: declaration.nativeName,
      alternatives: declaration.alternatives.map((alternative) => ({
        cName: alternative.nativeName,
        cSignature: alternative.nativeSignature,
      })),
      returnType: mapper.mapType(declaration.returnType, functionNotes?.return, "return", pointerTypes, namedTypes),
      parameters,
      variadic: declaration.variadic,
      cSignature: declaration.nativeSignature,
      metadata: declaration.metadata,
    });
  }
  validateReleaseContracts(functions, fileName, location);
  return { functions, pointerTypes };
}

function validateNoteTargets(
  declarations: ReadonlyMap<string, ForeignFunctionDeclaration>,
  notes: ApiNotes,
  fileName: string,
  location: SourceLocation,
): void {
  for (const [name, note] of Object.entries(notes.functions ?? {})) {
    const declaration = declarations.get(name);
    if (!declaration) {
      throw contractError(fileName, location, `API notes name unknown foreign function ${JSON.stringify(name)}`);
    }
    for (const indexText of Object.keys(note.parameters ?? {})) {
      const index = Number(indexText);
      if (!/^(?:0|[1-9][0-9]*)$/.test(indexText) || index >= declaration.parameters.length) {
        throw contractError(fileName, location, `API notes for ${JSON.stringify(name)} name missing parameter ${JSON.stringify(indexText)}`);
      }
    }
  }
}

function validateCallbackContract(
  declaration: ForeignFunctionDeclaration,
  callbackParameter: number,
  callback: NonNullable<PointerNote["callback"]>,
  callbackContexts: Map<number, number>,
  callbackReleases: Map<number, { callbackParameter: number; releaseContextParameter: number }>,
  fileName: string,
  location: SourceLocation,
): void {
  if (callback.lifetime === "escape" && (!callback.context || !callback.release || callback.thread !== "caller")) {
    throw new DiagnosticError(
      fileName,
      location,
      `escaping callback API notes for ${JSON.stringify(declaration.name)} require caller-thread context and release contracts`,
      {
        code: "Z0214",
        helps: ["declare thread: caller plus valid context and release parameter pairs, or keep the callback call-only"],
      },
    );
  }
  if (callback.lifetime !== "escape" && (callback.release || callback.thread)) {
    throw contractError(fileName, location, `call-only callback API notes for ${JSON.stringify(declaration.name)} cannot declare escape release or threading contracts`);
  }
  const context = callback.context;
  if (!context) return;
  if (
    !Number.isInteger(context.parameter)
    || !Number.isInteger(context.callbackParameter)
    || context.parameter! < 0
    || context.parameter! >= declaration.parameters.length
    || context.callbackParameter! < 0
  ) {
    throw contractError(fileName, location, `API notes for ${JSON.stringify(declaration.name)} contain an invalid callback context pair`);
  }
  if (context.parameter === callbackParameter) {
    throw contractError(fileName, location, `API notes for ${JSON.stringify(declaration.name)} cannot use the callback parameter as its own context parameter`);
  }
  if (callbackContexts.has(context.parameter!)) {
    throw contractError(fileName, location, `API notes for ${JSON.stringify(declaration.name)} pair context parameter ${context.parameter} more than once`);
  }
  callbackContexts.set(context.parameter!, callbackParameter);
  const release = callback.release;
  if (!release) return;
  if (
    !Number.isInteger(release.parameter)
    || !Number.isInteger(release.callbackParameter)
    || release.parameter! < 0
    || release.parameter! >= declaration.parameters.length
    || release.callbackParameter! < 0
    || release.parameter === callbackParameter
    || release.parameter === context.parameter
    || callbackReleases.has(release.parameter!)
  ) {
    throw contractError(fileName, location, `API notes for ${JSON.stringify(declaration.name)} contain an invalid callback release pair`);
  }
  callbackReleases.set(release.parameter!, {
    callbackParameter,
    releaseContextParameter: release.callbackParameter!,
  });
}

function validateReleaseContracts(
  functions: ReadonlyMap<string, ForeignFunction>,
  fileName: string,
  location: SourceLocation,
): void {
  for (const target of functions.values()) {
    if (target.returnType.kind !== "pointer" || target.returnType.ownership !== "owned") continue;
    const release = target.returnType.release ? functions.get(target.returnType.release) : null;
    const released = release?.parameters[0]?.type;
    const validRelease = release
      && release.parameters.length === 1
      && released?.kind === "pointer"
      && released.ownership === "consuming"
      && released.identity === target.returnType.identity;
    if (!validRelease) {
      throw contractError(
        fileName,
        location,
        `API notes for ${JSON.stringify(target.name)} require ${JSON.stringify(target.returnType.release)} to consume exactly one ${target.returnType.cName}`,
      );
    }
  }
}

function contractError(fileName: string, location: SourceLocation, message: string): DiagnosticError {
  return new DiagnosticError(fileName, location, message, { code: "Z0801" });
}
