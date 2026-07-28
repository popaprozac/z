import fs from "std/fs";
import process from "std/process";

function main(): i32 {
  const arguments = process.args();
  if (arguments.length == 0) return 2;
  if (!fs.exists(arguments[0])) return 1;

  const outcome = attempt fs.readText(arguments[0]);
  return match (outcome) {
    success(_) => 0;
    failure(_) => 1;
  };
}
