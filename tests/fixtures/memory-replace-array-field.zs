import console from "std/console";
import { replace } from "std/memory";

struct Document {
  id: i32;

  deinit {
    console.log(`released ${this.id}`);
  }
}

struct Library {
  documents: Array<Document>;

  function reload(inout this, fresh: Array<Document>): usize {
    let previous = replace(inout this.documents, move fresh);
    const count = previous.length;
    previous.clear();
    return count;
  }
}

function main(): i32 {
  let library = Library({ documents: Array<Document>(Document({ id: 1 }), Document({ id: 2 })) });
  if (library.reload(Array<Document>(Document({ id: 3 }))) != 2) return 1;
  if (library.documents.length != 1) return 2;
  if (library.documents[0].id != 3) return 3;
  return 0;
}
