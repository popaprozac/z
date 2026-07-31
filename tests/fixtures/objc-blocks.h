#ifndef Z_OBJC_BLOCKS_H
#define Z_OBJC_BLOCKS_H

#import <dispatch/dispatch.h>
#import <Foundation/Foundation.h>

@interface ZObjCBlockFixture : NSObject
+ (void)invoke:(void (^ _Nonnull)(int32_t value))handler;
+ (void)invokeOnWorker:(void (^ _Nonnull)(int32_t value))handler;
@end

@implementation ZObjCBlockFixture
+ (void)invoke:(void (^ _Nonnull)(int32_t value))handler {
  void (^copied)(int32_t) = [handler copy];
  copied(42);
}

+ (void)invokeOnWorker:(void (^ _Nonnull)(int32_t value))handler {
  void (^copied)(int32_t) = [handler copy];
  dispatch_semaphore_t completion = dispatch_semaphore_create(0);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    copied(42);
    dispatch_semaphore_signal(completion);
  });
  dispatch_semaphore_wait(completion, DISPATCH_TIME_FOREVER);
}
@end

#endif
