import { Mutex } from "std/sync";
import console from "std/console";

struct Request {
  path: String;
  deinit { console.log(`released request ${this.path}`); }
}

class Observer {
  name: String;
  deinit { console.log(`released observer ${this.name}`); }
}

struct Inbox {
  pending: Array<Request>;
}

function admit(in inbox: Mutex<Inbox>, request: Request, accept: boolean): boolean {
  return inbox.withLock(move (inout state): boolean => {
    if (!accept) return false;
    state.pending.push(move request);
    return true;
  });
}

function fail(in inbox: Mutex<Inbox>, request: Request): void throws i32 {
  try inbox.withLock(move (inout state): void throws i32 => {
    if (request.path.byteLength > 0) throw 7;
    state.pending.push(move request);
  });
}

function exercise(): i32 {
  const inbox = Mutex(Inbox({ pending: Array<Request>() }));
  if (!admit(in inbox, Request({ path: "accepted" }), true)) return 1;
  if (admit(in inbox, Request({ path: "rejected" }), false)) return 2;
  const failed = attempt fail(in inbox, Request({ path: "failed" }));
  match (failed) {
    success => return 3;
    failure(error) => { if (error != 7) return 4; }
  }
  const expression = Request({ path: "expression" });
  inbox.withLock(move (inout state): void => state.pending.push(move expression));
  const returned = Request({ path: "returned" });
  const received = inbox.withLock(move (in state): Request => move returned);
  if (received.path != "returned") return 5;
  const observer = new Observer({ name: "shared" });
  const observed = inbox.withLock(move (in state): usize => observer.name.byteLength);
  if (observed != observer.name.byteLength) return 6;
  // A borrowing callback still owns its locals. Early return needs a local
  // live flag which must not be overwritten by the enclosing function.
  const names = inbox.withLock((in state): Array<String> => {
    const local = Array<String>("local");
    if (state.pending.length == 0) return Array<String>();
    return move local;
  });
  if (names.length != 1 || names[0] != "local") return 7;
  return inbox.withLock((in state): i32 => i32(state.pending.length)) - 2;
}

function main(): i32 { return exercise(); }
