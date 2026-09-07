import { delay } from "std/time";
import { Generator } from "std/iteration";

struct Sample {
  signed: i32;
  z_signed: i32;
}

function values(): Generator<Sample> {
  yield Sample({ signed: 20, z_signed: 1 });
  yield Sample({ signed: 21, z_signed: 0 });
}

function generatedTotal(): i32 {
  const selected = Option<Sample>.some(Sample({ signed: 42, z_signed: 0 }));
  const matched = match (in selected) {
    some({ signed: number }) => number;
    none => 0;
  };
  if (matched != 42) return 0;
  let total = 0;
  for (const { signed: number, z_signed: extra } of values()) {
    total = total + number + extra;
  }
  return total;
}

async function calculate(): i32 {
  let sample = Sample({ signed: 20, z_signed: 1 });
  await delay(1);
  sample.signed = sample.signed + sample.z_signed;
  const rows = Array<Sample>(sample);
  let total = 0;
  for (const { signed: number, z_signed: extra } of rows) {
    total = total + number + extra;
  }
  return total;
}

async function main(): i32 {
  const total = await calculate();
  if (total != 22 || generatedTotal() != 42) return 1;
  return 0;
}
