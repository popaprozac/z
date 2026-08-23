#ifndef Z_OBJC_INSTANCEOF_H
#define Z_OBJC_INSTANCEOF_H

#import <Foundation/Foundation.h>

@interface ZObjCDynamicOwner : NSObject
+ (instancetype _Nonnull)sharedOwner;
@property(nonatomic, readonly) id _Nullable body;
@end

@implementation ZObjCDynamicOwner
+ (instancetype _Nonnull)sharedOwner {
  return [[self alloc] init];
}

- (id _Nullable)body {
  return @"dynamic body";
}
@end

#endif
