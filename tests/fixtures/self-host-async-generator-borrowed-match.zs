import { AsyncGenerator } from "std/iteration";
import { delay } from "std/time";

enum Route {
  publish String,
  idle,
}

async function values(route: Route): AsyncGenerator<usize> {
  match (in route) {
    publish(value) => {
      await delay(1);
      yield value.byteLength;
    }
    idle => {}
  }
}
