import console from "std/console";

type Count = u32;

struct Holder {
  label: String;
  total: u64;
}

function show(in label: String, value: u32): void {
  console.log(label, value);
}

function main(): i32 {
  const seen: u32 = 4;
  const delta: i64 = -12;
  const ratio: f64 = 2.5;
  const small: f32 = 0.125;
  const done = true;
  const count: Count = 9;
  const name: String = "zjs";
  const holder = Holder({ label: "box", total: 18446744073709551615 });
  const tiny: i8 = -128;
  const width: usize = 64;
  console.log(seen);
  console.log(delta, ratio, small, done, count);
  console.log("name:", name, holder.label, holder.total);
  console.log(seen + 1, delta * 2, !done, tiny, width);
  console.log(`template ${seen} and ${name}`);
  console.log(`template ${seen}`, seen);
  console.write("no newline ");
  console.write(seen, name);
  console.log();
  console.error("to stderr", seen);
  console.debug(ratio);
  console.log(1e21, 0.1, -0.0, 100.0, 1.0 / 3.0);
  const names = Array<String>("first", "second");
  for (const each of names) {
    console.log(each, each);
  }
  console.log(names[1]);
  const numbers = Array<u32>(3, 4);
  for (const number of numbers) {
    console.write(number, "");
  }
  console.log(numbers[0] + numbers[1]);
  let round: u32 = 0;
  while (round < 3) {
    console.log(`round ${round}`, round * 10);
    round = round + 1;
  }
  show("shown", 7);
  return 0;
}
