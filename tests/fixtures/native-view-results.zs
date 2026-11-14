import console from "std/console";

struct Document {
  id: i32;
  title: String;
}

struct Library {
  documents: Array<Document>;

  function first(): view Document {
    return this.documents[0];
  }
}

function pick(flag: boolean, in a: Library, in b: Library): view Document {
  if (flag) return a.documents[0];
  return b.documents[0];
}

function find(in library: Library, id: i32): Option<view Document> {
  let index: usize = 0;
  while (index < library.documents.length) {
    if (library.documents[index].id == id) return Option.some(library.documents[index]);
    index = index + 1;
  }
  return Option.none;
}

function inspect(in operation: () => i32): i32 {
  return operation();
}

function titleLength(in document: Document): usize {
  return document.title.byteLength;
}

function main(): i32 {
  const drafts = Library({ documents: Array<Document>(Document({ id: 7, title: "draft" })) });
  const published = Library({ documents: Array<Document>(Document({ id: 9, title: "published" })) });
  const first = drafts.first();
  const picked = pick(false, drafts, published);
  console.log(`first ${first.id} picked ${picked.id} length ${titleLength(picked)}`);
  const found = find(published, 9);
  const observed = match (in found) {
    some(document) => inspect(() => document.id);
    none => -1;
  };
  console.log(`observed ${observed}`);
  return 0;
}
