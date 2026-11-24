import console from "std/console";
import { Pool, Stack, lastOr } from "./pool.zs";

export struct Entity { name: String; hp: i32; }

// The same shape declared beside its use.
struct Bag<T> {
  values: Array<T>;

  function take(inout this): i32 {
    const popped = this.values.pop();
    match (popped) {
      some(value) => { return 1; }
      none => { return 0; }
    }
  }
}

function main(): i32 {
  let bag = Bag<Entity>({ values: Array<Entity>(Entity({ name: "a", hp: 1 })) });
  console.log(`bag ${bag.take()} ${bag.take()}`);

  let pool = Pool<Entity>({ values: Array<Entity>() });
  const first = pool.add(Entity({ name: "a", hp: 1 }));
  const second = pool.add(Entity({ name: "b", hp: 2 }));
  const taken = pool.take();
  match (taken) {
    some(entity) => console.log(`pool took ${entity.name} ${entity.hp} after ${first} ${second}`);
    none => console.log("pool took nothing");
  }
  console.log(`pool drained ${pool.drain()}`);

  let stack = new Stack<String>({ values: Array<String>() });
  stack.push("one");
  stack.push("two");
  console.log(`stack ${stack.depthAfterPop()}`);

  let numbers = Array<i64>(i64(4), i64(5));
  const last = lastOr(inout numbers, i64(0));
  let names = Array<String>();
  const name = lastOr(inout names, "fallback");
  let entities = Array<Entity>(Entity({ name: "c", hp: 3 }));
  const entity = lastOr(inout entities, Entity({ name: "none", hp: 0 }));
  console.log(`last ${last} ${name} ${entity.name}`);
  return 0;
}
