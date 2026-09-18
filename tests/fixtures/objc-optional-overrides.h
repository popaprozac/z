#import <Foundation/Foundation.h>
#include <signal.h>
#include <stdlib.h>
#include <unistd.h>

static int z_callback_phase;
static int z_callback_arguments;
static int z_callback_notes;
static int z_callback_tokens;
static inline int z_callback_argument(void) { return ++z_callback_arguments; }
static inline int z_callback_argument_count(void) { return z_callback_arguments; }
static inline int z_callback_note_count(void) { return z_callback_notes; }
static inline int z_callback_token_count(void) { return z_callback_tokens; }
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
@interface ZCallbackToken : NSObject
@property(readonly) int value;
@end
@implementation ZCallbackToken
- (instancetype)init { self = [super init]; if (self) ++z_callback_tokens; return self; }
- (int)value { return 42; }
- (void)dealloc { --z_callback_tokens; }
@end

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
- (int)optionalIncrement:(int)value;
- (int)missingIncrement:(int)value;
- (int)optionalInfo:(id<ZDropInfo>)info;
- (void)optionalNote:(int)value;
- (void)missingNote:(int)value;
- (BOOL)optionalFlag;
- (NSPoint)optionalPoint;
- (NSString *)optionalTitle;
- (NSString * _Nullable)optionalNullableTitle;
- (NSString * _Nullable)missingNullableTitle;
- (ZCallbackToken *)optionalToken;
- (ZCallbackToken * _Nullable)optionalNullableToken;
@end

@protocol ZInheritedCallbacks <ZOptionalCallbacks>
@end

__attribute__((swift_attr("@MainActor")))
@interface ZCallbackBase : NSObject <ZInheritedCallbacks>
- (instancetype)init NS_DESIGNATED_INITIALIZER;
- (int)inheritedValue;
@end
@implementation ZCallbackBase
- (instancetype)init { return [super init]; }
- (int)inheritedValue { return 7; }
- (int)optionalIncrement:(int)value { return value + [self optionalValue]; }
- (int)optionalInfo:(id<ZDropInfo>)info { return [info value]; }
- (void)optionalNote:(int)value { z_callback_notes += value; }
- (BOOL)optionalFlag { return NO; }
- (NSPoint)optionalPoint { return NSMakePoint(3, 4); }
- (NSString *)optionalTitle { return [NSString stringWithFormat:@"title-%d", 42]; }
- (NSString * _Nullable)optionalNullableTitle { return nil; }
- (ZCallbackToken *)optionalToken { return [[ZCallbackToken alloc] init]; }
- (ZCallbackToken * _Nullable)optionalNullableToken { return [[ZCallbackToken alloc] init]; }
@end

@interface ZCallbackDestination : ZCallbackBase
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
static inline int z_callback_inherited(ZCallbackDestination *target) {
    @autoreleasepool { return [target inheritedValue]; }
}
NS_ASSUME_NONNULL_END
