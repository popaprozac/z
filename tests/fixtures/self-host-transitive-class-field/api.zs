export class Counter {
  value: i32;

  function add(inout this, amount: i32): void {
    this.value = this.value + amount;
  }
}

export readonly class Config {
  readonly counter: Counter;
}

export function createConfig(): Config {
  return new Config({
    counter: new Counter({ value: 40 }),
  });
}
