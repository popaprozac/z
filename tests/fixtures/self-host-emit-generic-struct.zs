struct Pair<T> {
  first: T;
  second: T;
}

struct Box<T> {
  value: T;
}

function main(): i32 {
  const numbers = Pair({ first: 20, second: 22 });
  const nested = Pair({
    first: Box({ value: 20 }),
    second: Box({ value: 22 }),
  });
  const words = Pair({ first: "native", second: "generic" });
  const copied = Pair({ copy ...words, second: "layout" });
  const moved = Pair({ move ...copied, first: "owned" });
  const { first: movedFirst, second: movedSecond } = move moved;

  if (words.first.byteLength != 6) return 1;
  if (movedFirst.byteLength + movedSecond.byteLength != 11) return 2;
  if (nested.first.value + nested.second.value != 42) return 3;
  return numbers.first + numbers.second - 42;
}
