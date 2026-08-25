import console from "std/console";
import { TaskScope } from "std/async";
import { delay } from "std/time";
import { thread } from "std/thread";

struct PendingDelivery {
  message: String;

  deinit {
    console.log(`released ${this.message}`);
  }
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

readonly class DeliveryService {
  async function complete(): void on thread.main {
    await delay(1);
    console.log("completed request 40");
  }

  async function hold(): void on thread.main {
    const pending = PendingDelivery({
      message: duplicate("request 41"),
    });
    await delay(1000);
    console.log(`unexpected ${pending.message}`);
  }
}

async function main(): i32 on thread.main {
  const completed = new TaskScope();
  const completionService = new DeliveryService({});
  const completion = completed.schedule(
    thread.main,
    async move (): void => await completionService.complete()
  );
  await completed.close();

  const updates = new TaskScope();
  const service = new DeliveryService({});
  const control = updates.schedule(
    thread.main,
    async move (): void => await service.hold()
  );
  const requested = control.requestCancel();
  await updates.close();
  return completion.accepted && control.accepted && requested ? 0 : 1;
}
