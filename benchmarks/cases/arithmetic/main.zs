import bench from "../../support/bench.h";

function main(): i32 {
  const iterations = bench.z_bench_iterations();
  let index: u64 = 0;
  let checksum: u64 = 11400714819323198485;
  const started = bench.z_bench_now_ns();

  while (index < iterations) {
    checksum = (checksum ^ index).wrappingMultiply(1099511628211);
    index = index.wrappingAdd(1);
  }

  const elapsed = bench.z_bench_now_ns() - started;
  bench.z_bench_report("arithmetic", elapsed, checksum);
  return 0;
}
