import console from "std/console";

type Callback = () => i32;
type Notification = () => void;

function released(): void { console.log("released owner"); }

struct Receipt {
  label: String;
  deinit {
    const notify: Notification = released;
    notify();
  }
}

class Controller {
  callback: Callback;

  constructor(text: String) {
    const callback: Callback = move (): i32 => i32(text.byteLength);
    this.callback = callback;
    if (callback() != 6) console.log("incorrect constructor callback");
  }

  deinit {
    const notify: Notification = released;
    notify();
  }
}

struct GenericReceipt<T> {
  value: T;
  deinit {
    const notify: Notification = released;
    notify();
  }
}

class GenericController<T> {
  value: T;
  callback: Callback;
  constructor(value: T, text: String) {
    this.value = value;
    const callback: Callback = move (): i32 => i32(text.byteLength);
    this.callback = callback;
  }
  deinit {
    const notify: Notification = released;
    notify();
  }
}

function main(): i32 {
  const source = "answer!";
  const receipt = Receipt({ label: source.copyBytes(0, 6) });
  const controller = new Controller(source.copyBytes(0, 6));
  if (controller.callback() != 6) return 1;
  const genericReceipt = GenericReceipt<i32>({ value: 42 });
  const genericController = new GenericController<i32>(42, source.copyBytes(0, 6));
  if (genericController.callback() != 6) return 2;
  return 0;
}
