import console from "std/console";

function main(): i32 {
  const values = [1, 3, 4, 8];

  const firstEven: Option<i32> = for (const value of values) {
    if (value % 2 == 0) {
      select Option.some(value);
    }
  } else {
    select Option.none;
  };

  let attempts = 0;
  const status = while (attempts < 3) {
    attempts = attempts + 1;
    if (attempts == 2) {
      select "ready";
    }
  } else {
    select "exhausted";
  };

  const found = match (firstEven) {
    some(value) => value;
    none => 0;
  };
  console.log(`${status}: ${found}`);
  return found == 4 ? 0 : 1;
}
