import console from "std/console";
import { Map } from "std/collections";
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

enum MaybeStoredSpan {
  some TokenSpan,
  none,
}

struct StoredNode {
  kind: StoredSpan;
}

struct LinkedNode {
  value: i32;
  next: Option<view LinkedNode>;
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

function maybeStoredSpanLength(in value: MaybeStoredSpan): usize {
  return match (in value) {
    some(span) => spanLength(in span);
    none => 0;
  };
}

function linkedNextValue(in value: LinkedNode): i32 {
  const next = value.next;
  return match (in next) {
    some(node) => node.value;
    none => 0;
  };
}

function optionalLinkedValue(in value: Option<LinkedNode>): i32 {
  return match (in value) {
    some(node) => node.value;
    none => 0;
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
  let other = Arena({ initialCapacity: 64 });
  const absentPending = MaybeStoredSpan.none;
  const absent = other.create(absentPending);
  const absentLength = maybeStoredSpanLength(in absent);
  const maybeFirst = arena.create(TokenCoordinate({ offset: 9 }));
  const maybeLast = arena.create(TokenCoordinate({ offset: 51 }));
  const presentPending = MaybeStoredSpan.some(TokenSpan({
    first: maybeFirst,
    last: maybeLast,
  }));
  const present = arena.create(presentPending);
  const presentLength = maybeStoredSpanLength(in present);
  const linkedTailPending = LinkedNode({
    value: 22,
    next: Option<view LinkedNode>.none,
  });
  const linkedTail = arena.create(linkedTailPending);
  const linkedHeadPending = LinkedNode({
    value: 20,
    next: Option<view LinkedNode>.some(linkedTail),
  });
  const linkedHead = arena.create(linkedHeadPending);
  const linkedValue = linkedNextValue(in linkedHead);
  let linkedByName = Map<String, LinkedNode>();
  const mappedPending = LinkedNode({
    value: 41,
    next: Option<view LinkedNode>.some(linkedTail),
  });
  linkedByName.set("compiler", mappedPending);
  const retainedPending = LinkedNode({
    value: 7,
    next: Option<view LinkedNode>.some(linkedTail),
  });
  linkedByName.set("retained", retainedPending);
  const mapped = linkedByName.get("compiler");
  const mappedValue = match (in mapped) {
    some(node) => node.value + linkedNextValue(in node);
    none => 0;
  };
  const removed = linkedByName.remove("compiler");
  const removedValue = match (in removed) {
    some(node) => node.value;
    none => 0;
  };
  const storedRemoved = arena.create(removed);
  const storedRemovedValue = optionalLinkedValue(in storedRemoved);
  if (linkedByName.has("compiler")) return 1;
  const retained = linkedByName.get("retained");
  const retainedValue = match (in retained) {
    some(node) => node.value;
    none => 0;
  };
  const storedMapPending = LinkedNode({
    value: 20,
    next: Option<view LinkedNode>.some(linkedTail),
  });
  linkedByName.set("stored", storedMapPending);
  const storedLinks = arena.create(linkedByName);
  const storedMapped = storedLinks.get("stored");
  const storedMappedValue = match (in storedMapped) {
    some(node) => node.value;
    none => 0;
  };
  if (populatedLength != 42) return 1;
  if (arrayLength != 42) return 1;
  if (spans.length != 1) return 1;
  if (matched.length != 1) return 1;
  if (enumLength != 42) return 1;
  if (directLength != 42) return 1;
  if (absentLength != 0) return 1;
  if (presentLength != 42) return 1;
  if (linkedValue != 22) return 1;
  if (mappedValue != 63) return 1;
  if (removedValue != 41) return 1;
  if (storedRemovedValue != 41) return 1;
  if (retainedValue != 7) return 1;
  if (storedMappedValue != 20) return 1;
  console.log(`stored arena span ${length}`);
  arena.reset();
  other.reset();
  return i32(length) - 42;
}
