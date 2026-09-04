#ifndef Z_OBJC_BLOCKS_H
#define Z_OBJC_BLOCKS_H

#import <dispatch/dispatch.h>
#import <Foundation/Foundation.h>

@class ZObjCBlockFixture;

@protocol ZObjCReceivedBlockDelegate <NSObject>
- (void)fixture:(ZObjCBlockFixture * _Nonnull)fixture
        complete:(void (^ _Nonnull)(int32_t value))completion;
@end

typedef NS_OPTIONS(NSUInteger, ZObjCFetchOptions) {
  ZObjCFetchOptionNone = 0,
  ZObjCFetchOptionPrimary = 1 << 0,
};

@interface ZObjCBlockFixture : NSObject
@property(nonatomic, weak, nullable) id<ZObjCReceivedBlockDelegate> delegate;
@property(nonatomic) int32_t observed;
+ (void)invoke:(void (^ _Nonnull)(int32_t value))handler;
+ (void)invokeOnWorker:(void (^ _Nonnull)(int32_t value))handler;
+ (void)invokeObjectOnWorker:(void (^ _Nonnull)(NSString * _Nonnull value))handler;
+ (void)fetchObjectOnWorker:(void (^ _Nonnull)(NSString * _Nonnull value))handler;
+ (void)fetchObjectWithOptions:(ZObjCFetchOptions)options
                    completion:(void (^ _Nonnull)(NSString * _Nonnull value))handler;
- (int32_t)invokeDelegate;
- (void)prepareDelegate;
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

+ (void)invokeObjectOnWorker:(void (^ _Nonnull)(NSString * _Nonnull value))handler {
  void (^copied)(NSString *) = [handler copy];
  dispatch_semaphore_t completion = dispatch_semaphore_create(0);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    copied(@"native object");
    dispatch_semaphore_signal(completion);
  });
  dispatch_semaphore_wait(completion, DISPATCH_TIME_FOREVER);
}

+ (void)fetchObjectOnWorker:(void (^ _Nonnull)(NSString * _Nonnull value))handler {
  void (^copied)(NSString *) = [handler copy];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    copied(@"native object");
  });
}

+ (void)fetchObjectWithOptions:(ZObjCFetchOptions)options
                    completion:(void (^ _Nonnull)(NSString * _Nonnull value))handler {
  void (^copied)(NSString *) = [handler copy];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    copied((options & ZObjCFetchOptionPrimary) != 0 ? @"native object" : @"other");
  });
}

- (int32_t)invokeDelegate {
  __block int32_t observed = 0;
  [self.delegate fixture:self complete:^(int32_t value) {
    observed = value;
  }];
  return observed;
}

- (void)prepareDelegate {
  __weak ZObjCBlockFixture *weakSelf = self;
  [self.delegate fixture:self complete:^(int32_t value) {
    weakSelf.observed = value;
  }];
}
@end

#endif
