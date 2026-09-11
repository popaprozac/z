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

// Inline owned native state: its destructor deliberately dispatches through
// the owner while the owner's generated dealloc is clearing stored fields.
@interface ZSubclassStoredResource : NSObject
- (int)value;
@property(readonly) int storedValue;
- (void)attach:(ZSubclassFixture *)receiver;
- (void)touch;
@end
ZSubclassStoredResource *z_subclass_stored_resource(int value) NS_RETURNS_RETAINED;
int z_subclass_stored_live(void);
int z_subclass_stored_created(void);
int z_subclass_stored_destroyed(void);

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
int z_subclass_call_entry(ZSubclassFixture *object, int value);
int z_subclass_entry_scenario(void);
void z_subclass_entry_on_worker(ZSubclassFixture *object);

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
void z_subclass_source_deinit(size_t length, int offset);
int z_subclass_source_deinits(void);
NS_ASSUME_NONNULL_END
