import fs from "std/fs";

function lockAndRelease(): i32 throws String {
  const lock: fs.Lock = try fs.lock("/tmp/z-self-host-fs-lock.lock");
  lock.unlock();
  return 0;
}

function main(): i32 {
  return match (attempt lockAndRelease()) {
    success(status) => status;
    failure(_) => 1;
  };
}
