import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct PendingPublish {
  message: String;

  deinit {
    console.log(`released ${this.message}`);
  }
}

struct Published {
  code: i32;
  message: String;

  deinit {
    console.log(`released result ${this.message}`);
  }
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(pending: PendingPublish): Published on thread.main {
  await delay(1);
  console.log(`completed ${pending.message}`);
  return Published({
    code: 42,
    message: duplicate(pending.message),
  });
}

async function invoke(pending: PendingPublish): i32 {
  const published = await on thread.main publish(pending);
  console.log(`observed ${published.message}`);
  return published.code == 42 ? 0 : 1;
}

async function main(): i32 on thread.main {
  return await invoke(PendingPublish({
    message: duplicate("free local publish"),
  }));
}
