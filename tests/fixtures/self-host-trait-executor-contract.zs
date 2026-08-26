import { thread } from "std/thread";

export trait AsyncService {
  async function invoke(): i32;
}

export trait MainReadable {
  function read(): i32 on thread.main;
}
