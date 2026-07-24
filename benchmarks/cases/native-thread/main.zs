import bench from "../../support/bench.h";
import { thread } from "std/thread";

async function main(): i32 {
  const iterations = bench.z_bench_iterations();
  let index: u64 = 0;
  let checksum: u64 = 0;
  const started = bench.z_bench_now_ns();

  while (index < iterations) {
    const input = index;
    const worker = thread.spawn(move (): u64 => input);
    checksum = checksum + await worker;
    index = index + 1;
  }

  const elapsed = bench.z_bench_now_ns() - started;
  bench.z_bench_report_native_thread(elapsed, checksum);
  return 0;
}
