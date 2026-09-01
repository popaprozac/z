import bench from "../../support/bench.h";
import { Channel, Receiver, SyncReceiver } from "std/channel";
import { thread } from "std/thread";

function synchronizeReceiver(
  receiver: Receiver<u64>
): SyncReceiver<u64> {
  return receiver.sync();
}

function consume(
  in receiver: SyncReceiver<u64>,
  iterations: u64
): u64 {
  let received: u64 = 0;
  let checksum: u64 = 0;
  while (received < iterations) {
    const next = receiver.receive();
    const value = match (next) {
      some(value) => value;
      none => u64(0);
    };
    checksum = checksum + value;
    received = received + 1;
  }
  return checksum;
}

async function main(): i32 {
  const iterations = bench.z_bench_iterations();
  const { sender, receiver } = Channel<u64>.bounded(1);
  const syncReceiver = synchronizeReceiver(move receiver);
  const worker = thread.spawn(
    move (): u64 => consume(in syncReceiver, iterations)
  );

  let index: u64 = 0;
  const started = bench.z_bench_now_ns();
  while (index < iterations) {
    const sent = attempt await sender.send(index);
    match (sent) {
      success => {}
      failure(_) => return 1;
    }
    index = index + 1;
  }
  sender.close();
  const checksum = await worker;
  const elapsed = bench.z_bench_now_ns() - started;
  const name: cstring = "channel-thread";
  bench.z_bench_report(name, elapsed, checksum);
  return 0;
}
