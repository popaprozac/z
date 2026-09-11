#import "reference-identity.h"
static int live = 0;
static int equalCalls = 0;
@implementation ZIdentityObject
+ (instancetype)optionalWithValue:(int)value {
  return value < 0 ? nil : [[self alloc] initWithValue:value];
}
- (instancetype)initWithValue:(int)value {
  self = [super init];
  if (self) { _value = value; live++; }
  return self;
}
- (BOOL)isEqual:(id)other { (void)other; equalCalls++; return YES; }
- (void)dealloc { live--; }
@end
@implementation ZIdentityChild
@end
@implementation ZIdentityUnrelated
@end
ZIdentityObject *z_identity_make(int value) { return [[ZIdentityObject alloc] initWithValue:value]; }
ZIdentityObject *z_identity_optional(ZIdentityObject *value, BOOL present) { return present ? value : nil; }
NSObject *z_identity_base(ZIdentityObject *value) { return value; }
id z_identity_erased(ZIdentityObject *value) { return value; }
int z_identity_equal_calls(void) { return equalCalls; }
int z_identity_live(void) { return live; }
