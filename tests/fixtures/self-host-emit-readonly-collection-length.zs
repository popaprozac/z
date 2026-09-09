import console from "std/console";
import { Map, Set } from "std/collections";

type Arguments = readonly Array<String>;

readonly struct Snapshot {
  arguments: Arguments;
  counts: readonly Map<String, i32>;
  labels: readonly Set<String>;
}

readonly struct Launch {
  snapshot: Snapshot;
}

struct NamedLength {
  length: String;
}

function describe(in event: Launch): void {
  const observed = view event.snapshot;
  console.log(`views ${observed.arguments.length}/${observed.counts.length}/${observed.labels.length}`);
}

function detachedSnapshot(): readonly Array<String> {
  const values = Array<String>("kept");
  const frozen = values.freeze();
  return copy frozen;
}

function main(): i32 {
  const arguments = Array<String>("draft", "published");
  let counts = Map<String, i32>();
  counts.set("draft", 1);
  let labels = Set<String>();
  labels.add("first");
  labels.add("second");
  const event = Launch({ snapshot: Snapshot({
    arguments: arguments.freeze(),
    counts: counts.freeze(),
    labels: labels.freeze(),
  }) });
  const callback: (in event: Launch) => void = (in event: Launch): void => {
    console.log(`callback ${event.snapshot.arguments.length}/${event.snapshot.counts.length}/${event.snapshot.labels.length}`);
  };
  callback(in event);
  describe(in event);
  const duplicate = copy event.snapshot.arguments;
  console.log(`copy ${duplicate.length}; original ${event.snapshot.arguments.length}`);
  const detached = detachedSnapshot();
  console.log(`detached ${detached[0]}`);
  const named = NamedLength({ length: "ordinary field" });
  console.log(`custom ${named.length}`);
  return 0;
}
