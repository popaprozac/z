struct Document {
  id: i32;
}

struct Workspace {
  documents: Array<Document>;

  function add(inout this, document: Document): void {
    this.documents.push(document);
  }
}

function findDocument(
  id: i32,
  in active: Workspace,
  in archive: Workspace
): Option<view Document> {
  if (active.documents[0].id == id) {
    return Option.some(active.documents[0]);
  }
  return Option.some(archive.documents[0]);
}

function main(): i32 {
  let active = Workspace({ documents: Array<Document>(Document({ id: 20 })) });
  let archive = Workspace({ documents: Array<Document>(Document({ id: 22 })) });
  const found = findDocument(22, in active, in archive);
  archive.add(Document({ id: 24 }));
  return match (in found) {
    some(document) => document.id;
    none => -1;
  };
}
