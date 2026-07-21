import stdio from "stdio.h";

struct Pair<T> {
  first: T;
  second: T;

  static function make(first: T, second: T): Pair<T> {
    return Pair({ first, second });
  }
}

function first<T>(pair: Pair<T>): T {
  return pair.first;
}

function identity<T>(value: T): T {
  return value;
}

function main(): i32 {
  const pair = Pair({ first: 20, second: 22 });
  const explicit = Pair.make<i32>(pair.first, pair.second);
  const left = first(pair);
  const right = identity(explicit.second);
  stdio.printf("generic=%d\n", left + right);
  return 0;
}
