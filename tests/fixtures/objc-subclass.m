#import "objc-subclass.h"

static int liveCount = 0;
int z_subclass_live_count(void) { return liveCount; }

@implementation ZSubclassFixture {
  int _value;
}
- (instancetype)initWithValue:(int)value {
  self = [super init];
  if (self) { _value = value; liveCount += 1; }
  return self;
}
- (int)value { return _value; }
- (int)readVirtualValue { return [self value]; }
- (int)add:(int)left to:(int)right { return left + right; }
- (int)requiredValue { return 0; }
- (int)directValue { return 0; }
- (void)takeObject:(NSObject * __attribute__((ns_consumed)))object { (void)object; }
- (void)dealloc { liveCount -= 1; }
@end

@implementation ZFinalSubclassFixture
@end
