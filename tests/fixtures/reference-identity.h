#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
@interface ZIdentityObject : NSObject
- (instancetype)initWithValue:(int)value;
@property(readonly) int value;
@end
@interface ZIdentityChild : ZIdentityObject
@end
@interface ZIdentityUnrelated : NSObject
@end
ZIdentityObject *z_identity_make(int value) NS_RETURNS_RETAINED;
ZIdentityObject * _Nullable z_identity_optional(ZIdentityObject *value, BOOL present);
NSObject *z_identity_base(ZIdentityObject *value);
id z_identity_erased(ZIdentityObject *value);
int z_identity_equal_calls(void);
int z_identity_live(void);
NS_ASSUME_NONNULL_END
