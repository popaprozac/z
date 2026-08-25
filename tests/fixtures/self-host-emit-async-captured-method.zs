import { thread } from "std/thread";

struct Request {
  payload: String;
}

trait Source {
  async function load(in request: Request): String;
}

readonly class PrefixSource implements Source {
  readonly prefix: String;

  async function load(in request: Request): String {
    return `${this.prefix}:${request.payload}`;
  }
}

type Handler = async (in request: Request) => String on thread.any;

function createHandler<T: Source>(source: T): Handler {
  return async move (
    in request: Request
  ): String => await source.load(in request);
}

async function main(): i32 {
  const handler = createHandler(
    new PrefixSource({ prefix: "native" })
  );
  const request = Request({ payload: "captured method" });
  const result = await handler(in request);
  return result == "native:captured method" ? 0 : 1;
}
