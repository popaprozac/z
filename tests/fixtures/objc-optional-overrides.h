#import <Foundation/Foundation.h>
#include <signal.h>
#include <stdlib.h>
#include <unistd.h>

static int z_callback_phase;
static void z_callback_aborted(int signal_number) {
    (void)signal_number;
    _exit(90 + z_callback_phase);
}
static inline void z_callback_prepare(void) {
    const char *phase = getenv("Z_CALLBACK_PHASE");
    z_callback_phase = phase ? atoi(phase) : 0;
    if (z_callback_phase) signal(SIGABRT, z_callback_aborted);
}

NS_ASSUME_NONNULL_BEGIN
@protocol ZDropInfo <NSObject>
@property(readonly) int value;
@property(readonly) NSString *caption;
@property(readonly) NSPoint position;
@optional
@property(readonly) int missing;
@end

@protocol ZOptionalCallbacks <NSObject>
@optional
- (int)acceptInfo:(id<ZDropInfo>)info;
- (int)optionalValue;
- (int)missingValue;
- (int)inheritedValue;
@end

@protocol ZInheritedCallbacks <ZOptionalCallbacks>
@end

__attribute__((swift_attr("@MainActor")))
@interface ZCallbackBase : NSObject
- (instancetype)init NS_DESIGNATED_INITIALIZER;
- (int)inheritedValue;
@end
@implementation ZCallbackBase
- (instancetype)init { return [super init]; }
- (int)inheritedValue { return 7; }
@end

@interface ZCallbackDestination : ZCallbackBase <ZInheritedCallbacks>
- (instancetype)init NS_DESIGNATED_INITIALIZER;
@end
@implementation ZCallbackDestination
- (instancetype)init {
    self = [super init];
    if (self && z_callback_phase == 1) [self optionalValue];
    return self;
}
- (void)dealloc { if (z_callback_phase == 2) [self optionalValue]; }
@end

@interface ZDropInfoValue : NSObject <ZDropInfo>
@end
@implementation ZDropInfoValue
- (int)value { return 35; }
- (NSString *)caption { return @"probe"; }
- (NSPoint)position { return NSMakePoint(3, 4); }
@end

static inline int z_callback_dispatch(ZCallbackDestination *target) {
    return [target acceptInfo:[[ZDropInfoValue alloc] init]];
}
NS_ASSUME_NONNULL_END
