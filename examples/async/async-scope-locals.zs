import console from "std/console";
import { delay } from "std/time";

struct Report {
  value: i32;

  deinit {
    console.log(`released report ${this.value}`);
  }
}

async function inspectAfter(in report: Report): i32 {
  await delay(1);
  return report.value;
}

async function main(): i32 {
  let observed = 0;

  async scope {
    const report = Report({ value: 42 });
    const inspection = task inspectAfter(report);
    observed = await inspection;
    console.log(`observed report ${observed}`);
  }

  console.log("scope closed");
  return observed - 42;
}
