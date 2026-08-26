import console from "std/console";
import { TaskScope } from "std/async";
import { delay } from "std/time";
import { thread } from "std/thread";

struct PendingPublish {
  message: String;

  deinit {
    console.log(`released ${this.message}`);
  }
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

readonly class PublishService {
  async function publish(): i32 on thread.main {
    const pending = PendingPublish({
      message: duplicate("delegated publish"),
    });
    await delay(1000);
    console.log(`unexpected ${pending.message}`);
    return 42;
  }

  async function invoke(): i32 {
    return await on thread.main this.publish();
  }
}

async function runPublish(service: PublishService): void {
  const result = await service.invoke();
  if (result != 42) console.log("unexpected publish result");
}

async function main(): i32 on thread.main {
  const updates = new TaskScope();
  const service = new PublishService({});
  const control = updates.schedule(
    thread.main,
    async move (): void => await runPublish(service)
  );
  const requested = control.requestCancel();
  await updates.close();
  return control.accepted && requested ? 0 : 1;
}
