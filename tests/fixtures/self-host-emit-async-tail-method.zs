import console from "std/console";

struct Request {
  payload: String;
}

readonly class Source {
  readonly prefix: String;

  deinit {
    console.log("released method source");
  }
}

type Operation = async (in request: Request) => String;

readonly class Relay {
  readonly name: String;

  deinit {
    console.log("released relay method");
  }

  async function invoke(
    operation: Operation,
    in request: Request
  ): String {
    return await operation(in request);
  }
}

async function main(): i32 {
  const relay = new Relay({ name: "notes" });
  const source = new Source({ prefix: "native" });
  const operation: Operation = async move (
    in request: Request
  ): String => source.prefix == "native"
    ? copy request.payload
    : "invalid";
  const request = Request({ payload: "native method child" });
  const result = await relay.invoke(move operation, in request);
  return result == "native method child" ? 0 : 1;
}
