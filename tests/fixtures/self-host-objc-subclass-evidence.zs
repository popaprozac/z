import fs from "std/fs";
import process from "std/process";
import console from "std/console";
import { decodeRawForeignDeclarations } from "../../compiler/frontend/foreign-declaration-protocol.zs";

function inspect(in path: String): i32 throws String {
  const source = try fs.readText(path);
  const module = try decodeRawForeignDeclarations(source);
  if (module.version != 14) throw "wrong foreign protocol version";
  let foundBase = false;
  let foundFinal = false;
  let observed: usize = 0;
  for (const interface_ of module.objectiveCInterfaces) {
    if (interface_.className == "ZWireFinal") {
      foundFinal = true;
      if (!interface_.subclassingRestricted) throw "lost subclass restriction";
      match (in interface_.superName) {
        some(name) => { if (name != "ZWireBase") throw "wrong native superclass"; }
        none => throw "lost native superclass";
      }
    }
    if (interface_.className != "ZWireBase") continue;
    foundBase = true;
    if (interface_.subclassingRestricted) throw "invented subclass restriction";
    match (in interface_.executorAffinity) {
      some(executor) => { if (executor != "main") throw "wrong native affinity"; }
      none => throw "lost native affinity";
    }
    let index: usize = 0;
    while (index < interface_.methodCount) {
      const method = view module.objectiveCMethods[interface_.methodStart + index];
      const initializer = method.selector == "initWithValue:";
      if (method.designatedInitializer != initializer) throw "wrong designated initializer evidence";
      if (method.returnsInstanceType != initializer) throw "wrong instancetype evidence";
      if (method.requiresSuper != (method.selector == "requiredValue")) throw "wrong required-super evidence";
      if (method.direct != (method.selector == "directValue")) throw "wrong direct-dispatch evidence";
      // Clang also supplies consuming-self ownership for an ARC init-family method.
      if (method.consumesSelf != (initializer || method.selector == "consume")) throw "wrong consuming receiver evidence";
      if (method.variadic != (method.selector == "log:")) throw "wrong variadic evidence";
      let parameterIndex: usize = 0;
      while (parameterIndex < method.parameterCount) {
        const parameter = view module.objectiveCParameters[method.parameterStart + parameterIndex];
        const expected = method.selector == "takeIndex:object:" && parameterIndex == 1;
        if (parameter.consumed != expected) throw "wrong consuming parameter position";
        parameterIndex = parameterIndex + 1;
      }
      observed = observed + 1;
      index = index + 1;
    }
  }
  if (!foundBase || !foundFinal || observed != 7) throw "missing native subclass evidence";
  return 0;
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length != 1) return 2;
  return match (attempt inspect(arguments[0])) {
    success(code) => code;
    failure(error) => { console.log(error); select 1; }
  };
}
