import { Program } from "./parser.zs";
import {
  ModuleFunctionSignature,
  ModuleTypeParameterConstraint,
} from "./semantic-model.zs";

export struct NativeStandardCallShape {
  name: String;
  signature: ModuleFunctionSignature;
}

function standardSignature(
  parameterModes: Array<String>,
  parameterTypes: Array<String>,
  in returnType: String,
  in errorType: String
): ModuleFunctionSignature {
  return ModuleFunctionSignature({
    asynchronous: false,
    executorAffinity: "",
    threadContract: "",
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    parameterModes,
    parameterTypes,
    viewParameter: Option<usize>.none,
    invalidatesParameters: Array<usize>(),
    invalidatesLifetimes: Array<String>(),
    returnType: returnType.copyBytes(0, returnType.byteLength),
    errorType: errorType.copyBytes(0, errorType.byteLength),
  });
}

function namespaceHeader(
  in program: Program,
  in namespaceName: String
): String {
  for (const declaration of program.imports) {
    if (
      !declaration.selective
      && declaration.moduleName == namespaceName
    ) return declaration.header.copyBytes(
      0,
      declaration.header.byteLength
    );
  }
  return "";
}

function fsCall(in memberName: String): Option<NativeStandardCallShape> {
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  if (memberName == "lock") {
    parameterModes.push("in");
    parameterTypes.push("String");
    return Option.some(NativeStandardCallShape({
      name: "fs.lock",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "fs.Lock",
        "String"
      ),
    }));
  }
  if (memberName == "readBytes") {
    parameterModes.push("in");
    parameterTypes.push("String");
    return Option.some(NativeStandardCallShape({
      name: "fs.readBytes",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "Array<u8>",
        "String"
      ),
    }));
  }
  if (memberName == "readText") {
    parameterModes.push("in");
    parameterTypes.push("String");
    return Option.some(NativeStandardCallShape({
      name: "fs.readText",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "String",
        "String"
      ),
    }));
  }
  if (memberName == "writeText") {
    parameterModes.push("in");
    parameterTypes.push("String");
    parameterModes.push("in");
    parameterTypes.push("String");
    return Option.some(NativeStandardCallShape({
      name: "fs.writeText",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "void",
        "String"
      ),
    }));
  }
  if (memberName == "writeBytes") {
    parameterModes.push("in");
    parameterTypes.push("String");
    parameterModes.push("in");
    parameterTypes.push("Array<u8>");
    return Option.some(NativeStandardCallShape({
      name: "fs.writeBytes",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "void",
        "String"
      ),
    }));
  }
  if (memberName == "replace") {
    parameterModes.push("in");
    parameterTypes.push("String");
    parameterModes.push("in");
    parameterTypes.push("String");
    return Option.some(NativeStandardCallShape({
      name: "fs.replace",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "void",
        "String"
      ),
    }));
  }
  if (memberName == "exists") {
    parameterModes.push("in");
    parameterTypes.push("String");
    return Option.some(NativeStandardCallShape({
      name: "fs.exists",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "boolean",
        ""
      ),
    }));
  }
  if (memberName == "isDirectory") {
    parameterModes.push("in");
    parameterTypes.push("String");
    return Option.some(NativeStandardCallShape({
      name: "fs.isDirectory",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "boolean",
        ""
      ),
    }));
  }
  if (memberName == "createDirectories") {
    parameterModes.push("in");
    parameterTypes.push("String");
    return Option.some(NativeStandardCallShape({
      name: "fs.createDirectories",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "void",
        "String"
      ),
    }));
  }
  if (memberName == "realPath") {
    parameterModes.push("in");
    parameterTypes.push("String");
    return Option.some(NativeStandardCallShape({
      name: "fs.realPath",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "String",
        "String"
      ),
    }));
  }
  return Option<NativeStandardCallShape>.none;
}

function processCall(in memberName: String): Option<NativeStandardCallShape> {
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  if (memberName == "args") {
    return Option.some(NativeStandardCallShape({
      name: "process.args",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "Array<String>",
        ""
      ),
    }));
  }
  if (memberName == "executablePath") {
    return Option.some(NativeStandardCallShape({
      name: "process.executablePath",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "String",
        "String"
      ),
    }));
  }
  if (memberName == "run") {
    parameterModes.push("in");
    parameterTypes.push("String");
    parameterModes.push("value");
    parameterTypes.push("Slice<String>");
    return Option.some(NativeStandardCallShape({
      name: "process.run",
      signature: standardSignature(
        move parameterModes,
        move parameterTypes,
        "i32",
        "String"
      ),
    }));
  }
  return Option<NativeStandardCallShape>.none;
}

// Each argument is borrowed for the call and keeps its own type, which the
// resolver then checks is a number, a boolean, or a String.
function consoleCall(
  in memberName: String,
  argumentCount: usize
): Option<NativeStandardCallShape> {
  if (
    memberName != "log"
    && memberName != "write"
    && memberName != "error"
    && memberName != "debug"
  ) return Option<NativeStandardCallShape>.none;
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  let typeParameters = Array<String>();
  let argument: usize = 0;
  while (argument < argumentCount) {
    parameterModes.push("in");
    parameterTypes.push(`__z_console_${argument}`);
    typeParameters.push(`__z_console_${argument}`);
    argument = argument + 1;
  }
  let signature = standardSignature(
    move parameterModes,
    move parameterTypes,
    "void",
    ""
  );
  signature.typeParameters = move typeParameters;
  return Option.some(NativeStandardCallShape({
    name: `console.${memberName}`,
    signature: move signature,
  }));
}

function embedCall(
  in memberName: String,
  argumentCount: usize
): Option<NativeStandardCallShape> {
  if (memberName != "bytes" || argumentCount != 1) {
    return Option<NativeStandardCallShape>.none;
  }
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  parameterModes.push("value");
  parameterTypes.push("String");
  return Option.some(NativeStandardCallShape({
    name: "embed.bytes",
    signature: standardSignature(
      move parameterModes,
      move parameterTypes,
      "embed.StaticBytes",
      ""
    ),
  }));
}

function mathCall(
  in memberName: String,
  in argumentType: String,
  argumentCount: usize
): Option<NativeStandardCallShape> {
  if (
    memberName != "trunc"
    || argumentCount != 1
    || (argumentType != "f32" && argumentType != "f64")
  ) return Option<NativeStandardCallShape>.none;
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  parameterModes.push("value");
  parameterTypes.push(argumentType.copyBytes(0, argumentType.byteLength));
  return Option.some(NativeStandardCallShape({
    name: argumentType == "f32" ? "math.trunc.f32" : "math.trunc.f64",
    signature: standardSignature(
      move parameterModes,
      move parameterTypes,
      argumentType,
      ""
    ),
  }));
}

export function nativeStandardCall(
  in program: Program,
  in namespaceName: String,
  in memberName: String,
  argumentCount: usize,
  in argumentType: String
): Option<NativeStandardCallShape> {
  if (namespaceName == "String" && memberName == "fromBytes") {
    return Option.some(NativeStandardCallShape({
      name: "String.fromBytes",
      signature: standardSignature(Array<String>("value"), Array<String>("Slice<u8>"),
        "String", "__z_std_text_Utf8Error"),
    }));
  }
  const header = namespaceHeader(program, namespaceName);
  if (header == "std/fs") return fsCall(memberName);
  if (header == "std/process") return processCall(memberName);
  if (header == "std/embed") return embedCall(memberName, argumentCount);
  if (header == "std/math") {
    return mathCall(memberName, argumentType, argumentCount);
  }
  if (header == "std/console") return consoleCall(memberName, argumentCount);
  return Option<NativeStandardCallShape>.none;
}
