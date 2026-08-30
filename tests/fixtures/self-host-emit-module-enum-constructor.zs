import json from "std/json";

function main(): i32 {
  const value = json.JsonValue.string("ready");
  return match (value) {
    string(text) => text.byteLength == 5 ? 0 : 1;
    _ => 2;
  };
}
