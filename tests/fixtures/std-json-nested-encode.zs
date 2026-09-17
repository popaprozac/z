import json from "std/json";

readonly struct Document {
  title: String;
  tags: readonly Array<String>;
  children: readonly Array<Document>;
}

readonly struct Envelope {
  version: u32;
  document: Document;
}

function main(): i32 {
  return match (attempt run()) {
    success(status) => status;
    failure(_) => 99;
  };
}

function run(): i32 throws json.JsonEncodeError {
  const source = '{"version":1,"document":{"title":"Draft","tags":["a","b"],"children":[{"title":"Child","tags":[],"children":[]}]}}';
  const decoded = attempt json.decode<Envelope>(in source);
  return match (decoded) {
    failure(_) => 1;
    success(value) => {
      const encoded = try json.encode(in value);
      if (encoded != source) return 2;
      // Encoding borrows the entire graph, including published collections.
      if (value.document.children[0].title != "Child") return 3;
      if (value.document.tags[0] != "a") return 4;
      select 0;
    }
  };
}
