#ifndef Z_OBJC_BORROW_METHOD_H
#define Z_OBJC_BORROW_METHOD_H

#import <Foundation/Foundation.h>

@interface ZObjCBorrowMethodFixture : NSObject
+ (NSString * _Nonnull)echo:(NSString * _Nonnull)value;
@end

@implementation ZObjCBorrowMethodFixture
+ (NSString * _Nonnull)echo:(NSString * _Nonnull)value {
  return value;
}
@end

#endif
