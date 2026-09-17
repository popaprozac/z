import json from "std/json";

readonly struct Child {
  name: String;
  score: u8 = 7;
}

type OptionalName = Option<String>;

readonly struct Envelope {
  name: OptionalName;
  child: Option<Child>;
  tags: Option<readonly Array<String>>;
  children: Option<Array<Child>>;
  enabled: Option<boolean>;
  count: Option<u64>;
  balance: Option<i64>;
  byte: Option<u8>;
}

struct Defaults {
  absent: Option<String> = Option<String>.none;
  name: Option<String> = Option<String>.some("fallback");
  child: Option<Child> = Option<Child>.some(Child({ name: "default" }));
}

struct Required {
  value: Option<String>;
}

function rejects(in source: String): boolean {
  return match (attempt json.decode<Envelope>(in source)) {
    success(_) => false;
    failure(_) => true;
  };
}

function main(): i32 {
  return match (attempt run()) {
    success(status) => status;
    failure(_) => 99;
  };
}

function run(): i32 throws json.JsonEncodeError {
  const source = '{"name":"資料","child":{"name":"nested","score":255},"tags":["","one"],"children":[{"name":"a","score":7}],"enabled":false,"count":18446744073709551615,"balance":-9223372036854775808,"byte":42}';
  const value = match (attempt json.decode<Envelope>(in source)) {
    success(value) => value;
    failure(_) => return 1;
  };
  if ((try json.encode(in value)) != source) return 2;
  match (in value.name) {
    some(name) => { if (name != "資料") return 3; }
    none => return 4;
  }
  match (in value.tags) {
    some(tags) => { if (tags.length != 2 || tags[0] != "") return 5; }
    none => return 6;
  }
  const nulls = '{"name":null,"child":null,"tags":null,"children":null,"enabled":null,"count":null,"balance":null,"byte":null}';
  const absent = match (attempt json.decode<Envelope>(in nulls)) {
    success(value) => value;
    failure(_) => return 7;
  };
  if ((try json.encode(in absent)) != nulls) return 8;
  match (in absent.child) { some(_) => return 9; none => {} }

  // Missing is not null: only the declared defaults make these fields optional.
  const defaults = match (attempt json.decode<Defaults>("{}")) {
    success(value) => value;
    failure(_) => return 10;
  };
  if ((try json.encode(in defaults)) != '{"absent":null,"name":"fallback","child":{"name":"default","score":7}}') return 11;
  const override = match (attempt json.decode<Defaults>('{"absent":"present","name":null,"child":null}')) {
    success(value) => value;
    failure(_) => return 12;
  };
  if ((try json.encode(in override)) != '{"absent":"present","name":null,"child":null}') return 13;
  const replaced = match (attempt json.decode<Defaults>('{"name":"new","child":{"name":"new child"}}')) {
    success(value) => value;
    failure(_) => return 14;
  };
  if ((try json.encode(in replaced)) != '{"absent":null,"name":"new","child":{"name":"new child","score":7}}') return 15;
  match (attempt json.decode<Required>("{}")) {
    success(_) => return 16;
    failure(error) => { if (error.message != "missing required JSON field value") return 17; }
  }
  const empty = match (attempt json.decode<Required>('{"value":""}')) {
    success(value) => value;
    failure(_) => return 18;
  };
  if ((try json.encode(in empty)) != '{"value":""}') return 19;

  const invalid = Array<String>(
    '{"name":nul}',
    '{"name":nullx}',
    '{"name":null,"name":null}',
    '{"name":123}',
    '{"enabled":0}',
    '{"count":18446744073709551616}',
    '{"balance":-9223372036854775809}',
    '{"byte":256}',
    '{"byte":-1}',
    '{"byte":1.5}',
    '{"child":{"name":"owned","score":256}}',
    '{"tags":["owned",null]}',
    '{"children":[{"name":"owned"},{"name":"partial","score":256}]}',
    '{"child":{"name":"owned"},"child":null}',
    '{"tags":["owned"],"tags":null}'
  );
  let pass: i32 = 0;
  while (pass < 32) {
    for (const malformed of invalid) {
      if (!rejects(in malformed)) return 20;
    }
    // Failed replacement must clean both untouched defaults and partial input.
    match (attempt json.decode<Defaults>('{"name":"owned","child":{"name":"partial","score":256}}')) {
      success(_) => return 21;
      failure(_) => {}
    }
    pass = pass + 1;
  }
  return 0;
}
