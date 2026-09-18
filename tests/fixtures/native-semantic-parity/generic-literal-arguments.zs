import console from "std/console";

function accept<T>(value: T): T { return value; }

function append<T>(inout values: Array<T>, value: T): void {
  values.push(value);
}

function dollars<T>(in source: Array<T>): Array<T> {
  let result = Array<T>();
  let index: usize = 0;
  while (index < source.length) {
    if (source[index] == 36) {
      result.push(36);
      append<T>(inout result, 36);
      result.push(accept<T>(36));
    }
    index = index + 1;
  }
  return result;
}

struct Builder<T> {
  function value(): T { return accept<T>(300); }
}

struct Factory {
  function value<T>(): T { return accept<T>(300); }
}

function largest<T>(): T { return accept<T>(18446744073709551615); }
function smallest<T>(): T { return accept<T>(-9223372036854775808); }

function main(): i32 {
  const bytes = Array<u8>(36, 65, 36);
  const narrow = dollars<u8>(bytes);
  if (narrow.length != 6 || narrow[5] != 36) return 1;
  const units = Array<u16>(300, 36);
  const wide = dollars<u16>(units);
  if (wide.length != 3 || wide[2] != 36) return 2;
  const builder = Builder<u16>();
  const factory = Factory();
  if (builder.value() != 300 || factory.value<u16>() != 300) return 3;
  if (largest<u64>() != 18446744073709551615) return 4;
  if (smallest<i64>() != -9223372036854775808) return 5;
  console.log("ok");
  return 0;
}
