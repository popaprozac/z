import json from "std/json";

struct Point { x: f64; y: f64 = 4.5; }
struct Item { name: String; point: Point; }
struct Envelope { items: Array<Item>; extra: Option<f64>; }
struct OptionalPoint { point: Option<Point>; }
struct Empty {}

function roundTrip(value: f64): boolean {
  const point = Point({ x: value });
  const encoded = match (attempt json.encode(in point)) {
    success(text) => text;
    failure(_) => return false;
  };
  const decoded = match (attempt json.decode<Point>(in encoded)) {
    success(result) => result;
    failure(_) => return false;
  };
  return decoded.x.toBits() == value.toBits() && decoded.y == 4.5;
}

function rejects(value: f64): boolean {
  const point = Point({ x: value });
  return match (attempt json.encode(in point)) {
    success(_) => false;
    failure(error) => error.path == "x" && error.message == "JSON cannot encode a non-finite f64";
  };
}

function nestedFailure(value: f64): boolean {
  let items = Array<Item>();
  let index: usize = 0;
  while (index < 4) {
    items.push(Item({
      name: `item ${index}`,
      point: Point({ x: index == 3 ? value : 1.25 }),
    }));
    index = index + 1;
  }
  const envelope = Envelope({ items: move items, extra: Option<f64>.none });
  match (attempt json.encode(in envelope)) {
    success(_) => return false;
    failure(error) => if (error.path != "items[3].point.x") return false;
  }
  // The failed encoder borrows, and never consumes or changes its input.
  if (envelope.items.length != 4 || envelope.items[3].name != "item 3") return false;
  return envelope.items[3].point.x.toBits() == value.toBits();
}

function main(): i32 {
  if (!roundTrip(0.0) || !roundTrip(-0.0) || !roundTrip(0.1)) return 1;
  if (!roundTrip(-12345.625) || !roundTrip(1.25e200) || !roundTrip(1.25e-200)) return 2;
  if (!roundTrip(f64.fromBits(0x0000_0000_0000_0001))) return 3;
  if (!roundTrip(f64.fromBits(0x7fef_ffff_ffff_ffff))) return 4;
  const nan = f64.fromBits(0x7ff8_0000_0000_0001);
  const positiveInfinity = f64.fromBits(0x7ff0_0000_0000_0000);
  const negativeInfinity = f64.fromBits(0xfff0_0000_0000_0000);
  if (!rejects(nan) || !rejects(positiveInfinity) || !rejects(negativeInfinity)) return 5;
  if (!nestedFailure(nan) || !nestedFailure(positiveInfinity) || !nestedFailure(negativeInfinity)) return 6;
  const optional = OptionalPoint({ point: Option.some(Point({ x: nan })) });
  match (attempt json.encode(in optional)) {
    success(_) => return 7;
    failure(error) => if (error.path != "point.x") return 8;
  }
  const extra = Envelope({ items: Array<Item>(), extra: Option.some(positiveInfinity) });
  match (attempt json.encode(in extra)) {
    success(_) => return 9;
    failure(error) => if (error.path != "extra") return 10;
  }
  const finite = Envelope({
    items: Array<Item>(Item({ name: "kept", point: Point({ x: -1.25 }) })),
    extra: Option.some(0.5),
  });
  match (attempt json.encode(in finite)) {
    success(text) => if (text != '{"items":[{"name":"kept","point":{"x":-1.25,"y":4.5}}],"extra":0.5}') return 11;
    failure(_) => return 12;
  }
  const empty = Empty();
  match (attempt json.encode(in empty)) {
    success(text) => if (text != "{}") return 13;
    failure(_) => return 14;
  }
  return 0;
}
