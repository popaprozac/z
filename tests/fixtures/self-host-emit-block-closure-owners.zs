import console from "std/console";
import json from "std/json";

struct Message {
  text: String;
}

struct Receipt {
  label: String;

  deinit {
    console.log(`released ${this.label}`);
  }
}

readonly class Listener {
  prefix: String;

  deinit {
    console.log(`released listener ${this.prefix}`);
  }
}

type Handler = (in message: Message) => void;

function dispatch(in handler: Handler, in text: String): void {
  const message = Message({ text: copy text });
  handler(in message);
}

function consume(receipt: Receipt): void {
  console.log(`consumed ${receipt.label}`);
}

function main(): i32 {
  const listener = new Listener({ prefix: "notes" });
  const handler: Handler = move (in message: Message): void => {
    const encoded = match (attempt json.encode(in message)) {
      success(value) => value;
      failure(_) => return;
    };
    console.log(`${listener.prefix}: ${encoded}`);
    const outer = Receipt({ label: copy message.text });
    if (message.text == "early") return;
    if (message.text == "move") {
      consume(move outer);
      return;
    }
    const pending = Option.some(Receipt({ label: "payload" }));
    match (pending) {
      some(receipt) => {
        const nested = Receipt({ label: "nested" });
        console.log(receipt.label);
      }
      none => {}
    }
  };
  dispatch(in handler, "early");
  dispatch(in handler, "move");
  dispatch(in handler, "normal");
  return 0;
}
