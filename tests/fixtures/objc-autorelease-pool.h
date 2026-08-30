#ifndef Z_OBJC_AUTORELEASE_POOL_H
#define Z_OBJC_AUTORELEASE_POOL_H

#import <Foundation/Foundation.h>

static int32_t z_objc_autorelease_probe_live = 0;

@interface ZObjCAutoreleaseProbe : NSObject
+ (instancetype)makeAutoreleased;
- (int32_t)currentLive;
@end

@implementation ZObjCAutoreleaseProbe

+ (instancetype)makeAutoreleased {
  ZObjCAutoreleaseProbe *value = [[self alloc] init];
  return value;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) z_objc_autorelease_probe_live += 1;
  return self;
}

- (void)dealloc {
  z_objc_autorelease_probe_live -= 1;
}

- (int32_t)currentLive {
  return z_objc_autorelease_probe_live;
}

@end

static inline int32_t z_objc_autorelease_live(void) {
  return z_objc_autorelease_probe_live;
}

#endif
