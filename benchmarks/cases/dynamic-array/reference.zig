const std = @import("std");

extern fn z_bench_iterations() u64;
extern fn z_bench_now_ns() u64;
extern fn z_bench_report(name: [*:0]const u8, nanoseconds: u64, checksum: u64) void;

pub fn main() !void {
    const allocator = std.heap.c_allocator;
    const iterations = z_bench_iterations();
    var values: std.ArrayList(u64) = .empty;
    defer values.deinit(allocator);
    var index: u64 = 0;
    const started = z_bench_now_ns();

    while (index < iterations) {
        try values.append(allocator, index);
        index +%= 1;
    }

    var checksum: u64 = 0;
    var read: usize = 0;
    while (read < values.items.len) {
        checksum +%= values.items[read];
        read +%= 1;
    }

    z_bench_report("dynamic-array", z_bench_now_ns() - started, checksum);
}
