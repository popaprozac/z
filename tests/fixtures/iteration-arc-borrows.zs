import { Map } from "std/collections";
import { Generator } from "std/iteration";

class Document {
  value: i32;
  function read(): i32 { return this.value; }
  function close(inout this): void { this.value = 0; }
}
class Child { readonly document: Document; }
struct Entry { child: Child; }

function inspect(items: Slice<Document>): i32 {
  let total = 0;
  for (const item of items) { total = total + item.read(); }
  return total;
}

function documents(): Generator<Document> {
  yield new Document({ value: 42 });
}

function main(): i32 {
  const fixed = [new Document({ value: 21 })];
  if (inspect(fixed) != 21) return 1;
  const items = Array<Entry>(Entry({ child: new Child({ document: new Document({ value: 21 }) }) }));
  let total = 0;
  for (const { child } of items) { total = total + child.document.read(); }
  let mapped = Map<String, Child>();
  mapped.set("one", new Child({ document: new Document({ value: 21 }) }));
  for (const { value } of mapped) { total = total + value.document.read(); }
  if (total != 42) return 2;

  // A retained alias is independently owned; collection iteration did not
  // change the class's mutability or make all const ARC handles read-only.
  const document = fixed[0];
  document.close();
  if (document.read() != 0) return 3;

  // Generator yields transfer ownership rather than lending collection storage.
  const stream = documents();
  for (const yielded of stream) {
    yielded.close();
    if (yielded.read() != 0) return 4;
  }
  return 0;
}
