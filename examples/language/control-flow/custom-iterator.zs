import console from "std/console";
import { Iterator } from "std/iteration";

struct Countdown implements Iterator<i32> {
  current: i32;

  function next(inout this): Option<i32> {
    if (this.current == 0) {
      return Option.none;
    }
    const value = this.current;
    this.current = this.current - 1;
    return Option.some(value);
  }
}

function main(): i32 {
  let countdown = Countdown({ current: 3 });
  let total = 0;

  for (const value of inout countdown) {
    console.log(`countdown: ${value}`);
    total = total + value;
  }

  for (const value of Countdown({ current: 2 })) {
    total = total + value;
  }

  return total == 9 ? 0 : 1;
}
