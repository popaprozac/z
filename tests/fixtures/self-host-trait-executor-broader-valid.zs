import { MainReadable } from "./self-host-trait-executor-contract.zs";

class Snapshot implements MainReadable {
  readonly value: i32;

  function read(): i32 {
    return this.value;
  }
}

function main(): i32 {
  const snapshot = new Snapshot({ value: 42 });
  return snapshot.read() - 42;
}
