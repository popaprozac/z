import json from "std/json";

function main(): i32 {
  const decoded = attempt json.parse(
    '[null,true,false,42.5,"Z\\u03A9\\uD83D\\uDE80"]'
  );
  match (decoded) {
    success(value) => {
      const encoded = json.stringify(in value);
      if (encoded != '[null,true,false,42.5,"ZΩ🚀"]') return 1;
      return 0;
    }
    failure(_) => return 2;
  }
}
