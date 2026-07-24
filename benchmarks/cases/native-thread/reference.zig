const std = @import("std");

extern fn z_bench_iterations() u64;
extern fn z_bench_now_ns() u64;
extern fn z_bench_report(name: [*:0]const u8, nanoseconds: u64, checksum: u64) void;

const Worker = struct {
    input: u64,
    output: u64,
};

fn workerMain(worker: *Worker) void {
    worker.output = worker.input;
}

pub fn main() void {
    const iterations = z_bench_iterations();
    var index: u64 = 0;
    var checksum: u64 = 0;
    const started = z_bench_now_ns();

    while (index < iterations) {
        var worker = Worker{ .input = index, .output = 0 };
        const thread = std.Thread.spawn(.{}, workerMain, .{&worker}) catch unreachable;
        thread.join();
        checksum +%= worker.output;
        index +%= 1;
    }

    z_bench_report("native-thread", z_bench_now_ns() - started, checksum);
}
