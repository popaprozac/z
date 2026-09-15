import bench from "./input.h";
import { makeState, linear } from "./kernels.zs";

function main(): i32 {
  const rounds = bench.z_bench_iterations();
  const state = makeState(bench.z_index_bench_width());
  const started = bench.z_bench_now_ns();
  const checksum = linear(in state, rounds);
  const elapsed = bench.z_bench_now_ns() - started;
  bench.z_bench_report("linear", elapsed, checksum);
  return 0;
}
