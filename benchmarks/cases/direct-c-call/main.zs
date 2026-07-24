import bench from "../../support/bench.h";

function main(): i32 {
  const iterations = bench.z_bench_iterations();
  let index: u64 = 0;
  let checksum: u64 = 0;
  const started = bench.z_bench_now_ns();

  while (index < iterations) {
    checksum = checksum ^ bench.z_bench_mix(index);
    index = index.wrappingAdd(1);
  }

  const elapsed = bench.z_bench_now_ns() - started;
  bench.z_bench_report("direct-c-call", elapsed, checksum);
  return 0;
}
