import { Note } from "./model.zs";

class Catalog {
  function missing(): Option<Note> {
    return Option.none;
  }
}

function main(): i32 {
  const catalog = new Catalog({});
  return match (catalog.missing()) {
    some(_) => 1;
    none => 0;
  };
}
