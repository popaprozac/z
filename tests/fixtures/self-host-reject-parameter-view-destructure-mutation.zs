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

function main(): i32 {
  let workspace = Workspace({
    documents: Array<Document>(
      Document({ id: 20 }),
      Document({ id: 22 })
    ),
  });
  const { first, last } = workspace.endpoints();
  const observed = first.id;
  workspace.add(Document({ id: 24 }));
  return observed + last.id - 42;
}
