import { thread } from "std/thread";

struct Invocation {
  value: i32;
}

type Handler = (in invocation: Invocation) => i32 on thread.any;

trait Service {
  function invoke(in invocation: Invocation): i32;
}

function handlerFor<T: Service>(service: T): Handler {
  return move (in invocation: Invocation): i32 =>
    service.invoke(in invocation);
}

readonly class CounterService implements Service {
  readonly offset: i32;

  function invoke(in invocation: Invocation): i32 {
    return invocation.value + this.offset;
  }
}

function main(): i32 {
  const handler = handlerFor(new CounterService({ offset: 2 }));
  const invocation = Invocation({ value: 40 });
  return handler(in invocation) - 42;
}
