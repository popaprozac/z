import console from "std/console";
import { scheduler } from "std/async";
import { thread } from "std/thread";

struct ServiceRequest {
  message: String;

  deinit {
    console.log(`released request ${this.message}`);
  }
}

struct RoutedResponse {
  message: String;

  deinit {
    console.log(`released routed ${this.message}`);
  }
}

struct PublishedResponse {
  code: i32;
  message: String;

  deinit {
    console.log(`released published ${this.message}`);
  }
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

readonly class ServiceRouter {
  readonly prefix: String;

  async function route(in request: ServiceRequest): RoutedResponse {
    await scheduler.yield();
    return RoutedResponse({
      message: `${this.prefix}${request.message}`,
    });
  }
}

async function publish(
  response: RoutedResponse
): PublishedResponse on thread.main {
  console.log(`published ${response.message}`);
  return PublishedResponse({
    code: 42,
    message: duplicate(response.message),
  });
}

async function handle(
  router: ServiceRouter,
  request: ServiceRequest
): i32 {
  const routed = await router.route(in request);
  const published = await on thread.main publish(routed);
  console.log(`observed ${published.message}`);
  return published.code == 42 ? 0 : 1;
}

async function main(): i32 on thread.main {
  const router = new ServiceRouter({ prefix: duplicate("routed ") });
  return await handle(
    router,
    ServiceRequest({ message: duplicate("service response") })
  );
}
