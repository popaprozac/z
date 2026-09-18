import console from "std/console";

function lengthOf(source: Slice<u8>): usize {
  return source.length;
}

function expectLength(value: usize): boolean { return value == 3; }

function copyOf(source: Slice<u8>): Array<u8> {
  let bytes = Array<u8>.withCapacity(source.length);
  const inferred = source.length;
  const adjusted = source.length + 1;
  if (!expectLength(source.length) || inferred != 3 || adjusted != 4) {
    return bytes;
  }
  bytes.reserveCapacity(source.length + 2);
  let index: usize = 0;
  while (index < source.length) {
    bytes.push(source[index]);
    index = index + 1;
  }
  return bytes;
}

function main(): i32 {
  const bytes = Array<u8>(1, 2, 3);
  if (lengthOf(bytes) != 3) return 1;
  const copied = copyOf(bytes);
  if (copied.length != 3 || copied[2] != 3) return 2;
  console.log("ok");
  return 0;
}
