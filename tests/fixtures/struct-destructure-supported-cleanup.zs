import console from "std/console";
import { Map, Set } from "std/collections";

struct Resource { id: i32; deinit {} }
struct Phantom<T> { name: String; }

readonly class Session {
  name: String;
  resource: Resource;
  deinit { console.log(`released ${this.name}`); }
}

struct Batch {
  session: Session;
  names: Array<String>;
  optional: Option<String>;
  unusedTypeArgument: Phantom<Resource>;
  lookup: Map<String, i32>;
  labels: Set<String>;
}

function main(): i32 {
  let lookup = Map<String, i32>();
  lookup.set("name", 42);
  let labels = Set<String>();
  labels.add("stored");
  const session = new Session({ name: "shared", resource: Resource({ id: 42 }) });
  const batch = Batch({
    session,
    names: Array<String>("first", "second"),
    optional: Option.some("present"),
    unusedTypeArgument: Phantom<Resource>({ name: "phantom" }),
    lookup: move lookup,
    labels: move labels,
  });
  const { session: selected, names, optional, unusedTypeArgument, lookup: movedLookup, labels: movedLabels } = move batch;
  if (selected.resource.id != 42) return 1;
  if (names[1] != "second") return 2;
  if (unusedTypeArgument.name != "phantom") return 3;
  if (!movedLookup.has("name") || !movedLabels.has("stored")) return 6;
  return match (optional) { some(value) => value == "present" ? 0 : 4; none => 5; };
}
