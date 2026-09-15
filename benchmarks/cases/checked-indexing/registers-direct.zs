import bench from "./input.h";
import { makeState, registersDirect } from "./kernels.zs";

function main(): i32 {
  const rounds = bench.z_bench_iterations();
  let state = makeState(bench.z_index_bench_width());
  const started = bench.z_bench_now_ns();
  const checksum = registersDirect(inout state, rounds);
  const elapsed = bench.z_bench_now_ns() - started;
  bench.z_bench_report("registers-direct", elapsed, checksum);
  return 0;
}
