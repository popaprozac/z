unsafe extern "C" {
    fn z_bench_iterations() -> u64;
    fn z_bench_now_ns() -> u64;
    fn z_bench_report(name: *const u8, nanoseconds: u64, checksum: u64);
}

fn main() {
    let iterations = unsafe { z_bench_iterations() };
    let mut index = 0_u64;
    let mut checksum = 0x9e37_79b9_7f4a_7c15_u64;
    let started = unsafe { z_bench_now_ns() };

    while index < iterations {
        checksum = (checksum ^ index).wrapping_mul(1_099_511_628_211);
        index = index.wrapping_add(1);
    }

    unsafe {
        z_bench_report(
            c"arithmetic".as_ptr().cast(),
            z_bench_now_ns() - started,
            checksum,
        );
    }
}
