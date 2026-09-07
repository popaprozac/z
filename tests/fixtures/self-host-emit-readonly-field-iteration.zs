import { Map } from "std/collections";

readonly struct Launch {
  arguments: readonly Array<String>;
  labels: readonly Map<String, i32>;
}

function inspect(in launch: Launch): i32 {
  const first = copy launch.arguments[0];
  if (first != "--open") return -2;
  let score: i32 = 0;
  let snapshots = Array<String>();
  for (const argument of launch.arguments) {
    snapshots.push(copy argument);
    if (argument == "--open") score = score + 1;
    if (argument == "draft.md") score = score + 2;
  }
  if (snapshots.length != 2 || snapshots[0] != "--open") return -1;
  for (const entry of launch.labels) {
    if (entry.key == "count") score = score + entry.value;
  }
  return score;
}

function main(): i32 {
  let labels = Map<String, i32>();
  labels.set("count", 39);
  let arguments = Array<String>("--open", "draft.md");
  const launch = Launch({
    arguments: arguments.freeze(),
    labels: labels.freeze(),
  });
  return inspect(in launch) - 42;
}
