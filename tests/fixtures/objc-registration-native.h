#ifndef Z_OBJC_REGISTRATION_NATIVE_FIXTURE_H
#define Z_OBJC_REGISTRATION_NATIVE_FIXTURE_H

#import <Foundation/NSObject.h>

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#ifndef nil
#define nil ((id)0)
#endif

@class ZNativeRegistrationOwner;

@protocol ZNativeRegistrationHandler <NSObject>
- (void)registrationOwner:(ZNativeRegistrationOwner *)owner
           didReceiveValue:(int32_t)value;
@end

@interface ZNativeRegistrationOwner : NSObject {
  id<ZNativeRegistrationHandler> _handler;
  const char *_name;
}
+ (ZNativeRegistrationOwner *)createOwner;
- (void)addHandler:(id<ZNativeRegistrationHandler>)handler
              name:(const char *)name;
- (void)removeHandlerForName:(const char *)name;
- (void)emitValue:(int32_t)value;
@end

@implementation ZNativeRegistrationOwner
+ (ZNativeRegistrationOwner *)createOwner {
  return [[ZNativeRegistrationOwner alloc] init];
}

- (void)addHandler:(id<ZNativeRegistrationHandler>)handler
              name:(const char *)name {
  _handler = handler;
  _name = name;
  printf("registered %s\n", name);
}

- (void)removeHandlerForName:(const char *)name {
  if (_handler != nil && _name != NULL && strcmp(_name, name) == 0) {
    printf("unregistered %s\n", name);
    _handler = nil;
    _name = NULL;
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
