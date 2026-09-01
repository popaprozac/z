import {
  assert,
  cli,
  compileToC,
  diagnostics,
  mkdtempSync,
  resolve,
  rmSync,
  spawnSync,
  test,
  writeFileSync,
} from "./support/bootstrap.ts";

test("checks bounded channels with split asynchronous endpoints", () => {
  const source = `
    import { Channel, ChannelClosed, Receiver, Sender } from "std/channel";

    async function sendValue(in sender: Sender<i32>): void throws ChannelClosed<i32> {
      const value = 42;
      try await sender.send(value);
    }

    async function receiveValue(receiver: Receiver<i32>): i32 {
      const value = await receiver.receive();
      return match (value) {
        some(found) => found;
        none => 0;
      };
    }

    function build(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(4);
      sender.close();
      const syncReceiver = receiver.sync();
      return match (syncReceiver.receive()) {
        some(found) => found;
        none => 0;
      };
    }
  `;

  assert.deepEqual(diagnostics(source, "/tmp/z-channel-async-endpoints.zs"), []);
});

test("checks explicit synchronous channel endpoint conversion", () => {
  const source = `
    import { Channel, ChannelClosed } from "std/channel";

    function transfer(): i32 throws ChannelClosed<i32> {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const syncSender = sender.sync();
      const syncReceiver = receiver.sync();
      const value = 42;
      try syncSender.send(value);
      syncSender.close();
      return match (syncReceiver.receive()) {
        some(found) => found - 42;
        none => 1;
      };
    }

    function main(): i32 {
      const result = attempt transfer();
      return match (result) {
        success(value) => value;
        failure(error) => error.value;
      };
    }
  `;

  assert.deepEqual(diagnostics(source, "/tmp/z-channel-sync-endpoints.zs"), []);
});

test("runs a bounded synchronous channel end to end", () => {
  const directory = mkdtempSync("/tmp/z-channel-sync-runtime-");
  const file = resolve(directory, "main.zs");
  const source = `
    import { Channel, ChannelClosed } from "std/channel";

    function transfer(): i32 throws ChannelClosed<i32> {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const syncSender = sender.sync();
      const syncReceiver = receiver.sync();
      const value = 42;
      try syncSender.send(value);
      syncSender.close();
      return match (syncReceiver.receive()) {
        some(found) => found - 42;
        none => 1;
      };
    }

    function main(): i32 {
      const result = attempt transfer();
      return match (result) {
        success(value) => value;
        failure(error) => error.value;
      };
    }
  `;
  try {
    writeFileSync(file, source);
    const generated = compileToC(source, file);
    assert.match(generated, /pthread_cond_wait|SleepConditionVariableSRW/);
    const result = spawnSync(process.execPath, [cli, "run", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("transfers owned messages and returns an unsent owner when a channel is closed", () => {
  const directory = mkdtempSync("/tmp/z-channel-owned-message-");
  const file = resolve(directory, "main.zs");
  const source = `
    import { Channel } from "std/channel";

    function main(): i32 {
      const { sender, receiver } = Channel<String>.bounded(1);
      const syncSender = sender.sync();
      const syncReceiver = receiver.sync();

      const first = "ready";
      const sent = attempt syncSender.send(move first);
      const sendStatus = match (sent) {
        success => 0;
        failure(error) => i32(error.value.byteLength);
      };
      const received = match (syncReceiver.receive()) {
        some(message) => i32(message.byteLength) - 5;
        none => 1;
      };

      syncSender.close();
      const second = "closed";
      const rejected = attempt syncSender.send(move second);
      const recovered = match (rejected) {
        success => 1;
        failure(error) => i32(error.value.byteLength) - 6;
      };
      return sendStatus + received + recovered;
    }
  `;
  try {
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [cli, "run", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs asynchronous send and receive without blocking the executor", () => {
  const directory = mkdtempSync("/tmp/z-channel-async-runtime-");
  const file = resolve(directory, "main.zs");
  const source = `
    import { Channel, ChannelClosed, Sender } from "std/channel";
    import { delay } from "std/time";

    async function publish(sender: Sender<i32>): void throws ChannelClosed<i32> {
      try await sender.send(20);
      try await sender.send(22);
    }

    async function main(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const publishing = task publish(sender);
      // Let the producer fill the single slot and suspend on its second send.
      await delay(1);
      const first = await receiver.receive();
      const second = await receiver.receive();
      const sent = attempt await publishing;
      sender.close();
      const finished = await receiver.receive();
      const firstValue = match (first) {
        some(value) => value;
        none => 0;
      };
      const secondValue = match (second) {
        some(value) => value;
        none => 0;
      };
      const sendStatus = match (sent) {
        success => 0;
        failure(error) => error.value;
      };
      return match (finished) {
        some(value) => value;
        none => firstValue + secondValue - 42 + sendStatus;
      };
    }
  `;
  try {
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [cli, "run", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wakes a suspended async sender and preserves its unsent message when closed", () => {
  const directory = mkdtempSync("/tmp/z-channel-async-close-");
  const file = resolve(directory, "main.zs");
  const source = `
    import { Channel, ChannelClosed, Sender } from "std/channel";
    import { delay } from "std/time";

    async function publish(sender: Sender<i32>): void throws ChannelClosed<i32> {
      try await sender.send(20);
      try await sender.send(22);
    }

    async function main(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const publishing = task publish(sender);
      await delay(1);
      sender.close();
      const result = attempt await publishing;
      return match (result) {
        success => 1;
        failure(error) => error.value - 22;
      };
    }
  `;
  try {
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [cli, "run", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wakes a suspended async receiver when the last sender closes", () => {
  const directory = mkdtempSync("/tmp/z-channel-async-drain-");
  const file = resolve(directory, "main.zs");
  const source = `
    import { Channel, Sender } from "std/channel";
    import { delay } from "std/time";

    async function closeLater(sender: Sender<i32>): void {
      await delay(1);
      sender.close();
    }

    async function main(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const closing = task closeLater(sender);
      const value = await receiver.receive();
      await closing;
      return match (value) {
        some(found) => found + 1;
        none => 0;
      };
    }
  `;
  try {
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [cli, "run", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("removes a suspended channel waiter during structured task cancellation", () => {
  const directory = mkdtempSync("/tmp/z-channel-async-cancel-");
  const file = resolve(directory, "main.zs");
  const source = `
    import { Channel, ChannelClosed, Sender } from "std/channel";
    import { delay } from "std/time";

    async function publish(sender: Sender<i32>): void throws ChannelClosed<i32> {
      try await sender.send(20);
      try await sender.send(22);
    }

    async function main(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const publishing = task publish(sender);
      await delay(1);
      await publishing.cancel();
      sender.close();
      const first = await receiver.receive();
      const finished = await receiver.receive();
      const observed = match (first) {
        some(value) => value;
        none => 0;
      };
      return match (finished) {
        some(value) => value + 1;
        none => observed - 20;
      };
    }
  `;
  try {
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects zero-capacity bounded channels in the first channel tier", () => {
  const source = `
    import { Channel } from "std/channel";

    function main(): i32 {
      const endpoints = Channel<i32>.bounded(0);
      return 0;
    }
  `;

  const diagnostic = diagnostics(source, "/tmp/z-channel-zero-capacity.zs")[0];
  assert.equal(diagnostic?.code, "Z0710");
  assert.match(diagnostic?.message ?? "", /capacity must be greater than zero/);
});

test("requires an explicit move when transferring an owned channel message", () => {
  const source = `
    import { Channel, ChannelClosed, SyncSender } from "std/channel";

    function publish(in sender: SyncSender<String>): void throws ChannelClosed<String> {
      const message = "ready";
      try sender.send(message);
    }
  `;

  const diagnostic = diagnostics(source, "/tmp/z-channel-message-move.zs")[0];
  assert.match(diagnostic?.message ?? "", /move/i);
});

test("consumes the unique receiver when converting it to synchronous access", () => {
  const source = `
    import { Channel } from "std/channel";

    function main(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const syncReceiver = receiver.sync();
      const second = receiver.sync();
      sender.close();
      return 0;
    }
  `;

  const diagnostic = diagnostics(source, "/tmp/z-channel-unique-receiver.zs")[0];
  assert.match(diagnostic?.message ?? "", /use of moved value "receiver"/i);
});

test("keeps unique receiver operations directly awaited in the first tier", () => {
  const source = `
    import { Channel } from "std/channel";

    async function main(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const pending = task receiver.receive();
      sender.close();
      const value = await pending;
      return 0;
    }
  `;

  const diagnostic = diagnostics(source, "/tmp/z-channel-concurrent-receive.zs")[0];
  assert.equal(diagnostic?.code, "Z0710");
  assert.match(diagnostic?.message ?? "", /must be awaited directly/i);
});
