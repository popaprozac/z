struct Holder {
  bytes: Array<u8>;
  other: Array<u8>;

  function copyTail(inout this, first: usize): void {
    this.other.append(this.bytes.slice(first, this.bytes.length));
  }
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
  return 0;
}
