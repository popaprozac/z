#ifndef Z_OBJC_REGISTRATION_FIXTURE_H
#define Z_OBJC_REGISTRATION_FIXTURE_H

#import <Foundation/Foundation.h>

#include <stdint.h>
#include <stdio.h>

@class ZRegistrationOwner;

@protocol ZRegistrationHandler <NSObject>
- (void)registrationOwner:(ZRegistrationOwner *)owner
           didReceiveValue:(int32_t)value;
@end

@interface ZRegistrationOwner : NSObject {
  id<ZRegistrationHandler> _handler;
  NSString *_name;
}
- (void)addHandler:(id<ZRegistrationHandler>)handler name:(NSString *)name;
- (void)removeHandlerForName:(NSString *)name;
- (void)emitValue:(int32_t)value;
@end

@implementation ZRegistrationOwner
- (void)addHandler:(id<ZRegistrationHandler>)handler name:(NSString *)name {
  _handler = handler;
  _name = name;
  printf("registered %s\n", name.UTF8String);
}

- (void)removeHandlerForName:(NSString *)name {
  if (_handler != nil && [_name isEqualToString:name]) {
    printf("unregistered %s\n", name.UTF8String);
    _handler = nil;
    _name = nil;
  }
}

- (void)emitValue:(int32_t)value {
  [_handler registrationOwner:self didReceiveValue:value];
}

- (void)dealloc {
  if (_handler != nil) printf("dangling registration\n");
}
@end

#endif
