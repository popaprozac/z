import console from "std/console";

struct Message {
  payload: String;
}

type MessageHandler = (in message: Message) => void;

function dispatch(handler: MessageHandler): void {
  const message = Message({ payload: "ready" });
  handler(in message);
}

function main(): i32 {
  dispatch(
    move (in message: Message): void => console.log(
      `worker message: ${message.payload}`
    )
  );
  return 0;
}
