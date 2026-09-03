import console from "std/console";
import {
  I32WorkerMarker,
  acceptMarker,
  createTypedWorker,
} from "./library.zs";

function main(): i32 {
  const worker = createTypedWorker(42);
  const marker = I32WorkerMarker();
  const markerStatus = acceptMarker(marker);
  console.log(`nested worker value ${worker.current()}`);
  return worker.current() - 42 + markerStatus;
}
