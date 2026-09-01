// A bounded asynchronous work queue with ownership transfer and backpressure.
// Run `bun run z run examples/async/channels.zs`.

import { Channel, ChannelClosed, Sender } from "std/channel";
import console from "std/console";

struct IndexJob {
  document: String;
  priority: i32;
}

async function schedule(sender: Sender<IndexJob>): void throws ChannelClosed<IndexJob> {
  const guide = IndexJob({ document: "guide.md", priority: 2 });
  const reference = IndexJob({ document: "reference.md", priority: 1 });

  try await sender.send(move guide);
  // Capacity is one, so this suspends until the consumer makes room.
  try await sender.send(move reference);
  sender.close();
}

async function main(): i32 throws ChannelClosed<IndexJob> {
  const { sender, receiver } = Channel<IndexJob>.bounded(1);
  const producer = task schedule(move sender);

  const first = await receiver.receive();
  match (first) {
    some(job) => console.log(`indexing ${job.document} at priority ${job.priority}`);
    none => return 1;
  }

  const second = await receiver.receive();
  match (second) {
    some(job) => console.log(`indexing ${job.document} at priority ${job.priority}`);
    none => return 2;
  }

  try await producer;
  const finished = await receiver.receive();
  return match (finished) {
    some(_) => 3;
    none => 0;
  };
}
