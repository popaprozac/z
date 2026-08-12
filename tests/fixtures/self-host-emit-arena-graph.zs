import console from "std/console";
import { Arena } from "std/memory";

struct TokenCoordinate {
  offset: usize;
}

struct TokenSpan {
  first: view TokenCoordinate;
  last: view TokenCoordinate;
}

struct NamedTokenSpan {
  name: String;
  span: view TokenSpan;
}

enum SpanChoice {
  primary,
  alternate,
}

function spanLength(in span: TokenSpan): usize {
  const first = span.first;
  const last = span.last;
  return last.offset - first.offset;
}

function main(): i32 {
  let arena = Arena({ initialCapacity: 128 });
  const first = arena.create(TokenCoordinate({ offset: 20 }));
  const last = arena.create(TokenCoordinate({ offset: 62 }));
  const populatedPending = TokenSpan({ first, last });
  const populatedSpans = Array<TokenSpan>(populatedPending);
  const populated = arena.create(populatedSpans);
  const populatedLength = spanLength(populated[0]);
  const stored = arena.create(TokenSpan({ first, last }));
  const namedPending = NamedTokenSpan({ name: "compiler", span: stored });
  const named = arena.create(namedPending);
  const length = spanLength(named.span);
  const pending = TokenSpan({ first, last });
  let pendingSpans = Array<TokenSpan>();
  if (first.offset == 20) {
    pendingSpans.push(pending);
  } else {
    pendingSpans.push(pending);
  }
  const spans = arena.create(pendingSpans);
  const arrayLength = spanLength(spans[0]);
  const matchFirst = arena.create(TokenCoordinate({ offset: 20 }));
  const matchLast = arena.create(TokenCoordinate({ offset: 62 }));
  const matchPending = TokenSpan({ first: matchFirst, last: matchLast });
  let matchedSpans = Array<TokenSpan>();
  const choice = SpanChoice.primary;
  match (choice) {
    primary => matchedSpans.push(matchPending);
    alternate => matchedSpans.push(matchPending);
  }
  const matched = arena.create(matchedSpans);
  if (populatedLength != 42) return 1;
  if (arrayLength != 42) return 1;
  if (spans.length != 1) return 1;
  if (matched.length != 1) return 1;
  console.log(`stored arena span ${length}`);
  arena.reset();
  return i32(length) - 42;
}
