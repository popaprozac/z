// A method called on a borrowed view payload (an Option of a view, which is
// a pointer) passes that pointer, not its address.
import console from "std/console";
import { Map } from "std/collections";

struct Session {
  id: i32;
  label: String;

  function documentId(): i32 {
    return this.id;
  }
}

function main(): i32 {
  let sessions = Map<String, Session>();
  sessions.set("a", Session({ id: 42, label: `doc` }));
  const found = sessions.get("a");
  const id = match (in found) {
    some(session) => session.documentId();
    none => 0;
  };
  console.log(`id=${id}`);
  return 0;
}
