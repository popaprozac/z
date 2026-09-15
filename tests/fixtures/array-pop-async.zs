import { scheduler } from "std/async";

function isDraft(title: Option<String>): boolean {
  return match (title) {
    some(value) => value == "Draft";
    none => false;
  };
}

async function main(): i32 {
  let titles = Array<String>();
  titles.push("Draft");
  const title = titles.pop();
  await scheduler.yield();
  titles.push("Revised");
  return isDraft(move title) ? 0 : 1;
}
