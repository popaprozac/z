import { scheduler } from "std/async";

function persist(total: i32): void throws i32 {
  if (total != 42) throw total;
}

readonly class Source {
  async function value(input: i32): i32 {
    await scheduler.yield();
    return input;
  }
}

readonly class Calculator {
  async function total(source: Source): i32 {
    const first = await source.value(20);
    const second = await source.value(22);
    const values = Array<i32>(first, second);
    let total = 0;
    for (const value of values) {
      total = total + value;
    }
    const stored = attempt persist(total);
    return match (stored) {
      success => total;
      failure(_) => -1;
    };
  }
}

async function main(): i32 {
  const source = new Source({});
  const calculator = new Calculator({});
  const result = await calculator.total(source);
  return result == 42 ? 0 : 1;
}
