import console from "std/console";
import { TextBuffer } from "std/text";
import { thread } from "std/thread";

function makeMessage(id: i32): String {
  return `job=${id}`;
}

async function main(): i32 {
  const source = makeMessage(42);
  const measured = thread.spawn(move () => source.byteLength);
  // source is unavailable here because its owned UTF-8 storage moved.

  let output = TextBuffer();
  output.append("worker");
  const formatted = thread.spawn(move (): String => {
    output.appendAscii(61);
    output.append("42");
    return output.finish();
  });

  const sourceBytes = await measured;
  const message = await formatted;
  console.log(`source bytes=${sourceBytes}`);
  console.log(message);
  return 0;
}
