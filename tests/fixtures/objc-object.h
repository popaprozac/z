#ifndef Z_OBJC_OBJECT_H
#define Z_OBJC_OBJECT_H
#import <Foundation/Foundation.h>

typedef struct ZObjectRecord { int value; } ZObjectRecord;

// NSProxy is deliberately not an NSObject subclass.
@interface ZErasedProxy : NSProxy
+ (instancetype _Nonnull)make;
@end
@implementation ZErasedProxy
+ (instancetype _Nonnull)make { return [self alloc]; }
- (BOOL)isKindOfClass:(Class _Nonnull)cls { return cls == [ZErasedProxy class] || cls == [NSProxy class]; }
@end

@interface ZObjectSource : NSObject
+ (id _Nullable)text;
+ (id _Nonnull)proxy;
+ (int)same:(id _Nonnull)a other:(id _Nonnull)b;
+ (void)accept:(id _Nonnull)value;
@end
@implementation ZObjectSource
+ (id _Nullable)text { return @"native"; }
+ (id _Nonnull)proxy { return [ZErasedProxy make]; }
+ (int)same:(id _Nonnull)a other:(id _Nonnull)b { return a == b; }
+ (void)accept:(id _Nonnull)value { (void)value; }
@end

__attribute__((swift_attr("@MainActor")))
@interface ZObjectBase : NSObject
- (instancetype _Nonnull)init NS_UNAVAILABLE;
- (instancetype _Nonnull)initWithMarker:(int)marker NS_DESIGNATED_INITIALIZER;
- (int)inspect:(id _Nullable)value;
@end
@implementation ZObjectBase
- (instancetype _Nonnull)initWithMarker:(int)marker { (void)marker; return [super init]; }
- (int)inspect:(id _Nullable)value { return value == nil ? 0 : 7; }
@end
#endif
