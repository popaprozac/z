#define Z_PROPERTY_AVAILABLE __attribute__((availability(macos, introduced=10.10)))
__attribute__((objc_root_class))
@interface ZPropertyRoot
@property(nullable, readonly, strong) ZPropertyRoot *optional Z_PROPERTY_AVAILABLE;
@property(nonnull, readonly, strong) ZPropertyRoot *required Z_PROPERTY_AVAILABLE;
@property(null_unspecified, readonly, strong) ZPropertyRoot *unspecified Z_PROPERTY_AVAILABLE;
@end
@protocol ZPropertyProtocol
@property(nullable, readonly, strong) ZPropertyRoot *optional Z_PROPERTY_AVAILABLE;
@property(nonnull, readonly, strong) ZPropertyRoot *required Z_PROPERTY_AVAILABLE;
@end
