import { thread } from "std/thread";

struct AffineResource {
  id: i32;

  deinit {}
}

async function main(): i32 {
  const worker = thread.spawn(
    (): AffineResource => AffineResource({ id: 42 })
  );
  const value = await worker;
  return value.id;
}
