import type { SourceLocation } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { ApiNotes, PointerNote } from "./foreign-api-notes.ts";
import type {
  ForeignCallbackContextType,
  ForeignCallbackReleaseType,
  ForeignFunction,
  ForeignFunctionDeclaration,
  ForeignFunctionOverload,
  ForeignFunctionOverloadDeclaration,
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
  readonly mapVariadicType: (type: "cstring" | "clong") => ForeignType;
  readonly mapVariadicCallback: (
    nativeType: string,
    nativeSignature: string,
    nativeParameterNames: readonly string[],
    bytes: {
      readonly name: string;
      readonly access: "in" | "inout";
      readonly bufferParameter: number;
      readonly lengthParameters: readonly number[];
    },
    failure: number | string | undefined,
  ) => ForeignType;
};

export type NormalizedForeignContracts = {
  readonly functions: ReadonlyMap<string, ForeignFunction>;
  readonly functionAliases: ReadonlyMap<string, string>;
  readonly namespaces: ReadonlySet<string>;
  readonly pointerTypes: ReadonlyMap<string, ForeignPointerType>;
};

type FunctionApiNote = NonNullable<ApiNotes["functions"]>[string];

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
  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  const pointerTypes = new Map<string, ForeignPointerType>();
  for (const declaration of declarations.values()) {
    const functionNotes = notes.functions?.[declaration.name];
    const overloads = functionNotes?.projections?.length
      ? declaration.overloads.flatMap((overload) => functionNotes.projections!.map((projection) => {
        const effectiveProjection: FunctionApiNote = {
          ...functionNotes,
          ...projection,
          return: {
            ...(functionNotes.return ?? {}),
            ...(projection.return ?? {}),
          },
          parameters: {
            ...(functionNotes.parameters ?? {}),
            ...(projection.parameters ?? {}),
          },
          status: projection.status ?? functionNotes.status,
          executorAffinity: projection.executorAffinity ?? functionNotes.executorAffinity,
        };
        const normalized = normalizeOverload(
          overload,
          effectiveProjection,
          namedTypes,
          mapper,
          pointerTypes,
          fileName,
          location,
        );
        return {
          ...normalized,
          parameters: [
            ...normalized.parameters.map((parameter, index) => ({
              ...parameter,
              ...(projection.literals[String(index)]
                ? { literal: projection.literals[String(index)] }
                : {}),
            })),
            ...projection.variadicParameters.map((parameter) => ({
              name: parameter.name,
              type: parameter.type === "callback"
                ? mapper.mapVariadicCallback(
                  parameter.callback!.nativeType,
                  parameter.callback!.nativeSignature,
                  parameter.callback!.nativeParameterNames,
                  parameter.callback!.bytes,
                  parameter.callback!.failure,
                )
                : mapper.mapVariadicType(parameter.type),
              ...(parameter.type === "clong" ? { abiCast: "long" } : {}),
            })),
          ],
          connection: projection.connection ?? null,
          variadic: false,
          cSignature: `${overload.nativeSignature} projected as (${[
            ...normalized.parameters.map((parameter, index) => (
              projection.literals[String(index)] ?? parameter.type.cName
            )),
            ...projection.variadicParameters.map((parameter) => (
              parameter.type === "callback" ? parameter.callback!.nativeType : parameter.type
            )),
          ].join(", ")})`,
        };
      }))
      : declaration.overloads.map((overload) => normalizeOverload(
        overload,
        functionNotes,
        namedTypes,
        mapper,
        pointerTypes,
        fileName,
        location,
      ));
    functions.set(declaration.qualifiedName, {
      name: declaration.name,
      namespacePath: declaration.namespacePath,
      qualifiedName: declaration.qualifiedName,
      overloads,
    });
    for (let depth = 1; depth <= declaration.namespacePath.length; depth += 1) {
      namespaces.add(declaration.namespacePath.slice(0, depth).join("."));
    }
  }
  const qualificationsByName = new Map<string, string[]>();
  for (const declaration of functions.values()) {
    const qualifications = qualificationsByName.get(declaration.name) ?? [];
    qualifications.push(declaration.qualifiedName);
    qualificationsByName.set(declaration.name, qualifications);
  }
  for (const [name, qualifications] of qualificationsByName) {
    if (qualifications.length === 1) aliases.set(name, qualifications[0]);
  }
  validateReleaseContracts(functions, aliases, fileName, location);
  return { functions, functionAliases: aliases, namespaces, pointerTypes };
}

function normalizeOverload(
  declaration: ForeignFunctionOverloadDeclaration,
  functionNotes: FunctionApiNote | undefined,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  mapper: ForeignContractTypeMapper,
  pointerTypes: Map<string, ForeignPointerType>,
  fileName: string,
  location: SourceLocation,
): ForeignFunctionOverload {
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
      if (type.context.parameter < 0) continue;
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
    const returnType = mapper.mapType(
      declaration.returnType,
      functionNotes?.return,
      "return",
      pointerTypes,
      namedTypes,
    );
    if (functionNotes?.status) {
      const statusType = returnType.kind === "z"
        ? returnType.name
        : returnType.kind === "named" && returnType.type.kind === "enum"
          ? returnType.type.underlying
          : null;
      if (
        !statusType
        || !["i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "isize", "usize"].includes(statusType)
      ) {
        throw contractError(
          fileName,
          location,
          `status projection for ${JSON.stringify(declaration.name)} requires an integer or integer-backed enum native return type`,
        );
      }
    }
    return {
      name: declaration.name,
      cName: declaration.nativeName,
      returnType,
      status: functionNotes?.status ?? null,
      parameters,
      connection: null,
      buffers: functionNotes?.buffers ?? [],
      variadic: declaration.variadic,
      cSignature: declaration.nativeSignature,
      metadata: {
        ...declaration.metadata,
        executorAffinity: functionNotes?.executorAffinity ?? declaration.metadata.executorAffinity,
      },
    };
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
    if (note.return?.thread && (note.return.ownership !== "owned" || !note.return.release)) {
      throw contractError(fileName, location, `result thread contract for ${JSON.stringify(name)} requires owned return and release facts`);
    }
    for (const indexText of Object.keys(note.parameters ?? {})) {
      const index = Number(indexText);
      if (
        !/^(?:0|[1-9][0-9]*)$/.test(indexText)
        || declaration.overloads.some((overload) => index >= overload.parameters.length)
      ) {
        throw contractError(fileName, location, `API notes for ${JSON.stringify(name)} name missing parameter ${JSON.stringify(indexText)}`);
      }
      if (note.parameters?.[indexText]?.thread) {
        throw contractError(fileName, location, `native thread contracts currently apply only to owned producer results, not parameter ${JSON.stringify(indexText)} of ${JSON.stringify(name)}`);
      }
    }
  }
}

function validateCallbackContract(
  declaration: ForeignFunctionOverloadDeclaration,
  callbackParameter: number,
  callback: NonNullable<PointerNote["callback"]>,
  callbackContexts: Map<number, number>,
  callbackReleases: Map<number, { callbackParameter: number; releaseContextParameter: number }>,
  fileName: string,
  location: SourceLocation,
): void {
  if (callback.lifetime === "escape" && (!callback.context || !callback.release || !callback.thread)) {
    throw new DiagnosticError(
      fileName,
      location,
      `escaping callback API notes for ${JSON.stringify(declaration.name)} require context, release, and thread contracts`,
      {
        code: "Z0214",
        helps: ["declare thread: caller or thread: any plus valid context and release parameter pairs, or keep the callback call-only"],
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
  aliases: ReadonlyMap<string, string>,
  fileName: string,
  location: SourceLocation,
): void {
  for (const target of functions.values()) {
    for (const overload of target.overloads) {
      if (overload.returnType.kind !== "pointer" || overload.returnType.ownership !== "owned") continue;
      const releaseName = overload.returnType.release;
      const releaseKey = releaseName ? aliases.get(releaseName) ?? releaseName : null;
      const release = releaseKey ? functions.get(releaseKey) : null;
      const validRelease = release?.overloads.some((candidate) => {
        const released = candidate.parameters[0]?.type;
        return candidate.parameters.length === 1
          && released?.kind === "pointer"
          && released.ownership === "consuming"
          && released.identity === overload.returnType.identity;
      }) ?? false;
      if (!validRelease) {
        throw contractError(
          fileName,
          location,
          `API notes for ${JSON.stringify(target.name)} require ${JSON.stringify(releaseName)} to consume exactly one ${overload.returnType.cName}`,
        );
      }
    }
  }
}

function contractError(fileName: string, location: SourceLocation, message: string): DiagnosticError {
  return new DiagnosticError(fileName, location, message, { code: "Z0801" });
}
