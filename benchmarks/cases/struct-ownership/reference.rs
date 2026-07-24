unsafe extern "C" {
    fn z_bench_iterations() -> u64;
    fn z_bench_now_ns() -> u64;
    fn z_bench_drop(value: u64);
    fn z_bench_report(name: *const u8, nanoseconds: u64, checksum: u64);
}

struct Resource {
    value: u64,
}

impl Drop for Resource {
    fn drop(&mut self) {
        unsafe { z_bench_drop(self.value) };
    }
}

fn consume(resource: Resource) -> u64 {
    resource.value
}

fn main() {
    let iterations = unsafe { z_bench_iterations() };
    let mut index = 0_u64;
    let mut checksum = 0_u64;
    let started = unsafe { z_bench_now_ns() };

    while index < iterations {
        let resource = Resource { value: index };
        checksum = checksum.wrapping_add(consume(resource));
        index = index.wrapping_add(1);
    }

    unsafe {
        z_bench_report(
            c"struct-ownership".as_ptr().cast(),
            z_bench_now_ns() - started,
            checksum,
        );
    }
}
