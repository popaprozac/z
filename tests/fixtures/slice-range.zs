struct Holder {
  bytes: Array<u8>;
  other: Array<u8>;

  function copyTail(inout this, first: usize): void {
    this.other.append(this.bytes.slice(first, this.bytes.length));
  }
}

struct Pair {
  first: i32;
  second: i32;
}

function pairTotal(pairs: Slice<Pair>): i32 {
  let sum = 0;
  let index: usize = 0;
  while (index < pairs.length) {
    sum = sum + pairs[index].first + pairs[index].second;
    index = index + 1;
  }
  return sum;
}

function total(values: Slice<i32>): i32 {
  let sum = 0;
  let index: usize = 0;
  while (index < values.length) {
    sum = sum + values[index];
    index = index + 1;
  }
  return sum;
}

function middle(values: Slice<i32>): i32 {
  return total(values.slice(1, values.length - 1));
}

function main(): i32 {
  const fixed = [1, 2, 3, 4];
  const dynamic = Array<i32>(10, 20, 30);
  let joined = Array<i32>();
  joined.append(fixed.slice(1, 3));
  joined.append(dynamic.slice(0, 0));
  joined.append(dynamic.slice(2, 3));
  let holder = Holder({ bytes: Array<u8>(1, 2, 3), other: Array<u8>() });
  holder.copyTail(1);
  if (total(fixed.slice(0, 2)) != 3 || middle(dynamic) != 20) return 1;
  if (joined.length != 3 || joined[0] != 2 || joined[2] != 30) return 2;
  if (holder.other.length != 2 || holder.other[1] != 3) return 3;
  // A range whose elements are a struct: the range helper needs the
  // struct complete where it is emitted.
  let pairs = Array<Pair>();
  pairs.push(Pair({ first: 1, second: 2 }));
  pairs.push(Pair({ first: 3, second: 4 }));
  pairs.push(Pair({ first: 5, second: 6 }));
  if (pairTotal(pairs.slice(1, 3)) != 18 || pairTotal(pairs.slice(0, 0)) != 0) return 4;
  return 0;
}
