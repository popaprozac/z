unsafe extern "C" {
    fn z_bench_iterations() -> u64;
    fn z_bench_now_ns() -> u64;
    fn z_bench_report(name: *const u8, nanoseconds: u64, checksum: u64);
}

fn main() {
    let iterations = unsafe { z_bench_iterations() };
    let mut index = 0_u64;
    let mut checksum = 0_u64;
    let started = unsafe { z_bench_now_ns() };

    while index < iterations {
        let input = index;
        let worker = std::thread::spawn(move || input);
        checksum = checksum.wrapping_add(worker.join().expect("worker panicked"));
        index = index.wrapping_add(1);
    }

    unsafe {
        z_bench_report(
            c"native-thread".as_ptr().cast(),
            z_bench_now_ns() - started,
            checksum,
        );
    }
}
