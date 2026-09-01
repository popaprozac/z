use std::sync::mpsc::sync_channel;
use std::thread;

unsafe extern "C" {
    fn z_bench_iterations() -> u64;
    fn z_bench_now_ns() -> u64;
    fn z_bench_report(name: *const u8, nanoseconds: u64, checksum: u64);
}

fn main() {
    let iterations = unsafe { z_bench_iterations() };
    let (sender, receiver) = sync_channel::<u64>(1);
    let consumer = thread::spawn(move || {
        let mut checksum = 0_u64;
        for _ in 0..iterations {
            checksum = checksum.wrapping_add(receiver.recv().expect("channel sender closed"));
        }
        checksum
    });

    let started = unsafe { z_bench_now_ns() };
    for value in 0..iterations {
        sender.send(value).expect("channel receiver closed");
    }
    let checksum = consumer.join().expect("consumer panicked");
    unsafe {
        z_bench_report(
            c"channel-thread".as_ptr().cast(),
            z_bench_now_ns() - started,
            checksum,
        );
    }
}
