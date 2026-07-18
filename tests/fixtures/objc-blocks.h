#ifndef Z_OBJC_BLOCKS_H
#define Z_OBJC_BLOCKS_H

#import <Foundation/Foundation.h>

@interface ZObjCBlockFixture : NSObject
+ (void)invoke:(void (^ _Nonnull)(int32_t value))handler;
@end

@implementation ZObjCBlockFixture
+ (void)invoke:(void (^ _Nonnull)(int32_t value))handler {
  void (^copied)(int32_t) = [handler copy];
  copied(42);
}
@end

#endif
