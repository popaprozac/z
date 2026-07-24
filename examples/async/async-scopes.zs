import console from "std/console";

struct ScopeJob {
  id: i32;

  deinit {
    console.log(`released scoped job ${this.id}`);
  }
}

async function finish(job: ScopeJob): void {
  return;
}

async function main(): i32 {
  async scope {
    task finish(ScopeJob({ id: 10 }));

    async scope {
      task finish(ScopeJob({ id: 20 }));
      task finish(ScopeJob({ id: 21 }));
    }

    task finish(ScopeJob({ id: 11 }));
  }

  // This root child cannot start until both explicit scope boundaries exit.
  task finish(ScopeJob({ id: 30 }));
  return 0;
}
