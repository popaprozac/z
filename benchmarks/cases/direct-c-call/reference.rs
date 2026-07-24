unsafe extern "C" {
    fn z_bench_iterations() -> u64;
    fn z_bench_now_ns() -> u64;
    fn z_bench_mix(value: u64) -> u64;
    fn z_bench_report(name: *const u8, nanoseconds: u64, checksum: u64);
}

fn main() {
    let iterations = unsafe { z_bench_iterations() };
    let mut index = 0_u64;
    let mut checksum = 0_u64;
    let started = unsafe { z_bench_now_ns() };

    while index < iterations {
        checksum ^= unsafe { z_bench_mix(index) };
        index = index.wrapping_add(1);
    }

    unsafe {
        z_bench_report(
            c"direct-c-call".as_ptr().cast(),
            z_bench_now_ns() - started,
            checksum,
        );
    }
}
