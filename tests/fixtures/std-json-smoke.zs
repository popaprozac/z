import json from "std/json";

function main(): i32 {
  const decoded = attempt json.parse(
    '[null,true,false,42.5,"Z\\u03A9\\uD83D\\uDE80"]'
  );
  match (decoded) {
    success(value) => {
      const elementCount = match (in value) {
        array(values) => {
          const first = view values[0];
          const firstIsNull = match (in first) {
            nullValue => true;
            boolean(_) => false;
            number(_) => false;
            string(_) => false;
            array(_) => false;
            object(_) => false;
          };
          if (!firstIsNull) return 4;
          select values.length;
        }
        nullValue => usize(0);
        boolean(_) => usize(0);
        number(_) => usize(0);
        string(_) => usize(0);
        object(_) => usize(0);
      };
      if (elementCount != usize(5)) return 3;
      const encoded = json.stringify(in value);
      if (encoded != '[null,true,false,42.5,"ZΩ🚀"]') return 1;
      return 0;
    }
    failure(_) => return 2;
  }
}
