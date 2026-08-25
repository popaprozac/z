import { scheduler } from "std/async";

struct Request {
  body: String;
}

readonly class Source {
  readonly prefix: String;

  async function load(in request: Request): String {
    await scheduler.yield();
    return `${this.prefix}:${request.body}`;
  }

  async function decorate(in value: String): String {
    await scheduler.yield();
    return `${value}:decorated`;
  }
}

async function buildResponse(
  source: Source,
  in request: Request
): String {
  const loaded = await source.load(in request);
  const separator = "|";
  const decorated = await source.decorate(in loaded);
  return `${loaded}${separator}${decorated}`;
}

async function main(): i32 {
  const source = new Source({ prefix: "native" });
  const request = Request({ body: "two waits" });
  const response = await buildResponse(source, in request);
  return response
      == "native:two waits|native:two waits:decorated"
    ? 0
    : 1;
}
