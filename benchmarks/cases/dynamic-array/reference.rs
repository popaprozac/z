unsafe extern "C" {
    fn z_bench_iterations() -> u64;
    fn z_bench_now_ns() -> u64;
    fn z_bench_report(name: *const u8, nanoseconds: u64, checksum: u64);
}

fn main() {
    let iterations = unsafe { z_bench_iterations() };
    let mut values = Vec::<u64>::new();
    let mut index = 0_u64;
    let started = unsafe { z_bench_now_ns() };

    while index < iterations {
        values.push(index);
        index = index.wrapping_add(1);
    }

    let mut checksum = 0_u64;
    let mut read = 0_usize;
    while read < values.len() {
        checksum = checksum.wrapping_add(values[read]);
        read = read.wrapping_add(1);
    }

    unsafe {
        z_bench_report(
            c"dynamic-array".as_ptr().cast(),
            z_bench_now_ns() - started,
            checksum,
        );
    }
}
