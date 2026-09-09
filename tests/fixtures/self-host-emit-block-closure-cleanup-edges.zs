import console from "std/console";

struct Receipt {
  label: String;

  deinit {
    console.log(`released ${this.label}`);
  }
}

struct DeliveryError {
  message: String;

  deinit {
    console.log(`released error ${this.message}`);
  }
}

struct Batch {
  first: String;
  second: String;
}

type Handler = (in mode: i32) => void throws DeliveryError;

function prepare(mode: i32): Receipt throws DeliveryError {
  if (mode == 0) throw DeliveryError({ message: "prepare" });
  return Receipt({ label: "prepared" });
}

function deliver(in handler: Handler, mode: i32): void {
  match (attempt handler(in mode)) {
    success => console.log("delivered");
    failure(error) => console.log(error.message);
  }
}

function main(): i32 {
  const prefix = "delivery";
  const handler: Handler = move (in mode: i32): void throws DeliveryError => {
    const prior = Receipt({ label: copy prefix });
    const prepared = try prepare(mode);
    if (mode == 1) throw DeliveryError({ message: "callback" });
    const batch = Batch({
      first: `first ${mode}`,
      second: `second ${mode}`,
    });
    const { first, second } = move batch;
    let index = 0;
    while (index < 3) {
      index = index + 1;
      const iteration = Receipt({ label: `iteration ${index}` });
      if (index == 1) continue;
      if (index == 2) break;
    }
    if (mode == 2) return;
    console.log(first);
    console.log(second);
  };
  deliver(in handler, 0);
  deliver(in handler, 1);
  deliver(in handler, 2);
  deliver(in handler, 3);
  return 0;
}
