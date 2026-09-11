#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
typedef enum ZSubclassDepth { ZSubclassDepthLow = 0 } ZSubclassDepth;
typedef struct ZSubclassPoint { double x; double y; } ZSubclassPoint;
__attribute__((swift_attr("@MainActor")))
@interface ZSubclassFixture : NSObject
- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithValue:(int)value NS_DESIGNATED_INITIALIZER;
- (int)value;
- (int)readVirtualValue;
- (int)readObject:(ZSubclassFixture *)object;
- (int)add:(int)left to:(int)right;
- (void)recordPhase:(int)phase;
- (ZSubclassPoint)adjustPoint:(ZSubclassPoint)point;
- (int)readAccess:(int)mode;
- (int)writeAccess:(int)mode;
@property(readonly) int recordedPhase;
@property int configuredValue;
@property ZSubclassDepth configuredDepth;
- (int)requiredValue NS_REQUIRES_SUPER;
- (int)directValue __attribute__((objc_direct));
- (void)takeObject:(NSObject * __attribute__((ns_consumed)))object;
@end

__attribute__((objc_subclassing_restricted))
@interface ZFinalSubclassFixture : ZSubclassFixture
@end

// A retained temporary whose ARC cleanup reenters the constructing receiver.
@interface ZSubclassConstructorCleanup : NSObject
- (void)touch;
@end
ZSubclassConstructorCleanup *z_subclass_constructor_cleanup(ZSubclassFixture *object) NS_RETURNS_RETAINED;
int z_subclass_constructor_cleanups(void);

@interface ZSubclassAccessCleanup : NSObject
- (void)touch;
@end
ZSubclassAccessCleanup *z_subclass_access_cleanup(ZSubclassFixture *object, int write) NS_RETURNS_RETAINED;
int z_subclass_call_read(ZSubclassFixture *object, int mode);
int z_subclass_call_write(ZSubclassFixture *object, int mode);
void z_subclass_publish(ZSubclassFixture *object);
void z_subclass_drop_published(void);
int z_subclass_call_published(void);
int z_subclass_access_scenario(void);
void z_subclass_catch_abort(void);

__attribute__((swift_attr("@MainActor")))
@interface ZNullableSubclassFixture : NSObject
- (nullable instancetype)initWithValue:(int)value NS_DESIGNATED_INITIALIZER;
@end

int z_subclass_live_count(void);
void z_subclass_enter_body(void);
void z_subclass_leave_body(void);
int z_subclass_body_balance(void);
void z_subclass_check_constructing(ZSubclassFixture *object);
int z_subclass_lifecycle_failures(void);
int z_subclass_construction_callbacks(void);
int z_subclass_teardown_callbacks(void);
NS_ASSUME_NONNULL_END
