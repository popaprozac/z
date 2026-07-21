// Executable stage-one parser client. The protocol implementation is shared
// with the in-process library boundary.

import console from "std/console";
import fs from "std/fs";
import process from "std/process";
import { renderProgram } from "../../../compiler/frontend/parser-protocol.zs";

function streamProgram(in path: String): i32 throws String {
  const source = try fs.readText(path);
  const stream = try renderProgram(path, source);
  console.write(stream);
  return 0;
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length == 0) {
    console.error("usage: parser-stream <input.zs> [more.zs ...]");
    return 2;
  }

  for (const path of arguments) {
    const outcome = attempt streamProgram(path);
    const exitCode = match (outcome) {
      success(code) => code;
      failure(message) => {
        console.error(message);
        select 1;
      }
    };
    if (exitCode != 0) return exitCode;
  }
  return 0;
}
