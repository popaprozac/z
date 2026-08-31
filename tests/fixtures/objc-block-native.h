#ifndef Z_OBJC_BLOCK_NATIVE_H
#define Z_OBJC_BLOCK_NATIVE_H

#import <Foundation/Foundation.h>

@protocol ZNativeObjCBlockDelegate <NSObject>
- (void)requestValue:(void (^ _Nonnull)(int32_t value))completion;
@end

@interface ZNativeObjCBlockFixture : NSObject
+ (void)invoke:(void (^ _Nonnull)(id _Nullable value, NSError * _Nullable error))completion;
+ (int32_t)invokeDelegate:(id<ZNativeObjCBlockDelegate> _Nonnull)delegate;
@end

@implementation ZNativeObjCBlockFixture
+ (void)invoke:(void (^ _Nonnull)(id _Nullable value, NSError * _Nullable error))completion {
  completion(@"ready", nil);
}

+ (int32_t)invokeDelegate:(id<ZNativeObjCBlockDelegate> _Nonnull)delegate {
  __block int32_t observed = 0;
  [delegate requestValue:^(int32_t value) {
    observed = value;
  }];
  return observed;
}
@end

#endif
