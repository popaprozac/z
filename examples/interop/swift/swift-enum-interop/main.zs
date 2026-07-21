import console from "std/console";
import Swift from "ZSwiftState-Swift.hpp";

function main(): i32 {
  const ready = Swift.LoadState.ready(42);
  const idle = Swift.LoadState.idle();
  const copied = ready;

  const readyValue = ready.value();
  const idleValue = idle.value();
  const copiedValue = copied.value();
  console.log(`ready=${readyValue}, idle=${idleValue}, copy=${copiedValue}`);
  return readyValue + idleValue - copiedValue + 1;
}
