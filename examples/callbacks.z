import console from "std/console";
import {
  apply,
  applyWithContext,
  clearRetainedOperation,
  invokeRetainedOperation,
  retainOperation
} from "callbacks.h";

struct Offset {
  value: i32;

  deinit {
    console.log(`released offset=${this.value}`);
  }
}

function multiply(left: i32, right: i32): i32 {
  return left * right;
}

function installRetainedOperation(): void {
  const offset = Offset({ value: 2 });
  retainOperation(move (value) => value + offset.value);
}

function main(): i32 {
  const product = apply(6, 7, multiply);

  const total = apply(20, 22, (left, right) => left + right);

  const offset = 2;
  const captured = applyWithContext(40, (value) => value + offset);

  installRetainedOperation();
  const escaped = invokeRetainedOperation(40);
  clearRetainedOperation();

  console.log(`product=${product}, total=${total}, captured=${captured}, escaped=${escaped}`);
  return 0;
}
