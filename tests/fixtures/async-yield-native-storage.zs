import Foundation from "Foundation/Foundation.h";
import descriptors from "fcntl.h";
import console from "std/console";
import { scheduler } from "std/async";
import { Mutex } from "std/sync";

struct InboxState {
  count: i32;
  deinit { console.log("released inbox"); }
}

function makeInbox(): Mutex<InboxState> { return Mutex(InboxState({ count: 0 })); }

function openHandle(): Foundation.NSFileHandle = raw objc {
  int fd = open("/dev/null", O_RDONLY);
  if (fd < 0) abort();
  return [[NSFileHandle alloc] initWithFileDescriptor:fd closeOnDealloc:YES];
}

struct Lease {
  file: Foundation.NSFileHandle;
  deinit {
    this.file.closeFile();
    console.log("released lease");
  }
}

struct Endpoint {
  lease: Lease;
  file: Foundation.NSFileHandle;
  deinit {
    this.file.closeFile();
    console.log("released endpoint");
  }
}

function makeEndpoint(): Endpoint {
  return Endpoint({ lease: Lease({ file: openHandle() }), file: openHandle() });
}

async function listen(endpoint: Endpoint, inbox: Mutex<InboxState>, rounds: i32): i32 {
  const local = openHandle();
  let received = 0;
  while (received < rounds) {
    if (endpoint.file.fileDescriptor < 0 || local.fileDescriptor < 0) return 1;
    inbox.withLock((inout state): void => { state.count = state.count + 1; });
    await scheduler.yield();
    received = received + 1;
  }
  return 0;
}

async function listenMoved(endpoint: Endpoint, rounds: i32): i32 {
  const owner = move endpoint;
  let received = 0;
  while (received < rounds) {
    if (owner.file.fileDescriptor < 0) return 1;
    await scheduler.yield();
    received = received + 1;
  }
  return 0;
}

// No user deinit: the frame must still clear Clang-owned strong fields.
struct NativeOwner { file: Foundation.NSFileHandle; }

async function failNative(owner: NativeOwner): i32 throws NativeOwner {
  await scheduler.yield();
  throw owner;
}

async function joinNative(owner: NativeOwner): i32 throws NativeOwner {
  await scheduler.yield();
  const value = try await failNative(owner);
  return value;
}

async function joinConstructed(file: Foundation.NSFileHandle): i32 throws NativeOwner {
  await scheduler.yield();
  const value = try await failNative(NativeOwner({ file }));
  return value;
}

async function listenOwner(owner: NativeOwner, rounds: i32): i32 {
  const { file } = owner;
  let received = 0;
  while (received < rounds) {
    if (file.fileDescriptor < 0) return 1;
    await scheduler.yield();
    received = received + 1;
  }
  return 0;
}

async function listenDirect(file: Foundation.NSFileHandle | null, rounds: i32): i32 {
  if (file == null) return 0;
  let received = 0;
  while (received < rounds) {
    if (file.fileDescriptor < 0) return 1;
    await scheduler.yield();
    received = received + 1;
  }
  return 0;
}

async function main(): i32 {
  return await listen(makeEndpoint(), makeInbox(), 2);
}
