import { thread } from "std/thread";

struct DialogError {
  message: String;
}

struct TransferError {
  message: String;
}

readonly class DialogManager on thread.main {
  async function open(shouldCancel: boolean): Option<String> throws DialogError {
    if (shouldCancel) return Option<String>.none;
    return Option.some("notes.json");
  }
}

readonly class TransferService {
  readonly dialogs: DialogManager;

  async function importFile(
    shouldCancel: boolean
  ): Option<String> throws TransferError on thread.main {
    const selected = attempt await this.dialogs.open(shouldCancel);
    const path = match (selected) {
      success(value) => value;
      failure(error) => throw TransferError({ message: copy error.message });
    };
    return match (path) {
      some(value) => Option.some(move value);
      none => Option<String>.none;
    };
  }
}

async function main(): i32 {
  const service = new TransferService({
    dialogs: new DialogManager({}),
  });
  const imported = attempt await on thread.main service.importFile(false);
  const selection = match (imported) {
    success(value) => value;
    failure(_) => return 3;
  };
  return match (selection) {
    some(path) => path == "notes.json" ? 0 : 1;
    none => 2;
  };
}
