import { TaskScope } from "std/async";
import { delay } from "std/time";
import { thread } from "std/thread";

readonly class DeliveryService {
  async function hold(): void on thread.main {
    await delay(1);
  }
}

async function main(): i32 on thread.main {
  const updates = new TaskScope();
  const service = new DeliveryService({});
  const control = updates.schedule(
    thread.main,
    async move (): void => await service.hold()
  );
  await updates.close();
  return control.accepted ? 0 : 1;
}
