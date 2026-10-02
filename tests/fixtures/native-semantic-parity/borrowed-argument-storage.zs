import console from "std/console";

struct Pair {
  left: u32;
  right: u32;

  function leftOf(): u32 {
    return takeU32(this.left);
  }
}

struct Box<T> {
  item: T;
}

enum Color {
  red,
  green,
}

function takeU32(in value: u32): u32 {
  return value;
}

function takePair(in value: Pair): u32 {
  return value.left + value.right;
}

function takeBox(in value: Box<u32>): u32 {
  return value.item;
}

function takeText(in value: String): u32 {
  return u32(value.byteLength);
}

function takeItems(in value: Array<u32>): u32 {
  return u32(value.length);
}

function takeChoice(in value: Option<u32>): u32 {
  return match (value) { some(inner) => inner; none => 10; };
}

function takeColor(in value: Color): u32 {
  return match (value) { red => 1; green => 2; };
}

function fallible(): u32 throws String {
  return 6;
}

function apply(handler: (in value: u32) => u32, amount: u32): u32 {
  return handler(amount);
}

function increment(in value: u32): u32 {
  return value + 1;
}

// Every shape an `in` argument may take: named storage or a path into it,
// and the temporaries a call holds for its duration.
function run(): u32 throws String {
  const x: u32 = 4;
  const pair = Pair({ left: 1, right: 2 });
  let items = Array<u32>();
  items.push(3);
  let total = takeU32(x) + takeU32(pair.left) + takeU32(items[0]) + pair.leftOf() + takeU32(in x);
  total = total + takePair(Pair({ left: 5, right: 6 })) + takeBox(Box<u32>({ item: 7 })) + takeBox(Box({ item: 8 }));
  total = total + takeText("abc") + takeText(`n${x}`) + takeItems(Array<u32>());
  total = total + takeChoice(Option.none) + takeColor(Color.green) + takeU32(try fallible());
  total = total + apply(increment, x);
  return total;
}

function main(): i32 {
  const result = attempt run();
  match (result) {
    success(total) => console.log(total);
    failure(_) => return 1;
  }
  return 0;
}
