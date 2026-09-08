import {
  assert, cli, mkdtempSync, resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

// Every child is bounded: a failed wakeup must fail the test, not leave a
// spinning or blocked process behind. UBSan supplements the ownership checks.
function runChannelProgram(
  source: string, expectedOutput = "", instrument?: (source: string) => string,
  modules: Readonly<Record<string, string>> = {},
): void {
  const directory = mkdtempSync("/tmp/z-native-channel-");
  try {
    const input = resolve(directory, "main.zs");
    for (const [name, content] of Object.entries(modules)) {
      writeFileSync(resolve(directory, name), content);
    }
    writeFileSync(input, source);
    const stage0 = spawnSync(process.execPath, [cli, "run", input], {
      encoding: "utf8", timeout: 60_000,
    });
    assert.equal(stage0.status, 0, stage0.stderr || stage0.error?.message);
    assert.equal(stage0.stdout, expectedOutput);
    const parity = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
      encoding: "utf8", timeout: 60_000,
    });
    assert.equal(parity.status, 0, parity.stderr || parity.error?.message);
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr || emitted.error?.message);
    let generated = emitted.stdout;
    if (generated.includes("struct Z_ChannelStorage_")) {
      const releases = /if \(__atomic_sub_fetch\(&s->references, 1, __ATOMIC_ACQ_REL\) != 0\) return;/g;
      assert.ok([...generated.matchAll(releases)].length > 0);
      generated = "static long z_test_live_channels;\n" + generated
        .replaceAll("  s->references = 2;", "  __atomic_add_fetch(&z_test_live_channels, 1, __ATOMIC_RELAXED);\n  s->references = 2;")
        .replace(releases, "$&\n  __atomic_sub_fetch(&z_test_live_channels, 1, __ATOMIC_RELAXED);")
        + "\n__attribute__((destructor)) static void z_test_verify_channels(void) { if (__atomic_load_n(&z_test_live_channels, __ATOMIC_RELAXED) != 0) abort(); }\n";
    }
    const executable = resolve(directory, "program");
    const compiled = spawnSync("clang", [
      "-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread",
      "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable,
    ], { encoding: "utf8", input: instrument ? instrument(generated) : generated, timeout: 30_000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const repetitions = source.includes("thread.spawn") ? 8 : 1;
    for (let iteration = 0; iteration < repetitions; iteration += 1) {
      const executed = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
      assert.equal(executed.status, 0, executed.stderr || executed.error?.message);
      assert.equal(executed.stdout, expectedOutput);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("native sync channels preserve FIFO, ring wraparound, and draining after close", () => {
  runChannelProgram(`
    import { Channel, ChannelClosed, SyncReceiver, SyncSender } from "std/channel";
    function next(in receiver: SyncReceiver<i32>): i32 {
      return match (receiver.receive()) { some(value) => value; none => -1000; };
    }
    function exercise(): i32 throws ChannelClosed<i32> {
      const { sender, receiver } = Channel<i32>.bounded(2);
      const send = sender.sync();
      const receive = receiver.sync();
      try send.send(10);
      try send.send(20);
      if (next(in receive) != 10) return 1;
      try send.send(30);
      sender.close();
      send.close();
      if (next(in receive) != 20) return 2;
      if (next(in receive) != 30) return 3;
      if (next(in receive) != -1000) return 4;
      return match (attempt send.send(42)) {
        success => 5;
        failure(error) => error.value - 42;
      };
    }
    function main(): i32 {
      return match (attempt exercise()) { success(value) => value; failure(_) => 6; };
    }
  `);
}, 180_000);

test("native sync channels transfer owned String payloads and return rejected owners", () => {
  runChannelProgram(`
    import { Channel } from "std/channel";
    function main(): i32 {
      const { sender, receiver } = Channel<String>.bounded(1);
      const send = sender.sync();
      const receive = receiver.sync();
      const first = "ready";
      const sent = attempt send.send(move first);
      const status = match (sent) { success => 0; failure(_) => 1; };
      const read = match (receive.receive()) {
        some(message) => message == "ready" ? 0 : 2;
        none => 3;
      };
      send.close();
      const rejected = "closed";
      return match (attempt send.send(move rejected)) {
        success => 4;
        failure(error) => status + read + (error.value == "closed" ? 0 : 5);
      };
    }
  `);
}, 180_000);

test("native sync channels destroy received, rejected, and buffered owners exactly once", () => {
  runChannelProgram(`
    import { Channel } from "std/channel";
    struct Message {
      name: String;
    }
    function main(): i32 {
      const { sender, receiver } = Channel<Message>.bounded(2);
      const send = sender.sync();
      const receive = receiver.sync();
      const one = attempt send.send(Message({ name: "received" }));
      match (receive.receive()) { some(_) => {} none => return 1; }
      const two = attempt send.send(Message({ name: "buffered" }));
      send.close();
      match (attempt send.send(Message({ name: "rejected" }))) {
        success => return 2;
        failure(_) => {}
      }
      return 0;
    }
  `, "", (source) => {
    // Instrument automatic aggregate cleanup without requiring custom-deinit
    // thread-safety proof, which is a separate native semantic tier.
    const definition = /static[^\n]* void Z_Message_deinit\([^\n]*\) \{/g;
    assert.equal([...source.matchAll(definition)].length, 1);
    return "static unsigned z_test_message_deinits;\n"
      + source.replace(definition, "$&\n  z_test_message_deinits += 1;")
      + "\n__attribute__((destructor)) static void z_test_verify_cleanup(void) { if (z_test_message_deinits != 3) abort(); }\n";
  });
}, 180_000);

test("native channel senders cross worker boundaries and survive parent aliases", () => {
  runChannelProgram(`
    import { Channel } from "std/channel";
    import { thread } from "std/thread";
    async function main(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const send = sender.sync();
      const receive = receiver.sync();
      const worker = thread.spawn(move (): i32 => {
        const first = attempt send.send(20);
        const second = attempt send.send(22);
        return 0;
      });
      const a = match (receive.receive()) { some(value) => value; none => -1; };
      const b = match (receive.receive()) { some(value) => value; none => -1; };
      const joined = await worker;
      send.close();
      return a + b + joined - 42;
    }
  `);
}, 180_000);

test("native yielding workers signal readiness through sync channels before cancellation", () => {
  runChannelProgram(`
    import { Channel, SyncSender } from "std/channel";
    import { TaskScope, scheduler } from "std/async";
    import { thread } from "std/thread";
    async function listen(ready: SyncSender<i32>, updates: TaskScope): i32 {
      const delivered = attempt ready.send(1);
      await scheduler.yield();
      return 0;
    }
    async function main(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const readiness = receiver.sync();
      const ready = sender.sync();
      const updates = new TaskScope();
      const listener = thread.spawn(async move (): i32 => await listen(ready, updates));
      const value = readiness.receive();
      await listener.cancel();
      await updates.close();
      return match (value) { some(value) => value - 1; none => 1; };
    }
  `);
}, 180_000);

test("native yielding workers capture destructured bindings with their declaration identities", () => {
  runChannelProgram(`
    import { Channel, Sender } from "std/channel";
    import { scheduler } from "std/async";
    import { thread } from "std/thread";
    function drop(sender: Sender<i32>): void {}
    async function ready(sender: Sender<i32>, value: i32): i32 {
      const send = sender.sync();
      const sent = attempt send.send(value);
      await scheduler.yield();
      return 0;
    }
    async function main(): i32 {
      const { sender: outgoing, receiver } = Channel<i32>.bounded(1);
      const value = 42;
      const receive = receiver.sync();
      const worker = thread.spawn(async move (): i32 => await ready(outgoing, value));
      drop(move outgoing);
      const received = receive.receive();
      await worker.cancel();
      return match (received) { some(value) => value - 42; none => 1; };
    }
  `);
}, 180_000);

test("native yielding workers select nested owned startup results before suspension", () => {
  runChannelProgram(`
    import { Channel, Sender } from "std/channel";
    import { TaskScope, scheduler } from "std/async";
    import { thread } from "std/thread";
    struct Message { name: String; }
    function openMessage(): Option<Message> throws i32 {
      return Option.some(Message({ name: "ready" }));
    }
    async function listen(sender: Sender<i32>, updates: TaskScope): i32 {
      const ready = sender.sync();
      const selected = match (attempt openMessage()) {
        success(option) => match (option) {
          some(value) => value;
          none => return 1;
        }
        failure(error) => return error;
      };
      const sent = attempt ready.send(selected.name == "ready" ? 42 : 1);
      await scheduler.yield();
      return 0;
    }
    async function main(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const receive = receiver.sync();
      const updates = new TaskScope();
      const worker = thread.spawn(async move (): i32 => await listen(sender, updates));
      const received = receive.receive();
      await worker.cancel();
      await updates.cancel();
      return match (received) { some(value) => value - 42; none => 1; };
    }
  `, "", (source) => {
    const definition = /static[^\n]* void Z_Message_deinit\([^\n]*\) \{/g;
    assert.equal([...source.matchAll(definition)].length, 1);
    return "static unsigned z_test_message_deinits;\n"
      + source.replace(definition, "$&\n  z_test_message_deinits += 1;")
      + "\n__attribute__((destructor)) static void z_test_verify_cleanup(void) { if (z_test_message_deinits != 1) abort(); }\n";
  });
}, 180_000);

test("native channel receiver drop wakes a full-queue sender with its original value", () => {
  runChannelProgram(`
    import { Channel, SyncReceiver } from "std/channel";
    import { thread } from "std/thread";
    function drop(receiver: SyncReceiver<i32>): void {}
    async function main(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const send = sender.sync();
      const receive = receiver.sync();
      const first = attempt send.send(1);
      const worker = thread.spawn(move (): i32 => {
        return match (attempt send.send(42)) {
          success => 1;
          failure(error) => error.value - 42;
        };
      });
      drop(move receive);
      return await worker;
    }
  `);
}, 180_000);

test("native last-sender destruction wakes a uniquely transferred worker receiver", () => {
  runChannelProgram(`
    import { Channel, Sender } from "std/channel";
    import { thread } from "std/thread";
    function drop(sender: Sender<i32>): void {}
    async function main(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const receive = receiver.sync();
      const worker = thread.spawn(move (): i32 => {
        return match (receive.receive()) { some(_) => 1; none => 0; };
      });
      drop(move sender);
      return await worker;
    }
  `);
}, 180_000);

test("native workers may consume their retained sender without consuming the parent's handle", () => {
  runChannelProgram(`
    import { Channel, SyncSender } from "std/channel";
    import { thread } from "std/thread";
    function drop(sender: SyncSender<i32>): void {}
    async function main(): i32 {
      const { sender, receiver } = Channel<i32>.bounded(1);
      const send = sender.sync();
      const receive = receiver.sync();
      const worker = thread.spawn(move (): i32 => { drop(move send); return 0; });
      const joined = await worker;
      const sent = attempt send.send(42);
      return match (receive.receive()) { some(value) => joined + value - 42; none => 1; };
    }
  `);
}, 180_000);

test("native primitive array arguments do not inherit an unrelated local ownership flag", () => {
  runChannelProgram(`
    function main(): i32 {
      if (true) {
        const payload: usize = 42;
        let values = Array<usize>();
        values.push(payload);
        if (values[0] != 42) return 1;
      }
      if (true) {
        const payload = "owned";
        let values = Array<String>();
        values.push(move payload);
      }
      return 0;
    }
  `);
}, 180_000);

test("native owned storage consumes fallible array and channel payload temporaries exactly once", () => {
  runChannelProgram(`
    import { Channel } from "std/channel";
    struct Message { name: String; }
    function message(): Message throws i32 {
      return Message({ name: "payload remains owned by its destination" });
    }
    function exercise(): i32 throws i32 {
      let values = Array<Message>();
      values.push(try message());
      if (values[0].name != "payload remains owned by its destination") return 1;
      const { sender, receiver } = Channel<Message>.bounded(1);
      const send = sender.sync();
      const receive = receiver.sync();
      match (attempt send.send(try message())) { success => {} failure(_) => return 2; }
      match (receive.receive()) {
        some(value) => { if (value.name != values[0].name) return 3; }
        none => return 4;
      }
      send.close();
      return match (attempt send.send(try message())) {
        success => 5;
        failure(error) => error.value.name == values[0].name ? 0 : 6;
      };
    }
    function main(): i32 {
      return match (attempt exercise()) { success(value) => value; failure(_) => 7; };
    }
  `, "", (source) => {
    const definition = /static[^\n]* void Z_Message_deinit\([^\n]*\) \{/g;
    assert.equal([...source.matchAll(definition)].length, 1);
    // A try expression becomes a synthetic local in native lowering. Its
    // destination owns the value; statement cleanup must not also destroy it.
    assert.doesNotMatch(source, /Z_Message_deinit\(&_z_stage1_nested_try_\d+\)/);
    return "static unsigned z_test_message_deinits;\n"
      + source.replace(definition, "$&\n  z_test_message_deinits += 1;")
      + "\n__attribute__((destructor)) static void z_test_verify_cleanup(void) { if (z_test_message_deinits != 3) abort(); }\n";
  });
}, 180_000);

test("native channel handles compose through aliased imports and cross-module storage", () => {
  runChannelProgram(`
    import { Channel } from "std/channel";
    import { Command, Mailbox, Inbox } from "./mailbox.zs";
    function main(): i32 {
      const { sender, receiver } = Channel<Command>.bounded(1);
      const mailbox = new Mailbox({ sender });
      const inbox = Inbox({ receiver: receiver.sync() });
      const send = mailbox.sender.sync();
      const sent = attempt send.send(Command.stop);
      mailbox.sender.close();
      return match (inbox.receiver.receive()) {
        some(command) => match (command) { stop => 0; }
        none => 1;
      };
    }
  `, "", undefined, {
    "mailbox.zs": `
      import { Sender as Producer, SyncReceiver as Consumer } from "std/channel";
      export enum Command { stop, }
      export readonly class Mailbox { readonly sender: Producer<Command>; }
      export struct Inbox { receiver: Consumer<Command>; }
    `,
  });
}, 180_000);
