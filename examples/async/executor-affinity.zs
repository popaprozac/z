import { thread } from "std/thread";

// The controller owns mutable UI state and may only be used on the main
// executor. Its methods inherit that contract.
class NotesController on thread.main {
  readonly visibleCount: i32;

  function count(): i32 {
    return this.visibleCount;
  }
}

// Stored affinity is transitive: WindowModel is inferred as main-isolated
// because it owns a NotesController field. Hover WindowModel or `model` to see
// the inherited contract and its origin.
struct WindowModel {
  controller: NotesController;
}

function visibleNotes(in model: WindowModel): i32 on thread.main {
  return model.controller.count();
}

function main(): i32 {
  const controller = new NotesController({ visibleCount: 42 });
  const model = WindowModel({ controller });
  return visibleNotes(model) - 42;
}
