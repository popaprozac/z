struct Counter {
  count: i32;

  function add(inout this, amount: i32): void {
    this.count = this.count + amount;
  }
}

struct Heap {
  strings: Array<Array<u8>>;
  small: Array<u8>;
  counter: Counter;
  step: i32;

  function extend(inout this, target: usize, first: usize, last: usize): void {
    this.strings[target].append(this.small.slice(first, last));
  }

  function bump(inout this): void {
    this.counter.add(this.step);
  }
}

function main(): i32 {
  let heap = Heap({
    strings: Array<Array<u8>>(Array<u8>(1), Array<u8>()),
    small: Array<u8>(7, 8, 9),
    counter: Counter({ count: 40 }),
    step: 2,
  });
  heap.extend(0, 1, 3);
  heap.extend(1, 0, 1);
  heap.bump();
  if (heap.strings[0].length != 3 || heap.strings[0][2] != 9 || heap.strings[1][0] != 7) return 1;
  if (heap.counter.count != 42) return 2;
  return 0;
}
