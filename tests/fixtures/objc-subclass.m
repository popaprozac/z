#import "objc-subclass.h"

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
  }
  return self;
}
- (int)value { return _value; }
- (int)readVirtualValue { return [self value]; }
- (int)readObject:(ZSubclassFixture *)object { return [object value]; }
- (int)add:(int)left to:(int)right { return left + right; }
- (void)recordPhase:(int)phase { _recordedPhase = phase; }
- (ZSubclassPoint)adjustPoint:(ZSubclassPoint)point { return point; }
- (int)requiredValue { return 0; }
- (int)directValue { return 0; }
- (void)takeObject:(NSObject * __attribute__((ns_consumed)))object { (void)object; }
- (void)dealloc {
  [self checkBaseDispatch:3];
  teardownCallbacks += 1;
  liveCount -= 1;
}
@end

void z_subclass_check_constructing(ZSubclassFixture *object) {
  [object checkBaseDispatch:2];
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

@implementation ZFinalSubclassFixture
@end
