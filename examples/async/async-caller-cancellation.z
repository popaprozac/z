import console from "std/console";
import { delay } from "std/time";
import { zcpp } from "../../tests/fixtures/move-only.hpp";

struct DownloadSession {
  fileId: i32;
  lease: zcpp.UniqueValue;

  deinit {
    console.log(`released download ${this.fileId}`);
  }
}

async function download(session: DownloadSession): i32 {
  console.log(`started download ${session.fileId}`);
  await delay(1000);
  return session.lease.value();
}

async function main(): i32 {
  const task = spawn download(DownloadSession({
    fileId: 42,
    lease: zcpp.UniqueValue(42),
  }));

  await delay(1);
  console.log("cancelling download");
  await task.cancel();

  const live = zcpp.unique_live();
  console.log(`cancellation joined, live=${live}`);
  return live;
}
