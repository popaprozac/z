import { scheduler } from "std/async";

struct Request {
  payload: String;
}

readonly class Source {
  readonly prefix: String;

  async function load(in request: Request): String {
    await scheduler.yield();
    return `${this.prefix}:${request.payload}`;
  }
}

async function dispatch(
  source: Source,
  in request: Request
): String {
  const loaded = await source.load(in request);
  if (loaded != "native:linear child") return "invalid";
  return move loaded;
}

async function main(): i32 {
  const source = new Source({ prefix: "native" });
  const request = Request({ payload: "linear child" });
  const result = await dispatch(source, in request);
  return result == "native:linear child" ? 0 : 1;
}
