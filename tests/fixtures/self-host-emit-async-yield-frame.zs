import console from "std/console";
import { scheduler } from "std/async";

class Receipt {
  label: String;
  deinit { console.log(`released ${this.label}`); }
}

struct Delivery {
  selected: Receipt;
  discarded: Receipt;
  title: String;
}

function delivery(): Delivery {
  console.log("prepared delivery");
  return Delivery({
    selected: new Receipt({ label: "selected" }),
    discarded: new Receipt({ label: "discarded" }),
    title: "notes",
  });
}

async function traverse(): i32 {
  const { selected, title } = delivery();
  let count = 0;
  while (count < 4) {
    count = count + 1;
    if (count == 1) {
      await scheduler.yield();
      continue;
    }
    if (count == 2) {
      await scheduler.yield();
    } else {
      await scheduler.yield();
      break;
    }
  }
  console.log(selected.label);
  if (count != 3 || title != "notes") return 1;
  return 0;
}

async function waitForCancellation(): void {
  const { selected } = delivery();
  while (true) {
    await scheduler.yield();
    console.log(selected.label);
  }
}

async function main(): i32 {
  return await traverse();
}
