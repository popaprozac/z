import { AsyncService } from "./self-host-trait-executor-contract.zs";
import { thread } from "std/thread";

class MainService implements AsyncService {
  async function invoke(): i32 on thread.main {
    return 42;
  }
}

function main(): i32 {
  return 0;
}
