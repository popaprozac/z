import console from "std/console";
import json from "std/json";

struct Project {
  name: String;
  downloads: u64;
  active: boolean = true;
}

function main(): i32 {
  return match (attempt run()) {
    success(status) => status;
    failure(_) => 99;
  };
}

function run(): i32 throws json.JsonEncodeError {
  const decoded = attempt json.decode<Project>(
    '{"name":"Zapp","downloads":18446744073709551615}'
  );
  return match (decoded) {
    success(project) => {
      const encoded = try json.encode(in project);
      console.log(encoded);
      select 0;
    }
    failure(error) => {
      console.error(`JSON error at ${error.line}:${error.column}: ${error.message}`);
      select 1;
    }
  };
}
