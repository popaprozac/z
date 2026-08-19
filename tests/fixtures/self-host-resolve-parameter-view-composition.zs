struct Document {
  id: i32;
}

struct DocumentSelection {
  first: view Document;
  last: view Document;
}

struct Workspace {
  documents: Array<Document>;

  function endpoints(): DocumentSelection {
    return DocumentSelection({
      first: view this.documents[0],
      last: view this.documents[this.documents.length - 1],
    });
  }

  function add(inout this, document: Document): void {
    this.documents.push(document);
  }
}

function forwardedEndpoints(in workspace: Workspace): DocumentSelection {
  return workspace.endpoints();
}

function sumSelection(in selection: DocumentSelection): i32 {
  return selection.first.id + selection.last.id;
}

function main(): i32 {
  let workspace = Workspace({
    documents: Array<Document>(
      Document({ id: 20 }),
      Document({ id: 22 })
    ),
  });

  const selection = forwardedEndpoints(in workspace);
  const inspected = sumSelection(in selection);
  workspace.add(Document({ id: 24 }));

  const { first, last } = forwardedEndpoints(in workspace);
  const destructured = first.id + last.id;
  workspace.add(Document({ id: 26 }));

  return inspected + destructured - 86;
}
