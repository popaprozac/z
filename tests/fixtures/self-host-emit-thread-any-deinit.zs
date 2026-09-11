import { Mutex } from "std/sync";
import { thread } from "std/thread";
import { z_cleanup_begin, z_cleanup_record } from "./thread-any-deinit.h";

struct Resource {
  value: i32;

  deinit on thread.any {
    z_cleanup_record(this.value);
  }
}

readonly class SharedResource {
  resource: Mutex<Resource>;

  deinit on thread.any {
    z_cleanup_record(10);
  }
}

async function main(): i32 {
  z_cleanup_begin();
  const resource = new SharedResource({
    resource: Mutex(Resource({ value: 42 })),
  });
  const worker = thread.spawn(move (): i32 => {
    const local = Mutex(Resource({ value: 1 }));
    return resource.resource.withLock((in value): i32 => value.value)
      + local.withLock((in value): i32 => value.value);
  });
  const answer = await worker;
  return answer - 43;
}
