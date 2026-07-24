import console from "std/console";
import { delay } from "std/time";
import { Document, DocumentStore, Workspace } from "./model.zs";

function inspectLocalDocuments(inout documents: DocumentStore): i32 {
  // A value-struct owner can project a zero-copy view. Its loan ends at the
  // projected value's last use, so later collection growth is legal.
  const projected = documents.documentAt(0);
  const projectedId = projected.id;
  documents.open(Document({ id: 4, title: "After View" }));
  return projectedId;
}

async function inspectAfterDelay(snapshot: Option<Document>): i32 {
  await delay(1);
  return match (snapshot) {
    some(document) => document.id;
    none => -1;
  };
}

async function main(): i32 {
  let localDocuments = DocumentStore({ documents: Array<Document>() });
  localDocuments.open(Document({ id: 1, title: "Local Draft" }));
  const projectedId = inspectLocalDocuments(inout localDocuments);

  const workspace = new Workspace({ documents: Array<Document>() });
  workspace.open(Document({ id: 2, title: "Shared Draft" }));

  // ARC identity can have aliases that mutate the same storage, so class-owned
  // access remains lexical through a nonescaping callback. Its environment is
  // local to this synchronous call even though the enclosing function is async.
  let callbackId: i32 = -1;
  const found = workspace.withDocument(2, (in document) => {
    callbackId = document.id;
  });

  // An owned snapshot is the explicit boundary when data must survive
  // mutation, task creation, and suspension.
  const snapshot = workspace.documentSnapshot(2);
  const delayed = task inspectAfterDelay(snapshot);
  workspace.open(Document({ id: 3, title: "Added While Task Was Live" }));
  const snapshotId = await delayed;

  console.log(
    `value view=${projectedId}, class callback=${callbackId}, delayed snapshot=${snapshotId}`
  );

  if (
    projectedId == 1
    && found
    && callbackId == 2
    && snapshotId == 2
    && localDocuments.documentCount() == 2
    && workspace.documentCount() == 2
  ) {
    return 0;
  }
  return 1;
}
