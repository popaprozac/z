#import <Foundation/Foundation.h>

__attribute__((swift_attr("@UIActor")))
@interface ZAnnotatedMainObject : NSObject
+ (instancetype)shared;
- (NSInteger)value;
@end

@interface ZDeclaredMainObject : NSObject
+ (instancetype)shared;
- (NSInteger)value;
@end

@interface ZMethodMainObject : NSObject
+ (instancetype)shared;
- (NSInteger)refresh;
@end

@interface ZAnnotatedMethodObject : NSObject
+ (instancetype)shared;
- (NSInteger)refresh __attribute__((swift_attr("@UIActor")));
@end

NSInteger z_annotated_main_only(NSInteger value) __attribute__((swift_attr("@UIActor")));
NSInteger z_main_only(NSInteger value);
