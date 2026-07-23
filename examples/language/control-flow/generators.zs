import console from "std/console";
import { Generator } from "std/iteration";

function noteIdentifiers(count: i32): Generator<i32> {
  console.log("generator started");
  let identifier = 1;

  while (identifier <= count) {
    yield identifier;
    identifier = identifier + 1;
  }
}

function main(): i32 {
  const identifiers = noteIdentifiers(3);
  console.log("generator created");

  for (const identifier of identifiers) {
    console.log(`note ${identifier}`);
  }

  return 0;
}
