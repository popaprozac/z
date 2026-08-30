export class Event<T> {
  value: T;

  function current(): T {
    return this.value;
  }

  function inspect(value: T, handler: (in value: T) => void): void {
    handler(in value);
  }

  function notify(value: T, handler: (in value: T) => void): void {
    this.inspect(value, handler);
  }
}

export readonly class Events {
  readonly closed: Event<i32>;

  constructor(value: i32) {
    this.closed = new Event<i32>({ value });
  }
}

export function createEvents(value: i32): Events {
  return new Events(value);
}

class CallbackBox {
  callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
  }

  function run(): void {
    this.callback();
  }
}

export function runCallback(callback: () => void): void {
  const box = new CallbackBox(callback);
  box.run();
}
