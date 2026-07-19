import console from "std/console";
import Swift from "ZSwiftOwned-Swift.hpp";

struct CounterOwner {
  counter: Swift.OwnedCounter;
}

function main(): i32 {
  const first = Swift.OwnedCounter.init(40);
  const copied = first;
  const owner = CounterOwner({ counter: copied });
  const ownerCopy = owner;
  let changed = Swift.roundTrip(ownerCopy.counter);
  changed.setValue(42);

  const firstValue = first.getValue();
  const copiedValue = owner.counter.getValue();
  const changedValue = changed.getValue();
  const description: String = Swift.describeOwnedCounter(changed);
  const embedded: String = Swift.embeddedNullString();
  console.log(`first=${firstValue}, copied=${copiedValue}, changed=${changedValue}`);
  console.log(description);
  console.log(`embedded=${embedded}`);
  return changedValue - 42;
}
