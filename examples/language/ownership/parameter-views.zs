import { expect } from "std/test";

struct Document {
  id: i32;
  title: String;
}

struct Library {
  documents: Array<Document>;

  function add(inout this, document: Document): void {
    this.documents.push(document);
  }
}

function chooseDocument(
  preferDrafts: boolean,
  in drafts: Library,
  in published: Library
): view Document {
  if (preferDrafts) return drafts.documents[0];
  return published.documents[0];
}

function exerciseParameterView(): i32 {
  let drafts = Library({
    documents: Array<Document>(
      Document({ id: 20, title: "Ownership notes" })
    ),
  });
  let published = Library({
    documents: Array<Document>(
      Document({ id: 22, title: "Interop guide" })
    ),
  });

  const selected = chooseDocument(true, in drafts, in published);
  const selectedId = selected.id;

  // The view may refer to either input, so both libraries remain read-only
  // through its last use. Both can grow again after selectedId is copied.
  drafts.add(Document({ id: 40, title: "Async notes" }));
  published.add(Document({ id: 42, title: "Collections guide" }));
  return selectedId + i32(drafts.documents.length) + i32(published.documents.length);
}

test "parameter views borrow every possible source owner" {
  expect(exerciseParameterView()).toEqual(24);
}

function main(): i32 {
  return exerciseParameterView() - 24;
}
