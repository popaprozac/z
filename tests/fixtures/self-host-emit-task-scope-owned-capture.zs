import console from "std/console";
import { TaskScope } from "std/async";
import { thread } from "std/thread";

struct Delivery {
  payload: String;
}

async function prepare(message: String): Option<Delivery> {
  return Option.some(Delivery({ payload: move message }));
}

async function route(message: String): void on thread.main {
  const delivery = await prepare(move message);
  match (delivery) {
    some(value) => console.log(value.payload);
    none => {}
  }
}

function submit(updates: TaskScope, message: String): boolean {
  const control = updates.schedule(
    thread.main,
    async move (): void => await route(move message)
  );
  return control.accepted;
}

async function main(): i32 on thread.main {
  const updates = new TaskScope();
  const accepted = submit(updates, "native owned delivery");
  await updates.close();
  return accepted ? 0 : 1;
}
