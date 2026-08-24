import { scheduler } from "std/async";
import console from "std/console";

struct Request {
  payload: String;
}

enum Response {
  success String,
  failure String,
}

readonly class Service {
  readonly prefix: String;

  deinit {
    console.log("released async service");
  }

  async function invoke(in request: Request): Response {
    await scheduler.yield();
    if (this.prefix != "search") {
      return Response.failure("INVALID_SERVICE");
    }
    return Response.success(copy request.payload);
  }
}

async function main(): i32 {
  const service = new Service({ prefix: "search" });
  const request = Request({ payload: "native async method" });
  const response = await service.invoke(in request);
  return match (response) {
    success(value) => value == "native async method" ? 0 : 1;
    failure(_) => 2;
  };
}
