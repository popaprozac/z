import { Arena } from "std/memory";

struct Item { value: i32; }
struct Link { item: view Item; }

function main(): i32 {
  let arena = Arena();
  const item = arena.create(Item({ value: 42 }));
  let links = Array<Link>();
  links.push(Link({ item }));
  const removed = links.pop();
  links.clear();
  const stored = arena.create(removed);
  return 0;
}
