import { Map } from "std/collections";

struct User {
  id: i32;
  name: String;
}

function main(): i32 {
  let users = Map<String, User>();
  users.set("ada", User({ id: 20, name: "Ada" }));
  users.set("grace", User({ id: 22, name: "Grace" }));
  users.set("temporary", User({ id: 1, name: "Temporary" }));
  if (!users.delete("temporary") || users.delete("temporary")) return 1;

  const found = users.get("ada");
  const observed = match (in found) {
    some(user) => user.id;
    none => 0;
  };

  let total = 0;
  for (const entry of users) {
    total = total + entry.value.id;
  }

  // The view's last use has ended, so structural mutation is legal again.
  const removed = users.remove("grace");
  return match (removed) {
    some(user) => observed + user.id - total;
    none => 2;
  };
}
