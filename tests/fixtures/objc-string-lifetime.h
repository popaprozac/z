#ifndef Z_OBJC_STRING_LIFETIME_H
#define Z_OBJC_STRING_LIFETIME_H
#import <Foundation/Foundation.h>

@interface ZStringLifetimeOwner : NSObject
@property(nonatomic, copy) NSString * _Nonnull title;
+ (NSString * _Nonnull)echo:(NSString * _Nonnull)value;
+ (NSString * _Nonnull)echoIn:(NSString * _Nonnull)value;
@end
@implementation ZStringLifetimeOwner
+ (NSString * _Nonnull)echo:(NSString * _Nonnull)value { return value; }
+ (NSString * _Nonnull)echoIn:(NSString * _Nonnull)value { return value; }
@end
#endif
