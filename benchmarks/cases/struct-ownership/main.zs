import bench from "../../support/bench.h";

struct Resource {
  value: u64;

  deinit {
    bench.z_bench_drop(this.value);
  }
}

function consume(resource: Resource): u64 {
  return resource.value;
}

function main(): i32 {
  const iterations = bench.z_bench_iterations();
  let index: u64 = 0;
  let checksum: u64 = 0;
  const started = bench.z_bench_now_ns();

  while (index < iterations) {
    const resource = Resource({ value: index });
    checksum = checksum.wrappingAdd(consume(move resource));
    index = index.wrappingAdd(1);
  }

  const elapsed = bench.z_bench_now_ns() - started;
  bench.z_bench_report("struct-ownership", elapsed, checksum);
  return 0;
}
