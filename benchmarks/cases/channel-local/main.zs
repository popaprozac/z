import bench from "../../support/bench.h";
import { Channel } from "std/channel";

function main(): i32 {
  const iterations = bench.z_bench_iterations();
  const { sender, receiver } = Channel<u64>.bounded(1);
  const syncSender = sender.sync();
  const syncReceiver = receiver.sync();
  let index: u64 = 0;
  let checksum: u64 = 0;
  const started = bench.z_bench_now_ns();

  while (index < iterations) {
    const sent = attempt syncSender.send(index);
    match (sent) {
      success => {}
      failure(_) => return 1;
    }
    const received = syncReceiver.receive();
    const value = match (received) {
      some(value) => value;
      none => u64(0);
    };
    checksum = checksum + value;
    index = index + 1;
  }

  const elapsed = bench.z_bench_now_ns() - started;
  syncSender.close();
  const name: cstring = "channel-local";
  bench.z_bench_report(name, elapsed, checksum);
  return 0;
}
