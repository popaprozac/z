import fs from "std/fs";
import process from "std/process";
import {
  decodeRawForeignDeclarations,
} from "../../compiler/frontend/foreign-declaration-protocol.zs";
import {
  normalizeForeignContracts,
  parseForeignContracts,
} from "../../compiler/frontend/foreign-contracts.zs";

function inspect(
  in declarationPath: String,
  in contractPath: String
): i32 throws String {
  const declarationSource = try fs.readText(declarationPath);
  const declarations = try decodeRawForeignDeclarations(declarationSource);
  const contractSource = try fs.readText(contractPath);
  const contracts = try parseForeignContracts(contractSource, contractPath);
  const normalized = try normalizeForeignContracts(
    contracts,
    declarations,
    "foreign-functions-only.h"
  );
  if (normalized.moduleSpecifier != "foreign-functions-only.h") return 10;
  if (normalized.functions.length != 1) return 11;
  if (normalized.functions[0].name != "z_foreign_add") return 12;
  if (normalized.functions[0].nativeName != "z_foreign_add") return 13;
  if (normalized.functions[0].returnType != "i32") return 14;
  if (normalized.functions[0].parameters.length != 2) return 15;
  if (normalized.functions[0].parameters[0].name != "left") return 16;
  if (normalized.functions[0].parameters[0].typeName != "i32") return 17;
  if (normalized.functions[0].parameters[1].name != "right") return 18;
  if (normalized.functions[0].parameters[1].typeName != "i32") return 19;
  return 0;
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length != 2) return 2;
  const outcome = attempt inspect(arguments[0], arguments[1]);
  return match (outcome) {
    success(code) => code;
    failure(_) => 3;
  };
}
