#include "objc-subclass-wire.h"

__attribute__((availability(macos,introduced=12.0)))
@interface ZWireAvailable : ZWireBase
- (int)futureValue __attribute__((availability(macos,introduced=14.2,message="use value on older systems")));
- (int)removedValue __attribute__((availability(macos,introduced=10.0,obsoleted=13.1)));
- (int)otherPlatform __attribute__((availability(ios,unavailable)));
- (int)deprecatedValue __attribute__((availability(macos,introduced=10.0,deprecated=12.0)));
- (int)forbiddenValue __attribute__((unavailable("retired method")));
- (instancetype _Nonnull)initForFuture:(int)value __attribute__((objc_designated_initializer)) __attribute__((availability(macos,introduced=14.1)));
@property int futureProperty __attribute__((availability(macos,introduced=14.3)));
@end

__attribute__((availability(macos,introduced=14.0)))
@interface ZWireFuture : ZWireBase
@end

__attribute__((unavailable("retired base")))
@interface ZWireUnavailable : ZWireBase
@end
