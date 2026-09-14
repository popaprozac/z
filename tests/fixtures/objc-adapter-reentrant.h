#ifndef Z_OBJC_ADAPTER_REENTRANT_H
#define Z_OBJC_ADAPTER_REENTRANT_H
#import <Foundation/Foundation.h>
#include <stdint.h>
#include <stdlib.h>

static int32_t z_reentrant_destroyed = 0;
static inline void z_reentrant_destroy(void) { ++z_reentrant_destroyed; }
static inline void z_reentrant_expect(int32_t expected) {
  if (z_reentrant_destroyed != expected) exit(93);
}
@class ZReentrantOwner;
@protocol ZReentrantHandler <NSObject>
- (void)receive:(ZReentrantOwner *)owner;
- (int32_t)value:(ZReentrantOwner *)owner;
@end
@interface ZReentrantOwner : NSObject
@property(nonatomic, strong) id<ZReentrantHandler> handler;
- (void)clear;
- (void)fire;
- (int32_t)read;
@end
@implementation ZReentrantOwner
- (void)clear { self.handler = nil; }
- (void)fire {
  // Deliberately do not pin here: the generated entry must protect its Z
  // receiver even if the last native owner unregisters during the callback.
  __unsafe_unretained id<ZReentrantHandler> target = _handler;
  [target receive:self];
}
- (int32_t)read {
  __unsafe_unretained id<ZReentrantHandler> target = _handler;
  return [target value:self];
}
@end
#endif
