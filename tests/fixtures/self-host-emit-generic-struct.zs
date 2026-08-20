struct Pair<T> {
  first: T;
  second: T;
}

struct Box<T> {
  value: T;
}

struct Cell<T> {
  value: T;

  static function create(value: T): Cell<T> {
    return Cell({ value });
  }

  function occupied(): boolean {
    return true;
  }

  function replace(inout this, next: T): void {
    this.value = next;
  }

  function take(move this): T {
    return this.value;
  }
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
  let number = Cell.create(20);
  number.replace(22);
  if (!number.occupied()) return 1;
  const numberValue = number.take();
  let word = Cell.create("old");
  word.replace("native");
  const wordValue = word.take();

  if (words.first.byteLength != 6) return 1;
  if (movedFirst.byteLength + movedSecond.byteLength != 11) return 2;
  if (nested.first.value + nested.second.value != 42) return 3;
  if (wordValue.byteLength != 6) return 4;
  return numbers.first + numbers.second + numberValue - 64;
}
