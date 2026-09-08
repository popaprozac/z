import {
  assert, compileToNative, hostToolchainTest, mkdtempSync, projectRoot,
  readFileSync, resolve, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";

function command(executable: string, args: string[], input?: string, timeout = 30_000) {
  const result = spawnSync(executable, args, {
    encoding: "utf8", input, timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

function execute(source: string, binary: string, expected: string): void {
  command("clang", ["-x", "objective-c", "-std=c11", "-fobjc-arc", "-framework", "Foundation",
    "-Wall", "-Wextra", "-Werror", "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all",
    "-", "-o", binary], source);
  assert.equal(command(binary, [], undefined, 5_000), expected);
}

hostToolchainTest("cleans Foundation resources and synchronized storage in native yield frames", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-native-yield-objc-");
  try {
    const input = resolve(directory, "main.zs");
    const fixture = resolve(projectRoot, "tests/fixtures/async-yield-native-storage.zs");
    const original = readFileSync(fixture, "utf8");
    writeFileSync(input, original);
    const expected = "released inbox\nreleased endpoint\nreleased lease\n";
    execute(compileToNative(original, input).source, resolve(directory, "stage0"), expected);

    // Unlike the source-only self-host-emit probe, the standalone driver loads
    // real Clang header metadata. Build it from this checkout, not a stale binary.
    const driver = resolve(directory, "z");
    command(process.execPath, [resolve(projectRoot, "scripts/bootstrap-native.ts"), driver], undefined, 240_000);
    const native = resolve(directory, "native");
    command(driver, ["build", input, native], undefined, 120_000);
    const source = readFileSync(`${native}.m`, "utf8");
    execute(source, resolve(directory, "native-ubsan"), expected);

    const harness = `#include <errno.h>
static int descriptor_closed(int fd) { errno = 0; return fcntl(fd, F_GETFD) == -1 && errno == EBADF; }
int main(void) {
  Z_AsyncExecutor executor = {0};
  for (int phase = 0; phase < 3; ++phase) {
    Z_AsyncInvocation invocation;
    int endpoint_fd, lease_fd, local_fd = -1;
    __weak NSFileHandle *endpoint_owner;
    __weak NSFileHandle *lease_owner;
    @autoreleasepool {
      Z_Endpoint endpoint = makeEndpoint();
      endpoint_owner = endpoint.file;
      lease_owner = endpoint.lease.file;
      endpoint_fd = endpoint.file.fileDescriptor;
      lease_fd = endpoint.lease.file.fileDescriptor;
      invocation = _z_stage1_yield_listen_start(&executor, endpoint, makeInbox(), 2);
    }
    if (phase != 0) {
      z_stage1_async_enqueue(&executor, invocation.task);
      if (phase == 2) {
        @autoreleasepool {
          if (!z_stage1_async_drive_one(&executor) || invocation.task->completed) return 1;
          local_fd = ((_z_stage1_yield_listen *)invocation.task)->_z_binding_local.fileDescriptor;
        }
      }
      z_stage1_async_request_cancel(invocation.task);
      if (!z_stage1_async_drive_one(&executor) || !invocation.task->cancelled) return 2;
    }
    invocation.destroy(invocation.task);
    if (!descriptor_closed(endpoint_fd) || !descriptor_closed(lease_fd)) return 3;
    if (local_fd >= 0 && !descriptor_closed(local_fd)) return 4;
    if (endpoint_owner != nil || lease_owner != nil) return 10;
  }
  // A moved-from parameter has a disarmed Z cleanup guard but may still have
  // Clang strong aliases. Both its slots and the new owner's slots must clear.
  for (int phase = 0; phase < 3; ++phase) {
    Z_AsyncInvocation invocation;
    int endpoint_fd, lease_fd;
    __weak NSFileHandle *endpoint_owner;
    __weak NSFileHandle *lease_owner;
    @autoreleasepool {
      Z_Endpoint endpoint = makeEndpoint();
      endpoint_fd = endpoint.file.fileDescriptor;
      lease_fd = endpoint.lease.file.fileDescriptor;
      endpoint_owner = endpoint.file;
      lease_owner = endpoint.lease.file;
      invocation = _z_stage1_yield_listenMoved_start(&executor, endpoint, 2);
    }
    if (phase != 0) {
      z_stage1_async_enqueue(&executor, invocation.task);
      if (phase == 2 && (!z_stage1_async_drive_one(&executor) || invocation.task->completed)) return 11;
      z_stage1_async_request_cancel(invocation.task);
      if (!z_stage1_async_drive_one(&executor) || !invocation.task->cancelled) return 12;
    }
    invocation.destroy(invocation.task);
    if (!descriptor_closed(endpoint_fd) || !descriptor_closed(lease_fd)) return 13;
    if (endpoint_owner != nil || lease_owner != nil) return 14;
  }
  // Direct Objective-C parameters and plain wrappers have no Z deinit hook.
  // Releasing their frame storage must nevertheless close the last ARC owner.
  for (int kind = 0; kind < 2; ++kind) {
    for (int phase = 0; phase < 3; ++phase) {
      Z_AsyncInvocation invocation;
      int fd;
      @autoreleasepool {
        NSFileHandle *file = openHandle();
        fd = file.fileDescriptor;
        if (kind == 0) invocation = _z_stage1_yield_listenDirect_start(&executor, file, 2);
        else invocation = _z_stage1_yield_listenOwner_start(&executor, (Z_NativeOwner){ .file = file }, 2);
      }
      if (phase != 0) {
        z_stage1_async_enqueue(&executor, invocation.task);
        if (phase == 2 && (!z_stage1_async_drive_one(&executor) || invocation.task->completed)) return 5;
        z_stage1_async_request_cancel(invocation.task);
        if (!z_stage1_async_drive_one(&executor) || !invocation.task->cancelled) return 6;
      }
      invocation.destroy(invocation.task);
      if (!descriptor_closed(fd)) return 7;
    }
  }
  Z_AsyncInvocation absent = _z_stage1_yield_listenDirect_start(&executor, nil, 2);
  z_stage1_async_enqueue(&executor, absent.task);
  if (!z_stage1_async_drive_one(&executor) || !absent.task->completed || absent.task->cancelled) return 9;
  absent.destroy(absent.task);
  if (executor.head != NULL || executor.tail != NULL) return 8;
  // An error with only Clang ARC storage (no Z deinit) must be released both
  // when unclaimed and after transfer out of the child and parent frames.
  for (int phase = 0; phase < 3; ++phase) {
    Z_AsyncInvocation invocation;
    int fd;
    __weak NSFileHandle *owner;
    @autoreleasepool {
      NSFileHandle *file = openHandle();
      owner = file;
      fd = file.fileDescriptor;
      invocation = _z_stage1_yield_joinNative_start(&executor, (Z_NativeOwner){ .file = file });
    }
    z_stage1_async_enqueue(&executor, invocation.task);
    // Leave the failed child's owned result pending at the parent join.
    for (int tick = 0; tick < 4; ++tick) {
      if (!z_stage1_async_drive_one(&executor)) return 15;
    }
    if (phase == 0) {
      z_stage1_async_request_cancel(invocation.task);
      if (!z_stage1_async_drive_one(&executor) || !invocation.task->cancelled) return 16;
      invocation.destroy(invocation.task);
    } else {
      if (!z_stage1_async_drive_one(&executor) || !invocation.task->completed) return 17;
      if (phase == 1) invocation.destroy(invocation.task);
      else {
        __typeof__(((_z_stage1_yield_joinNative *)invocation.task)->result) result = {0};
        invocation.take_result(invocation.task, &result);
        invocation.destroy(invocation.task);
        if (descriptor_closed(fd) || owner == nil) return 18;
        result = (__typeof__(result)){0};
      }
    }
    if (!descriptor_closed(fd) || owner != nil) {
      fprintf(stderr, "native error phase %d retained fd=%d object=%p\\n", phase, fd, owner);
      return 19;
    }
    if (executor.head != NULL || executor.tail != NULL) return 20;
  }
  // The match subject and its payload have lexical Clang ARC lifetimes.
  // They must end before the next resume label, including early-return paths.
  for (int phase = 0; phase < 3; ++phase) {
    Z_AsyncInvocation invocation;
    int fd;
    __weak NSFileHandle *owner;
    @autoreleasepool {
      NSFileHandle *file = openHandle();
      fd = file.fileDescriptor;
      owner = file;
      invocation = _z_stage1_yield_matchNative_start(&executor, (Z_NativeOwner){ .file = file }, phase == 0);
    }
    z_stage1_async_enqueue(&executor, invocation.task);
    @autoreleasepool {
      if (!z_stage1_async_drive_one(&executor)) return 21;
      if (phase == 0 && !invocation.task->completed) return 22;
      if (phase != 0) {
        if (invocation.task->completed || descriptor_closed(fd) || owner == nil) return 23;
        if (phase == 1) z_stage1_async_request_cancel(invocation.task);
        if (!z_stage1_async_drive_one(&executor) || !invocation.task->completed) return 24;
        if (invocation.task->cancelled != (phase == 1)) return 25;
      }
      invocation.destroy(invocation.task);
    }
    if (!descriptor_closed(fd) || owner != nil) return 26;
    if (executor.head != NULL || executor.tail != NULL) return 27;
  }
  return 0;
}`;
    // Bridge names are private generated identities, not a native ABI. Resolve
    // the frame names after header-aware mangling rather than pinning module IDs.
    const nativeHarness = harness.replace(
      /\b_z_stage1_yield_(listenMoved|listenDirect|listenOwner|joinNative|matchNative|listen)(_start)?\b/g,
      (_match, name: string, suffix: string | undefined) => {
        const frame = new RegExp(`typedef struct (_z_stage1_yield_(?:__z_module_\\d+_)?${name}) \\{`).exec(source)?.[1];
        assert.ok(frame, `Missing frame for ${name}`);
        return frame + (suffix ?? "");
      },
    );
    execute(`#define main z_fixture_main\n${source}\n#undef main\n${nativeHarness}`, resolve(directory, "cancellation-ubsan"),
      expected.repeat(3) + "released endpoint\nreleased lease\n".repeat(3));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 360_000);
