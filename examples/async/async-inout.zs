import console from "std/console";
import { delay } from "std/time";
import { zcpp } from "../../tests/fixtures/move-only.hpp";

struct Counter {
  value: i32;

  function add(inout this, amount: i32): void {
    this.value = this.value + amount;
  }
}

async function addAfter(inout counter: Counter, amount: i32): void {
  await delay(1);
  counter.add(amount);
}

async function adjustNativeAfter(inout resource: zcpp.UniqueValue, amount: i32): i32 {
  await delay(1);
  resource.add(amount);
  return resource.value();
}

async function main(): i32 {
  let counter = Counter({ value: 40 });
  await addAfter(inout counter, 2);

  let nativeResource = zcpp.UniqueValue(40);
  const nativeValue = await adjustNativeAfter(inout nativeResource, 2);
  const finished = nativeResource.finish(0);
  const live = zcpp.unique_live();

  console.log(`counter=${counter.value}, native=${nativeValue}, finished=${finished}, live=${live}`);
  return counter.value - 42 + nativeValue - 42 + finished - 42 + live;
}
