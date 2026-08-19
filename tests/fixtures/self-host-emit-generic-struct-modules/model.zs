export struct Pair<T> {
  first: T;
  second: T;

  function replaceSecond(inout this, value: T): void {
    this.second = value;
  }
}

export function makePair(first: i32, second: i32): Pair<i32> {
  return Pair({ first, second });
}

export function total(in pair: Pair<i32>): i32 {
  return pair.first + pair.second;
}
