import embed from "std/embed";

const DATA: embed.StaticBytes = embed.bytes("./slice-argument-storage-data.txt");

struct Holder {
  bytes: Array<u8>;
  rows: Array<i32>[2];

  function count(): usize {
    return total(this.bytes);
  }
}

function total(values: Slice<u8>): usize {
  return values.length;
}

function forward(values: Slice<u8>): usize {
  return total(values);
}

function rowLength(values: Slice<i32>): usize {
  return values.length;
}

function main(): i32 {
  const local = Array<u8>(1, 2, 3);
  const fixed = [4, 5];
  const holder = Holder({ bytes: Array<u8>(6), rows: [Array<i32>(1), Array<i32>(2, 3)] });
  const sum = total(local) + forward(local) + total(DATA) + holder.count() + total(holder.bytes)
    + rowLength(holder.rows[1]);
  const fixedCount = rowLength(fixed);
  return sum == 12 && fixedCount == 2 ? 0 : 1;
}
