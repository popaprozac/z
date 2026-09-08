import console from "std/console";

struct Guard {
  name: String;
  deinit { console.log(`released ${this.name}`); }
}

function main(): i32 {
  const end = Option<i32>.none;
  while (true) {
    const guard = Guard({ name: "while" });
    match (end) {
      some(value) => return value;
      none => break;
    }
  }
  const values = [1, 2, 3];
  for (const value of values) {
    const guard = Guard({ name: "for" });
    match (end) {
      some(_) => return value;
      none => break;
    }
  }
  let rounds = 0;
  while (rounds < 2) {
    while (true) {
      match (end) { some(_) => return 3; none => break; }
    }
    rounds = rounds + 1;
    match (end) { some(_) => return 5; none => continue; }
  }
  return rounds - 2;
}
