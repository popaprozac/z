import console from "std/console";

struct LoadError {
  code: i32;
}

struct Session {
  userId: i32;
  displayName: String;
  selectedDocumentId: Option<i32>;

  function selection(): Option<i32> {
    return this.selectedDocumentId;
  }

  function summary(): String {
    return `${this.displayName} (#${this.userId})`;
  }

  function loadSummary(): String throws LoadError {
    if (this.userId <= 0) {
      throw LoadError({ code: 404 });
    }
    return this.summary();
  }

  function report(): void {
    console.log(`active session: ${this.displayName}`);
  }
}

struct Dashboard {
  activeSession?: Session;
}

function loadActive(in dashboard: Dashboard): Option<String> throws LoadError {
  return try dashboard.activeSession?.loadSummary();
}

function main(): i32 {
  const dashboard = Dashboard({
    activeSession: Session({
      userId: 42,
      displayName: "Ada",
      selectedDocumentId: Option.some(7),
    }),
  });
  const empty = Dashboard();

  // Scalar results are lifted into Option<T>.
  const userId = dashboard.activeSession?.userId;

  // An Option<T> result stays flat rather than becoming Option<Option<T>>.
  const selectedDocumentId = dashboard.activeSession?.selection();

  // A stored cleanup-bearing field is borrowed as Option<view T>.
  const displayName = dashboard.activeSession?.displayName;

  // A fresh owned method result becomes Option<T>.
  const summary = dashboard.activeSession?.summary();

  // A void call runs only when the receiver is present.
  dashboard.activeSession?.report();
  empty.activeSession?.report();

  // Absence is a successful none; a real LoadError remains in the error channel.
  const loaded = attempt loadActive(in dashboard);

  const observedUserId = match (in userId) {
    some(value) => value;
    none => 0;
  };
  const observedDocumentId = match (in selectedDocumentId) {
    some(value) => value;
    none => 0;
  };
  const observedNameBytes = match (in displayName) {
    some(value) => value.byteLength;
    none => usize(0);
  };
  const observedSummaryBytes = match (in summary) {
    some(value) => value.byteLength;
    none => usize(0);
  };
  const observedLoadedBytes = match (loaded) {
    success(value) => {
      const bytes = match (value) {
        some(summary) => summary.byteLength;
        none => usize(0);
      };
      select bytes;
    }
    failure(error) => usize(error.code);
  };

  if (observedUserId != 42) return 1;
  if (observedDocumentId != 7) return 2;
  if (observedNameBytes != 3) return 3;
  if (observedSummaryBytes == 0) return 4;
  if (observedLoadedBytes == 0) return 5;
  return 0;
}
