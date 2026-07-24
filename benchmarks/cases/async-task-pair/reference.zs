import bench from "../../support/bench.h";

async function ready(value: u64): u64 {
  return value;
}

async function main(): i32 {
  const iterations = bench.z_bench_iterations();
  let index: u64 = 0;
  let checksum: u64 = 0;
  const started = bench.z_bench_now_ns();

  while (index < iterations) {
    checksum = checksum + await ready(index);
    index = index + 1;
    checksum = checksum + await ready(index);
    index = index + 1;
  }

  const elapsed = bench.z_bench_now_ns() - started;
  const name: cstring = "async-task-pair";
  bench.z_bench_report(name, elapsed, checksum);
  return 0;
}
