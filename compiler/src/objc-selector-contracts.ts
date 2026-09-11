import type { SourceLocation } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { ForeignCallbackContract, ForeignFunctionContract } from "./foreign-declarations.ts";
import type { ForeignNamedType, ForeignObjCInterface, ForeignObjCMethod, ForeignObjCSelectorContract, ForeignType } from "./foreign-ir.ts";

const scalarABI = new Map<string, string>([
  ["boolean", "bool"], ["i8", "int8_t"], ["u8", "uint8_t"],
  ["i16", "int16_t"], ["u16", "uint16_t"], ["i32", "int32_t"], ["u32", "uint32_t"],
  ["i64", "int64_t"], ["u64", "uint64_t"], ["isize", "intptr_t"], ["usize", "uintptr_t"],
  ["f32", "float"], ["f64", "double"], ["void", "void"],
]);

export function validateSelectorContract(
  declaration: ForeignFunctionContract,
  method: ForeignObjCMethod,
  callback: ForeignCallbackContract,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  interfaces: ReadonlyMap<string, ForeignObjCInterface>,
  fileName: string,
): ForeignObjCSelectorContract {
  const reject = (location: SourceLocation, message: string): never => {
    throw new DiagnosticError(fileName, location, message, { code: "Z0801" });
  };
  const selectorParameter = declaration.parameters.findIndex((parameter) => parameter.name === callback.parameter);
  if (method.parameters[selectorParameter]?.type.kind !== "selector") {
    reject(callback.parameterLocation, `selector callback ${JSON.stringify(callback.parameter)} requires a native SEL parameter`);
  }
  if (!callback.target || !callback.signature) {
    reject(callback.location, "a selector callback requires both target <parameter>; and an inline type (...) => ... on thread.main;");
  }
  if (callback.context || callback.contextOption || callback.release || callback.owner || callback.nativeType
    || callback.bytes || callback.failure !== null || callback.thread || declaration.asyncCallback) {
    reject(callback.location, "a selector callback cannot mix target/type with context, owner, deinit, project, failure, thread, or async projection facts; delivery is chosen by native registration");
  }
  if (declaration.returnNullable || declaration.resultOwnership || declaration.resultBorrowedFrom || declaration.invalidates.length) {
    reject(declaration.returnLocation, "selector callback registration cannot also project result ownership, nullability, or invalidation in this tier");
  }
  const targetParameter = declaration.parameters.findIndex((parameter) => parameter.name === callback.target);
  if (targetParameter < 0) reject(callback.targetLocation!, `selector callback names unknown target parameter ${JSON.stringify(callback.target)}`);
  if (targetParameter === selectorParameter || method.parameters[targetParameter].type.kind !== "object") {
    reject(callback.targetLocation!, `selector target ${JSON.stringify(callback.target)} must be an Objective-C object parameter`);
  }
  for (const index of [targetParameter, selectorParameter]) {
    const parameter = declaration.parameters[index];
    if (parameter.mode !== "value" || parameter.nullable || parameter.nullOnly || parameter.fixed || parameter.release || parameter.explicitType
      || method.consumedParameters?.includes(index)) {
      reject(parameter.location, "selector registration requires ordinary target and SEL parameters, without consuming, nullable, fixed, or release projections");
    }
  }
  const typeFor = (name: string, location: SourceLocation, result: boolean): ForeignType => {
    const scalar = scalarABI.get(name);
    if (scalar && (result || name !== "void")) return { kind: "z", name: name as Extract<ForeignType, { kind: "z" }>["name"], cName: scalar };
    const object = interfaces.get(name);
    if (object && !result) return { kind: "object", typeName: object.typeName, className: object.className, cName: `${object.className} *`, nullable: false };
    const named = namedTypes.get(name);
    if (named && (named.kind === "enum" || named.kind === "scalar")) {
      return { kind: "named", type: named, cName: named.cName };
    }
    return reject(location, `unsupported selector callback ${result ? "return" : "parameter"} type ${JSON.stringify(name)}; use scalars or native enums${result ? ", or void" : ", or an in borrowed imported Objective-C object"}`);
  };
  const parameters = callback.signature.parameters.map((parameter) => {
    const type = typeFor(parameter.typeName, parameter.typeLocation, false);
    if ((type.kind === "object") !== (parameter.mode === "in")) {
      reject(parameter.location, `selector callback parameter ${JSON.stringify(parameter.name)} requires ${type.kind === "object" ? "in for a borrowed Objective-C object" : "value passing for a scalar or native value"}`);
    }
    return { name: parameter.name, mode: parameter.mode, type };
  });
  return { selectorParameter, targetParameter, parameters,
    returnType: typeFor(callback.signature.returnType, callback.signature.returnLocation, true),
    executorAffinity: "main", cardinality: callback.cardinality };
}
