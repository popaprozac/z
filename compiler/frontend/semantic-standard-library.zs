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
    typeParameters: Array<String>(),
    typeParameterConstraints: Array<ModuleTypeParameterConstraint>(),
    parameterModes,
    parameterTypes,
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

function consoleCall(
  in memberName: String
): Option<NativeStandardCallShape> {
  if (
    memberName != "log"
    && memberName != "write"
    && memberName != "error"
    && memberName != "debug"
  ) return Option<NativeStandardCallShape>.none;
  let parameterModes = Array<String>();
  let parameterTypes = Array<String>();
  parameterModes.push("in");
  parameterTypes.push("String");
  return Option.some(NativeStandardCallShape({
    name: `console.${memberName}`,
    signature: standardSignature(
      move parameterModes,
      move parameterTypes,
      "void",
      ""
    ),
  }));
}

export function nativeStandardCall(
  in program: Program,
  in namespaceName: String,
  in memberName: String,
  argumentCount: usize,
  stringArgumentSyntax: boolean
): Option<NativeStandardCallShape> {
  const header = namespaceHeader(program, namespaceName);
  if (header == "std/fs") return fsCall(memberName);
  if (header == "std/process") return processCall(memberName);
  if (
    header == "std/console"
    && argumentCount == 1
    && stringArgumentSyntax
  ) return consoleCall(memberName);
  return Option<NativeStandardCallShape>.none;
}
