import console from "std/console";

struct Document {
  id: i32;
  title: String;
  deinit { console.log(`released ${this.id}`); }
}

struct History {
  documents: Array<Document>;

  function undo(inout this): Option<Document> {
    return this.documents.pop();
  }
}

function takeLast<T>(inout values: Array<T>): Option<T> {
  return values.pop();
}

function main(): i32 {
  let history = History({ documents: Array<Document>(
    Document({ id: 1, title: "Draft" }),
    Document({ id: 2, title: "Published" })
  ) });
  const capacity = history.documents.capacity;
  const previous = history.undo();
  history.documents.clear();
  history.documents.push(Document({ id: 3, title: "Revised" }));
  if (history.documents.capacity != capacity) return 1;
  match (previous) {
    some(document) => {
      if (document.id != 2 || document.title != "Published") return 2;
    }
    none => return 3;
  }
  { const abandoned = history.documents.pop(); }
  history.documents.push(Document({ id: 4, title: "Final" }));

  let numbers = Array<i32>(20, 22);
  const last = match (takeLast(inout numbers)) { some(value) => value; none => 0; };
  if (last != 22) return 4;
  const first = match (numbers.pop()) { some(value) => value; none => 0; };
  if (first != 20) return 5;
  const unexpected = match (numbers.pop()) { some(_) => true; none => false; };
  if (unexpected) return 6;
  if (numbers.length != 0 || numbers.capacity < 2) return 7;
  numbers.push(42);
  const reused = match (numbers.pop()) { some(value) => value; none => 0; };
  if (reused != 42) return 8;
  const frozen = numbers.freeze();
  if (frozen.capacity < 2 || frozen.length != 0) return 11;

  let names = Array<String>("Saved");
  const name = names.pop();
  names.clear();
  match (name) {
    some(value) => { if (value != "Saved") return 9; }
    none => return 10;
  }
  return 0;
}
