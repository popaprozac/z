import fs from "std/fs";
import process from "std/process";
import {
  decodeRawForeignDeclarations,
} from "../../compiler/frontend/foreign-declaration-protocol.zs";

function inspect(in path: String): i32 throws String {
  const encoded = try fs.readText(path);
  const module = try decodeRawForeignDeclarations(encoded);
  if (module.version != 1) return 10;
  if (module.producer != "clang") return 11;
  if (module.objectiveC || module.cPlusPlus) return 12;
  if (module.functions.length != 1) return 13;
  if (module.overloads.length != 1) return 14;
  if (module.parameters.length != 2) return 15;
  if (module.availability.length != 1) return 16;
  if (module.namespaces.length != 1) return 17;
  if (module.namespaces[0] != "math") return 18;
  if (module.functions[0].name != "measureπ") return 19;
  if (module.functions[0].qualifiedName != "math.measureπ") return 20;
  if (module.overloads[0].nativeName != "math::measure_pi") return 21;
  if (module.overloads[0].returnNativeType != "long") return 22;
  if (module.overloads[0].nativeSignature != "long (int, const char *)") {
    return 23;
  }
  match (in module.overloads[0].returnCanonicalNativeType) {
    some(name) => {
      if (name != "long") return 24;
    }
    none => return 25;
  }
  match (in module.parameters[0].name) {
    some(name) => {
      if (name != "value") return 26;
    }
    none => return 27;
  }
  if (module.parameters[1].nativeType != "const char *") return 28;
  match (in module.availability[0].platform) {
    some(platform) => {
      if (platform != "macos") return 29;
    }
    none => return 30;
  }
  match (in module.availability[0].introduced) {
    some(version) => {
      if (version != "14.0") return 31;
    }
    none => return 32;
  }
  if (!module.availability[0].deprecated) return 33;
  return 0;
}

function inspectClang(in path: String): i32 throws String {
  const encoded = try fs.readText(path);
  const module = try decodeRawForeignDeclarations(encoded);
  if (module.version != 1) return 40;
  if (module.producer != "clang") return 41;
  if (module.objectiveC || module.cPlusPlus) return 42;
  if (module.functions.length != 2) return 43;
  if (module.overloads.length != 2) return 44;
  if (module.parameters.length != 4) return 45;
  if (module.availability.length != 0) return 46;
  if (module.functions[0].name != "z_foreign_add") return 47;
  if (module.functions[1].name != "z_foreign_measure") return 48;
  if (module.overloads[0].returnNativeType != "int") return 49;
  if (module.overloads[1].returnNativeType != "long") return 50;
  if (module.parameters[0].nativeType != "int") return 51;
  if (module.parameters[1].nativeType != "int") return 52;
  if (module.parameters[2].nativeType != "int") return 53;
  if (module.parameters[3].nativeType != "const char *") return 54;
  match (in module.overloads[0].sourceFile) {
    some(path) => {
      if (path.byteLength == 0) return 55;
    }
    none => return 56;
  }
  return 0;
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length < 1 || arguments.length > 2) return 2;
  if (arguments.length == 2 && arguments[1] == "clang") {
    const outcome = attempt inspectClang(arguments[0]);
    return match (outcome) {
      success(code) => code;
      failure(_) => 3;
    };
  }
  const outcome = attempt inspect(arguments[0]);
  return match (outcome) {
    success(code) => code;
    failure(_) => 3;
  };
}
