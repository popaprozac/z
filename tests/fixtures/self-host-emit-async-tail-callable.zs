import console from "std/console";

struct Request {
  payload: String;
}

readonly class Source {
  readonly prefix: String;

  deinit {
    console.log("released relay source");
  }
}

type Operation = async (in request: Request) => String;

async function relay(
  operation: Operation,
  in request: Request
): String {
  return await operation(in request);
}

async function main(): i32 {
  const source = new Source({ prefix: "native" });
  const operation: Operation = async move (
    in request: Request
  ): String => source.prefix == "native"
    ? copy request.payload
    : "invalid";
  const request = Request({ payload: "native child frame" });
  const result = await relay(move operation, in request);
  return result == "native child frame" ? 0 : 1;
}
