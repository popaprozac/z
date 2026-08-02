import { thread } from "std/thread";

function launchMessage(input: String): Task<i32> {
  return thread.spawn(move (): i32 => i32(input.byteLength) - 18);
}

async function main(): i32 {
  const message = "owned worker value";
  let answer: i32 = 1;
  if (message.byteLength > 0) {
    const worker = thread.spawn(
      move (): i32 => i32(message.byteLength) - 18
    );
    answer = await worker;
  }
  const blockMessage = "block worker value";
  const blockWorker = thread.spawn(move (): i32 => {
    return i32(blockMessage.byteLength) - 18;
  });
  const blockAnswer = await blockWorker;
  const parameterWorker = launchMessage("owned worker value");
  const parameterAnswer = await parameterWorker;
  return answer + blockAnswer + parameterAnswer;
}
