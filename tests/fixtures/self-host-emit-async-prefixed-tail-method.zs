import console from "std/console";

struct Request {
  payload: String;

  deinit {
    console.log("released forwarded request");
  }
}

readonly class Source {
  readonly prefix: String;

  deinit {
    console.log("released prefixed source");
  }
}

type Operation = async (in request: Request) => String;

readonly class Relay {
  readonly name: String;

  deinit {
    console.log("released prefixed relay");
  }

  async function invoke(
    operation: Operation,
    in request: Request
  ): String {
    const forwarded = Request({
      payload: copy request.payload,
    });
    return await operation(in forwarded);
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
  const request = Request({ payload: "prefixed method child" });
  const result = await relay.invoke(move operation, in request);
  return result == "prefixed method child" ? 0 : 1;
}
