import bench from "../../support/bench.h";

function main(): i32 {
  const iterations = bench.z_bench_iterations();
  let values = Array<u64>();
  let index: u64 = 0;
  const started = bench.z_bench_now_ns();

  while (index < iterations) {
    values.push(index);
    index = index.wrappingAdd(1);
  }

  let checksum: u64 = 0;
  let read: usize = 0;
  while (read < values.length) {
    checksum = checksum.wrappingAdd(values[read]);
    read = read.wrappingAdd(1);
  }

  const elapsed = bench.z_bench_now_ns() - started;
  bench.z_bench_report("dynamic-array", elapsed, checksum);
  return 0;
}
