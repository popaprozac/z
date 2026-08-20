export struct Pair<T> {
  first: T;
  second: T;

  static function create(first: T, second: T): Pair<T> {
    return Pair({ first, second });
  }

  function replaceSecond(inout this, value: T): void {
    this.second = value;
  }
}

export function makePair(first: i32, second: i32): Pair<i32> {
  return Pair.create(first, second);
}

export function total(in pair: Pair<i32>): i32 {
  return pair.first + pair.second;
}
