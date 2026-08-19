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
  let index: usize = 0;
  while (index < active.documents.length) {
    if (active.documents[index].id == id) {
      return Option.some(active.documents[index]);
    }
    index = index + 1;
  }
  index = 0;
  while (index < archive.documents.length) {
    if (archive.documents[index].id == id) {
      return Option.some(archive.documents[index]);
    }
    index = index + 1;
  }
  return Option.none;
}

function main(): i32 {
  let active = Workspace({ documents: Array<Document>(Document({ id: 20 })) });
  let archive = Workspace({ documents: Array<Document>(Document({ id: 22 })) });
  const found = findDocument(22, in active, in archive);
  const observed = match (in found) {
    some(document) => {
      const id = document.id;
      active.add(Document({ id: 24 }));
      archive.add(Document({ id: 26 }));
      select id;
    }
    none => {
      active.add(Document({ id: 28 }));
      archive.add(Document({ id: 30 }));
      select -1;
    }
  };
  return observed - 22;
}
