import json from "std/json";

struct Point { x: f64; y: f64 = 4.5; }
struct Envelope { point: Point; extra: Option<f64> = Option<f64>.none; }

function valid(): i32 throws json.JsonError {
  const point = try json.decode<Point>("{\"x\":12.5}");
  if (point.x != 12.5 || point.y != 4.5) return 1;
  const nested = try json.decode<Envelope>("{\"point\":{\"x\":-1.25e2,\"y\":0},\"extra\":0.125}");
  if (nested.point.x != -125.0 || nested.point.y != 0.0) return 2;
  match (in nested.extra) {
    some(value) => if (value != 0.125) return 3;
    none => return 4;
  }
  return 0;
}

function rejects(source: String): boolean {
  return match (attempt json.decode<Point>(in source)) {
    success(_) => false;
    failure(_) => true;
  };
}

function main(): i32 {
  const result = match (attempt valid()) {
    success(value) => value;
    failure(_) => 5;
  };
  if (result != 0) return result;
  if (!rejects("{\"x\":1e9999}")) return 6;
  if (!rejects("{\"x\":NaN}")) return 7;
  if (!rejects("{\"x\":1.}")) return 8;
  if (!rejects("{\"x\":\"12.5\"}")) return 9;
  if (!rejects("{\"x\":01.5}")) return 10;
  return 0;
}
