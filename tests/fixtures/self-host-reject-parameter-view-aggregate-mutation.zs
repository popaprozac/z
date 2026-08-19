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

function selectDocuments(in workspace: Workspace): DocumentSpan {
  return DocumentSpan({
    first: view workspace.documents[0],
    last: view workspace.documents[1],
  });
}

function main(): i32 {
  let workspace = Workspace({
    documents: Array<Document>(
      Document({ id: 20 }),
      Document({ id: 22 })
    ),
  });
  const selected = selectDocuments(in workspace);
  workspace.add(Document({ id: 24 }));
  return selected.first.id;
}
