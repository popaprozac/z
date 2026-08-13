import { Arena } from "std/memory";

struct Coordinate {
  value: i32;
}

struct Span {
  first: view Coordinate;
  last: view Coordinate;
}

enum MaybeSpan {
  some Span,
  none,
}

enum Choice {
  present,
  absent,
}

function main(): i32 {
  let arena = Arena();
  const first = arena.create(Coordinate({ value: 20 }));
  const last = arena.create(Coordinate({ value: 22 }));
  const conditional = if (first.value == 20) {
    select MaybeSpan.some(Span({ first, last }));
  } else {
    select MaybeSpan.none;
  };
  const storedConditional = arena.create(conditional);
  const choice = Choice.present;
  const matched = match (choice) {
    present => MaybeSpan.some(Span({ first, last }));
    absent => MaybeSpan.none;
  };
  const storedMatched = arena.create(matched);
  return 0;
}
