import bench from "./input.h";
import { makeState, registersView } from "./kernels.zs";

function main(): i32 {
  const rounds = bench.z_bench_iterations();
  let state = makeState(bench.z_index_bench_width());
  const started = bench.z_bench_now_ns();
  const checksum = registersView(inout state, rounds);
  const elapsed = bench.z_bench_now_ns() - started;
  bench.z_bench_report("registers-view", elapsed, checksum);
  return 0;
}
