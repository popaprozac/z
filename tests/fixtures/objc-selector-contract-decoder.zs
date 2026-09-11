import fs from "std/fs";
import process from "std/process";
import console from "std/console";
import { decodeRawForeignDeclarations } from "../../compiler/frontend/foreign-declaration-protocol.zs";
import { normalizeForeignContracts, parseForeignContracts } from "../../compiler/frontend/foreign-contracts.zs";

function inspect(in wirePath: String, in contractPath: String): i32 throws String {
  const wire = try fs.readText(wirePath);
  const source = try fs.readText(contractPath);
  const raw = try decodeRawForeignDeclarations(wire);
  const contract = try parseForeignContracts(source, contractPath);
  const normalized = try normalizeForeignContracts(contract, raw, "objc-selector.h");
  let count: usize = 0;
  for (const object of normalized.objectiveCInterfaces) {
    for (const method of object.methods) {
      for (const callback of method.selectorCallbacks) {
        if (!method.representable) throw "checked selector registration was not exposed to call-site validation";
        if (callback.selectorParameter != 1 || callback.targetParameter != 0) throw "lost target/selector pairing";
        if (callback.signature.executorAffinity != "thread.main") throw "lost callback affinity";
        if (method.executorAffinity.byteLength != 0) throw "callback affinity changed registration affinity";
        console.log(`${callback.signature.returnType} ${callback.nativeReturnType} ${callback.cardinality}`);
        let index: usize = 0;
        for (const parameter of callback.signature.parameterTypes) {
          console.log(`${callback.signature.parameterModes[index]} ${parameter} ${callback.nativeParameterTypes[index]}`);
          index = index + 1;
        }
        count = count + 1;
      }
    }
  }
  if (count != 1) throw `expected one selector contract, found ${count}`;
  return 0;
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length != 2) return 2;
  return match (attempt inspect(arguments[0], arguments[1])) {
    success(value) => value;
    failure(error) => { console.error(error); select 1; }
  };
}
