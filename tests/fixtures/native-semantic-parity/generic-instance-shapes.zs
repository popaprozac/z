import console from "std/console";
import { TextBuffer } from "std/text";
import { replace } from "std/memory";
import { Channel } from "std/channel";

struct Box<T> {
  item: T;
  spare: Option<T>;
}

struct Pair<T> {
  left: T;
  right: T;
}

function heap(text: String): String {
  let buffer = TextBuffer();
  let round = 0;
  while (round < 12) {
    buffer.append(text);
    round = round + 1;
  }
  return buffer.finish();
}

// Iteration binds each element.
function countAll<T>(items: Array<T>): usize {
  let count: usize = 0;
  for (const item of items) {
    count = count + 1;
  }
  return count;
}

// A match payload of T.
function present<T>(slot: Option<T>): boolean {
  match (slot) {
    some(inner) => return true;
    none => {}
  }
  return false;
}

// A borrowed match over a field holding T.
function hasSpare<T>(box: Box<T>): boolean {
  match (in box.spare) {
    some(inner) => return true;
    none => {}
  }
  return false;
}

// Moving a whole T into a new aggregate and back out.
function wrap<T>(value: T): Box<T> {
  return Box({ item: value, spare: Option.none });
}

function unwrap<T>(box: Box<T>): T {
  const { item, spare } = move box;
  return item;
}

// Replacing initialized storage of type T.
function swapIn<T>(inout slot: T, next: T): T {
  return replace(inout slot, move next);
}

// A struct spread keeping one T field and replacing the other.
function withLeft<T>(pair: Pair<T>, left: T): Pair<T> {
  return Pair({ move ...pair, left });
}

// An explicit copy of a T beside the original.
function twin<T>(value: T): Array<T> {
  let items = Array<T>();
  items.push(copy value);
  items.push(value);
  return items;
}

// A channel whose message type is T.
function channelOf<T>(): u32 {
  const { sender, receiver } = Channel<T>.bounded(4);
  return 1;
}

// A plain method of a generic struct building another generic aggregate.
struct Shelf<T> {
  count: u32;

  function boxed(value: T): Box<T> {
    return Box({ item: value, spare: Option.none });
  }
}

// A generic class's constructor taking ownership of a T.
class Keeper<T> {
  readonly item: T;

  constructor(item: T) {
    this.item = move item;
  }
}

// Building and dropping a collection of T.
function collect<T>(first: T, second: T): Array<T> {
  let items = Array<T>();
  items.push(first);
  items.push(second);
  return items;
}

function main(): i32 {
  const names = collect(heap("alpha "), heap("beta "));
  if (countAll(names) != 2) return 1;
  if (!present(Option.some(heap("gamma ")))) return 2;
  const box = Box<String>({ item: heap("delta "), spare: Option.some(heap("epsilon ")) });
  if (!hasSpare(box)) return 3;
  const wrapped = wrap(heap("zeta "));
  const back = unwrap(wrapped);
  if (back.byteLength != 60) return 4;
  let slot = heap("eta ");
  const previous = swapIn(inout slot, heap("theta "));
  if (previous.byteLength != 48 || slot.byteLength != 72) return 5;
  const pair = Pair<String>({ left: heap("iota "), right: heap("kappa ") });
  const moved = withLeft(pair, heap("lambda "));
  if (moved.left.byteLength != 84 || moved.right.byteLength != 72) return 6;
  const twins = twin(heap("mu "));
  if (twins.length != 2 || twins[0].byteLength != 36) return 8;
  if (channelOf<String>() + channelOf<u32>() != 2) return 9;
  const shelf = Shelf<String>({ count: 1 });
  const shelved = shelf.boxed(heap("nu "));
  const counts = Shelf<u32>({ count: 2 });
  const counted = counts.boxed(4);
  if (shelved.item.byteLength != 36 || counted.item != 4) return 10;
  const keeper = new Keeper<String>(heap("xi "));
  if (keeper.item.byteLength != 36) return 11;
  const numbers = collect(u32(1), u32(2));
  if (countAll(numbers) != 2 || !present(Option.some(u32(3)))) return 7;
  console.log("ok");
  return 0;
}
