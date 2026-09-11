#import "objc-subclass.h"
#include <signal.h>
#include <stdlib.h>
#import <objc/message.h>
#include <pthread.h>

int z_subclass_entry_scenario(void) {
  const char *value = getenv("Z_SUBCLASS_ENTRY_SCENARIO");
  return value ? atoi(value) : 0;
}
// The selector is deliberately absent from the superclass header. This is a
// native ABI oracle, not a Z-level selector conversion or registration bypass.
int z_subclass_call_entry(ZSubclassFixture *object, int value) {
  return ((int (*)(id, SEL, int))objc_msgSend)(object, sel_registerName("receive:"), value);
}
static void *callEntryOnWorker(void *context) {
  @autoreleasepool { (void)z_subclass_call_entry((__bridge ZSubclassFixture *)context, 1); }
  return NULL;
}
void z_subclass_entry_on_worker(ZSubclassFixture *object) {
  pthread_t worker;
  if (pthread_create(&worker, NULL, callEntryOnWorker, (__bridge void *)object)) abort();
  if (pthread_join(worker, NULL)) abort();
}

static int liveCount = 0;
int z_subclass_live_count(void) { return liveCount; }
static int bodyBalance = 0;
void z_subclass_enter_body(void) { bodyBalance += 1; }
void z_subclass_leave_body(void) { bodyBalance -= 1; }
int z_subclass_body_balance(void) { return bodyBalance; }
static int lifecycleFailures = 0;
static int constructionCallbacks = 0;
static int teardownCallbacks = 0;
static int constructorCleanups = 0;
int z_subclass_lifecycle_failures(void) { return lifecycleFailures; }
int z_subclass_construction_callbacks(void) { return constructionCallbacks; }
int z_subclass_teardown_callbacks(void) { return teardownCallbacks; }
int z_subclass_constructor_cleanups(void) { return constructorCleanups; }
static int sourceDeinits = 0;
void z_subclass_source_deinit(size_t length, int offset) {
  if (length != 5 || offset != 2) lifecycleFailures += 1;
  sourceDeinits += 1;
}
int z_subclass_source_deinits(void) { return sourceDeinits; }

@implementation ZSubclassFixture {
  int _value;
}
- (void)checkBaseDispatch:(int)phase {
  // These deliberately use virtual dispatch, including nested dispatch through
  // readObject:. None may enter the Z override outside the ready lifetime.
  if ([self value] != _value) lifecycleFailures += 1;
  if ([self add:7 to:9] != 16) lifecycleFailures += 1;
  if ([self readObject:self] != _value) lifecycleFailures += 1;
  [self recordPhase:phase];
  if (_recordedPhase != phase) lifecycleFailures += 1;
  ZSubclassPoint point = [self adjustPoint:(ZSubclassPoint){ 1, 2 }];
  if (point.x != 1 || point.y != 2) lifecycleFailures += 1;
}
- (instancetype)initWithValue:(int)value {
  self = [super init];
  if (self) {
    _value = value;
    liveCount += 1;
    [self checkBaseDispatch:1];
    constructionCallbacks += 1;
    if (z_subclass_entry_scenario() == 1) (void)z_subclass_call_entry(self, 1);
  }
  return self;
}
- (int)value { return _value; }
- (int)readVirtualValue { return [self value]; }
- (int)readObject:(ZSubclassFixture *)object { return [object value]; }
- (int)add:(int)left to:(int)right { return left + right; }
- (void)recordPhase:(int)phase { _recordedPhase = phase; }
- (ZSubclassPoint)adjustPoint:(ZSubclassPoint)point { return point; }
- (int)readAccess:(int)mode { return mode; }
- (int)writeAccess:(int)mode { return mode; }
- (int)requiredValue { return 0; }
- (int)directValue { return 0; }
- (void)takeObject:(NSObject * __attribute__((ns_consumed)))object { (void)object; }
- (void)dealloc {
  if (z_subclass_entry_scenario() == 2) (void)z_subclass_call_entry(self, 1);
  [self checkBaseDispatch:3];
  teardownCallbacks += 1;
  liveCount -= 1;
}
@end

void z_subclass_check_constructing(ZSubclassFixture *object) {
  [object checkBaseDispatch:2];
}

static int storedLive = 0;
static int storedCreated = 0;
static int storedDestroyed = 0;
int z_subclass_stored_live(void) { return storedLive; }
int z_subclass_stored_created(void) { return storedCreated; }
int z_subclass_stored_destroyed(void) { return storedDestroyed; }
@implementation ZSubclassStoredResource {
  int _value;
  // Test oracle only: the field owner outlives this precise field-release
  // callback. A zeroing weak reference is already nil during owner dealloc.
  __unsafe_unretained ZSubclassFixture *_receiver;
}
- (instancetype)initWithValue:(int)value {
  self = [super init];
  if (self) { _value = value; storedLive += 1; storedCreated += 1; }
  return self;
}
- (int)value { return _value; }
- (void)attach:(ZSubclassFixture *)receiver { _receiver = receiver; }
- (int)storedValue { return _value; }
- (void)touch {}
- (void)dealloc {
  if (_receiver) [_receiver checkBaseDispatch:6];
  storedLive -= 1;
  storedDestroyed += 1;
}
@end
ZSubclassStoredResource *z_subclass_stored_resource(int value) {
  return [[ZSubclassStoredResource alloc] initWithValue:value];
}

@implementation ZSubclassConstructorCleanup {
  __weak ZSubclassFixture *_receiver;
}
- (instancetype)initWithReceiver:(ZSubclassFixture *)receiver {
  self = [super init];
  if (self) _receiver = receiver;
  return self;
}
- (void)touch {}
- (void)dealloc {
  ZSubclassFixture *receiver = _receiver;
  if (receiver == nil) lifecycleFailures += 1;
  else [receiver checkBaseDispatch:5];
  constructorCleanups += 1;
}
@end

ZSubclassConstructorCleanup *z_subclass_constructor_cleanup(ZSubclassFixture *object) {
  return [[ZSubclassConstructorCleanup alloc] initWithReceiver:object];
}

int z_subclass_call_read(ZSubclassFixture *object, int mode) { return [object readAccess:mode]; }
int z_subclass_call_write(ZSubclassFixture *object, int mode) { return [object writeAccess:mode]; }

@implementation ZSubclassAccessCleanup {
  __weak ZSubclassFixture *_receiver;
  int _write;
}
- (instancetype)initWithReceiver:(ZSubclassFixture *)receiver write:(int)write {
  self = [super init];
  if (self) { _receiver = receiver; _write = write; }
  return self;
}
- (void)touch {}
- (void)dealloc {
  ZSubclassFixture *receiver = _receiver;
  if (receiver == nil) abort();
  if (_write) (void)[receiver writeAccess:0];
  else (void)[receiver readAccess:0];
}
@end
ZSubclassAccessCleanup *z_subclass_access_cleanup(ZSubclassFixture *object, int write) {
  return [[ZSubclassAccessCleanup alloc] initWithReceiver:object write:write];
}

static ZSubclassFixture *published;
void z_subclass_publish(ZSubclassFixture *object) { published = object; }
void z_subclass_drop_published(void) { published = nil; }
int z_subclass_call_published(void) {
  // Deliberately no native strong temporary. The generated method must keep
  // its own receiver alive when a callback clears the last outside owner.
  __unsafe_unretained ZSubclassFixture *receiver = published;
  return [receiver writeAccess:3];
}
int z_subclass_access_scenario(void) {
  const char *value = getenv("Z_SUBCLASS_ACCESS_SCENARIO");
  return value ? atoi(value) : 0;
}
// Expected contract traps must not create macOS crash reports during tests.
static void expectedAbort(int signalNumber) { (void)signalNumber; _Exit(86); }
void z_subclass_catch_abort(void) { signal(SIGABRT, expectedAbort); }

@implementation ZFinalSubclassFixture
@end
