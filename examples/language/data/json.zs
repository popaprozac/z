import console from "std/console";
import json from "std/json";

struct Project {
  name: String;
  downloads: u64;
  active: boolean = true;
}

function main(): i32 {
  const decoded = attempt json.decode<Project>(
    '{"name":"Zapp","downloads":18446744073709551615}'
  );
  return match (decoded) {
    success(project) => {
      const encoded = json.encode(in project);
      console.log(encoded);
      select 0;
    }
    failure(error) => {
      console.error(`JSON error at ${error.line}:${error.column}: ${error.message}`);
      select 1;
    }
  };
}
