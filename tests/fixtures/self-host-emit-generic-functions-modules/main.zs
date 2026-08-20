import { preserve as keep, libraryValue } from "./library.zs";
import { secondValue } from "./second.zs";

function main(): i32 {
  const value = keep<String>("module");
  if (value != "module") return 1;
  return libraryValue() + secondValue() - 42;
}
