import stdio from "stdio.h";

struct Counter {
  value: i32;

  function bump(inout this): void {
    add(inout this, 1);
  }
}

struct Resource {
  id: i32;

  deinit {
    stdio.printf("drop=%d\n", this.id);
  }
}

function read(in counter: Counter): i32 {
  return counter.value;
}

function add(inout counter: Counter, amount: i32): void {
  counter.value = counter.value + amount;
}

function forward(inout counter: Counter): void {
  add(inout counter, 2);
}

function inspect(in resource: Resource): i32 {
  return resource.id;
}

function main(): i32 {
  let counter = Counter({ value: 10 });
  add(inout counter, 3);
  forward(inout counter);
  counter.bump();

  const resource = Resource({ id: 42 });
  stdio.printf(
    "counter=%d literal=%d resource=%d\n",
    read(counter),
    read(Counter({ value: 7 })),
    inspect(resource)
  );
  return 0;
}
