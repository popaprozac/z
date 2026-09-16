import { ByteBuffer } from "./array-capacity-types.zs";

type Bytes = Array<u8>;

function buffer<T>(size: usize): Array<T> {
  return Array<T>.withCapacity(size);
}

struct Storage { values: Array<i32>; }
struct Factory {
  function withCapacity(size: usize): Array<i32> {
    return Array<i32>(i32(size));
  }
}

function grow(inout values: Array<i32>): void {
  values.reserveCapacity(16);
}

function main(): i32 {
  let bytes = Bytes.withCapacity(8);
  bytes.push(65);
  let imported = ByteBuffer.withCapacity(8);
  imported.push(66);
  if (imported.length != 1 || imported[0] != 66) return 4;
  let values = buffer<i32>(8);
  values.push(42);
  grow(inout values);
  if (values.length != 1 || values.capacity < 16 || values[0] != 42) return 1;
  let storage = Storage({ values });
  storage.values.reserveCapacity(32);
  if (storage.values.length != 1 || storage.values[0] != 42) return 2;
  const factory = Factory();
  const custom = factory.withCapacity(8);
  if (custom.length != 1 || custom[0] != 8) return 3;
  return 0;
}
