import { thread } from "std/thread";

struct WorkError {
  message: String;
}

readonly struct WorkRequest {
  title: String;
  body: Option<String> = Option<String>.none;
}

type WorkOutcome = Result<i32, WorkError>;
type WorkOperation = async () => WorkOutcome on thread.main;

struct WorkBackend {
  operation: WorkOperation;
}

async function produce(): i32 throws WorkError on thread.main {
  return 42;
}

class WorkState on thread.main {
  backend: WorkBackend;

  async function read(): i32 throws WorkError {
    const outcome = await this.backend.operation();
    return match (outcome) {
      success(value) => value;
      failure(error) => throw error;
    };
  }
}

async function main(): i32 throws WorkError on thread.main {
  const operation: WorkOperation = async () => attempt await produce();
  const state = new WorkState({ backend: WorkBackend({ operation }) });
  const title = "Notification";
  const request = WorkRequest({
    title: copy title,
    body: Option.some("Ready"),
  });
  const value = try await state.read();
  // `title` remains frame-backed across the await. Its compiler-private alias
  // must not rewrite the `.title` field token in the expression below.
  return value == 42 && request.title == title ? 0 : 2;
}
