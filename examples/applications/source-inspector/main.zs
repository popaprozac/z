import console from "std/console";
import fs from "std/fs";
import process from "std/process";
import { scanSource } from "./scanner.zs";

function inspectFile(in path: String): i32 throws String {
  const source = try fs.readText(path);
  const summary = try scanSource(source);
  console.log(`${path}: ${summary.lineCount} lines, ${summary.byteCount} UTF-8 bytes`);
  console.log(`${summary.tokenCount} tokens: ${summary.identifierCount} identifiers, ${summary.numberCount} numbers`);
  console.log(`${summary.stringCount} strings`);
  console.log(`first identifier: ${summary.firstIdentifier}`);
  return 0;
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length == 0) {
    console.error("usage: source-inspector <input.zs>");
    return 2;
  }

  const outcome = attempt inspectFile(arguments[0]);
  return match (outcome) {
    success(exitCode) => exitCode;
    failure(message) => {
      console.error(`could not inspect source: ${message}`);
      select 1;
    }
  };
}
