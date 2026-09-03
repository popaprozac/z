export readonly class RawIdentity {
  readonly value: i32;

  constructor(value: i32) {
    this.value = value;
  }
}

export readonly class MessageBox<T> {
  readonly value: T;
  readonly identity: RawIdentity;

  constructor(value: T, identity: RawIdentity) {
    this.value = value;
    this.identity = move identity;
  }
}

export readonly class TypedWorker<T> {
  readonly messages: MessageBox<T>;

  constructor(value: T, identity: RawIdentity) {
    this.messages = new MessageBox<T>(value, move identity);
  }

  function current(): T {
    return this.messages.value;
  }
}

export function createTypedWorker<T>(value: T): TypedWorker<T> {
  const identity = new RawIdentity(42);
  return new TypedWorker<T>(value, move identity);
}

export readonly struct WorkerMarker<T> {}

export type I32WorkerMarker = WorkerMarker<i32>;

export function acceptMarker(marker: WorkerMarker<i32>): i32 {
  return 0;
}
