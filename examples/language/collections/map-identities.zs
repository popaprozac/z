import { Map } from "std/collections";
import console from "std/console";

class DocumentSession {
  id: i32;
  title: String;

  deinit {
    console.log(`closed ${this.title}`);
  }
}

function main(): i32 {
  let sessions = Map<i32, DocumentSession>();
  const draft = new DocumentSession({ id: 7, title: "Draft" });

  // Class values have shared ARC identity. The map retains `draft`, and the
  // caller can continue using its own reference after insertion.
  sessions.set(draft.id, draft);
  console.log(`open: ${draft.title}`);

  // Identity lookup returns Option<DocumentSession>, not a storage view.
  const found = sessions.get(7);
  const title = match (in found) {
    some(session) => copy session.title;
    none => "Missing";
  };
  console.log(`found: ${title}`);

  // Removal transfers the map's retained identity into the Option.
  const removed = sessions.remove(7);
  return match (in removed) {
    some(session) => session.id - 7;
    none => 1;
  };
}
