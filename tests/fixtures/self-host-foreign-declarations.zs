import fs from "std/fs";
import process from "std/process";
import {
  decodeRawForeignDeclarations,
} from "../../compiler/frontend/foreign-declaration-protocol.zs";

function inspect(in path: String): i32 throws String {
  const encoded = try fs.readText(path);
  const module = try decodeRawForeignDeclarations(encoded);
  if (module.version != 8) return 10;
  if (module.producer != "clang") return 11;
  if (module.objectiveC || module.cPlusPlus) return 12;
  if (module.functions.length != 1) return 13;
  if (module.overloads.length != 1) return 14;
  if (module.parameters.length != 2) return 15;
  if (module.availability.length != 1) return 16;
  if (module.namespaces.length != 1) return 17;
  if (module.namespaces[0] != "math") return 18;
  if (module.types.length != 1) return 34;
  if (module.types[0].kind != "record") return 35;
  if (module.types[0].exportName != "WirePoint") return 36;
  if (module.types[0].layout != "struct") return 37;
  if (module.types[0].fieldCount != 2) return 38;
  match (in module.types[0].canonicalNativeName) {
    some(name) => {
      if (name != "WirePoint") return 85;
    }
    none => return 86;
  }
  if (module.fields.length != 2) return 39;
  if (module.fields[0].name != "x") return 82;
  if (module.fields[0].typeName != "int") return 83;
  if (module.fields[1].name != "y") return 84;
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
  if (module.version != 8) return 40;
  if (module.producer != "clang") return 41;
  if (module.objectiveC || module.cPlusPlus) return 42;
  if (module.types.length != 1) return 67;
  if (module.types[0].kind != "enum") return 68;
  if (module.types[0].exportName != "ZForeignStatus") return 69;
  if (module.types[0].nativeName != "ZForeignStatus") return 70;
  if (module.types[0].underlyingType != "i32") return 71;
  if (module.fields.length != 0) return 81;
  if (module.functions.length != 6) return 43;
  if (module.constants.length != 5) return 60;
  if (module.constants[0].name != "Z_FOREIGN_ENUM_OK") return 61;
  if (module.constants[0].typeName != module.types[0].typeName) return 62;
  if (module.constants[0].sourceKind != "enum") return 63;
  if (module.constants[1].name != "Z_FOREIGN_ENUM_FAILED") return 64;
  if (module.constants[2].name != "Z_FOREIGN_OK") return 65;
  if (module.constants[2].typeName != "i32") return 66;
  if (module.constants[3].name != "Z_FOREIGN_RETRY") return 72;
  if (module.constants[4].name != "Z_FOREIGN_UNSIGNED") return 73;
  if (module.constants[4].typeName != "u32") return 74;
  if (module.overloads.length != 6) return 44;
  if (module.parameters.length != 8) return 45;
  if (module.availability.length != 0) return 46;
  if (module.functions[0].name != "z_foreign_add") return 47;
  if (module.functions[1].name != "z_foreign_status") return 48;
  if (module.functions[2].name != "z_foreign_enum_status") return 49;
  if (module.functions[3].name != "z_foreign_status_code") return 75;
  if (module.functions[4].name != "z_foreign_text_length") return 78;
  if (module.functions[5].name != "z_foreign_measure") return 82;
  if (module.overloads[0].returnNativeType != "int") return 50;
  if (module.overloads[1].returnNativeType != "int") return 51;
  if (module.overloads[2].returnNativeType != "ZForeignStatus") return 52;
  if (module.overloads[3].returnNativeType != "int") return 76;
  if (module.overloads[4].returnNativeType != "int") return 79;
  if (module.overloads[5].returnNativeType != "long") return 83;
  if (module.parameters[0].nativeType != "int") return 53;
  if (module.parameters[1].nativeType != "int") return 54;
  if (module.parameters[2].nativeType != "int") return 55;
  if (module.parameters[3].nativeType != "int") return 56;
  if (module.parameters[4].nativeType != "ZForeignStatus") return 57;
  if (module.parameters[5].nativeType != "const char *") return 77;
  if (module.parameters[6].nativeType != "int") return 80;
  if (module.parameters[7].nativeType != "const char *") return 84;
  match (in module.overloads[0].sourceFile) {
    some(path) => {
      if (path.byteLength == 0) return 58;
    }
    none => return 59;
  }
  return 0;
}

function inspectObjC(in path: String): i32 throws String {
  const encoded = try fs.readText(path);
  const module = try decodeRawForeignDeclarations(encoded);
  if (module.version != 8) return 90;
  if (!module.objectiveC || module.cPlusPlus) return 91;

  let foundProtocol = false;
  for (const protocol of module.objectiveCProtocols) {
    if (protocol.protocolName == "ZRegistrationHandler") {
      foundProtocol = true;
      if (protocol.methodCount != 1) return 92;
      if (protocol.inheritedCount != 1) return 102;
      if (
        module.objectiveCProtocolInheritance[protocol.inheritedStart]
          != "ZBaseHandler"
      ) return 103;
      const method = view module.objectiveCMethods[protocol.methodStart];
      if (method.ownerKind != "protocol") return 93;
      if (method.selector != "registrationOwner:didReceiveValue:") return 94;
      if (!method.required || !method.instance) return 95;
    }
  }
  if (!foundProtocol) return 96;

  let foundOwner = false;
  let foundRegistration = false;
  for (const interface_ of module.objectiveCInterfaces) {
    if (interface_.className == "ZRegistrationOwner") {
      foundOwner = true;
      let methodIndex: usize = 0;
      while (methodIndex < interface_.methodCount) {
        const method = view module.objectiveCMethods[
          interface_.methodStart + methodIndex
        ];
        if (method.selector == "addHandler:name:") {
          foundRegistration = true;
          if (method.parameterCount != 2) return 97;
          const handler = view module.objectiveCParameters[
            method.parameterStart
          ];
          if (handler.nativeType != "id") return 98;
          if (handler.protocolCount != 1) return 99;
          if (
            module.objectiveCParameterProtocols[handler.protocolStart]
              != "ZRegistrationHandler"
          ) return 100;
        }
        methodIndex = methodIndex + 1;
      }
    }
  }
  if (!foundOwner || !foundRegistration) return 101;
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
  if (arguments.length == 2 && arguments[1] == "objc") {
    const outcome = attempt inspectObjC(arguments[0]);
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
