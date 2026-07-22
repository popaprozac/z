import stdio from "stdio.h";

struct Pair<T> {
  first: T;
  second: T;

  static function make(first: T, second: T): Pair<T> {
    return Pair({ first, second });
  }

  function choose<U>(left: U, right: U): U {
    if (this.first > 0) return left;
    return right;
  }
}

struct Utility {
  static function preserve<T>(value: T): T {
    return value;
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
  const left = pair.choose(first(pair), pair.second);
  const right = Utility.preserve(identity(explicit.second));
  stdio.printf("generic=%d\n", left + right);
  return 0;
}
