import { thread } from "std/thread";
import {
  Owner,
  createOwner,
  existingItem,
} from "./owner.zs";

function main(): i32 on thread.main {
  const owner: Owner = createOwner();
  const item = existingItem(in owner);
  const found = owner.registry.values.get("answer");
  match (in found) {
    some(entry) => entry.read();
    none => {}
  }
  const direct = match (in found) {
    some(entry) => entry.read();
    none => 0;
  };
  return item.read() + direct - 84;
}
