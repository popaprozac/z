extern fn z_bench_iterations() u64;
extern fn z_bench_now_ns() u64;
extern fn z_bench_mix(value: u64) u64;
extern fn z_bench_report(name: [*:0]const u8, nanoseconds: u64, checksum: u64) void;

pub fn main() void {
    const iterations = z_bench_iterations();
    var index: u64 = 0;
    var checksum: u64 = 0;
    const started = z_bench_now_ns();

    while (index < iterations) {
        checksum ^= z_bench_mix(index);
        index +%= 1;
    }

    z_bench_report("direct-c-call", z_bench_now_ns() - started, checksum);
}
