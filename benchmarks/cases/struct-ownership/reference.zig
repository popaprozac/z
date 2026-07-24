extern fn z_bench_iterations() u64;
extern fn z_bench_now_ns() u64;
extern fn z_bench_drop(value: u64) void;
extern fn z_bench_report(name: [*:0]const u8, nanoseconds: u64, checksum: u64) void;

const Resource = struct {
    value: u64,

    fn deinit(self: Resource) void {
        z_bench_drop(self.value);
    }
};

fn consume(resource: Resource) u64 {
    defer resource.deinit();
    return resource.value;
}

pub fn main() void {
    const iterations = z_bench_iterations();
    var index: u64 = 0;
    var checksum: u64 = 0;
    const started = z_bench_now_ns();

    while (index < iterations) {
        const resource = Resource{ .value = index };
        checksum +%= consume(resource);
        index +%= 1;
    }

    z_bench_report("struct-ownership", z_bench_now_ns() - started, checksum);
}
