import { Map } from "std/collections";

enum JsonValue {
  nullValue,
  booleanValue boolean,
  numberValue f64,
  stringValue String,
  arrayValue Array<JsonValue>,
  objectValue Map<String, JsonValue>,
}

function main(): i32 {
  let fields = Map<String, JsonValue>();
  fields.set("name", JsonValue.stringValue("Z"));
  fields.set("enabled", JsonValue.booleanValue(true));

  const children = Array<JsonValue>(
    JsonValue.objectValue(fields),
    JsonValue.arrayValue(Array<JsonValue>(JsonValue.numberValue(42.0)))
  );
  const value = JsonValue.arrayValue(children);
  return match (value) {
    arrayValue(items) => i32(items.length) - 2;
    objectValue(_) => 1;
    nullValue => 1;
    booleanValue(_) => 2;
    numberValue(_) => 3;
    stringValue(_) => 4;
  };
}
