import {
  Channel,
  ChannelClosed,
  Receiver,
  Sender,
  SyncReceiver,
  SyncSender,
} from "std/channel";

struct NativeMessage {
  body: String;
}

readonly class NativeMailbox<Message> {
  readonly sender: SyncSender<Message>;

  function post(
    message: Message
  ): void throws ChannelClosed<Message> {
    try this.sender.send(move message);
  }
}

async function sendAsync(
  sender: Sender<NativeMessage>
): void throws ChannelClosed<NativeMessage> {
  const message = NativeMessage({ body: "async" });
  try await sender.send(move message);
  sender.close();
}

async function receiveAsync(receiver: Receiver<NativeMessage>): i32 {
  return match (await receiver.receive()) {
    some(message) => i32(message.body.byteLength);
    none => 0;
  };
}

function useSync(): i32 throws ChannelClosed<NativeMessage> {
  const { sender, receiver } = Channel<NativeMessage>.bounded(1);
  const producer: SyncSender<NativeMessage> = sender.sync();
  const consumer: SyncReceiver<NativeMessage> = receiver.sync();
  const mailbox = new NativeMailbox<NativeMessage>({ sender: producer });
  const message = NativeMessage({ body: "sync" });
  try mailbox.post(move message);
  return match (consumer.receive()) {
    some(received) => i32(received.body.byteLength);
    none => 0;
  };
}

function main(): i32 {
  return match (attempt useSync()) {
    success(value) => value - 4;
    failure(_) => 1;
  };
}
