import { replace } from "std/memory";
import console from "std/console";

struct Session {
  name: String;

  deinit {
    console.log(`closed ${this.name}`);
  }
}

function main(): i32 {
  let active = Session({ name: "draft" });
  const ready = Session({ name: "published" });

  // The target stays initialized while the displaced owner is returned.
  const previous = replace(inout active, move ready);
  console.log(`replaced ${previous.name} with ${active.name}`);
  return 0;
}
