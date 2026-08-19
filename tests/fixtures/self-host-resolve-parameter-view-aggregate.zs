struct Document {
  id: i32;
}

struct DocumentSpan {
  first: view Document;
  last: view Document;
}

struct Workspace {
  documents: Array<Document>;

  function add(inout this, document: Document): void {
    this.documents.push(document);
  }
}

function selectDocuments(
  preferActive: boolean,
  in active: Workspace,
  in archive: Workspace
): DocumentSpan {
  if (!preferActive) {
    return DocumentSpan({
      first: view archive.documents[0],
      last: view archive.documents[1],
    });
  }
  return DocumentSpan({
    first: view active.documents[0],
    last: view active.documents[1],
  });
}

function main(): i32 {
  let active = Workspace({
    documents: Array<Document>(
      Document({ id: 1 }),
      Document({ id: 2 })
    ),
  });
  let archive = Workspace({
    documents: Array<Document>(
      Document({ id: 20 }),
      Document({ id: 22 })
    ),
  });
  const selected = selectDocuments(false, in active, in archive);
  const total = selected.first.id + selected.last.id;
  active.add(Document({ id: 3 }));
  archive.add(Document({ id: 24 }));
  return total - 42;
}
