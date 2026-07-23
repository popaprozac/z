import console from "std/console";
import { Generator } from "std/iteration";

struct ScanSummary {
  values: i32;
  total: i32;
}

function scanValues(count: i32): Generator<i32, ScanSummary> {
  let current = 1;
  let total = 0;

  while (current <= count) {
    total = total + current;
    yield current;
    current = current + 1;
  }

  return ScanSummary({
    values: count,
    total,
  });
}

function main(): i32 {
  const scanner = scanValues(3);
  let running = true;
  let observedTotal = 0;

  while (running) {
    const step = scanner.next();
    match (step) {
      yielded(value) => console.log(`value ${value}`);
      complete(summary) => {
        observedTotal = summary.total;
        console.log(`complete count=${summary.values} total=${summary.total}`);
        running = false;
      }
    }
  }

  return observedTotal - 6;
}
