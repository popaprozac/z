import console from "std/console";

class Document {
  id: i32;
  deinit { console.log(`released ${this.id}`); }
}

function main(): i32 {
  let documents = Array<Document>();
  const document = new Document({ id: 42 });
  documents.push(document);
  const removed = documents.pop();
  documents.clear();
  return match (removed) {
    some(value) => value.id == document.id ? 0 : 1;
    none => 2;
  };
}
