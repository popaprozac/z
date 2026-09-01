use std::sync::mpsc::sync_channel;

unsafe extern "C" {
    fn z_bench_iterations() -> u64;
    fn z_bench_now_ns() -> u64;
    fn z_bench_report(name: *const u8, nanoseconds: u64, checksum: u64);
}

fn main() {
    let iterations = unsafe { z_bench_iterations() };
    let (sender, receiver) = sync_channel::<u64>(1);
    let mut index = 0_u64;
    let mut checksum = 0_u64;
    let started = unsafe { z_bench_now_ns() };

    while index < iterations {
        sender.send(index).expect("channel receiver closed");
        checksum = checksum.wrapping_add(receiver.recv().expect("channel sender closed"));
        index = index.wrapping_add(1);
    }

    unsafe {
        z_bench_report(
            c"channel-local".as_ptr().cast(),
            z_bench_now_ns() - started,
            checksum,
        );
    }
}
