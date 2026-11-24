import console from "std/console";
import { thread } from "std/thread";
import { delay } from "std/time";

// A `thread.spawn` worker owns what its closure captures. A value without
// cleanup is a copy the worker may assign. A moved owner (an Array, a String,
// or an aggregate of them) is released exactly once: by the worker when it
// keeps it, otherwise by whoever the worker hands it to. A deeply readonly
// class is shared with the worker, synchronous or async.

readonly class Settings {
  limit: i32;
}

struct Counter {
  value: i32;
}

struct Batch {
  names: Array<String>;
  title: String;
}

function named(in prefix: String, count: i32): Array<String> {
  let names = Array<String>();
  let index = 0;
  while (index < count) {
    names.push(`${prefix}${index}`);
    index = index + 1;
  }
  return names;
}

function total(names: Array<String>): usize {
  let bytes: usize = 0;
  for (const name of names) {
    bytes = bytes + name.byteLength;
  }
  return bytes;
}

async function main(): i32 {
  let count = 1;
  const bumped = thread.spawn(move (): i32 => {
    count = count + 41;
    return count;
  });
  let counter = Counter({ value: 1 });
  const stepped = thread.spawn(move (): i32 => {
    counter.value = counter.value + 1;
    return counter.value;
  });
  const bumpedCount = await bumped;
  const steppedCount = await stepped;
  console.log(`copies ${bumpedCount} ${steppedCount}, parent ${count} ${counter.value}`);

  const listPrefix = "list";
  let listed = named(listPrefix, 2);
  const extended = thread.spawn(move (): usize => {
    listed.push("extra");
    return listed.length;
  });
  const extendedLength = await extended;
  console.log(`extended ${extendedLength}`);

  const keptPrefix = "kept";
  const kept = Batch({ names: named(keptPrefix, 3), title: "batch" });
  const measured = thread.spawn(move (): usize => kept.names.length + kept.title.byteLength);
  const measuredLength = await measured;
  console.log(`kept ${measuredLength}`);

  const returned = "returned text";
  const handed = thread.spawn(move (): String => {
    return returned;
  });
  const back = await handed;
  console.log(`back ${back}`);

  const consumedPrefix = "consumed";
  const consumed = named(consumedPrefix, 2);
  const eaten = thread.spawn(move (): usize => {
    return total(move consumed);
  });
  const eatenBytes = await eaten;
  console.log(`consumed ${eatenBytes}`);

  const settings = new Settings({ limit: 7 });
  const direct = thread.spawn(move (): i32 => settings.limit);
  const framed = thread.spawn(async move (): i32 => {
    await delay(1);
    return settings.limit + 1;
  });
  const directLimit = await direct;
  const framedLimit = await framed;
  console.log(`shared ${directLimit} ${framedLimit} ${settings.limit}`);

  const droppedPrefix = "dropped";
  const dropped = named(droppedPrefix, 2);
  const ignored = thread.spawn(move (): usize => dropped.length);
  return 0;
}
