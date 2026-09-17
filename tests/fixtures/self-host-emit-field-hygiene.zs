import json from "std/json";
import console from "std/console";

struct NativeWords {
  signed: i64 = -12;
  unsigned: u64 = 34;
  z_signed: i32 = 5;
  z_field_signed: i32 = 6;
  template: Option<String> = Option<String>.some("kept");
}

class Record {
  signed: String;
  z_signed: String;
  z_field_signed: String;
  self: i32;

  function size(): usize {
    return this.signed.byteLength + this.z_signed.byteLength + this.z_field_signed.byteLength;
  }
}

// Explicit public C layouts retain valid ABI field names unchanged.
export c struct PublicRecord {
  id: i32;
  self: i32;
  z_field_signed: i32;
}

function update(inout words: NativeWords): void {
  words.signed = -42;
  words.unsigned = 42;
}

function main(): i32 {
  return match (attempt run()) {
    success(status) => status;
    failure(_) => 99;
  };
}

function run(): i32 throws json.JsonEncodeError {
  let words = NativeWords();
  update(inout words);
  const snapshot = NativeWords({ copy ...words, z_signed: 8 });
  const encoded = try json.encode(in snapshot);
  if (encoded != "{\"signed\":-42,\"unsigned\":42,\"z_signed\":8,\"z_field_signed\":6,\"template\":\"kept\"}") return 1;
  const decoded = match (attempt json.decode<NativeWords>(encoded)) {
    success(value) => value;
    failure(_) => return 2;
  };
  const { signed: negative, unsigned: positive } = copy decoded;
  if (negative != i64(-42) || positive != u64(42)) return 3;
  const selected = Option<NativeWords>.some(copy decoded);
  const observed = match (in selected) {
    some(row) => row.signed;
    none => i64(0);
  };
  if (observed != i64(-42)) return 6;
  const replacement = NativeWords({ move ...words, template: Option<String>.some("updated") });
  match (in replacement.template) {
    some(text) => { if (text != "updated") return 7; }
    none => return 8;
  }
  const record = new Record({ signed: "a", z_signed: "bb", z_field_signed: "ccc", self: 10 });
  if (record.size() != 6 || record.self != 10) return 4;
  const publicRecord = PublicRecord({ id: 12, self: 13, z_field_signed: 14 });
  if (publicRecord.id + publicRecord.self + publicRecord.z_field_signed != 39) return 5;
  console.log(encoded);
  return 0;
}
