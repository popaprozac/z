struct Document {
  title: String;
}

struct Library {
  currentDocument: Document;

  function current(): view Document {
    return this.currentDocument;
  }
}

function main(): i32 {
  const library = Library({
    currentDocument: Document({ title: "Draft" }),
  });

  // `copy` creates independent owned storage. The borrowed Library view and
  // its owner remain available after this expression.
  const snapshot = copy library.current();

  // `move` transfers the Library's existing owner. `library` cannot be used
  // after this point; `transferred` now performs its deterministic cleanup.
  const transferred = move library;

  if (
    snapshot.title.byteLength == 5
    && transferred.currentDocument.title.byteLength == 5
  ) return 0;
  return 1;
}
