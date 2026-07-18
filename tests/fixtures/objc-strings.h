#ifndef Z_OBJC_STRINGS_H
#define Z_OBJC_STRINGS_H

#import <Foundation/Foundation.h>

@interface ZObjCStringFixture : NSObject
+ (NSString * _Nonnull)echo:(NSString * _Nonnull)value;
+ (NSString * _Nonnull)embeddedNull;
@end

@implementation ZObjCStringFixture
+ (NSString * _Nonnull)echo:(NSString * _Nonnull)value {
  return value;
}

+ (NSString * _Nonnull)embeddedNull {
  const unichar characters[] = { 'a', 0, 'b' };
  return [NSString stringWithCharacters:characters length:3];
}
@end

#endif
