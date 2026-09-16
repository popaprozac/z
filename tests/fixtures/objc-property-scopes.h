#import <Foundation/Foundation.h>

@interface ZPropertyScopeBase : NSObject
@property(nonatomic, readonly) int value;
@property(class, readonly) double value;
@property(nonatomic, readonly) int marker;
@end

@interface ZPropertyScopeChild : ZPropertyScopeBase
@property(nonatomic, readonly) int value;
@property(class, readonly) int marker;
@end

@implementation ZPropertyScopeBase
- (int)value { return 11; }
+ (double)value { return 22.5; }
- (int)marker { return 31; }
@end

@implementation ZPropertyScopeChild
- (int)value { return 41; }
+ (int)marker { return 51; }
@end
