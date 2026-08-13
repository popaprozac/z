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

enum StoredSpan {
  span TokenSpan,
  alternate TokenSpan,
}

struct StoredNode {
  kind: StoredSpan;
}

function spanLength(in span: TokenSpan): usize {
  const first = span.first;
  const last = span.last;
  return last.offset - first.offset;
}

function storedSpanLength(in value: StoredSpan): usize {
  return match (in value) {
    span(span) => spanLength(in span);
    alternate(span) => spanLength(in span);
  };
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
  const enumFirst = arena.create(TokenCoordinate({ offset: 20 }));
  const enumLast = arena.create(TokenCoordinate({ offset: 62 }));
  const enumPending = StoredNode({
    kind: StoredSpan.span(TokenSpan({ first: enumFirst, last: enumLast })),
  });
  const enumStored = arena.create(enumPending);
  const enumKind = enumStored.kind;
  const enumLength = storedSpanLength(in enumKind);
  const directFirst = arena.create(TokenCoordinate({ offset: 1 }));
  const directLast = arena.create(TokenCoordinate({ offset: 43 }));
  const directPending = StoredSpan.alternate(TokenSpan({
    first: directFirst,
    last: directLast,
  }));
  const directStored = arena.create(directPending);
  const directLength = storedSpanLength(in directStored);
  if (populatedLength != 42) return 1;
  if (arrayLength != 42) return 1;
  if (spans.length != 1) return 1;
  if (matched.length != 1) return 1;
  if (enumLength != 42) return 1;
  if (directLength != 42) return 1;
  console.log(`stored arena span ${length}`);
  arena.reset();
  return i32(length) - 42;
}
