#ifndef Z_OBJC_ARRAY_POP_H
#define Z_OBJC_ARRAY_POP_H
#import <Foundation/Foundation.h>
#include <stdlib.h>

static int z_array_pop_live = 0;

@interface ZArrayPopOwner : NSObject
@property(nonatomic, copy) NSString * _Nonnull title;
@end

@implementation ZArrayPopOwner
- (instancetype _Nonnull)init {
  self = [super init];
  if (self) z_array_pop_live += 1;
  return self;
}
- (void)dealloc { z_array_pop_live -= 1; }
@end

static void z_array_pop_verify_cleanup(void) {
  if (z_array_pop_live != 0) abort();
}

static inline void z_array_pop_watch_cleanup(void) {
  atexit(z_array_pop_verify_cleanup);
}
#endif
