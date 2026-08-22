import console from "std/console";
import json from "std/json";

function main(): i32 {
  const parsed = attempt json.parse(
    '{"project":"Zapp","features":["native","small","fast"],"ready":true}'
  );
  return match (parsed) {
    success(document) => {
      const encoded = json.stringify(in document);
      console.log(encoded);
      select 0;
    }
    failure(error) => {
      console.error(`JSON error at ${error.line}:${error.column}: ${error.message}`);
      select 1;
    }
  };
}
