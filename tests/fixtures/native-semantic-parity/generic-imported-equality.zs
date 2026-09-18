import console from "std/console";
import { forwarded, Checker, MethodChecker } from "./generic-equality-library.zs";

enum Kind { first, second, }

function main(): i32 {
  const same = Array<Kind>(Kind.first);
  const different = Array<Kind>(Kind.second);
  if (!forwarded<Kind>(same, same) || forwarded<Kind>(same, different)) return 1;
  const checker = Checker<Kind>();
  if (!checker.same(same, same) || checker.same(same, different)) return 2;
  const method = MethodChecker();
  if (method.different<Kind>(same, same) || !method.different<Kind>(same, different)) return 3;
  console.log("ok");
  return 0;
}
