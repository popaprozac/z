import { thread } from "std/thread";
import {
  Item,
  Owner,
  createOwner,
} from "./owner.zs";

function main(): i32 on thread.main {
  const owner: Owner = createOwner();
  const found = owner.registry.values.get("answer");
  match (in found) {
    some(item) => return item.value - 42;
    none => return 1;
  }
}
