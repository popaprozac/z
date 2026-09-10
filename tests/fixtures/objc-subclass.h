#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
typedef enum ZSubclassDepth { ZSubclassDepthLow = 0 } ZSubclassDepth;
__attribute__((swift_attr("@MainActor")))
@interface ZSubclassFixture : NSObject
- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithValue:(int)value NS_DESIGNATED_INITIALIZER;
- (int)value;
- (int)readVirtualValue;
- (int)readObject:(ZSubclassFixture *)object;
- (int)add:(int)left to:(int)right;
@property int configuredValue;
@property ZSubclassDepth configuredDepth;
- (int)requiredValue NS_REQUIRES_SUPER;
- (int)directValue __attribute__((objc_direct));
- (void)takeObject:(NSObject * __attribute__((ns_consumed)))object;
@end

__attribute__((objc_subclassing_restricted))
@interface ZFinalSubclassFixture : ZSubclassFixture
@end

__attribute__((swift_attr("@MainActor")))
@interface ZNullableSubclassFixture : NSObject
- (nullable instancetype)initWithValue:(int)value NS_DESIGNATED_INITIALIZER;
@end

int z_subclass_live_count(void);
void z_subclass_enter_body(void);
void z_subclass_leave_body(void);
int z_subclass_body_balance(void);
NS_ASSUME_NONNULL_END
